import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resetAndRequestDemo, resumeDemo, runDemoCommand } from '../scripts/demo-local.js';
import { runProposalReviewCommand } from '../src/cli/commands/proposals.js';
import { runReviewerInitCommand } from '../src/cli/commands/reviewer-init.js';
import { loadConfig } from '../src/config.js';
import { openReadOnlyLocalDatabase } from '../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { withTestDatabase } from './helpers/test-db.js';

const environment = { SECUREOPS_MODE: 'local-full' };
const passphrase = 'fictional-local-demo-reviewer-passphrase';

function demoPath(workingDirectory: string): string {
  return path.join(workingDirectory, 'data', 'demo', 'secureops-demo.db');
}

function readDemo<T>(
  workingDirectory: string,
  read: (database: ReturnType<typeof openReadOnlyLocalDatabase>) => T,
): T {
  const config = loadConfig(
    { ...environment, SECUREOPS_DB_PATH: demoPath(workingDirectory) },
    workingDirectory,
  );
  const database = openReadOnlyLocalDatabase(config);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

async function decide(
  workingDirectory: string,
  proposalId: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const selectedDatabase = demoPath(workingDirectory);
  await runReviewerInitCommand(['--db-path', selectedDatabase], environment, workingDirectory, {
    isInteractive: () => true,
    askUsername: async () => 'demo_reviewer',
    askPassphrase: async () => passphrase,
  });
  const result = await runProposalReviewCommand(
    { databasePath: selectedDatabase, proposalId },
    environment,
    workingDirectory,
    {
      isInteractive: () => true,
      write: () => undefined,
      chooseDecision: async () => decision,
      askReason: async () => 'Independent decision for a fictional local demo.',
      confirmDecision: async () => true,
      authRuntime: {
        isInteractive: () => true,
        askUsername: async () => 'demo_reviewer',
        askPassphrase: async () => passphrase,
        delay: async () => undefined,
      },
    },
  );
  expect(result).toContain(`Recorded ${decision} decision`);
}

describe('disposable local demonstration runner', () => {
  it('sets up a zero-key pending request and pauses without enrollment or execution', async () => {
    await withTestDatabase(async (unrelatedDatabase) => {
      const workingDirectory = path.dirname(unrelatedDatabase.name);
      const options = { environment, workingDirectory };
      const output = runDemoCommand([], options);
      const pendingId = readDemo(
        workingDirectory,
        (database) => new SqliteProposalRepository(database).list()[0]?.id,
      );
      expect(pendingId).toMatch(/^proposal-/);
      expect(output).toContain(`Pending proposal: ${pendingId}`);
      expect(output).toContain('npm run build');
      expect(output).toContain('reviewer:init');
      expect(output).toContain('proposals:list');
      expect(output).toContain('proposals:review');
      expect(output).toContain('Estimated monthly cost:');
      expect(output).not.toContain(passphrase);
      expect(
        readDemo(workingDirectory, (database) => ({
          resources: new SqliteResourceRepository(database).list({ limit: 100 }).length,
          status: new SqliteProposalRepository(database).getById(pendingId ?? '')?.status,
          identities: database.prepare('SELECT COUNT(*) AS count FROM local_identities').get(),
          decisions: database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get(),
          executions: database.prepare('SELECT COUNT(*) AS count FROM executions').get(),
        })),
      ).toMatchObject({
        resources: 12,
        status: 'pending_approval',
        identities: { count: 0 },
        decisions: { count: 0 },
        executions: { count: 0 },
      });
      expect(resumeDemo(pendingId ?? '', options).status).toBe('pending_approval');
      expect(unrelatedDatabase.prepare('SELECT COUNT(*) AS count FROM resources').get()).toEqual({
        count: 0,
      });
    });
  });

  it('resumes only after independent approval and returns the saved execution on retry', async () => {
    await withTestDatabase(async (unrelatedDatabase) => {
      const workingDirectory = path.dirname(unrelatedDatabase.name);
      const options = { environment, workingDirectory };
      const pending = resetAndRequestDemo(options);
      await decide(workingDirectory, pending.proposalId, 'approved');
      const first = resumeDemo(pending.proposalId, options);
      const second = resumeDemo(pending.proposalId, options);
      expect(first).toEqual(second);
      expect(first.status).toBe('executed');
      if (first.status !== 'executed') throw new Error('Expected fictional execution.');
      expect(first.auditActions).toEqual([
        'proposal_created',
        'approval_requested',
        'review_decided',
        'execution_attempted',
        'execution_result',
      ]);
      expect(runDemoCommand(['resume', '--proposal-id', pending.proposalId], options)).toContain(
        first.executionId,
      );
      expect(
        readDemo(workingDirectory, (database) => ({
          executions: database.prepare('SELECT COUNT(*) AS count FROM executions').get(),
          events: database.prepare('SELECT COUNT(*) AS count FROM audit_events').get(),
        })),
      ).toEqual({ executions: { count: 1 }, events: { count: 5 } });
    });
  });

  it('keeps rejection read-only and confines a repeated setup reset to the demo database', async () => {
    await withTestDatabase(async (unrelatedDatabase) => {
      const workingDirectory = path.dirname(unrelatedDatabase.name);
      const options = { environment, workingDirectory };
      const sentinel = path.join(workingDirectory, 'keep.txt');
      writeFileSync(sentinel, 'keep');
      const first = resetAndRequestDemo(options);
      await decide(workingDirectory, first.proposalId, 'rejected');
      expect(resumeDemo(first.proposalId, options).status).toBe('rejected');
      expect(
        readDemo(workingDirectory, (database) =>
          database.prepare('SELECT COUNT(*) AS count FROM executions').get(),
        ),
      ).toEqual({ count: 0 });

      const second = resetAndRequestDemo(options);
      expect(second.proposalId).not.toBe(first.proposalId);
      expect(
        readDemo(workingDirectory, (database) => ({
          proposals: new SqliteProposalRepository(database).list().map((proposal) => proposal.id),
          identities: database.prepare('SELECT COUNT(*) AS count FROM local_identities').get(),
        })),
      ).toEqual({ proposals: [second.proposalId], identities: { count: 0 } });
      expect(existsSync(sentinel)).toBe(true);
      expect(unrelatedDatabase.prepare('SELECT COUNT(*) AS count FROM resources').get()).toEqual({
        count: 0,
      });
    });
  });
});
