import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../src/application/approval-request-service.js';
import { AuditService } from '../src/application/audit-service.js';
import { ProposalService } from '../src/application/proposal-service.js';
import { ReviewService } from '../src/application/review-service.js';
import { loadConfig } from '../src/config.js';
import { PreconditionError, ValidationError } from '../src/domain/errors.js';
import {
  computeAuditEventHash,
  type AuditEventRecord,
} from '../src/infra/sqlite/audit-repository.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor, type ActorContext } from '../src/security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { buildProposalRequest } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const passphrase = 'fictional-secret-reviewer-passphrase';
const proposalReason = 'Private synthetic proposal reason for a local demo.';
const approvalJustification = 'Private synthetic approval justification for a local demo.';
const reviewReason = 'Private synthetic review note for a local demo.';

function agentActor(): ActorContext {
  return createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
}

function createDraft(database: SqliteConnection, actor: ActorContext): string {
  const request = buildProposalRequest();
  return new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(actor, {
    resourceId: request.resourceId,
    action: { type: 'disable_compute' },
    reason: proposalReason,
    idempotencyKey: request.idempotencyKey,
  }).proposalId;
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
        'identity-audit-reviewer',
        'audit_reviewer',
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
  const runtime: ReviewerAuthRuntime = {
    isInteractive: () => true,
    askUsername: async () => 'audit_reviewer',
    askPassphrase: async () => passphrase,
    delay: async () => undefined,
  };
  return authenticateCliActor(database, 'reviewer', runtime);
}

function auditRows(database: SqliteConnection): AuditEventRecord[] {
  const rows = database
    .prepare(
      `
    SELECT sequence, id, actor_type, actor_id, action, subject_type, subject_id,
      event_json, occurred_at, previous_hash, event_hash
    FROM audit_events ORDER BY sequence
  `,
    )
    .all() as Array<{
    sequence: number;
    id: string;
    actor_type: AuditEventRecord['actorType'];
    actor_id: string;
    action: string;
    subject_type: AuditEventRecord['subjectType'];
    subject_id: string;
    event_json: string;
    occurred_at: string;
    previous_hash: string | null;
    event_hash: string;
  }>;
  return rows.map((row) => ({
    sequence: row.sequence,
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    eventJson: row.event_json,
    occurredAt: row.occurred_at,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
  }));
}

describe('application audit events', () => {
  it('orders correlated workflow events and excludes free text and secrets', async () => {
    await withTestDatabase(
      async (database) => {
        const agent = agentActor();
        const proposalId = createDraft(database, agent);
        new ApprovalRequestService(
          database,
          createFixedClock('2026-01-01T01:00:00.000Z'),
        ).requestApproval(agent, { proposalId, justification: approvalJustification });
        const reviewer = await reviewerActor(database);
        const decision = new ReviewService(
          database,
          createFixedClock('2026-01-01T02:00:00.000Z'),
          createSequentialIdGenerator(),
        ).review(reviewer, { proposalId, decision: 'approved', reason: reviewReason });

        const events = auditRows(database);
        expect(events.map((event) => event.action)).toEqual([
          'proposal_created',
          'approval_requested',
          'review_decided',
        ]);
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
        expect(events.every((event) => event.subjectId === proposalId)).toBe(true);
        expect(events[0]?.actorId).toBe(agent.actorId);
        expect(events[2]?.actorId).toBe(reviewer.actorId);
        expect(events[1]?.previousHash).toBe(events[0]?.eventHash);
        expect(events[2]?.previousHash).toBe(events[1]?.eventHash);
        expect(events[2]?.eventJson).toContain(decision.decisionId);
        for (const event of events) {
          expect(computeAuditEventHash(event)).toBe(event.eventHash);
          for (const secret of [passphrase, proposalReason, approvalJustification, reviewReason]) {
            expect(event.eventJson).not.toContain(secret);
          }
        }
      },
      { seed: true },
    );
  });

  it('does not append another creation event for an exact proposal replay', async () => {
    await withTestDatabase(
      (database) => {
        const agent = agentActor();
        const request = buildProposalRequest();
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const input = {
          resourceId: request.resourceId,
          action: { type: 'disable_compute' as const },
          reason: proposalReason,
          idempotencyKey: request.idempotencyKey,
        };
        const first = service.proposeChange(agent, input);
        expect(service.proposeChange(agent, input)).toEqual(first);
        expect(auditRows(database)).toHaveLength(1);
      },
      { seed: true },
    );
  });

  it('rolls back a proposal when its audit append fails', async () => {
    await withTestDatabase(
      (database) => {
        database.exec(`
        CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events
        BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END
      `);
        expect(() => createDraft(database, agentActor())).toThrow();
        expect(database.prepare('SELECT count(*) AS total FROM proposals').get()).toEqual({
          total: 0,
        });
        expect(auditRows(database)).toEqual([]);
      },
      { seed: true },
    );
  });

  it('requires a transaction and rejects arbitrary execution payload fields', async () => {
    await withTestDatabase(
      (database) => {
        const audit = new AuditService(database, createFixedClock(), createSequentialIdGenerator());
        const agent = agentActor();
        const input = {
          proposalId: 'proposal-audit-001',
          resourceId: 'res-aws-ec2-01',
          resourceVersion: 1,
          policyVersion: 'demo-v1',
          actionType: 'disable_compute',
        };
        expect(() => audit.recordExecutionAttempt(agent, input)).toThrow(PreconditionError);
        expect(() =>
          database
            .transaction(() =>
              audit.recordExecutionResult(agent, {
                ...input,
                outcome: 'internal_failure',
                error: passphrase,
              }),
            )
            .immediate(),
        ).toThrow(ValidationError);
        expect(() =>
          database
            .transaction(() =>
              audit.recordExecutionResult(agent, {
                ...input,
                outcome: 'executed',
              }),
            )
            .immediate(),
        ).toThrow(ValidationError);
        database
          .transaction(() => {
            audit.recordExecutionAttempt(agent, input);
            audit.recordExecutionResult(agent, {
              ...input,
              outcome: 'executed',
              executionId: 'execution-audit-001',
            });
          })
          .immediate();
        expect(auditRows(database).map((event) => event.action)).toEqual([
          'execution_attempted',
          'execution_result',
        ]);
      },
      { seed: true },
    );
  });

  it('makes a changed predecessor link visible to chain verification', async () => {
    await withTestDatabase(
      (database) => {
        const audit = new AuditService(database, createFixedClock(), createSequentialIdGenerator());
        const agent = agentActor();
        const input = {
          proposalId: 'proposal-audit-001',
          resourceId: 'res-aws-ec2-01',
          resourceVersion: 1,
          policyVersion: 'demo-v1',
          actionType: 'disable_compute',
        };
        database
          .transaction(() => {
            audit.recordExecutionAttempt(agent, input);
            audit.recordExecutionResult(agent, { ...input, outcome: 'conflict' });
          })
          .immediate();
        const before = auditRows(database);
        expect(before[1]?.previousHash).toBe(before[0]?.eventHash);
        const alteredHash =
          before[0]?.eventHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
        database
          .prepare('UPDATE audit_events SET previous_hash = ? WHERE sequence = 2')
          .run(alteredHash);
        const after = auditRows(database);
        expect(after[1]?.previousHash).not.toBe(after[0]?.eventHash);
        if (after[1] === undefined) throw new Error('Missing synthetic audit event.');
        expect(computeAuditEventHash(after[1])).not.toBe(after[1].eventHash);
      },
      { seed: true },
    );
  });
});
