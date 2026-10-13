import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { openInMemoryTestDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';

const resourceMigration = readFileSync(
  new URL('../src/infra/sqlite/migrations/001_resources.sql', import.meta.url),
  'utf8',
);
const workflowMigration = readFileSync(
  new URL('../src/infra/sqlite/migrations/002_workflows.sql', import.meta.url),
  'utf8',
);

const resourceInsert = `
  INSERT INTO resources (
    id, provider, provider_resource_id, kind, region, environment, owner, tags_json,
    monthly_cost_estimate_cents, utilization_metric, utilization_percent,
    protected_from_changes, has_restricted_tag, has_policy_violation,
    created_at, updated_at, version
  ) VALUES (
    'res-aws-ec2-01', 'aws', 'demo/aws/ec2/001', 'ec2-instance', 'us-east-1',
    'development', 'team-sandbox', '{}', 6900, 'cpu', 0, 0, 0, 0,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
  )
`;

const proposalRow = {
  id: 'proposal-001',
  resource_id: 'res-aws-ec2-01',
  proposer_actor_id: 'local-agent',
  action_type: 'resize_compute',
  requested_change_json: '{"size":"small"}',
  reason: 'Synthetic resource is idle',
  expected_resource_version: 1,
  idempotency_key: 'proposal-key-001',
  request_fingerprint: 'a'.repeat(64),
  policy_snapshot_json: '{"version":"demo-v1","allowed":true}',
  status: 'draft',
  approval_justification: null as string | null,
  created_at: '2026-01-01T01:00:00.000Z',
  updated_at: '2026-01-01T01:00:00.000Z',
};

const proposalInsert = `
  INSERT INTO proposals (
    id, resource_id, proposer_actor_id, action_type, requested_change_json,
    reason, expected_resource_version, idempotency_key, request_fingerprint,
    policy_snapshot_json, status, approval_justification, created_at, updated_at
  ) VALUES (
    @id, @resource_id, @proposer_actor_id, @action_type, @requested_change_json,
    @reason, @expected_resource_version, @idempotency_key, @request_fingerprint,
    @policy_snapshot_json, @status, @approval_justification, @created_at, @updated_at
  )
`;

function withMigratedDatabase(run: (database: SqliteConnection) => void): void {
  const database = openInMemoryTestDatabase();
  try {
    database.exec(resourceMigration);
    database.exec(workflowMigration);
    run(database);
  } finally {
    database.close();
  }
}

function insertProposal(
  database: SqliteConnection,
  overrides: Partial<typeof proposalRow> = {},
): void {
  database.prepare(proposalInsert).run({ ...proposalRow, ...overrides });
}

describe('workflow migration', () => {
  it('stores a draft proposal linked to a resource', () => {
    withMigratedDatabase((database) => {
      database.exec(resourceInsert);
      insertProposal(database);
      expect(
        database.prepare('SELECT status, expected_resource_version FROM proposals').get(),
      ).toEqual({
        status: 'draft',
        expected_resource_version: 1,
      });
    });
  });

  it('rejects missing resource and proposal references', () => {
    withMigratedDatabase((database) => {
      expect(() => insertProposal(database)).toThrow();
      database.exec(resourceInsert);
      expect(() =>
        database
          .prepare(
            `
          INSERT INTO approval_decisions (id, proposal_id, reviewer_id, decision, reason, decided_at)
          VALUES ('decision-001', 'missing-proposal', 'reviewer-001', 'approved', 'Reviewed', '2026-01-01T02:00:00.000Z')
        `,
          )
          .run(),
      ).toThrow();

      insertProposal(database);
      expect(() =>
        database
          .prepare(
            `
          INSERT INTO executions (
            id, proposal_id, executor_actor_id, idempotency_key,
            result_json, resource_version_after, executed_at
          ) VALUES (
            'execution-002', 'proposal-001', 'local-agent', 'execution-key-002',
            '{}', 2, '2026-01-01T03:00:00.000Z'
          )
        `,
          )
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `
          INSERT INTO executions (
            id, proposal_id, executor_actor_id, idempotency_key,
            result_json, resource_version_after, executed_at
          ) VALUES (
            'execution-001', 'missing-proposal', 'local-agent', 'execution-key-001',
            '{}', 2, '2026-01-01T03:00:00.000Z'
          )
        `,
          )
          .run(),
      ).toThrow();
    });
  });

  it('reserves each proposal idempotency key within its actor', () => {
    withMigratedDatabase((database) => {
      database.exec(resourceInsert);
      insertProposal(database);
      expect(() =>
        insertProposal(database, { id: 'proposal-002', request_fingerprint: 'b'.repeat(64) }),
      ).toThrow();
      insertProposal(database, { id: 'proposal-003', proposer_actor_id: 'other-agent' });
      expect(database.prepare('SELECT count(*) AS total FROM proposals').get()).toEqual({
        total: 2,
      });
    });
  });

  it('accepts only the declared proposal states and action types', () => {
    withMigratedDatabase((database) => {
      database.exec(resourceInsert);
      for (const status of [
        'draft',
        'pending_approval',
        'approved',
        'rejected',
        'executed',
        'stale',
      ]) {
        insertProposal(database, {
          id: `proposal-${status}`,
          idempotency_key: `key-${status}`,
          status,
        });
      }
      expect(() =>
        insertProposal(database, {
          id: 'proposal-invalid',
          idempotency_key: 'key-invalid',
          status: 'unknown',
        }),
      ).toThrow();
      expect(() =>
        insertProposal(database, {
          id: 'proposal-script',
          idempotency_key: 'key-script',
          action_type: 'run_script',
        }),
      ).toThrow();
    });
  });

  it('rejects malformed or oversized workflow payloads', () => {
    withMigratedDatabase((database) => {
      database.exec(resourceInsert);
      expect(() => insertProposal(database, { requested_change_json: '[]' })).toThrow();
      expect(() => insertProposal(database, { policy_snapshot_json: '{broken' })).toThrow();
      expect(() =>
        insertProposal(database, {
          requested_change_json: JSON.stringify({ text: 'x'.repeat(8192) }),
        }),
      ).toThrow();
    });
  });

  it('permits only one review decision per proposal', () => {
    withMigratedDatabase((database) => {
      database.exec(resourceInsert);
      insertProposal(database);
      const insertDecision = database.prepare(`
        INSERT INTO approval_decisions (id, proposal_id, reviewer_id, decision, reason, decided_at)
        VALUES (@id, @proposal_id, @reviewer_id, @decision, @reason, @decided_at)
      `);
      insertDecision.run({
        id: 'decision-001',
        proposal_id: proposalRow.id,
        reviewer_id: 'reviewer-001',
        decision: 'approved',
        reason: 'Reviewed',
        decided_at: '2026-01-01T02:00:00.000Z',
      });
      expect(() =>
        insertDecision.run({
          id: 'decision-002',
          proposal_id: proposalRow.id,
          reviewer_id: 'reviewer-002',
          decision: 'rejected',
          reason: 'Second decision',
          decided_at: '2026-01-01T02:01:00.000Z',
        }),
      ).toThrow();
      insertProposal(database, { id: 'proposal-002', idempotency_key: 'proposal-key-002' });
      expect(() =>
        insertDecision.run({
          id: 'decision-003',
          proposal_id: 'proposal-002',
          reviewer_id: 'reviewer-003',
          decision: 'pending',
          reason: 'Invalid decision',
          decided_at: '2026-01-01T02:02:00.000Z',
        }),
      ).toThrow();
    });
  });

  it('permits only one completed execution per proposal and actor key', () => {
    withMigratedDatabase((database) => {
      database.exec(resourceInsert);
      insertProposal(database);
      const insertDecision = database.prepare(`
        INSERT INTO approval_decisions (id, proposal_id, reviewer_id, decision, reason, decided_at)
        VALUES (@id, @proposal_id, @reviewer_id, @decision, @reason, @decided_at)
      `);
      insertDecision.run({
        id: 'decision-001',
        proposal_id: proposalRow.id,
        reviewer_id: 'reviewer-001',
        decision: 'approved',
        reason: 'Reviewed',
        decided_at: '2026-01-01T02:00:00.000Z',
      });
      const insertExecution = database.prepare(`
        INSERT INTO executions (
          id, proposal_id, executor_actor_id, idempotency_key,
          result_json, resource_version_after, executed_at
        ) VALUES (
          @id, @proposal_id, @executor_actor_id, @idempotency_key,
          @result_json, @resource_version_after, @executed_at
        )
      `);
      const execution = {
        id: 'execution-001',
        proposal_id: proposalRow.id,
        executor_actor_id: 'local-agent',
        idempotency_key: 'execution-key-001',
        result_json: '{"applied":true}',
        resource_version_after: 2,
        executed_at: '2026-01-01T03:00:00.000Z',
      };
      insertExecution.run(execution);
      expect(() =>
        insertExecution.run({
          ...execution,
          id: 'execution-002',
          idempotency_key: 'execution-key-002',
        }),
      ).toThrow();
      insertProposal(database, { id: 'proposal-002', idempotency_key: 'proposal-key-002' });
      insertDecision.run({
        id: 'decision-002',
        proposal_id: 'proposal-002',
        reviewer_id: 'reviewer-002',
        decision: 'approved',
        reason: 'Reviewed',
        decided_at: '2026-01-01T02:01:00.000Z',
      });
      expect(() =>
        insertExecution.run({ ...execution, id: 'execution-003', proposal_id: 'proposal-002' }),
      ).toThrow();
      expect(database.prepare('SELECT count(*) AS total FROM executions').get()).toEqual({
        total: 1,
      });
    });
  });
});
