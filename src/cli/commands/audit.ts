import { select } from '@inquirer/prompts';
import { z } from 'zod';

import { AuditListService, type AuditListItem } from '../../application/audit-list-service.js';
import { AuditVerificationService } from '../../application/audit-verification-service.js';
import { loadConfig } from '../../config.js';
import { resourceIdSchema } from '../../domain/resource.js';
import { openReadOnlyLocalDatabase, type SqliteConnection } from '../../infra/sqlite/connection.js';
import { requireCurrentMigrations } from '../../infra/sqlite/migrate.js';
import { proposalDraftSchema } from '../../infra/sqlite/proposal-repository.js';
import type { ActorContext } from '../../security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../../security/reviewer-auth.js';

const databasePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const listOptionsSchema = z
  .strictObject({
    databasePath: databasePathSchema,
    proposalId: proposalDraftSchema.shape.id.optional(),
    resourceId: resourceIdSchema.optional(),
    limit: z.int().min(1).max(100).optional(),
    offset: z.int().min(0).max(10_000).optional(),
  })
  .refine((options) => options.proposalId === undefined || options.resourceId === undefined);
const verifyOptionsSchema = z.strictObject({ databasePath: databasePathSchema });

type AuditCliRole = 'reviewer' | 'auditor';

export class AuditCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditCommandError';
  }
}

export interface AuditPromptRuntime {
  isInteractive(): boolean;
  chooseRole(): Promise<AuditCliRole>;
  readonly authRuntime?: ReviewerAuthRuntime;
}

const promptContext = { input: process.stdin, output: process.stderr };
const defaultRuntime: AuditPromptRuntime = {
  isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
  chooseRole: async () => {
    const role = await select(
      {
        message: 'Local audit reader role',
        choices: [
          { name: 'Reviewer', value: 'reviewer' },
          { name: 'Auditor', value: 'auditor' },
        ],
      },
      promptContext,
    );
    if (role !== 'reviewer' && role !== 'auditor')
      throw new AuditCommandError('Invalid audit reader role.');
    return role;
  },
};

async function withAuthenticatedAuditReader<T>(
  databasePath: string,
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
  runtime: AuditPromptRuntime,
  operation: (database: SqliteConnection, actor: ActorContext) => T,
): Promise<T> {
  if (!runtime.isInteractive()) {
    throw new AuditCommandError('Audit commands require an interactive terminal.');
  }
  const config = loadConfig({ ...environment, SECUREOPS_DB_PATH: databasePath }, workingDirectory);
  if (config.mode !== 'local-full') {
    throw new AuditCommandError('Audit commands require local-full mode.');
  }
  let database: SqliteConnection;
  try {
    database = openReadOnlyLocalDatabase(config);
  } catch {
    throw new AuditCommandError('Select an existing readable local database file.');
  }
  try {
    try {
      requireCurrentMigrations(database);
    } catch {
      throw new AuditCommandError('Apply database migrations before reading audit events.');
    }
    const role = await runtime.chooseRole();
    if (role !== 'reviewer' && role !== 'auditor')
      throw new AuditCommandError('Invalid audit reader role.');
    const actor = await authenticateCliActor(database, role, runtime.authRuntime);
    return operation(database, actor);
  } finally {
    database.close();
  }
}

/** Only fields validated by AuditListService reach the terminal. */
function formatAuditItem(item: AuditListItem): string {
  const resource = item.resourceId === null ? '' : ` resource:${item.resourceId}`;
  return (
    `#${item.sequence} ${item.occurredAt} ${item.action} ` +
    `${item.subjectType}:${item.subjectId}${resource} ` +
    `by ${item.actorType}:${item.actorId} (${item.id})`
  );
}

/** Authenticate for each invocation before reading the protected trace. */
export async function runAuditListCommand(
  options: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  runtime: AuditPromptRuntime = defaultRuntime,
): Promise<string> {
  const parsed = listOptionsSchema.safeParse(options);
  if (!parsed.success) throw new AuditCommandError('Invalid audit list options.');
  return withAuthenticatedAuditReader(
    parsed.data.databasePath,
    environment,
    workingDirectory,
    runtime,
    (database, actor) => {
      const items = new AuditListService(database).list(actor, {
        proposalId: parsed.data.proposalId,
        resourceId: parsed.data.resourceId,
        limit: parsed.data.limit ?? 50,
        offset: parsed.data.offset ?? 0,
      });
      return items.length === 0
        ? 'No local fictional audit events found.'
        : `Local fictional audit events (listing does not verify integrity):\n${items.map(formatAuditItem).join('\n')}`;
    },
  );
}

/** Report consistency of rows currently present, not proof of an undeleted tail. */
export async function runAuditVerifyCommand(
  options: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  runtime: AuditPromptRuntime = defaultRuntime,
): Promise<string> {
  const parsed = verifyOptionsSchema.safeParse(options);
  if (!parsed.success) throw new AuditCommandError('Invalid audit verification options.');
  return withAuthenticatedAuditReader(
    parsed.data.databasePath,
    environment,
    workingDirectory,
    runtime,
    (database, actor) => {
      const report = new AuditVerificationService(database).verify(actor);
      const summary = report.valid
        ? `Local fictional audit chain consistent: ${report.verifiedEvents} of ${report.totalEvents} stored events verified.`
        : `Local fictional audit chain inconsistent at sequence ${report.firstInvalidSequence} ` +
          `(${report.failure}); ${report.verifiedEvents} of ${report.totalEvents} stored events verified.`;
      return `${summary}\nA deleted tail cannot be detected without a trusted external head record.`;
    },
  );
}
