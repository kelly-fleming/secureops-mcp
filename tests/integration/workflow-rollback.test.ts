import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../../src/application/approval-request-service.js';
import { AuditVerificationService } from '../../src/application/audit-verification-service.js';
import { ExecutionService } from '../../src/application/execution-service.js';
import { ProposalService } from '../../src/application/proposal-service.js';
import { ReviewService } from '../../src/application/review-service.js';
import { loadConfig } from '../../src/config.js';
import { publicErrorFor, type OperationalErrorCode } from '../../src/domain/errors.js';
import type { SqliteConnection } from '../../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { derivePasswordVerifier } from '../../src/security/password.js';
import { createMcpActor, type ActorContext } from '../../src/security/permissions.js';
import { authenticateCliActor } from '../../src/security/reviewer-auth.js';
import { buildProposalRequest } from '../helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

const draftAt = '2026-01-01T00:00:00.000Z';
const requestedAt = '2026-01-01T01:00:00.000Z';
const decidedAt = '2026-01-01T02:00:00.000Z';
const executedAt = '2026-01-01T03:00:00.000Z';
const reviewerPassphrase = 'fictional-rollback-reviewer-passphrase';
const reviewerName = 'rollback_reviewer';

function agent(database: SqliteConnection): ActorContext {
  return createMcpActor(
    loadConfig({ SECUREOPS_MODE: 'local-full', SECUREOPS_DB_PATH: database.name }, process.cwd()),
  );
}

async function reviewer(database: SqliteConnection): Promise<ActorContext> {
  const verifier = await derivePasswordVerifier(reviewerPassphrase);
  try {
    database
      .prepare(
        `INSERT INTO local_identities (
          id, username, role, disabled, password_kdf, password_salt,
          password_verifier, scrypt_cost, scrypt_block_size,
          scrypt_parallelization, created_at, updated_at
        ) VALUES (?, ?, 'reviewer', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'identity-rollback-reviewer',
        reviewerName,
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
  return authenticateCliActor(database, 'reviewer', {
    isInteractive: () => true,
    askUsername: async () => reviewerName,
    askPassphrase: async () => reviewerPassphrase,
    delay: async () => undefined,
  });
}

function createDraft(database: SqliteConnection): string {
  const fixture = buildProposalRequest();
  return new ProposalService(
    database,
    createFixedClock(draftAt),
    createSequentialIdGenerator(),
  ).proposeChange(agent(database), {
    resourceId: fixture.resourceId,
    action: { type: 'disable_compute' },
    reason: fixture.reason,
    idempotencyKey: fixture.idempotencyKey,
  }).proposalId;
}

function requestApproval(database: SqliteConnection, proposalId: string): void {
  new ApprovalRequestService(database, createFixedClock(requestedAt)).requestApproval(
    agent(database),
    { proposalId, justification: 'Independent fictional review requested.' },
  );
}

function approve(database: SqliteConnection, actor: ActorContext, proposalId: string): void {
  new ReviewService(database, createFixedClock(decidedAt), createSequentialIdGenerator()).review(
    actor,
    {
      proposalId,
      decision: 'approved',
      reason: 'Approved this fictional resource change.',
    },
  );
}

function workflowSnapshot(database: SqliteConnection, actor: ActorContext, proposalId: string) {
  const resourceId = buildProposalRequest().resourceId;
  const count = (table: 'approval_decisions' | 'executions' | 'audit_events'): number => {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
      total: number;
    };
    return row.total;
  };
  return {
    resource: new SqliteResourceRepository(database).getById(resourceId),
    proposal: new SqliteProposalRepository(database).getById(proposalId),
    decisions: count('approval_decisions'),
    executions: count('executions'),
    auditCount: count('audit_events'),
    auditHead: database
      .prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
      .get(),
    auditVerification: new AuditVerificationService(database).verify(actor),
  };
}

function expectSafeRefusal(operation: () => unknown, code: OperationalErrorCode): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(publicErrorFor(failure)).toEqual({
    code,
    message:
      code === 'CONFLICT' ? 'Request conflicts with current state.' : 'An internal error occurred.',
  });
}

const reviewFailures = [
  {
    stage: 'decision insertion',
    sql: `CREATE TRIGGER reject_review_decision BEFORE INSERT ON approval_decisions
      BEGIN SELECT RAISE(ABORT, 'synthetic decision failure'); END;`,
    publicCode: 'CONFLICT',
  },
  {
    stage: 'proposal status transition',
    sql: `CREATE TRIGGER reject_review_status BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'approved'
      BEGIN SELECT RAISE(ABORT, 'synthetic review status failure'); END;`,
    publicCode: 'INTERNAL_ERROR',
  },
  {
    stage: 'audit append',
    sql: `CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'review_decided'
      BEGIN SELECT RAISE(ABORT, 'synthetic review audit failure'); END;`,
    publicCode: 'CONFLICT',
  },
] as const;

const executionFailures = [
  {
    stage: 'attempt audit append',
    sql: `CREATE TRIGGER reject_execution_attempt BEFORE INSERT ON audit_events
      WHEN NEW.action = 'execution_attempted'
      BEGIN SELECT RAISE(ABORT, 'synthetic execution attempt failure'); END;`,
    publicCode: 'CONFLICT',
  },
  {
    stage: 'resource update',
    sql: `CREATE TRIGGER reject_execution_resource BEFORE UPDATE OF version ON resources
      WHEN NEW.version > OLD.version
      BEGIN SELECT RAISE(ABORT, 'synthetic resource update failure'); END;`,
    publicCode: 'INTERNAL_ERROR',
  },
  {
    stage: 'success audit append',
    sql: `CREATE TRIGGER reject_execution_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'execution_result'
      BEGIN SELECT RAISE(ABORT, 'synthetic execution audit failure'); END;`,
    publicCode: 'CONFLICT',
  },
  {
    stage: 'execution insertion',
    sql: `CREATE TRIGGER reject_execution_row BEFORE INSERT ON executions
      BEGIN SELECT RAISE(ABORT, 'synthetic execution row failure'); END;`,
    publicCode: 'CONFLICT',
  },
  {
    stage: 'proposal status transition',
    sql: `CREATE TRIGGER reject_execution_status BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'executed'
      BEGIN SELECT RAISE(ABORT, 'synthetic execution status failure'); END;`,
    publicCode: 'INTERNAL_ERROR',
  },
] as const;

describe('service-owned workflow rollback', () => {
  it('restores a draft when the approval audit append fails', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        const auditReader = await reviewer(database);
        const before = workflowSnapshot(database, auditReader, proposalId);
        expect(before.proposal?.status).toBe('draft');
        expect(before.auditVerification.valid).toBe(true);
        database.exec(`CREATE TRIGGER reject_approval_audit BEFORE INSERT ON audit_events
          WHEN NEW.action = 'approval_requested'
          BEGIN SELECT RAISE(ABORT, 'synthetic approval audit failure'); END;`);

        expectSafeRefusal(() => requestApproval(database, proposalId), 'CONFLICT');
        expect(database.inTransaction).toBe(false);
        expect(workflowSnapshot(database, auditReader, proposalId)).toEqual(before);
      },
      { seed: true },
    );
  });

  it.each(reviewFailures)(
    'restores pending state after $stage fails',
    async ({ sql, publicCode }) => {
      await withTestDatabase(
        async (database) => {
          const proposalId = createDraft(database);
          requestApproval(database, proposalId);
          const auditReader = await reviewer(database);
          const before = workflowSnapshot(database, auditReader, proposalId);
          expect(before.proposal?.status).toBe('pending_approval');
          expect(before.auditVerification.valid).toBe(true);
          database.exec(sql);

          expectSafeRefusal(() => approve(database, auditReader, proposalId), publicCode);
          expect(database.inTransaction).toBe(false);
          expect(workflowSnapshot(database, auditReader, proposalId)).toEqual(before);
        },
        { seed: true },
      );
    },
  );

  it.each(executionFailures)(
    'restores approved state after $stage fails',
    async ({ sql, publicCode }) => {
      await withTestDatabase(
        async (database) => {
          const proposalId = createDraft(database);
          requestApproval(database, proposalId);
          const auditReader = await reviewer(database);
          approve(database, auditReader, proposalId);
          const before = workflowSnapshot(database, auditReader, proposalId);
          expect(before.proposal?.status).toBe('approved');
          expect(before.auditVerification.valid).toBe(true);
          database.exec(sql);

          expectSafeRefusal(
            () =>
              new ExecutionService(
                database,
                createFixedClock(executedAt),
                createSequentialIdGenerator(),
              ).executeChange(agent(database), {
                proposalId,
                idempotencyKey: 'execution-rollback-key-0001',
              }),
            publicCode,
          );
          expect(database.inTransaction).toBe(false);
          expect(workflowSnapshot(database, auditReader, proposalId)).toEqual(before);
        },
        { seed: true },
      );
    },
  );
});
