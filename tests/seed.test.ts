import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runDatabaseCommand } from '../src/cli/commands/db.js';
import { openInMemoryTestDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';
import { applyMigrations, discoverMigrations } from '../src/infra/sqlite/migrate.js';
import {
  loadSeedResources,
  resetDemoDatabase,
  seedDemoDatabase,
} from '../src/infra/sqlite/seed.js';

function testDirectory(): string {
  const directory = process.env.SECUREOPS_TEST_DIR;
  if (directory === undefined) throw new Error('Missing disposable test directory');
  return directory;
}

function withMigratedDatabase(run: (database: SqliteConnection) => void): void {
  const database = openInMemoryTestDatabase();
  try {
    applyMigrations(database);
    run(database);
  } finally {
    database.close();
  }
}

function count(database: SqliteConnection, table: string): number {
  const allowedTables = new Set([
    'resources',
    'proposals',
    'approval_decisions',
    'executions',
    'local_identities',
    'audit_events',
  ]);
  if (!allowedTables.has(table)) throw new Error('Unexpected test table');
  const row = database.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

describe('disposable demo seeding', () => {
  it('loads ordered, fictional fixture resources and rejects invalid input', () => {
    const resources = loadSeedResources();
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.map((resource) => resource.id)).toEqual(
      [...resources.map((resource) => resource.id)].sort(),
    );

    const badFixture = path.join(testDirectory(), 'invalid.json');
    writeFileSync(badFixture, JSON.stringify([{ id: 'res-invalid', provider: 'aws' }]));
    expect(() => loadSeedResources(pathToFileURL(badFixture))).toThrow('invalid resource');
  });

  it('inserts only missing resources and preserves a changed resource on repeat seed', () => {
    withMigratedDatabase((database) => {
      const resources = loadSeedResources();
      expect(seedDemoDatabase(database, resources)).toBe(resources.length);
      database.prepare('UPDATE resources SET version = 2 WHERE id = ?').run(resources[0]?.id);
      expect(seedDemoDatabase(database, resources)).toBe(0);
      expect(
        database.prepare('SELECT version FROM resources WHERE id = ?').get(resources[0]?.id),
      ).toEqual({ version: 2 });
      expect(count(database, 'resources')).toBe(resources.length);
    });
  });

  it('restores fixture resources and clears workflow, identity, and audit rows', () => {
    withMigratedDatabase((database) => {
      const resources = loadSeedResources();
      seedDemoDatabase(database, resources);
      const resourceId = resources[0]?.id;
      database.prepare('UPDATE resources SET version = 2 WHERE id = ?').run(resourceId);
      database
        .prepare(
          `
        INSERT INTO proposals (
          id, resource_id, proposer_actor_id, action_type, requested_change_json,
          reason, expected_resource_version, idempotency_key, request_fingerprint,
          policy_snapshot_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          'proposal-demo',
          resourceId,
          'agent-demo',
          'disable_compute',
          '{}',
          'Demo only',
          2,
          'seed-test',
          'a'.repeat(64),
          '{}',
          'draft',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      database
        .prepare(
          `
        INSERT INTO local_identities (
          id, username, role, disabled, password_kdf, password_salt,
          password_verifier, scrypt_cost, scrypt_block_size, scrypt_parallelization,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          'reviewer-demo',
          'reviewer_demo',
          'reviewer',
          0,
          'scrypt',
          Buffer.alloc(16),
          Buffer.alloc(32),
          16384,
          8,
          1,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      database
        .prepare(
          `
        INSERT INTO audit_events (
          sequence, id, actor_type, actor_id, action, subject_type, subject_id,
          event_json, occurred_at, previous_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          1,
          'event-demo',
          'system',
          'seed-test',
          'demo',
          'resource',
          resourceId,
          '{}',
          '2026-01-01T00:00:00.000Z',
          null,
          'a'.repeat(64),
        );

      expect(resetDemoDatabase(database, resources)).toBe(resources.length);
      expect(count(database, 'resources')).toBe(resources.length);
      for (const table of [
        'proposals',
        'approval_decisions',
        'executions',
        'local_identities',
        'audit_events',
      ]) {
        expect(count(database, table)).toBe(0);
      }
      expect(
        database.prepare('SELECT version FROM resources WHERE id = ?').get(resourceId),
      ).toEqual({ version: 1 });
      expect(database.prepare('SELECT count(*) AS total FROM schema_migrations').get()).toEqual({
        total: discoverMigrations().length,
      });
    });
  });

  it('refuses to seed or reset an inventory outside the fictional fixture', () => {
    withMigratedDatabase((database) => {
      const resources = loadSeedResources();
      seedDemoDatabase(database, resources);
      database
        .prepare(
          `
        UPDATE resources SET id = 'res-foreign-001', provider_resource_id = 'demo/aws/other'
        WHERE id = ?
      `,
        )
        .run(resources[0]?.id);
      expect(() => seedDemoDatabase(database, resources)).toThrow('outside the fictional demo');
      expect(() => resetDemoDatabase(database, resources)).toThrow('outside the fictional demo');
      expect(count(database, 'resources')).toBe(resources.length);
    });
  });

  it('requires force and the dedicated path before opening a database', () => {
    const workingDirectory = testDirectory();
    const demoPath = path.join(workingDirectory, 'data', 'demo', 'secureops-demo.db');
    expect(() =>
      runDatabaseCommand(['reset', '--db-path', demoPath], {}, workingDirectory),
    ).toThrow('Usage:');
    expect(existsSync(demoPath)).toBe(false);
    expect(() =>
      runDatabaseCommand(
        ['seed', '--db-path', path.join(workingDirectory, 'production.db')],
        {},
        workingDirectory,
      ),
    ).toThrow('data/demo/secureops-demo.db');
    expect(() =>
      runDatabaseCommand(
        ['seed', '--db-path', demoPath],
        {
          SECUREOPS_MODE: 'http-demo',
          SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
          SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
        },
        workingDirectory,
      ),
    ).toThrow('local-full mode');
  });

  it('runs seed and forced reset against the selected disposable file', () => {
    const workingDirectory = testDirectory();
    const demoPath = path.join(workingDirectory, 'data', 'demo', 'secureops-demo.db');
    const command = ['--db-path', demoPath];
    expect(runDatabaseCommand(['seed', ...command], {}, workingDirectory)).toEqual({
      action: 'seed',
      resourceCount: loadSeedResources().length,
    });
    expect(runDatabaseCommand(['seed', ...command], {}, workingDirectory)).toEqual({
      action: 'seed',
      resourceCount: 0,
    });
    expect(runDatabaseCommand(['reset', ...command, '--force'], {}, workingDirectory)).toEqual({
      action: 'reset',
      resourceCount: loadSeedResources().length,
    });
  });
});
