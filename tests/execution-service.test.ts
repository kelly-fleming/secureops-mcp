import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../src/application/approval-request-service.js';
import { ExecutionService } from '../src/application/execution-service.js';
import { ProposalService } from '../src/application/proposal-service.js';
import { ReviewService } from '../src/application/review-service.js';
import { loadConfig } from '../src/config.js';
import type { ChangeAction } from '../src/domain/change.js';
import {
  ConflictError,
  ForbiddenError,
  PreconditionError,
  ValidationError,
} from '../src/domain/errors.js';
import { openConfiguredDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';
import { SqliteExecutionRepository } from '../src/infra/sqlite/execution-repository.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor, type ActorContext } from '../src/security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { buildProposalRequest } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const requestedAt = '2026-01-01T01:00:00.000Z';
const decidedAt = '2026-01-01T02:00:00.000Z';
const executedAt = '2026-01-01T03:00:00.000Z';
const passphrase = 'fictional-execution-reviewer-passphrase';
const executionKey = 'execution-key-000001';

function agentActor(): ActorContext {
  return createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
}

async function reviewerActor(database: SqliteConnection): Promise<ActorContext> {
  const verifier = await derivePasswordVerifier(passphrase);
  try {
    database
      .prepare(
        `
      INSERT INTO local_identities (
        id, username, role, disabled, password_kdf, password_salt,
        password_verifier, scrypt_cost, scrypt_block_size,
        scrypt_parallelization, created_at, updated_at
      ) VALUES (?, ?, 'reviewer', 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        'identity-execution-reviewer',
        'execution_reviewer',
        verifier.passwordKdf,
        verifier.passwordSalt,
        verifier.passwordVerifier,
        verifier.scryptCost,
        verifier.scryptBlockSize,
        verifier.scryptParallelization,
        requestedAt,
        requestedAt,
      );
  } finally {
    verifier.passwordSalt.fill(0);
    verifier.passwordVerifier.fill(0);
  }
  const runtime: ReviewerAuthRuntime = {
    isInteractive: () => true,
    askUsername: async () => 'execution_reviewer',
    askPassphrase: async () => passphrase,
    delay: async () => undefined,
  };
  return authenticateCliActor(database, 'reviewer', runtime);
}

function pendingProposal(
  database: SqliteConnection,
  action: ChangeAction = { type: 'disable_compute' },
): string {
  const request = buildProposalRequest();
  const proposalId = new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(agentActor(), {
    resourceId: request.resourceId,
    action,
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
  }).proposalId;
  new ApprovalRequestService(database, createFixedClock(requestedAt)).requestApproval(
    agentActor(),
    { proposalId, justification: 'Independent review for this fictional change.' },
  );
  return proposalId;
}

async function approvedProposal(
  database: SqliteConnection,
  action: ChangeAction = { type: 'disable_compute' },
): Promise<string> {
  const proposalId = pendingProposal(database, action);
  const reviewer = await reviewerActor(database);
  new ReviewService(database, createFixedClock(decidedAt), createSequentialIdGenerator()).review(
    reviewer,
    {
      proposalId,
      decision: 'approved',
      reason: 'Approved this fictional local change.',
    },
  );
  return proposalId;
}

function executionService(database: SqliteConnection): ExecutionService {
  return new ExecutionService(
    database,
    createFixedClock(executedAt),
    createSequentialIdGenerator(),
  );
}

function count(database: SqliteConnection, table: 'executions' | 'audit_events'): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

describe('simulated execution', () => {
  it('refuses claimed approval and a forged approved status without a reviewer decision', async () => {
    await withTestDatabase(
      (database) => {
        const proposalId = pendingProposal(database);
        const service = executionService(database);
        const actor = agentActor();
        const resources = new SqliteResourceRepository(database);
        const before = resources.getById(buildProposalRequest().resourceId);
        if (before === null) throw new Error('Missing fictional compute resource.');
        const auditBefore = count(database, 'audit_events');
        const input = { proposalId, idempotencyKey: executionKey };

        expect(() =>
          service.executeChange(actor, {
            ...input,
            decision: 'approved',
            reviewerId: 'identity-claimed-reviewer',
          }),
        ).toThrow(ValidationError);
        expect(() => service.executeChange(actor, input)).toThrow(PreconditionError);

        // Test-only storage tampering bypasses the normal authenticated review transition.
        database.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").run(proposalId);
        expect(() => service.executeChange(actor, input)).toThrow(PreconditionError);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        expect(database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get()).toEqual({
          count: 0,
        });
        expect(count(database, 'executions')).toBe(0);
        expect(count(database, 'audit_events')).toBe(auditBefore);
        expect(resources.getById(buildProposalRequest().resourceId)).toEqual(before);
      },
      { seed: true },
    );
  });

  it.each([
    { name: 'disable', action: { type: 'disable_compute' } as const, expectedCost: 0 },
    {
      name: 'resize',
      action: { type: 'resize_compute', targetSize: 'demo-medium' } as const,
      expectedCost: 10_000,
    },
  ])(
    'applies an approved $name once and returns the saved result',
    async ({ action, expectedCost }) => {
      await withTestDatabase(
        async (database) => {
          const proposalId = await approvedProposal(database, action);
          const before = new SqliteResourceRepository(database).getById(
            buildProposalRequest().resourceId,
          );
          if (before === null) throw new Error('Missing fictional resource.');
          const otherResources = new SqliteResourceRepository(database)
            .list({ limit: 100 })
            .filter((resource) => resource.id !== before.id);
          const auditCountBefore = count(database, 'audit_events');

          const result = executionService(database).executeChange(agentActor(), {
            proposalId,
            idempotencyKey: executionKey,
          });

          expect(result.status).toBe('executed');
          expect(result.proposalId).toBe(proposalId);
          expect(result.resourceId).toBe(before.id);
          expect(result.resourceVersion).toBe(before.version + 1);
          expect(result.executionId).toBe('execution-000001');
          expect(result.auditEventId).toBe('event-000003');
          expect(result.result.before).toEqual(before);
          expect(result.result.after.monthlyCostEstimateCents).toBe(expectedCost);
          expect(result.result.after.version).toBe(before.version + 1);
          expect(result.simulationNotice).toContain('Fictional demo data');
          expect(Object.isFrozen(result.result.after.tags)).toBe(true);
          expect(new SqliteResourceRepository(database).getById(before.id)).toEqual(
            result.result.after,
          );
          expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
            'executed',
          );
          expect(
            new SqliteExecutionRepository(database).getByProposalId(proposalId)?.result.preview,
          ).toEqual(result.result);
          expect(count(database, 'executions')).toBe(1);
          expect(count(database, 'audit_events')).toBe(auditCountBefore + 2);
          expect(
            database
              .prepare(
                `
        SELECT action FROM audit_events WHERE subject_id = ? ORDER BY sequence DESC LIMIT 2
      `,
              )
              .all(proposalId),
          ).toEqual([{ action: 'execution_result' }, { action: 'execution_attempted' }]);
          expect(
            new SqliteResourceRepository(database)
              .list({ limit: 100 })
              .filter((resource) => resource.id !== before.id),
          ).toEqual(otherResources);
        },
        { seed: true },
      );
    },
  );

  it('returns the original execution for an exact retry without new writes', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await approvedProposal(database);
        const service = executionService(database);
        const actor = agentActor();
        const input = { proposalId, idempotencyKey: executionKey };
        const first = service.executeChange(actor, input);
        const resourceAfter = new SqliteResourceRepository(database).getById(first.resourceId);
        const auditCount = count(database, 'audit_events');

        expect(service.executeChange(actor, input)).toEqual(first);
        expect(count(database, 'executions')).toBe(1);
        expect(count(database, 'audit_events')).toBe(auditCount);
        expect(new SqliteResourceRepository(database).getById(first.resourceId)).toEqual(
          resourceAfter,
        );
        expect(() =>
          service.executeChange(actor, {
            proposalId,
            idempotencyKey: 'execution-key-conflict',
          }),
        ).toThrow(ConflictError);
        expect(() =>
          service.executeChange(actor, {
            proposalId: 'proposal-other-001',
            idempotencyKey: executionKey,
          }),
        ).toThrow(ConflictError);
        expect(() => service.executeChange({ ...actor }, input)).toThrow(ForbiddenError);
      },
      { seed: true },
    );
  });

  it('rolls back resource, execution, proposal, and audit writes when insert fails', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await approvedProposal(database);
        const before = new SqliteResourceRepository(database).getById(
          buildProposalRequest().resourceId,
        );
        const auditCount = count(database, 'audit_events');
        database.exec(`
        CREATE TRIGGER reject_execution BEFORE INSERT ON executions
        BEGIN SELECT RAISE(ABORT, 'synthetic execution failure'); END
      `);

        expect(() =>
          executionService(database).executeChange(agentActor(), {
            proposalId,
            idempotencyKey: executionKey,
          }),
        ).toThrow();
        expect(
          new SqliteResourceRepository(database).getById(buildProposalRequest().resourceId),
        ).toEqual(before);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        expect(count(database, 'executions')).toBe(0);
        expect(count(database, 'audit_events')).toBe(auditCount);
      },
      { seed: true },
    );
  });

  it('allows one execution across two serial calls on separate connections', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await approvedProposal(database);
        const mainPath = (
          database.pragma('database_list') as Array<{ name: string; file: string }>
        ).find((entry) => entry.name === 'main')?.file;
        if (mainPath === undefined) throw new Error('Missing private test database path.');
        const secondDatabase = openConfiguredDatabase(
          loadConfig(
            {
              SECUREOPS_MODE: 'local-full',
              SECUREOPS_DB_PATH: mainPath,
            },
            process.cwd(),
          ),
        );
        try {
          const actor = agentActor();
          const first = executionService(database);
          const second = executionService(secondDatabase);
          // better-sqlite3 is synchronous: these callbacks do not overlap their write locks.
          const outcomes = await Promise.allSettled([
            Promise.resolve().then(() =>
              first.executeChange(actor, {
                proposalId,
                idempotencyKey: 'execution-key-first',
              }),
            ),
            Promise.resolve().then(() =>
              second.executeChange(actor, {
                proposalId,
                idempotencyKey: 'execution-key-second',
              }),
            ),
          ]);
          expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
          expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
          expect(count(database, 'executions')).toBe(1);
          expect(
            new SqliteResourceRepository(database).getById(buildProposalRequest().resourceId)
              ?.version,
          ).toBe(2);
        } finally {
          secondDatabase.close();
        }
      },
      { seed: true },
    );
  });
});
