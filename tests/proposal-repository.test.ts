import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../src/domain/errors.js';
import { demoPolicySchema, loadDemoPolicy } from '../src/domain/policy.js';
import {
  SqliteProposalRepository,
  type ProposalDraft,
} from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { buildProposalRequest, buildResource } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const firstInstant = '2026-01-01T00:00:00.000Z';
const secondInstant = '2026-01-01T01:00:00.000Z';
const thirdInstant = '2026-01-01T02:00:00.000Z';
const fourthInstant = '2026-01-01T03:00:00.000Z';

function draft(id: string, overrides: Partial<ProposalDraft> = {}): ProposalDraft {
  const request = buildProposalRequest();
  return {
    id,
    resourceId: request.resourceId,
    proposerActorId: 'local-agent',
    action: { type: 'disable_compute' },
    reason: request.reason,
    expectedResourceVersion: request.expectedResourceVersion,
    idempotencyKey: request.idempotencyKey,
    policySnapshot: demoPolicySchema.parse(loadDemoPolicy()),
    createdAt: createFixedClock(firstInstant).now().toISOString(),
    ...overrides,
  };
}

describe('SQLite proposal repository', () => {
  it('returns the original proposal for an exact actor-scoped retry and rejects a changed request', async () => {
    await withTestDatabase(
      (database) => {
        const repository = new SqliteProposalRepository(database);
        const ids = createSequentialIdGenerator();
        const first = repository.createDraft(draft(ids.nextId('proposal')));
        const retry = draft(ids.nextId('proposal'), { createdAt: secondInstant });

        expect(repository.createDraft(retry)).toEqual(first);
        expect(repository.list()).toHaveLength(1);
        expect(() =>
          repository.createDraft({ ...retry, reason: 'A different synthetic reason.' }),
        ).toThrow(ConflictError);
        expect(() => repository.createDraft({ ...retry, expectedResourceVersion: 2 })).toThrow(
          ConflictError,
        );
        expect(
          repository.createDraft(
            draft(ids.nextId('proposal'), {
              proposerActorId: 'other-agent',
              reason: 'A different synthetic reason.',
            }),
          ).proposerActorId,
        ).toBe('other-agent');
        expect(repository.list()).toHaveLength(2);
      },
      { seed: true },
    );
  });

  it('reads validated proposals with deterministic filtering and bounded pagination', async () => {
    await withTestDatabase(
      (database) => {
        const repository = new SqliteProposalRepository(database);
        const ids = createSequentialIdGenerator();
        const first = repository.createDraft(
          draft(ids.nextId('proposal'), {
            idempotencyKey: 'first-key-000001',
            createdAt: secondInstant,
          }),
        );
        const second = repository.createDraft(
          draft(ids.nextId('proposal'), {
            idempotencyKey: 'second-key-000001',
            createdAt: firstInstant,
            proposerActorId: 'other-agent',
          }),
        );
        const third = repository.createDraft(
          draft(ids.nextId('proposal'), {
            idempotencyKey: 'third-key-000001',
            createdAt: secondInstant,
          }),
        );

        expect(repository.getById(first.id)).toEqual(first);
        expect(repository.getById('proposal-missing')).toBeNull();
        expect(repository.list()).toEqual([second, first, third]);
        expect(repository.list({ proposerActorId: 'local-agent', limit: 1, offset: 1 })).toEqual([
          third,
        ]);
        expect(repository.list({ resourceId: first.resourceId, status: 'draft' })).toHaveLength(3);
        expect(repository.list({ status: 'stale' })).toEqual([]);
        expect(() => repository.list({ limit: 101 })).toThrow(ValidationError);
        expect(() => repository.list({ proposerActorId: "agent' OR 1=1 --" })).toThrow(
          ValidationError,
        );
        expect(() => repository.getById("proposal-001' OR 1=1 --")).toThrow(ValidationError);
      },
      { seed: true },
    );
  });

  it('rejects invalid drafts and malformed stored rows without exposing partial data', async () => {
    await withTestDatabase(
      (database) => {
        const repository = new SqliteProposalRepository(database);
        const ids = createSequentialIdGenerator();
        expect(() =>
          repository.createDraft(
            draft(ids.nextId('proposal'), {
              resourceId: 'res-absent-001',
            }),
          ),
        ).toThrow(NotFoundError);
        expect(() =>
          repository.createDraft({
            ...draft(ids.nextId('proposal')),
            action: {
              type: 'disable_compute',
              targetSize: 'demo-large',
            },
          }),
        ).toThrow(ValidationError);

        const malformedChange = repository.createDraft(
          draft(ids.nextId('proposal'), {
            idempotencyKey: 'malformed-change-001',
          }),
        );
        const malformedPolicy = repository.createDraft(
          draft(ids.nextId('proposal'), {
            idempotencyKey: 'malformed-policy-001',
          }),
        );
        database
          .prepare('UPDATE proposals SET requested_change_json = ? WHERE id = ?')
          .run('{"unexpected":true}', malformedChange.id);
        database
          .prepare('UPDATE proposals SET policy_snapshot_json = ? WHERE id = ?')
          .run('{}', malformedPolicy.id);

        expect(() => repository.getById(malformedChange.id)).toThrow(InternalError);
        expect(() => repository.getById(malformedPolicy.id)).toThrow(InternalError);
        expect(() => repository.list()).toThrow(InternalError);
      },
      { seed: true },
    );
  });

  it('requires the expected status, justification, and matching reviewer decision', async () => {
    await withTestDatabase(
      (database) => {
        const repository = new SqliteProposalRepository(database);
        const resources = new SqliteResourceRepository(database);
        const resourceBefore = resources.getById(buildResource().id);
        const created = repository.createDraft(
          draft(createSequentialIdGenerator().nextId('proposal')),
        );
        const originalAction = created.action;

        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'draft',
            targetStatus: 'pending_approval',
            updatedAt: secondInstant,
          }),
        ).toThrow(ValidationError);
        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'draft',
            targetStatus: 'approved',
            updatedAt: secondInstant,
          }),
        ).toThrow(ValidationError);

        const pending = repository.transitionStatus({
          id: created.id,
          expectedStatus: 'draft',
          targetStatus: 'pending_approval',
          approvalJustification: 'Independent review is required.',
          updatedAt: secondInstant,
        });
        expect(pending.approvalJustification).toBe('Independent review is required.');
        expect(pending.action).toEqual(originalAction);
        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'draft',
            targetStatus: 'stale',
            updatedAt: thirdInstant,
          }),
        ).toThrow(ConflictError);
        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'pending_approval',
            targetStatus: 'approved',
            updatedAt: firstInstant,
          }),
        ).toThrow(ConflictError);
        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'pending_approval',
            targetStatus: 'approved',
            updatedAt: thirdInstant,
          }),
        ).toThrow(ConflictError);

        database
          .prepare(
            `
        INSERT INTO approval_decisions (id, proposal_id, reviewer_id, decision, reason, decided_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
          )
          .run(
            'decision-000001',
            created.id,
            'reviewer-001',
            'approved',
            'Reviewed synthetic change.',
            thirdInstant,
          );
        const approved = repository.transitionStatus({
          id: created.id,
          expectedStatus: 'pending_approval',
          targetStatus: 'approved',
          updatedAt: thirdInstant,
        });
        expect(approved.status).toBe('approved');
        expect(approved.approvalJustification).toBe(pending.approvalJustification);
        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'approved',
            targetStatus: 'executed',
            updatedAt: fourthInstant,
          }),
        ).toThrow(ConflictError);
        expect(resources.getById(buildResource().id)).toEqual(resourceBefore);

        const stale = repository.transitionStatus({
          id: created.id,
          expectedStatus: 'approved',
          targetStatus: 'stale',
          updatedAt: fourthInstant,
        });
        expect(stale.status).toBe('stale');
        expect(stale.action).toEqual(originalAction);
        expect(() =>
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'stale',
            targetStatus: 'pending_approval',
            approvalJustification: 'Independent review is required.',
            updatedAt: fourthInstant,
          }),
        ).toThrow(ValidationError);
      },
      { seed: true },
    );
  });

  it('joins an outer transaction so a failed audit write rolls back creation and transitions', async () => {
    await withTestDatabase(
      (database) => {
        const repository = new SqliteProposalRepository(database);
        const ids = createSequentialIdGenerator();
        const rolledBack = draft(ids.nextId('proposal'));
        const createWorkflow = database.transaction(() => {
          repository.createDraft(rolledBack);
          throw new Error('Synthetic audit failure');
        });
        expect(() => createWorkflow.immediate()).toThrow('Synthetic audit failure');
        expect(repository.getById(rolledBack.id)).toBeNull();

        const created = repository.createDraft(draft(ids.nextId('proposal')));
        const transitionWorkflow = database.transaction(() => {
          repository.transitionStatus({
            id: created.id,
            expectedStatus: 'draft',
            targetStatus: 'pending_approval',
            approvalJustification: 'Independent review is required.',
            updatedAt: secondInstant,
          });
          throw new Error('Synthetic audit failure');
        });
        expect(() => transitionWorkflow.immediate()).toThrow('Synthetic audit failure');
        expect(repository.getById(created.id)?.status).toBe('draft');
      },
      { seed: true },
    );
  });
});
