import { describe, expect, it } from 'vitest';

import { AgentAuditService } from '../../src/application/agent-audit-service.js';
import { ApprovalRequestService } from '../../src/application/approval-request-service.js';
import { AuditVerificationService } from '../../src/application/audit-verification-service.js';
import { ExecutionService } from '../../src/application/execution-service.js';
import { ProposalService } from '../../src/application/proposal-service.js';
import { ResourceService } from '../../src/application/resource-service.js';
import { ReviewService } from '../../src/application/review-service.js';
import { loadConfig } from '../../src/config.js';
import { ConflictError, PreconditionError } from '../../src/domain/errors.js';
import type { SqliteConnection } from '../../src/infra/sqlite/connection.js';
import { SqliteDecisionRepository } from '../../src/infra/sqlite/decision-repository.js';
import { SqliteExecutionRepository } from '../../src/infra/sqlite/execution-repository.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { derivePasswordVerifier } from '../../src/security/password.js';
import { createMcpActor, type ActorContext } from '../../src/security/permissions.js';
import {
  authenticateCliActor,
  type ReviewerAuthRuntime,
} from '../../src/security/reviewer-auth.js';
import { buildProposalRequest } from '../helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

const draftTime = '2026-01-01T00:00:00.000Z';
const requestedTime = '2026-01-01T01:00:00.000Z';
const decidedTime = '2026-01-01T02:00:00.000Z';
const executedTime = '2026-01-01T03:00:00.000Z';
const reviewerPassphrase = 'fictional-workflow-reviewer-passphrase';
const executionKey = 'workflow-execution-000001';

function localActor(database: SqliteConnection): ActorContext {
  return createMcpActor(
    loadConfig(
      {
        SECUREOPS_MODE: 'local-full',
        SECUREOPS_DB_PATH: database.name,
      },
      process.cwd(),
    ),
  );
}

async function authenticatedReviewer(database: SqliteConnection): Promise<ActorContext> {
  const verifier = await derivePasswordVerifier(reviewerPassphrase);
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
        'identity-workflow-reviewer',
        'workflow_reviewer',
        verifier.passwordKdf,
        verifier.passwordSalt,
        verifier.passwordVerifier,
        verifier.scryptCost,
        verifier.scryptBlockSize,
        verifier.scryptParallelization,
        requestedTime,
        requestedTime,
      );
  } finally {
    verifier.passwordSalt.fill(0);
    verifier.passwordVerifier.fill(0);
  }
  const runtime: ReviewerAuthRuntime = {
    isInteractive: () => true,
    askUsername: async () => 'workflow_reviewer',
    askPassphrase: async () => reviewerPassphrase,
    delay: async () => undefined,
  };
  return authenticateCliActor(database, 'reviewer', runtime);
}

function pendingProposal(database: SqliteConnection, actor: ActorContext): string {
  const fixture = buildProposalRequest();
  const draft = new ProposalService(
    database,
    createFixedClock(draftTime),
    createSequentialIdGenerator(),
  ).proposeChange(actor, {
    resourceId: fixture.resourceId,
    action: { type: 'disable_compute' },
    reason: fixture.reason,
    idempotencyKey: fixture.idempotencyKey,
  });
  new ApprovalRequestService(database, createFixedClock(requestedTime)).requestApproval(actor, {
    proposalId: draft.proposalId,
    justification: 'Please review this fictional change independently.',
  });
  return draft.proposalId;
}

describe('local fictional proposal workflow', () => {
  it('runs a reviewed change from analysis through execution and audit verification', async () => {
    await withTestDatabase(
      async (database) => {
        const actor = localActor(database);
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const proposalFixture = buildProposalRequest();
        const originalResource = resources.getById(proposalFixture.resourceId);
        if (originalResource === null) throw new Error('Missing fictional idle compute resource.');

        const analysis = new ResourceService(resources).analyzeResource(actor, {
          resourceId: originalResource.id,
        });
        expect(analysis.observations.map((observation) => observation.code)).toContain('idle');
        expect(analysis.estimatedMonthlyCostChangeCents).toBe(0);
        expect(resources.getById(originalResource.id)).toEqual(originalResource);

        const action = { type: 'disable_compute' } as const;
        const proposalService = new ProposalService(
          database,
          createFixedClock(draftTime),
          createSequentialIdGenerator(),
        );
        const draftInput = {
          resourceId: originalResource.id,
          action,
          reason: proposalFixture.reason,
          idempotencyKey: proposalFixture.idempotencyKey,
        };
        const draft = proposalService.proposeChange(actor, draftInput);
        expect(draft.status).toBe('draft');
        expect(draft.preview.before).toEqual(originalResource);
        expect(draft.preview.after.monthlyCostEstimateCents).toBe(0);
        expect(draft.evaluation).toMatchObject({ allowed: true, approvalRequired: true });
        expect(proposals.getById(draft.proposalId)).toMatchObject({
          resourceId: originalResource.id,
          proposerActorId: actor.actorId,
          action,
          expectedResourceVersion: originalResource.version,
          status: 'draft',
        });
        expect(resources.getById(originalResource.id)).toEqual(originalResource);
        expect(proposalService.proposeChange(actor, draftInput)).toEqual(draft);
        expect(proposals.list()).toHaveLength(1);
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 1,
        });

        const justification = 'Please review the fictional idle compute change independently.';
        const approvalService = new ApprovalRequestService(
          database,
          createFixedClock(requestedTime),
        );
        const request = approvalService.requestApproval(actor, {
          proposalId: draft.proposalId,
          justification,
        });
        expect(request).toMatchObject({
          proposalId: draft.proposalId,
          status: 'pending_approval',
        });
        expect(request.reviewerInstructions).toContain('proposals:review');
        expect(request.reviewerInstructions).toContain(draft.proposalId);
        expect(request.reviewerInstructions).not.toContain(database.name);
        expect(proposals.getById(draft.proposalId)).toMatchObject({
          status: 'pending_approval',
          action,
          expectedResourceVersion: originalResource.version,
          approvalJustification: justification,
        });
        expect(resources.getById(originalResource.id)).toEqual(originalResource);
        expect(database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get()).toEqual({
          count: 0,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
          count: 0,
        });
        expect(() =>
          approvalService.requestApproval(actor, {
            proposalId: draft.proposalId,
            justification,
          }),
        ).toThrow(ConflictError);

        const audit = new AgentAuditService(database).getAuditLog(actor, {
          proposalId: draft.proposalId,
        });
        expect(audit.events.map((event) => event.action)).toEqual([
          'proposal_created',
          'approval_requested',
        ]);
        expect(audit.events.every((event) => event.subjectId === draft.proposalId)).toBe(true);
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 2,
        });
        const serializedAudit = JSON.stringify(audit);
        expect(serializedAudit).not.toContain(proposalFixture.reason);
        expect(serializedAudit).not.toContain(justification);
        expect(serializedAudit).not.toContain(database.name);

        const reviewer = await authenticatedReviewer(database);
        expect(reviewer.actorId).toBe('identity-workflow-reviewer');
        expect(reviewer.actorId).not.toBe(actor.actorId);

        const reviewReason = 'Approved this fictional idle compute change.';
        const decision = new ReviewService(
          database,
          createFixedClock(decidedTime),
          createSequentialIdGenerator(),
        ).review(reviewer, {
          proposalId: draft.proposalId,
          decision: 'approved',
          reason: reviewReason,
        });
        expect(decision).toMatchObject({
          proposalId: draft.proposalId,
          status: 'approved',
          decidedAt: decidedTime,
        });
        expect(
          new SqliteDecisionRepository(database).getByProposalId(draft.proposalId),
        ).toMatchObject({
          id: decision.decisionId,
          reviewerId: reviewer.actorId,
          decision: 'approved',
        });
        expect(proposals.getById(draft.proposalId)?.status).toBe('approved');
        expect(resources.getById(originalResource.id)).toEqual(originalResource);

        const executionService = new ExecutionService(
          database,
          createFixedClock(executedTime),
          createSequentialIdGenerator(),
        );
        const execution = executionService.executeChange(actor, {
          proposalId: draft.proposalId,
          idempotencyKey: executionKey,
        });
        expect(execution).toMatchObject({
          proposalId: draft.proposalId,
          status: 'executed',
          resourceId: originalResource.id,
          resourceVersion: originalResource.version + 1,
        });
        expect(execution.result.before).toEqual(originalResource);
        expect(execution.result.after.monthlyCostEstimateCents).toBe(0);
        expect(resources.getById(originalResource.id)).toEqual(execution.result.after);
        expect(proposals.getById(draft.proposalId)?.status).toBe('executed');
        expect(
          new SqliteExecutionRepository(database).getByProposalId(draft.proposalId),
        ).toMatchObject({
          id: execution.executionId,
          executorActorId: actor.actorId,
          result: { auditEventId: execution.auditEventId },
        });
        expect(
          executionService.executeChange(actor, {
            proposalId: draft.proposalId,
            idempotencyKey: executionKey,
          }),
        ).toEqual(execution);
        expect(() =>
          executionService.executeChange(actor, {
            proposalId: draft.proposalId,
            idempotencyKey: 'workflow-execution-other-key',
          }),
        ).toThrow(ConflictError);
        expect(resources.getById(originalResource.id)).toEqual(execution.result.after);
        expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
          count: 1,
        });

        const finalAudit = new AgentAuditService(database).getAuditLog(actor, {
          proposalId: draft.proposalId,
        });
        expect(finalAudit.events.map((event) => event.action)).toEqual([
          'proposal_created',
          'approval_requested',
          'review_decided',
          'execution_attempted',
          'execution_result',
        ]);
        expect(finalAudit.events.at(-1)?.id).toBe(execution.auditEventId);
        expect(new AuditVerificationService(database).verify(reviewer)).toEqual({
          valid: true,
          totalEvents: 5,
          verifiedEvents: 5,
          firstInvalidSequence: null,
          failure: null,
        });
        const storedAuditPayloads = database
          .prepare('SELECT event_json FROM audit_events')
          .all() as Array<{ event_json: string }>;
        const serializedPayloads = JSON.stringify(storedAuditPayloads);
        for (const untrustedText of [
          reviewerPassphrase,
          reviewer.actorId,
          proposalFixture.reason,
          justification,
          reviewReason,
          database.name,
        ])
          expect(serializedPayloads).not.toContain(untrustedText);
      },
      { seed: true },
    );
  });

  it('keeps a rejected proposal from changing the resource or creating an execution', async () => {
    await withTestDatabase(
      async (database) => {
        const actor = localActor(database);
        const proposalId = pendingProposal(database, actor);
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const originalResource = resources.getById(buildProposalRequest().resourceId);
        if (originalResource === null) throw new Error('Missing fictional idle compute resource.');
        const reviewer = await authenticatedReviewer(database);

        const rejected = new ReviewService(
          database,
          createFixedClock(decidedTime),
          createSequentialIdGenerator(),
        ).review(reviewer, {
          proposalId,
          decision: 'rejected',
          reason: 'Declined this fictional idle compute change.',
        });
        expect(rejected.status).toBe('rejected');
        expect(proposals.getById(proposalId)?.status).toBe('rejected');
        expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)).toMatchObject({
          reviewerId: reviewer.actorId,
          decision: 'rejected',
        });

        expect(() =>
          new ExecutionService(
            database,
            createFixedClock(executedTime),
            createSequentialIdGenerator(),
          ).executeChange(actor, { proposalId, idempotencyKey: executionKey }),
        ).toThrow(PreconditionError);
        expect(resources.getById(originalResource.id)).toEqual(originalResource);
        expect(new SqliteExecutionRepository(database).getByProposalId(proposalId)).toBeNull();
        expect(
          new AgentAuditService(database)
            .getAuditLog(actor, { proposalId })
            .events.map((event) => event.action),
        ).toEqual(['proposal_created', 'approval_requested', 'review_decided']);
        expect(new AuditVerificationService(database).verify(reviewer)).toMatchObject({
          valid: true,
          totalEvents: 3,
          verifiedEvents: 3,
        });
      },
      { seed: true },
    );
  });

  it('refuses an approved proposal after a competing resource version change', async () => {
    await withTestDatabase(
      async (database) => {
        const actor = localActor(database);
        const proposalId = pendingProposal(database, actor);
        const reviewer = await authenticatedReviewer(database);
        new ReviewService(
          database,
          createFixedClock(decidedTime),
          createSequentialIdGenerator(),
        ).review(reviewer, {
          proposalId,
          decision: 'approved',
          reason: 'Approved before the fictional resource changed.',
        });

        const resources = new SqliteResourceRepository(database);
        const originalResource = resources.getById(buildProposalRequest().resourceId);
        if (originalResource === null) throw new Error('Missing fictional idle compute resource.');
        // A repository write simulates another caller advancing the resource version.
        const competingUpdate = resources.updateIfVersion(
          originalResource,
          originalResource.version,
        );
        expect(competingUpdate.status).toBe('updated');
        expect(resources.getById(originalResource.id)?.version).toBe(originalResource.version + 1);

        expect(() =>
          new ExecutionService(
            database,
            createFixedClock(executedTime),
            createSequentialIdGenerator(),
          ).executeChange(actor, { proposalId, idempotencyKey: executionKey }),
        ).toThrow(ConflictError);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)?.decision).toBe(
          'approved',
        );
        expect(new SqliteExecutionRepository(database).getByProposalId(proposalId)).toBeNull();
        expect(
          new AgentAuditService(database)
            .getAuditLog(actor, { proposalId })
            .events.map((event) => event.action),
        ).toEqual(['proposal_created', 'approval_requested', 'review_decided']);
        expect(new AuditVerificationService(database).verify(reviewer)).toMatchObject({
          valid: true,
          totalEvents: 3,
          verifiedEvents: 3,
        });
      },
      { seed: true },
    );
  });
});
