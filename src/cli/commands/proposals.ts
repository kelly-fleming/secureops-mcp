import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';

import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';

import {
  ReviewQueueService,
  type PendingReviewItem,
} from '../../application/review-queue-service.js';
import { ReviewService } from '../../application/review-service.js';
import { loadConfig } from '../../config.js';
import { reviewDecisionSchema } from '../../infra/sqlite/decision-repository.js';
import { openConfiguredDatabase, type SqliteConnection } from '../../infra/sqlite/connection.js';
import {
  applyMigrations,
  discoverMigrations,
  type MigrationFile,
} from '../../infra/sqlite/migrate.js';
import { proposalDraftSchema } from '../../infra/sqlite/proposal-repository.js';
import type { ActorContext } from '../../security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../../security/reviewer-auth.js';

const databasePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const listOptionsSchema = z.strictObject({
  databasePath: databasePathSchema,
  limit: z.int().min(1).max(100).optional(),
  offset: z.int().min(0).max(10_000).optional(),
});
const reviewOptionsSchema = z.strictObject({
  databasePath: databasePathSchema,
  proposalId: proposalDraftSchema.shape.id,
});

type ReviewDecision = 'approved' | 'rejected';

export class ProposalCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalCommandError';
  }
}

export interface ProposalPromptRuntime {
  isInteractive(): boolean;
  write(text: string): void;
  chooseDecision(item: PendingReviewItem): Promise<ReviewDecision>;
  askReason(): Promise<string>;
  confirmDecision(decision: ReviewDecision, proposalId: string): Promise<boolean>;
  readonly authRuntime?: ReviewerAuthRuntime;
}

const promptContext = { input: process.stdin, output: process.stderr };
const defaultRuntime: ProposalPromptRuntime = {
  isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
  write: (text) => {
    process.stderr.write(text);
  },
  chooseDecision: async (item) => {
    const choices =
      item.readiness === 'ready'
        ? [
            { name: 'Approve fictional local change', value: 'approved' },
            { name: 'Reject proposal', value: 'rejected' },
          ]
        : [{ name: 'Reject proposal', value: 'rejected' }];
    const choice = await select(
      { message: 'Your independent review decision', choices },
      promptContext,
    );
    if (choice !== 'approved' && choice !== 'rejected')
      throw new ProposalCommandError('Invalid review choice.');
    return choice;
  },
  askReason: () =>
    input(
      {
        message: 'Reason for decision',
        validate: (value) =>
          reviewDecisionSchema.shape.reason.safeParse(value).success ||
          'Enter 1 to 1000 printable characters.',
      },
      promptContext,
    ),
  confirmDecision: (decision, proposalId) =>
    confirm(
      {
        message: `Record ${decision} for ${proposalId}?`,
        default: false,
      },
      promptContext,
    ),
};

function requireExistingRegularDatabase(databasePath: string): void {
  try {
    const entry = lstatSync(databasePath);
    if (entry.isFile() && entry.nlink === 1) return;
  } catch {
    // Never create a database for an authenticated review command.
  }
  throw new ProposalCommandError('Select an existing regular local database file.');
}

function requireCurrentMigrations(
  database: SqliteConnection,
  migrations: readonly MigrationFile[],
): void {
  database
    .transaction(() => {
      if (applyMigrations(database, migrations).applied !== 0) {
        throw new ProposalCommandError('Apply database migrations before reviewing proposals.');
      }
    })
    .immediate();
}

async function withAuthenticatedReviewer<T>(
  databasePath: string,
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
  runtime: ProposalPromptRuntime,
  operation: (database: SqliteConnection, actor: ActorContext) => Promise<T> | T,
): Promise<T> {
  if (!runtime.isInteractive()) {
    throw new ProposalCommandError('Proposal review commands require an interactive terminal.');
  }
  const config = loadConfig({ ...environment, SECUREOPS_DB_PATH: databasePath }, workingDirectory);
  if (config.mode !== 'local-full') {
    throw new ProposalCommandError('Proposal review commands require local-full mode.');
  }
  requireExistingRegularDatabase(config.database.path);
  const migrations = discoverMigrations();
  const database = openConfiguredDatabase(config);
  try {
    requireCurrentMigrations(database, migrations);
    const actor = await authenticateCliActor(database, 'reviewer', runtime.authRuntime);
    return await operation(database, actor);
  } finally {
    database.close();
  }
}

function safeTerminalText(value: string): string {
  // Keep stored human text on one visible terminal line, including Unicode separators
  // and invisible direction or formatting marks that can disguise a decision prompt.
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Treat proposal text and policy rationale as data, never terminal control sequences. */
export function formatPendingProposal(item: PendingReviewItem): string {
  const action =
    item.action.type === 'resize_compute'
      ? `resize compute to ${item.action.targetSize}`
      : 'disable idle compute';
  const findings = item.policy.findings.map(
    (finding) => `  ${finding.ruleId}: ${finding.result} - ${safeTerminalText(finding.rationale)}`,
  );
  return [
    `Proposal ${item.proposalId} [${item.readiness}] - fictional local simulation`,
    `  Proposer: ${safeTerminalText(item.proposerActorId)}`,
    `  Resource: ${safeTerminalText(item.resource.id)} (${item.resource.provider} ${item.resource.kind}, ${item.resource.environment})`,
    `  Owner: ${safeTerminalText(item.resource.owner)}`,
    `  Version: expected ${item.expectedResourceVersion}, current ${item.resource.version}`,
    `  Action: ${action}`,
    `  Reason: ${safeTerminalText(item.reason)}`,
    `  Justification: ${safeTerminalText(item.approvalJustification)}`,
    item.preview === null
      ? '  Preview: unavailable for current resource state'
      : `  Estimated monthly cost: ${formatCents(item.preview.before.monthlyCostEstimateCents)} -> ${formatCents(item.preview.after.monthlyCostEstimateCents)}`,
    `  Current policy ${item.policy.policyVersion}: ${item.policy.allowed ? 'eligible' : 'denied'}`,
    ...findings,
  ].join('\n');
}

/** Authenticate before exposing any pending proposal or reviewer-only detail. */
export async function runProposalListCommand(
  options: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  runtime: ProposalPromptRuntime = defaultRuntime,
): Promise<string> {
  const parsed = listOptionsSchema.safeParse(options);
  if (!parsed.success) throw new ProposalCommandError('Invalid proposal list options.');
  return withAuthenticatedReviewer(
    parsed.data.databasePath,
    environment,
    workingDirectory,
    runtime,
    (database, actor) => {
      const items = new ReviewQueueService(database).listPending(actor, {
        limit: parsed.data.limit ?? 50,
        offset: parsed.data.offset ?? 0,
      });
      return items.length === 0
        ? 'No pending fictional proposals.'
        : items.map(formatPendingProposal).join('\n\n');
    },
  );
}

/** One masked authentication and one explicit human decision per invocation. */
export async function runProposalReviewCommand(
  options: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  runtime: ProposalPromptRuntime = defaultRuntime,
): Promise<string> {
  const parsed = reviewOptionsSchema.safeParse(options);
  if (!parsed.success) throw new ProposalCommandError('Invalid proposal review options.');
  return withAuthenticatedReviewer(
    parsed.data.databasePath,
    environment,
    workingDirectory,
    runtime,
    async (database, actor) => {
      const item = new ReviewQueueService(database).getPending(actor, parsed.data.proposalId);
      runtime.write(`${formatPendingProposal(item)}\n`);
      if (item.readiness === 'stale' || item.readiness === 'self_review_forbidden') {
        throw new ProposalCommandError('This proposal cannot be reviewed in its current state.');
      }
      const decision = await runtime.chooseDecision(item);
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new ProposalCommandError('Invalid review choice.');
      }
      if (decision === 'approved' && item.readiness !== 'ready') {
        throw new ProposalCommandError('Current policy or resource state does not allow approval.');
      }
      const reason = await runtime.askReason();
      const parsedReason = reviewDecisionSchema.shape.reason.safeParse(reason);
      if (!parsedReason.success) throw new ProposalCommandError('Invalid decision reason.');
      if (!(await runtime.confirmDecision(decision, item.proposalId))) {
        return 'Review canceled; no decision recorded.';
      }
      const result = new ReviewService(
        database,
        { now: () => new Date() },
        { nextId: (prefix) => `${prefix}-${randomUUID()}` },
      ).review(actor, {
        proposalId: item.proposalId,
        decision,
        reason: parsedReason.data,
      });
      return `Recorded ${result.status} decision ${result.decisionId} for fictional proposal ${result.proposalId}.`;
    },
  );
}
