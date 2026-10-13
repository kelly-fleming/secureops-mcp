import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../src/application/approval-request-service.js';
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
import { demoPolicySchema, loadDemoPolicy } from '../src/domain/policy.js';
import { openConfiguredDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';
import { SqliteDecisionRepository } from '../src/infra/sqlite/decision-repository.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor, type ActorContext } from '../src/security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { buildProposalRequest } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const approvalTime = '2026-01-01T01:00:00.000Z';
const decisionTime = '2026-01-01T02:00:00.000Z';
const passphrase = 'fictional-reviewer-passphrase-001';
const reviewReason = 'Reviewed the fictional resource and current policy.';

function agentActor(): ActorContext {
  return createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
}

function createPendingProposal(
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
  new ApprovalRequestService(database, createFixedClock(approvalTime)).requestApproval(
    agentActor(),
    {
      proposalId,
      justification: 'Independent review requested for this fictional change.',
    },
  );
  return proposalId;
}

async function authenticateReviewer(
  database: SqliteConnection,
  username: string,
): Promise<ActorContext> {
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
        `identity-${username}`,
        username,
        verifier.passwordKdf,
        verifier.passwordSalt,
        verifier.passwordVerifier,
        verifier.scryptCost,
        verifier.scryptBlockSize,
        verifier.scryptParallelization,
        approvalTime,
        approvalTime,
      );
  } finally {
    verifier.passwordSalt.fill(0);
    verifier.passwordVerifier.fill(0);
  }
  const runtime: ReviewerAuthRuntime = {
    isInteractive: () => true,
    askUsername: async () => username,
    askPassphrase: async () => passphrase,
    delay: async () => undefined,
  };
  return authenticateCliActor(database, 'reviewer', runtime);
}

function reviewService(database: SqliteConnection, loadPolicy = loadDemoPolicy): ReviewService {
  return new ReviewService(
    database,
    createFixedClock(decisionTime),
    createSequentialIdGenerator(),
    loadPolicy,
  );
}

function decisionCount(database: SqliteConnection): number {
  const row = database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get() as {
    count: number;
  };
  return row.count;
}

describe('human review decisions', () => {
  it('atomically approves a pending proposal with the authenticated reviewer identity', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const actor = await authenticateReviewer(database, 'reviewer_one');
        const resources = new SqliteResourceRepository(database);
        const resourceBefore = resources.getById(buildProposalRequest().resourceId);
        const result = reviewService(database).review(actor, {
          proposalId,
          decision: 'approved',
          reason: reviewReason,
        });

        expect(result).toEqual({
          proposalId,
          decisionId: 'decision-000001',
          status: 'approved',
          decidedAt: decisionTime,
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)).toEqual({
          id: result.decisionId,
          proposalId,
          reviewerId: actor.actorId,
          decision: 'approved',
          reason: reviewReason,
          decidedAt: decisionTime,
        });
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        expect(resources.getById(buildProposalRequest().resourceId)).toEqual(resourceBefore);
      },
      { seed: true },
    );
  });

  it('records a rejection and refuses any second decision', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const actor = await authenticateReviewer(database, 'reviewer_one');
        const service = reviewService(database);
        expect(
          service.review(actor, { proposalId, decision: 'rejected', reason: reviewReason }).status,
        ).toBe('rejected');
        expect(() =>
          service.review(actor, { proposalId, decision: 'approved', reason: reviewReason }),
        ).toThrow(ConflictError);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('rejected');
        expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)?.decision).toBe(
          'rejected',
        );
        expect(decisionCount(database)).toBe(1);
      },
      { seed: true },
    );
  });

  it('refuses approval when the resource version changed', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const actor = await authenticateReviewer(database, 'reviewer_one');
        const resources = new SqliteResourceRepository(database);
        const current = resources.getById(buildProposalRequest().resourceId);
        if (current === null) throw new Error('Missing fictional compute resource.');
        expect(resources.updateIfVersion(current, current.version).status).toBe('updated');

        expect(() =>
          reviewService(database).review(actor, {
            proposalId,
            decision: 'approved',
            reason: reviewReason,
          }),
        ).toThrow(ConflictError);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
          'pending_approval',
        );
        expect(decisionCount(database)).toBe(0);
      },
      { seed: true },
    );
  });

  it('denies approval under a tightened policy but allows the reviewer to reject', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database, {
          type: 'resize_compute',
          targetSize: 'demo-medium',
        });
        const actor = await authenticateReviewer(database, 'reviewer_one');
        const original = loadDemoPolicy();
        const tightened = demoPolicySchema.parse({
          ...original,
          version: 'demo-v2',
          rules: original.rules.map((rule) =>
            rule.type === 'limit_monthly_cost_increase'
              ? { ...rule, maximumMonthlyIncreaseCents: 0 }
              : rule,
          ),
        });
        const service = reviewService(database, () => tightened);
        expect(() =>
          service.review(actor, {
            proposalId,
            decision: 'approved',
            reason: reviewReason,
          }),
        ).toThrow(PreconditionError);
        expect(decisionCount(database)).toBe(0);
        expect(
          service.review(actor, { proposalId, decision: 'rejected', reason: reviewReason }).status,
        ).toBe('rejected');
      },
      { seed: true },
    );
  });

  it('permits rejection when a once eligible resource is now protected', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const actor = await authenticateReviewer(database, 'reviewer_one');
        // Simulate out-of-band state drift without a version bump to isolate preview eligibility.
        database
          .prepare('UPDATE resources SET protected_from_changes = 1 WHERE id = ?')
          .run(buildProposalRequest().resourceId);
        const service = reviewService(database);
        expect(() =>
          service.review(actor, {
            proposalId,
            decision: 'approved',
            reason: reviewReason,
          }),
        ).toThrow(PreconditionError);
        expect(
          service.review(actor, { proposalId, decision: 'rejected', reason: reviewReason }).status,
        ).toBe('rejected');
      },
      { seed: true },
    );
  });

  it('rejects agent, forged reviewer, self decision, and malformed input before writing', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const actor = await authenticateReviewer(database, 'reviewer_one');
        const service = reviewService(database);
        expect(() =>
          service.review(agentActor(), { proposalId, decision: 'approved', reason: reviewReason }),
        ).toThrow(ForbiddenError);
        expect(() =>
          service.review({ ...actor }, { proposalId, decision: 'approved', reason: reviewReason }),
        ).toThrow(ForbiddenError);
        expect(() =>
          service.review(actor, {
            proposalId,
            decision: 'approved',
            reason: reviewReason,
            reviewerId: actor.actorId,
          }),
        ).toThrow(ValidationError);
        database
          .prepare('UPDATE proposals SET proposer_actor_id = ? WHERE id = ?')
          .run(actor.actorId, proposalId);
        expect(() =>
          service.review(actor, { proposalId, decision: 'rejected', reason: reviewReason }),
        ).toThrow(ForbiddenError);
        expect(decisionCount(database)).toBe(0);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
          'pending_approval',
        );
      },
      { seed: true },
    );
  });

  it('allows only one of two competing reviewer connections to decide a proposal', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const firstActor = await authenticateReviewer(database, 'reviewer_one');
        const secondActor = await authenticateReviewer(database, 'reviewer_two');
        const databases = database.pragma('database_list') as { name: string; file: string }[];
        const mainPath = databases.find((entry) => entry.name === 'main')?.file;
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
        const first = reviewService(database);
        try {
          const second = reviewService(secondDatabase);
          const results = await Promise.allSettled([
            Promise.resolve().then(() =>
              first.review(firstActor, {
                proposalId,
                decision: 'approved',
                reason: reviewReason,
              }),
            ),
            Promise.resolve().then(() =>
              second.review(secondActor, {
                proposalId,
                decision: 'rejected',
                reason: reviewReason,
              }),
            ),
          ]);
          expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
          expect(decisionCount(database)).toBe(1);
          const decision = new SqliteDecisionRepository(database).getByProposalId(proposalId);
          expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
            decision?.decision,
          );
        } finally {
          secondDatabase.close();
        }
      },
      { seed: true },
    );
  });

  it('rolls back decision and status when a later workflow write fails', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        const actor = await authenticateReviewer(database, 'reviewer_one');
        const workflow = database.transaction(() => {
          reviewService(database).review(actor, {
            proposalId,
            decision: 'approved',
            reason: reviewReason,
          });
          throw new Error('Synthetic audit append failure');
        });
        expect(() => workflow.immediate()).toThrow('Synthetic audit append failure');
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
          'pending_approval',
        );
        expect(decisionCount(database)).toBe(0);
      },
      { seed: true },
    );
  });
});
