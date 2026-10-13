import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../src/application/approval-request-service.js';
import { ProposalService } from '../src/application/proposal-service.js';
import { loadConfig } from '../src/config.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../src/domain/errors.js';
import { demoPolicySchema, loadDemoPolicy } from '../src/domain/policy.js';
import type { ChangeAction } from '../src/domain/change.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { requestApprovalOutputSchema } from '../src/mcp/schemas.js';
import { createMcpActor } from '../src/security/permissions.js';
import { buildProposalRequest } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const approvalTime = '2026-01-01T01:00:00.000Z';
const justification = 'Please review this fictional change independently.';

function agentActor() {
  return createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
}

function viewerActor() {
  return createMcpActor(
    loadConfig(
      {
        SECUREOPS_MODE: 'http-demo',
        SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
        SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
      },
      process.cwd(),
    ),
  );
}

function createDraft(
  database: SqliteConnection,
  action: ChangeAction = { type: 'disable_compute' },
): string {
  const request = buildProposalRequest();
  return new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(agentActor(), {
    resourceId: request.resourceId,
    action,
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
  }).proposalId;
}

describe('approval request service', () => {
  it('moves one eligible draft to the pending list without changing its payload', async () => {
    await withTestDatabase(
      (database) => {
        const proposals = new SqliteProposalRepository(database);
        const resources = new SqliteResourceRepository(database);
        const id = createDraft(database);
        const before = proposals.getById(id);
        if (before === null) throw new Error('Missing fictional draft proposal.');
        const resourceBefore = resources.getById(before.resourceId);
        const service = new ApprovalRequestService(database, createFixedClock(approvalTime));

        const output = service.requestApproval(agentActor(), { proposalId: id, justification });
        const after = proposals.getById(id);
        expect(output).toEqual({
          proposalId: id,
          status: 'pending_approval',
          reviewerInstructions:
            'From the project root, an independent reviewer runs in an interactive terminal: ' +
            `npm run cli -- proposals:review --db-path "<absolute path to the same local .db>" --proposal-id ${id}`,
        });
        expect(requestApprovalOutputSchema.safeParse(output).success).toBe(true);
        expect(Object.isFrozen(output)).toBe(true);
        expect(after).toEqual({
          ...before,
          status: 'pending_approval',
          approvalJustification: justification,
          updatedAt: approvalTime,
        });
        expect(
          proposals.list({ status: 'pending_approval' }).map((proposal) => proposal.id),
        ).toEqual([id]);
        expect(database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get()).toEqual({
          count: 0,
        });
        expect(resources.getById(before.resourceId)).toEqual(resourceBefore);
        expect(() =>
          service.requestApproval(agentActor(), { proposalId: id, justification }),
        ).toThrow(ConflictError);
        expect(proposals.list({ status: 'pending_approval' })).toHaveLength(1);
      },
      { seed: true },
    );
  });

  it('rejects a stale resource version and leaves the proposal in draft', async () => {
    await withTestDatabase(
      (database) => {
        const id = createDraft(database);
        const proposals = new SqliteProposalRepository(database);
        const resources = new SqliteResourceRepository(database);
        const current = resources.getById(buildProposalRequest().resourceId);
        if (current === null) throw new Error('Missing fictional compute resource.');
        resources.updateIfVersion(
          {
            ...current,
            monthlyCostEstimateCents: current.monthlyCostEstimateCents + 100,
          },
          current.version,
        );

        const service = new ApprovalRequestService(database, createFixedClock(approvalTime));
        expect(() =>
          service.requestApproval(agentActor(), { proposalId: id, justification }),
        ).toThrow(ConflictError);
        expect(proposals.getById(id)?.status).toBe('draft');
        expect(proposals.getById(id)?.approvalJustification).toBeNull();
      },
      { seed: true },
    );
  });

  it('re-evaluates changed policy and refuses a newly denied draft', async () => {
    await withTestDatabase(
      (database) => {
        const id = createDraft(database, { type: 'resize_compute', targetSize: 'demo-medium' });
        const original = loadDemoPolicy();
        const tightenedPolicy = demoPolicySchema.parse({
          ...original,
          version: 'demo-v2',
          rules: original.rules.map((rule) =>
            rule.type === 'limit_monthly_cost_increase'
              ? { ...rule, maximumMonthlyIncreaseCents: 0 }
              : rule,
          ),
        });
        const service = new ApprovalRequestService(
          database,
          createFixedClock(approvalTime),
          () => tightenedPolicy,
        );

        expect(() =>
          service.requestApproval(agentActor(), { proposalId: id, justification }),
        ).toThrow(PreconditionError);
        expect(new SqliteProposalRepository(database).getById(id)?.status).toBe('draft');
      },
      { seed: true },
    );
  });

  it('denies viewers, forged actors, malformed requests, and missing proposals', async () => {
    await withTestDatabase(
      (database) => {
        const id = createDraft(database);
        const service = new ApprovalRequestService(database, createFixedClock(approvalTime));
        expect(() => service.requestApproval(viewerActor(), { invalid: true })).toThrow(
          ForbiddenError,
        );
        expect(() =>
          service.requestApproval(
            {
              role: 'agent',
              actorId: 'local-agent',
              source: 'local-mcp',
            } as ReturnType<typeof agentActor>,
            { proposalId: id, justification },
          ),
        ).toThrow(ForbiddenError);
        expect(() =>
          service.requestApproval(agentActor(), { proposalId: id, justification: 'short' }),
        ).toThrow(ValidationError);
        expect(() =>
          service.requestApproval(agentActor(), {
            proposalId: id,
            justification,
            decision: 'approved',
          }),
        ).toThrow(ValidationError);
        expect(() =>
          service.requestApproval(agentActor(), {
            proposalId: 'proposal-absent',
            justification,
          }),
        ).toThrow(NotFoundError);
        expect(new SqliteProposalRepository(database).getById(id)?.status).toBe('draft');
      },
      { seed: true },
    );
  });

  it('denies an agent who did not create the draft', async () => {
    await withTestDatabase(
      (database) => {
        const id = createDraft(database);
        database
          .prepare('UPDATE proposals SET proposer_actor_id = ? WHERE id = ?')
          .run('another-agent', id);
        const service = new ApprovalRequestService(database, createFixedClock(approvalTime));

        expect(() =>
          service.requestApproval(agentActor(), { proposalId: id, justification }),
        ).toThrow(ForbiddenError);
        expect(new SqliteProposalRepository(database).getById(id)?.status).toBe('draft');
      },
      { seed: true },
    );
  });

  it('rolls back the transition with a failed outer workflow transaction', async () => {
    await withTestDatabase(
      (database) => {
        const id = createDraft(database);
        const service = new ApprovalRequestService(database, createFixedClock(approvalTime));
        const workflow = database.transaction(() => {
          service.requestApproval(agentActor(), { proposalId: id, justification });
          throw new Error('Synthetic audit failure');
        });
        expect(() => workflow.immediate()).toThrow('Synthetic audit failure');
        expect(new SqliteProposalRepository(database).getById(id)?.status).toBe('draft');
      },
      { seed: true },
    );
  });
});
