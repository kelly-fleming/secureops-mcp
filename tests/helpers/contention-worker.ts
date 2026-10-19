import { parentPort, workerData } from 'node:worker_threads';

import { ExecutionService } from '../../src/application/execution-service.js';
import { ProposalService } from '../../src/application/proposal-service.js';
import { ReviewService } from '../../src/application/review-service.js';
import { loadConfig } from '../../src/config.js';
import { publicErrorFor } from '../../src/domain/errors.js';
import { loadDemoPolicy } from '../../src/domain/policy.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { createMcpActor } from '../../src/security/permissions.js';
import { authenticateCliActor } from '../../src/security/reviewer-auth.js';
import { requirePrivateTestDatabasePath } from './contention-path.js';
import {
  isContentionCommand,
  type ContentionReply,
  type ReviewWork,
} from './contention-protocol.js';
import { createFixedClock, createSequentialIdGenerator } from './fakes.js';

const port =
  parentPort ??
  (() => {
    throw new Error('A contention worker requires a parent thread.');
  })();

function send(
  requestId: number,
  kind: ContentionReply['kind'],
  result?: unknown,
  errorCode?: string,
): void {
  port.postMessage({
    requestId,
    kind,
    result,
    ...(errorCode === undefined ? {} : { errorCode }),
  } satisfies ContentionReply);
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_BUSY')
  );
}

function rollbackIfOpen(database: SqliteConnection): void {
  if (database.inTransaction) database.exec('ROLLBACK');
}

let opened: SqliteConnection | undefined;
let agent: ReturnType<typeof createMcpActor> | undefined;
try {
  const data = workerData as unknown;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('databasePath' in data) ||
    typeof data.databasePath !== 'string'
  ) {
    throw new Error('A private database path is required.');
  }
  const config = loadConfig(
    {
      SECUREOPS_MODE: 'local-full',
      SECUREOPS_DB_PATH: requirePrivateTestDatabasePath(data.databasePath),
    },
    process.cwd(),
  );
  opened = openConfiguredDatabase(config);
  agent = createMcpActor(config);
  send(0, 'ready');
} catch {
  try {
    opened?.close();
  } catch {
    // A failed open must still notify the parent so it can terminate the worker.
  }
  send(0, 'failed');
  port.close();
}

if (opened !== undefined && agent !== undefined) {
  const database = opened;
  const agentActor = agent;
  port.on('message', async (value: unknown) => {
    if (!isContentionCommand(value)) return;
    const { requestId, kind } = value;
    try {
      switch (kind) {
        case 'hold-lock':
          database.exec('BEGIN IMMEDIATE');
          send(requestId, 'lock-held');
          return;
        case 'release-lock':
          if (!database.inTransaction) throw new Error('No lock is held.');
          database.exec('ROLLBACK');
          send(requestId, 'lock-released');
          return;
        case 'commit-lock':
          if (!database.inTransaction) throw new Error('No lock is held.');
          database.exec('COMMIT');
          send(requestId, 'lock-released');
          return;
        case 'advance-resource': {
          if (!database.inTransaction || typeof value.input !== 'string') {
            throw new Error('A held lock and resource ID are required.');
          }
          const resources = new SqliteResourceRepository(database);
          const current = resources.getById(value.input);
          if (current === null) throw new Error('Missing resource.');
          if (resources.updateIfVersion(current, current.version).status !== 'updated') {
            throw new Error('Could not advance resource.');
          }
          send(requestId, 'resource-advanced');
          return;
        }
        case 'attempt-lock':
          send(requestId, 'attempt-started');
          database.exec('BEGIN IMMEDIATE');
          database.exec('ROLLBACK');
          send(requestId, 'acquired');
          return;
        case 'propose':
        case 'review':
        case 'execute': {
          let result: unknown;
          const ids = createSequentialIdGenerator(value.sequence ?? 1);
          if (kind === 'propose') {
            send(requestId, 'operation-started');
            result = new ProposalService(
              database,
              createFixedClock('2026-01-01T00:00:00.000Z'),
              ids,
            ).proposeChange(agentActor, value.input);
          } else if (kind === 'execute') {
            send(requestId, 'operation-started');
            result = new ExecutionService(
              database,
              createFixedClock('2026-01-01T03:00:00.000Z'),
              ids,
            ).executeChange(agentActor, value.input);
          } else {
            const work = value.input as ReviewWork;
            if (typeof work !== 'object' || work === null) throw new Error('Invalid review work.');
            const reviewer = await authenticateCliActor(database, 'reviewer', {
              isInteractive: () => true,
              askUsername: async () => work.username,
              askPassphrase: async () => work.passphrase,
              delay: async () => undefined,
            });
            send(requestId, 'operation-started');
            const policy = (): unknown => {
              const current = loadDemoPolicy();
              if (work.denyCurrentPolicy !== true) return current;
              return {
                ...current,
                rules: current.rules.map((rule) =>
                  rule.type === 'limit_monthly_cost_increase'
                    ? { ...rule, maximumMonthlyIncreaseCents: 0 }
                    : rule,
                ),
              };
            };
            result = new ReviewService(
              database,
              createFixedClock('2026-01-01T02:00:00.000Z'),
              ids,
              policy,
            ).review(reviewer, {
              proposalId: work.proposalId,
              decision: work.decision,
              reason: work.reason,
            });
          }
          send(requestId, 'operation-completed', result);
          return;
        }
        case 'close':
          rollbackIfOpen(database);
          database.close();
          send(requestId, 'closed');
          port.close();
          return;
      }
    } catch (error) {
      try {
        rollbackIfOpen(database);
      } catch {
        // The parent bounds this worker and can terminate it after a failed command.
      }
      if (kind === 'propose' || kind === 'review' || kind === 'execute') {
        send(
          requestId,
          'operation-refused',
          undefined,
          isBusy(error) ? 'SQLITE_BUSY' : publicErrorFor(error).code,
        );
      } else {
        send(requestId, isBusy(error) ? 'busy' : 'failed');
      }
    }
  });
}
