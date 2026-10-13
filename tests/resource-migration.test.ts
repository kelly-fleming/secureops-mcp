import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { openInMemoryTestDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';

const migration = readFileSync(
  new URL('../src/infra/sqlite/migrations/001_resources.sql', import.meta.url),
  'utf8',
);

const resourceRow = {
  id: 'res-aws-ec2-01',
  provider: 'aws',
  provider_resource_id: 'demo/aws/ec2/001',
  kind: 'ec2-instance',
  region: 'us-east-1',
  environment: 'development',
  owner: 'team-sandbox',
  tags_json: '{"purpose":"sandbox"}',
  monthly_cost_estimate_cents: 6900,
  utilization_metric: 'cpu',
  utilization_percent: 0,
  protected_from_changes: 0,
  has_restricted_tag: 0,
  has_policy_violation: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  version: 1,
};

const insertSql = `
  INSERT INTO resources (
    id, provider, provider_resource_id, kind, region, environment, owner, tags_json,
    monthly_cost_estimate_cents, utilization_metric, utilization_percent,
    protected_from_changes, has_restricted_tag, has_policy_violation,
    created_at, updated_at, version
  ) VALUES (
    @id, @provider, @provider_resource_id, @kind, @region, @environment, @owner, @tags_json,
    @monthly_cost_estimate_cents, @utilization_metric, @utilization_percent,
    @protected_from_changes, @has_restricted_tag, @has_policy_violation,
    @created_at, @updated_at, @version
  )
`;

function withMigratedDatabase(run: (database: SqliteConnection) => void): void {
  const database = openInMemoryTestDatabase();
  try {
    database.exec(migration);
    run(database);
  } finally {
    database.close();
  }
}

function insertResource(
  database: SqliteConnection,
  overrides: Partial<typeof resourceRow> = {},
): void {
  database.prepare(insertSql).run({ ...resourceRow, ...overrides });
}

describe('resource migration', () => {
  it('creates the domain columns, local primary key, and integer version', () => {
    withMigratedDatabase((database) => {
      const columns = database.pragma('table_info(resources)') as Array<{
        name: string;
        type: string;
        pk: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'provider',
        'provider_resource_id',
        'kind',
        'region',
        'environment',
        'owner',
        'tags_json',
        'monthly_cost_estimate_cents',
        'utilization_metric',
        'utilization_percent',
        'protected_from_changes',
        'has_restricted_tag',
        'has_policy_violation',
        'created_at',
        'updated_at',
        'version',
      ]);
      expect(columns.find((column) => column.name === 'id')?.pk).toBe(1);
      expect(columns.find((column) => column.name === 'version')?.type).toBe('INTEGER');
      insertResource(database);
      expect(database.prepare('SELECT count(*) AS total FROM resources').get()).toEqual({
        total: 1,
      });
    });
  });

  it('enforces unique local and provider identities', () => {
    withMigratedDatabase((database) => {
      insertResource(database);
      expect(() =>
        insertResource(database, { provider_resource_id: 'demo/aws/ec2/002' }),
      ).toThrow();
      expect(() => insertResource(database, { id: 'res-aws-ec2-02' })).toThrow();
      insertResource(database, {
        id: 'res-azure-vm-01',
        provider: 'azure',
        provider_resource_id: 'demo/aws/ec2/001',
        kind: 'virtual-machine',
      });
      expect(database.prepare('SELECT count(*) AS total FROM resources').get()).toEqual({
        total: 2,
      });
    });
  });

  it('rejects provider, kind, and utilization mismatches', () => {
    withMigratedDatabase((database) => {
      expect(() => insertResource(database, { provider: 'gcp' })).toThrow();
      expect(() => insertResource(database, { kind: 's3-bucket' })).toThrow();
      expect(() => insertResource(database, { utilization_metric: 'storage' })).toThrow();
      expect(() => insertResource(database, { environment: 'invalid' })).toThrow();
    });
  });

  it('rejects malformed JSON, invalid estimates, flags, versions, and timestamps', () => {
    withMigratedDatabase((database) => {
      expect(() => insertResource(database, { tags_json: '{broken' })).toThrow();
      expect(() => insertResource(database, { tags_json: '[]' })).toThrow();
      expect(() => insertResource(database, { monthly_cost_estimate_cents: -1 })).toThrow();
      expect(() => insertResource(database, { utilization_percent: 101 })).toThrow();
      expect(() => insertResource(database, { protected_from_changes: 2 })).toThrow();
      expect(() => insertResource(database, { version: 0 })).toThrow();
      expect(() => insertResource(database, { updated_at: '2025-01-01T00:00:00.000Z' })).toThrow();
    });
  });

  it('creates indexes for provider identity and filtered listings', () => {
    withMigratedDatabase((database) => {
      const indexes = database.pragma('index_list(resources)') as Array<{
        name: string;
        unique: number;
      }>;
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'resources_provider_identity_unique', unique: 1 }),
          expect.objectContaining({ name: 'resources_provider_kind_environment_id', unique: 0 }),
          expect.objectContaining({ name: 'resources_environment_id', unique: 0 }),
        ]),
      );
    });
  });
});
