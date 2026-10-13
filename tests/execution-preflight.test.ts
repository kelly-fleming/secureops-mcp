import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../src/application/approval-request-service.js';
import { ExecutionPreflight } from '../src/application/execution-preflight.js';
import { ProposalService } from '../src/application/proposal-service.js';
import { ReviewService } from '../src/application/review-service.js';
import { loadConfig } from '../src/config.js';
import type { ChangeAction } from '../src/domain/change.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  PreconditionError,
  ValidationError,
} from '../src/domain/errors.js';
import { demoPolicySchema, loadDemoPolicy } from '../src/domain/policy.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor, type ActorContext } from '../src/security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { buildProposalRequest } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const requestedAt = '2026-01-01T01:00:00.000Z';
const decidedAt = '2026-01-01T02:00:00.000Z';
const passphrase = 'fictional-preflight-reviewer-passphrase';
const reviewReason = 'Reviewed this fictional change for the local demo.';

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
  new ApprovalRequestService(database, createFixedClock(requestedAt)).requestApproval(
    agentActor(),
    {
      proposalId,
      justification: 'Independent review requested for a fictional change.',
    },
  );
  return proposalId;
}

async function authenticateReviewer(database: SqliteConnection): Promise<ActorContext> {
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
        'identity-preflight-reviewer',
        'preflight_reviewer',
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
    askUsername: async () => 'preflight_reviewer',
    askPassphrase: async () => passphrase,
    delay: async () => undefined,
  };
  return authenticateCliActor(database, 'reviewer', runtime);
}

async function createReviewedProposal(
  database: SqliteConnection,
  decision: 'approved' | 'rejected' = 'approved',
  action?: ChangeAction,
): Promise<string> {
  const proposalId = createPendingProposal(database, action);
  const reviewer = await authenticateReviewer(database);
  new ReviewService(database, createFixedClock(decidedAt), createSequentialIdGenerator()).review(
    reviewer,
    { proposalId, decision, reason: reviewReason },
  );
  return proposalId;
}

function check(database: SqliteConnection, proposalId: string, loadPolicy = loadDemoPolicy) {
  return database
    .transaction(() =>
      new ExecutionPreflight(database, loadPolicy).check(agentActor(), { proposalId }),
    )
    .immediate();
}

describe('execution preflight', () => {
  it('returns a fresh approved preview without writing execution state', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        const before = new SqliteResourceRepository(database).getById(
          buildProposalRequest().resourceId,
        );
        const result = check(database, proposalId);

        expect(result.proposalId).toBe(proposalId);
        expect(result.resourceId).toBe(buildProposalRequest().resourceId);
        expect(result.action).toEqual({ type: 'disable_compute' });
        expect(result.decisionId).toBe('decision-000001');
        expect(result.policyVersion).toBe(loadDemoPolicy().version);
        expect(result.preview.after.monthlyCostEstimateCents).toBe(0);
        expect(Object.isFrozen(result)).toBe(true);
        expect(database.prepare('SELECT COUNT(*) AS total FROM executions').get()).toEqual({
          total: 0,
        });
        expect(new SqliteResourceRepository(database).getById(result.resourceId)).toEqual(before);
      },
      { seed: true },
    );
  });

  it('refuses a forged approved status without an independent decision', async () => {
    await withTestDatabase(
      (database) => {
        const proposalId = createPendingProposal(database);
        database.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").run(proposalId);
        expect(() => check(database, proposalId)).toThrow(PreconditionError);
      },
      { seed: true },
    );
  });

  it('refuses a rejected proposal even though it has a decision row', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database, 'rejected');
        expect(() => check(database, proposalId)).toThrow(PreconditionError);
      },
      { seed: true },
    );
  });

  it('refuses a stale resource version after approval', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        const resources = new SqliteResourceRepository(database);
        const resource = resources.getById(buildProposalRequest().resourceId);
        if (resource === null) throw new Error('Missing fictional resource.');
        expect(resources.updateIfVersion(resource, resource.version).status).toBe('updated');
        expect(() => check(database, proposalId)).toThrow(ConflictError);
      },
      { seed: true },
    );
  });

  it('re-evaluates a changed policy and rejects a newly denied resize', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database, 'approved', {
          type: 'resize_compute',
          targetSize: 'demo-medium',
        });
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
        expect(() => check(database, proposalId, () => tightened)).toThrow(PreconditionError);
        expect(() =>
          check(database, proposalId, () => ({
            ...tightened,
            version: original.version,
          })),
        ).toThrow(PreconditionError);
        expect(
          check(database, proposalId, () =>
            demoPolicySchema.parse({
              ...original,
              version: 'demo-v2',
            }),
          ).policyVersion,
        ).toBe('demo-v2');
      },
      { seed: true },
    );
  });

  it('refuses a change that became ineligible under the same resource version', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        database
          .prepare('UPDATE resources SET protected_from_changes = 1 WHERE id = ?')
          .run(buildProposalRequest().resourceId);
        expect(() => check(database, proposalId)).toThrow(PreconditionError);
      },
      { seed: true },
    );
  });

  it('refuses an approval after its reviewer is disabled', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        database
          .prepare('UPDATE local_identities SET disabled = 1 WHERE id = ?')
          .run('identity-preflight-reviewer');
        expect(() => check(database, proposalId)).toThrow(PreconditionError);
      },
      { seed: true },
    );
  });

  it('refuses an approval already used by an execution row', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        database
          .prepare(
            `
        INSERT INTO executions (
          id, proposal_id, executor_actor_id, idempotency_key,
          result_json, resource_version_after, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
          )
          .run(
            'execution-preflight-001',
            proposalId,
            agentActor().actorId,
            'preflight-execution-key-001',
            '{}',
            2,
            decidedAt,
          );
        expect(() => check(database, proposalId)).toThrow(ConflictError);
      },
      { seed: true },
    );
  });

  it('refuses a proposal marked executed even if its execution row is missing', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        database.prepare("UPDATE proposals SET status = 'executed' WHERE id = ?").run(proposalId);
        expect(() => check(database, proposalId)).toThrow(ConflictError);
      },
      { seed: true },
    );
  });

  it('rejects an unsupported stored action before returning a preview', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        // Simulate corrupt local storage beyond the normal SQLite CHECK boundary.
        database.pragma('ignore_check_constraints = ON');
        try {
          database
            .prepare('UPDATE proposals SET action_type = ? WHERE id = ?')
            .run('unsupported_action', proposalId);
        } finally {
          database.pragma('ignore_check_constraints = OFF');
        }
        expect(() => check(database, proposalId)).toThrow(InternalError);
      },
      { seed: true },
    );
  });

  it('checks issued authority, strict input, and the caller-owned transaction', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = await createReviewedProposal(database);
        const service = new ExecutionPreflight(database);
        const agent = agentActor();
        expect(() => service.check(agent, { proposalId })).toThrow(PreconditionError);
        expect(() =>
          database.transaction(() => service.check({ ...agent }, { proposalId })).immediate(),
        ).toThrow(ForbiddenError);
        expect(() =>
          database
            .transaction(() =>
              service.check(agent, {
                proposalId,
                decision: 'approved',
              }),
            )
            .immediate(),
        ).toThrow(ValidationError);
      },
      { seed: true },
    );
  });
});
