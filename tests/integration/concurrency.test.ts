import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../../src/application/approval-request-service.js';
import { ProposalService } from '../../src/application/proposal-service.js';
import { ReviewService } from '../../src/application/review-service.js';
import { loadConfig } from '../../src/config.js';
import type { SqliteConnection } from '../../src/infra/sqlite/connection.js';
import { SqliteDecisionRepository } from '../../src/infra/sqlite/decision-repository.js';
import { SqliteExecutionRepository } from '../../src/infra/sqlite/execution-repository.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { executeChangeOutputSchema, proposeChangeOutputSchema } from '../../src/mcp/schemas.js';
import { derivePasswordVerifier } from '../../src/security/password.js';
import { createMcpActor } from '../../src/security/permissions.js';
import { authenticateCliActor } from '../../src/security/reviewer-auth.js';
import { buildProposalRequest } from '../helpers/builders.js';
import { withContentionWorkers, type WorkOutcome } from '../helpers/contention.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

const resourceId = buildProposalRequest().resourceId;
const passphrase = 'fictional-contention-reviewer-secret';

function agent(database: SqliteConnection) {
  return createMcpActor(
    loadConfig({ SECUREOPS_MODE: 'local-full', SECUREOPS_DB_PATH: database.name }, process.cwd()),
  );
}

async function enrollReviewer(database: SqliteConnection, suffix: string): Promise<void> {
  const verifier = await derivePasswordVerifier(passphrase);
  try {
    database
      .prepare(
        `
      INSERT INTO local_identities (
        id, username, role, disabled, password_kdf, password_salt,
        password_verifier, scrypt_cost, scrypt_block_size, scrypt_parallelization,
        created_at, updated_at
      ) VALUES (?, ?, 'reviewer', 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        `identity-contention-${suffix}`,
        `contention_${suffix}`,
        verifier.passwordKdf,
        verifier.passwordSalt,
        verifier.passwordVerifier,
        verifier.scryptCost,
        verifier.scryptBlockSize,
        verifier.scryptParallelization,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
  } finally {
    verifier.passwordSalt.fill(0);
    verifier.passwordVerifier.fill(0);
  }
}

function draftInput(
  key: string,
  action: { type: 'disable_compute' } | { type: 'resize_compute'; targetSize: 'demo-medium' } = {
    type: 'disable_compute',
  },
) {
  return {
    resourceId,
    action,
    reason: 'Fictional contention request.',
    idempotencyKey: key,
  } as const;
}

function pendingProposal(
  database: SqliteConnection,
  key = 'contention-draft-000001',
  action: ReturnType<typeof draftInput>['action'] = { type: 'disable_compute' },
): string {
  const actor = agent(database);
  const draft = new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(actor, draftInput(key, action));
  new ApprovalRequestService(
    database,
    createFixedClock('2026-01-01T01:00:00.000Z'),
  ).requestApproval(actor, {
    proposalId: draft.proposalId,
    justification: 'Independent fictional review.',
  });
  return draft.proposalId;
}

async function approvedProposal(database: SqliteConnection): Promise<string> {
  const proposalId = pendingProposal(database);
  await enrollReviewer(database, 'first');
  const reviewer = await authenticateCliActor(database, 'reviewer', {
    isInteractive: () => true,
    askUsername: async () => 'contention_first',
    askPassphrase: async () => passphrase,
    delay: async () => undefined,
  });
  new ReviewService(
    database,
    createFixedClock('2026-01-01T02:00:00.000Z'),
    createSequentialIdGenerator(),
  ).review(reviewer, {
    proposalId,
    decision: 'approved',
    reason: 'Fictional change approved.',
  });
  return proposalId;
}

function completed(outcome: WorkOutcome): Record<string, unknown> {
  expect(outcome.status).toBe('completed');
  if (
    outcome.status !== 'completed' ||
    typeof outcome.result !== 'object' ||
    outcome.result === null
  ) {
    throw new Error('Expected completed contention work.');
  }
  return outcome.result as Record<string, unknown>;
}

describe('independent SQLite writers', () => {
  it('bounds a real lock timeout, then lets a writer acquire after release', async () => {
    await withTestDatabase(
      async (database) => {
        await withContentionWorkers(database, 2, async ([holder, contender]) => {
          if (!holder || !contender) throw new Error('Missing contention workers.');
          await holder.holdLock();
          const timedOut = contender.attemptLock();
          await timedOut.started;
          expect(await timedOut.result).toBe('busy');
          const waiting = contender.attemptLock();
          await waiting.started;
          await holder.releaseLock();
          expect(await waiting.result).toBe('acquired');
          const recovered = contender.attemptLock();
          await recovered.started;
          expect(await recovered.result).toBe('acquired');
        });
      },
      { seed: true },
    );
  }, 20_000);

  it('allows one of two independently authenticated reviewers to decide', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = pendingProposal(database);
        await enrollReviewer(database, 'first');
        await enrollReviewer(database, 'second');
        await withContentionWorkers(database, 3, async ([holder, first, second]) => {
          if (!holder || !first || !second) throw new Error('Missing contention workers.');
          await holder.holdLock();
          const review = (username: string) => ({
            username,
            passphrase,
            proposalId,
            decision: 'approved' as const,
            reason: 'Independent fictional decision.',
          });
          const one = first.run('review', review('contention_first'), 101);
          const two = second.run('review', review('contention_second'), 201);
          await Promise.all([one.started, two.started]);
          await holder.releaseLock();
          const outcomes = await Promise.all([one.result, two.result]);
          expect(outcomes.filter((outcome) => outcome.status === 'completed')).toHaveLength(1);
          expect(outcomes.filter((outcome) => outcome.status === 'refused')).toEqual([
            { status: 'refused', errorCode: 'CONFLICT' },
          ]);
        });
        const decision = new SqliteDecisionRepository(database).getByProposalId(proposalId);
        expect(decision?.decision).toBe('approved');
        expect(['identity-contention-first', 'identity-contention-second']).toContain(
          decision?.reviewerId,
        );
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        expect(database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get()).toEqual({
          count: 1,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 3,
        });
      },
      { seed: true },
    );
  });

  it.each([
    ['resource', { type: 'disable_compute' } as const, 'CONFLICT'],
    [
      'policy',
      { type: 'resize_compute', targetSize: 'demo-medium' } as const,
      'PRECONDITION_FAILED',
    ],
  ] as const)(
    'rechecks current %s before an approval commits',
    async (change, action, errorCode) => {
      await withTestDatabase(
        async (database) => {
          const proposalId = pendingProposal(database, `contention-${change}-draft`, action);
          await enrollReviewer(database, 'first');
          await withContentionWorkers(database, 2, async ([holder, reviewer]) => {
            if (!holder || !reviewer) throw new Error('Missing contention workers.');
            await holder.holdLock();
            const decision = reviewer.run(
              'review',
              {
                username: 'contention_first',
                passphrase,
                proposalId,
                decision: 'approved',
                reason: 'Fictional contention review.',
                denyCurrentPolicy: change === 'policy',
              },
              101,
            );
            await decision.started;
            if (change === 'resource') {
              await holder.advanceResource(resourceId);
              await holder.commitLock();
            } else {
              await holder.releaseLock();
            }
            expect(await decision.result).toEqual({ status: 'refused', errorCode });
          });
          expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
            'pending_approval',
          );
          expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)).toBeNull();
          expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
            count: 2,
          });
        },
        { seed: true },
      );
    },
  );

  it('preserves distinct draft identities and versions, then refuses a stale exact retry', async () => {
    await withTestDatabase(
      async (database) => {
        const before = new SqliteResourceRepository(database).getById(resourceId);
        if (before === null) throw new Error('Missing fictional resource.');
        let firstId = '';
        let secondId = '';
        await withContentionWorkers(database, 3, async ([holder, first, second]) => {
          if (!holder || !first || !second) throw new Error('Missing contention workers.');
          await holder.holdLock();
          const one = first.run('propose', draftInput('contention-key-first'), 101);
          const two = second.run('propose', draftInput('contention-key-second'), 201);
          await Promise.all([one.started, two.started]);
          await holder.releaseLock();
          const [firstResult, secondResult] = await Promise.all([one.result, two.result]);
          firstId = proposeChangeOutputSchema.parse(completed(firstResult)).proposalId;
          secondId = proposeChangeOutputSchema.parse(completed(secondResult)).proposalId;
          expect(firstId).not.toBe(secondId);
          const replay = first.run('propose', draftInput('contention-key-first'), 301);
          await replay.started;
          expect(proposeChangeOutputSchema.parse(completed(await replay.result)).proposalId).toBe(
            firstId,
          );
          await holder.holdLock();
          await holder.advanceResource(resourceId);
          await holder.commitLock();
          const stale = first.run('propose', draftInput('contention-key-first'), 401);
          await stale.started;
          expect(await stale.result).toEqual({ status: 'refused', errorCode: 'CONFLICT' });
        });
        const proposals = new SqliteProposalRepository(database);
        expect(proposals.getById(firstId)?.expectedResourceVersion).toBe(before.version);
        expect(proposals.getById(secondId)?.expectedResourceVersion).toBe(before.version);
        expect(proposals.list()).toHaveLength(2);
        expect(new SqliteResourceRepository(database).getById(resourceId)?.version).toBe(
          before.version + 1,
        );
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 2,
        });
      },
      { seed: true },
    );
  });

  it.each([
    ['same', 'contention-execution-key', 'contention-execution-key'],
    ['different', 'contention-execution-first', 'contention-execution-second'],
  ] as const)(
    'serializes %s execution keys and saves only one change',
    async (_label, firstKey, secondKey) => {
      await withTestDatabase(
        async (database) => {
          const proposalId = await approvedProposal(database);
          const before = new SqliteResourceRepository(database).getById(resourceId);
          if (before === null) throw new Error('Missing fictional resource.');
          await withContentionWorkers(database, 3, async ([holder, first, second]) => {
            if (!holder || !first || !second) throw new Error('Missing contention workers.');
            await holder.holdLock();
            const one = first.run('execute', { proposalId, idempotencyKey: firstKey }, 101);
            const two = second.run('execute', { proposalId, idempotencyKey: secondKey }, 201);
            await Promise.all([one.started, two.started]);
            await holder.releaseLock();
            const [firstResult, secondResult] = await Promise.all([one.result, two.result]);
            if (firstKey === secondKey) {
              const saved = executeChangeOutputSchema.parse(completed(firstResult));
              expect(executeChangeOutputSchema.parse(completed(secondResult))).toEqual(saved);
              const replay = first.run('execute', { proposalId, idempotencyKey: firstKey }, 301);
              await replay.started;
              expect(executeChangeOutputSchema.parse(completed(await replay.result))).toEqual(
                saved,
              );
            } else {
              expect(
                [firstResult, secondResult].filter((outcome) => outcome.status === 'completed'),
              ).toHaveLength(1);
              expect(
                [firstResult, secondResult].filter((outcome) => outcome.status === 'refused'),
              ).toEqual([{ status: 'refused', errorCode: 'CONFLICT' }]);
            }
          });
          expect(new SqliteResourceRepository(database).getById(resourceId)?.version).toBe(
            before.version + 1,
          );
          expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
            'executed',
          );
          expect(
            new SqliteExecutionRepository(database).getByProposalId(proposalId),
          ).not.toBeNull();
          expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
            count: 1,
          });
          expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
            count: 5,
          });
        },
        { seed: true },
      );
    },
  );
});
