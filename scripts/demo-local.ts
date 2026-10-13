import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentAuditService } from '../src/application/agent-audit-service.js';
import { ApprovalRequestService } from '../src/application/approval-request-service.js';
import { ExecutionService } from '../src/application/execution-service.js';
import { PolicyPreviewService } from '../src/application/policy-preview-service.js';
import { ProposalService } from '../src/application/proposal-service.js';
import { ResourceService, type ResourceListResult } from '../src/application/resource-service.js';
import { runDatabaseCommand } from '../src/cli/commands/db.js';
import { loadConfig } from '../src/config.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors.js';
import {
  openConfiguredDatabase,
  openReadOnlyLocalDatabase,
} from '../src/infra/sqlite/connection.js';
import { SqliteDecisionRepository } from '../src/infra/sqlite/decision-repository.js';
import { requireCurrentMigrations } from '../src/infra/sqlite/migrate.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { proposalIdSchema } from '../src/mcp/schemas.js';
import { createMcpActor } from '../src/security/permissions.js';

const demoDatabasePath = 'data/demo/secureops-demo.db';
const demoResourceId = 'res-aws-ec2-01';
const demoAction = { type: 'disable_compute' } as const;
const proposalKey = 'demo-local-setup-001';
const executionKeyFor = (proposalId: string): string => `demo-local-execution-${proposalId}`;

function quoteShellPath(value: string): string {
  // Single quotes prevent expansion in PowerShell and POSIX shells. Their escape rules differ.
  return process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function requireRegularDemoDatabase(databasePath: string): void {
  try {
    const entry = lstatSync(databasePath);
    if (entry.isFile() && entry.nlink === 1) return;
  } catch {
    // Keep the selected local path out of routine failure text.
  }
  throw new Error('An existing regular demo database is required.');
}

export interface DemoPreparationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
}

export interface DemoPreview {
  readonly resourceCount: number;
  readonly resources: ResourceListResult['resources'];
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly observationCodes: readonly string[];
  readonly monthlyCostBeforeCents: number;
  readonly monthlyCostAfterCents: number;
  readonly policyVersion: string;
  readonly approvalRequired: true;
}

export interface PendingDemo extends DemoPreview {
  readonly proposalId: string;
  readonly status: 'pending_approval';
  readonly reviewerCommands: readonly string[];
}

export type DemoResume =
  | Readonly<{ proposalId: string; status: 'pending_approval' | 'rejected' | 'stale' }>
  | Readonly<{
      proposalId: string;
      status: 'executed';
      executionId: string;
      resourceVersion: number;
      monthlyCostAfterCents: number;
      auditActions: readonly string[];
    }>;

/** Restore only the disposable demo path, then inspect its fictional baseline read-only. */
export function resetAndPreviewDemo(options: DemoPreparationOptions = {}): DemoPreview {
  const environment = options.environment ?? process.env;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const config = loadConfig(
    {
      ...environment,
      SECUREOPS_DB_PATH: demoDatabasePath,
    },
    workingDirectory,
  );
  if (config.mode !== 'local-full') throw new Error('Local demo requires local-full mode.');

  // Reuse the database command's exact-path, link, fixture, and migration guards.
  const reset = runDatabaseCommand(
    ['reset', '--db-path', demoDatabasePath, '--force'],
    environment,
    workingDirectory,
  );
  const database = openReadOnlyLocalDatabase(config);
  try {
    const actor = createMcpActor(config);
    const resources = new SqliteResourceRepository(database);
    const resourceService = new ResourceService(resources);
    const listed = resourceService.listResources(actor, { limit: 100 });
    const resource = resourceService.getResource(actor, { resourceId: demoResourceId }).resource;
    const analysis = resourceService.analyzeResource(actor, { resourceId: demoResourceId });
    const policy = new PolicyPreviewService(resources).evaluatePolicy(actor, {
      resourceId: demoResourceId,
      action: demoAction,
    });
    if (
      listed.resources.length !== reset.resourceCount ||
      !analysis.observations.some((observation) => observation.code === 'idle') ||
      !policy.evaluation.allowed ||
      !policy.evaluation.approvalRequired
    ) {
      throw new Error('Fictional demo baseline is not eligible for review.');
    }

    return Object.freeze({
      resourceCount: listed.resources.length,
      resources: listed.resources,
      resourceId: resource.id,
      resourceVersion: resource.version,
      observationCodes: Object.freeze(analysis.observations.map((observation) => observation.code)),
      monthlyCostBeforeCents: resource.monthlyCostEstimateCents,
      monthlyCostAfterCents: policy.preview.after.monthlyCostEstimateCents,
      policyVersion: policy.evaluation.policyVersion,
      approvalRequired: true as const,
    });
  } finally {
    database.close();
  }
}

/** Prepare one fictional request, then hand the pending proposal to a human reviewer. */
export function resetAndRequestDemo(options: DemoPreparationOptions = {}): PendingDemo {
  const preview = resetAndPreviewDemo(options);
  const environment = options.environment ?? process.env;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const config = loadConfig(
    {
      ...environment,
      SECUREOPS_DB_PATH: demoDatabasePath,
    },
    workingDirectory,
  );
  if (config.mode !== 'local-full') throw new Error('Local demo requires local-full mode.');

  // Reset closed its connection. Refuse a missing or linked replacement before opening for writes.
  requireRegularDemoDatabase(config.database.path);
  const database = openConfiguredDatabase(config);
  const proposalId = (() => {
    try {
      requireCurrentMigrations(database);
      const actor = createMcpActor(config);
      const clock = { now: () => new Date() };
      // The preview is advisory. One outer write transaction prevents a changed baseline
      // or failed approval request from leaving a misleading draft behind.
      return database
        .transaction((): string => {
          const current = new SqliteResourceRepository(database).getById(preview.resourceId);
          if (
            current === null ||
            current.version !== preview.resourceVersion ||
            current.monthlyCostEstimateCents !== preview.monthlyCostBeforeCents
          ) {
            throw new ConflictError();
          }
          const proposal = new ProposalService(database, clock, {
            nextId: (prefix) => `${prefix}-${randomUUID()}`,
          }).proposeChange(actor, {
            resourceId: preview.resourceId,
            action: demoAction,
            reason: 'Demonstrate independent review of an idle fictional compute resource.',
            idempotencyKey: proposalKey,
          });
          const requested = new ApprovalRequestService(database, clock).requestApproval(actor, {
            proposalId: proposal.proposalId,
            justification: 'Request human review before simulating this fictional change.',
          });
          if (
            requested.status !== 'pending_approval' ||
            requested.proposalId !== proposal.proposalId
          ) {
            throw new Error('Demo proposal did not enter the review queue.');
          }
          return requested.proposalId;
        })
        .immediate();
    } finally {
      database.close();
    }
  })();

  const selectedPath = quoteShellPath(config.database.path);
  return Object.freeze({
    ...preview,
    proposalId,
    status: 'pending_approval' as const,
    reviewerCommands: Object.freeze([
      'npm run build',
      `npm run cli -- reviewer:init --db-path ${selectedPath}`,
      `npm run cli -- proposals:list --db-path ${selectedPath}`,
      `npm run cli -- proposals:review --db-path ${selectedPath} --proposal-id ${proposalId}`,
    ]),
  });
}

/** Resume only this runner's proposal; execution independently rechecks reviewer authority. */
export function resumeDemo(proposalId: string, options: DemoPreparationOptions = {}): DemoResume {
  if (!proposalIdSchema.safeParse(proposalId).success) throw new ValidationError();
  const environment = options.environment ?? process.env;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const config = loadConfig(
    { ...environment, SECUREOPS_DB_PATH: demoDatabasePath },
    workingDirectory,
  );
  if (config.mode !== 'local-full') throw new Error('Local demo requires local-full mode.');

  const readDatabase = openReadOnlyLocalDatabase(config);
  const status = (() => {
    try {
      requireCurrentMigrations(readDatabase);
      const proposal = new SqliteProposalRepository(readDatabase).getById(proposalId);
      if (proposal === null) throw new NotFoundError();
      if (
        proposal.proposerActorId !== 'local-agent' ||
        proposal.resourceId !== demoResourceId ||
        proposal.idempotencyKey !== proposalKey ||
        proposal.action.type !== demoAction.type
      )
        throw new ConflictError();
      if (proposal.status === 'draft') throw new ConflictError();
      if (proposal.status === 'approved' || proposal.status === 'executed') {
        const decision = new SqliteDecisionRepository(readDatabase).getByProposalId(proposalId);
        if (decision?.decision !== 'approved') throw new ConflictError();
      }
      return proposal.status;
    } finally {
      readDatabase.close();
    }
  })();

  if (status === 'pending_approval' || status === 'rejected' || status === 'stale') {
    return Object.freeze({ proposalId, status });
  }

  // The read-only status is advisory. ExecutionService rechecks all protected state
  // in its own immediate write transaction and makes an exact retry idempotent.
  requireRegularDemoDatabase(config.database.path);
  const database = openConfiguredDatabase(config);
  try {
    requireCurrentMigrations(database);
    const actor = createMcpActor(config);
    const result = new ExecutionService(database).executeChange(actor, {
      proposalId,
      idempotencyKey: executionKeyFor(proposalId),
    });
    const events = new AgentAuditService(database).getAuditLog(actor, { proposalId, limit: 20 });
    return Object.freeze({
      proposalId,
      status: 'executed' as const,
      executionId: result.executionId,
      resourceVersion: result.resourceVersion,
      monthlyCostAfterCents: result.result.after.monthlyCostEstimateCents,
      auditActions: Object.freeze(events.events.map((event) => event.action)),
    });
  } finally {
    database.close();
  }
}

class DemoUsageError extends Error {}

/** Direct command output contains only fictional summaries and local reviewer commands. */
export function runDemoCommand(
  args: readonly string[],
  options: DemoPreparationOptions = {},
): string {
  if (args.length === 0 || (args.length === 1 && args[0] === 'setup')) {
    const pending = resetAndRequestDemo(options);
    return [
      `Restored ${pending.resourceCount} fictional resources:`,
      ...pending.resources.map(
        (resource) =>
          `  ${resource.id}: ${resource.provider} ${resource.kind}, estimated $${(resource.monthlyCostEstimateCents / 100).toFixed(2)}/month`,
      ),
      `Idle compute candidate: ${pending.resourceId} (version ${pending.resourceVersion}).`,
      `Estimated monthly cost: $${(pending.monthlyCostBeforeCents / 100).toFixed(2)} -> $${(pending.monthlyCostAfterCents / 100).toFixed(2)}.`,
      `Policy ${pending.policyVersion} requires independent approval.`,
      `Pending proposal: ${pending.proposalId}.`,
      'From the project root, use an interactive terminal for reviewer commands:',
      ...pending.reviewerCommands,
      `After review: npm run demo:local -- resume --proposal-id ${pending.proposalId}`,
      'Setup always resets this disposable demo database; resume never resets it.',
    ].join('\n');
  }
  if (args.length === 3 && args[0] === 'resume' && args[1] === '--proposal-id') {
    const result = resumeDemo(args[2] ?? '', options);
    if (result.status === 'pending_approval') {
      return `Proposal ${result.proposalId} still awaits independent review; no change executed.`;
    }
    if (result.status === 'rejected' || result.status === 'stale') {
      return `Proposal ${result.proposalId} is ${result.status}; no change executed.`;
    }
    if (result.status !== 'executed') throw new Error('Unexpected demo resume status.');
    return [
      `Fictional proposal ${result.proposalId} executed as ${result.executionId}.`,
      `Resource version: ${result.resourceVersion}; estimated monthly cost: $${(result.monthlyCostAfterCents / 100).toFixed(2)}.`,
      `Audit trace: ${result.auditActions.join(' -> ')}.`,
      'Repeating this resume command returns the saved execution without another change.',
    ].join('\n');
  }
  throw new DemoUsageError(
    'Usage: npm run demo:local [-- setup] | npm run demo:local -- resume --proposal-id <proposal-id>',
  );
}

function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return path.resolve(entryPoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    process.stdout.write(`${runDemoCommand(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof DemoUsageError ? error.message : 'Local demo failed; review the selected demo database and proposal state.'}\n`,
    );
    process.exitCode = 1;
  }
}
