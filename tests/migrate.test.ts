import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runMigrationCommand } from '../src/cli/commands/migrate.js';
import { openInMemoryTestDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';
import {
  applyMigrations,
  discoverMigrations,
  type MigrationFile,
} from '../src/infra/sqlite/migrate.js';

function withDatabase(run: (database: SqliteConnection) => void): void {
  const database = openInMemoryTestDatabase();
  try {
    run(database);
  } finally {
    database.close();
  }
}

function testDirectory(): string {
  const directory = process.env.SECUREOPS_TEST_DIR;
  if (directory === undefined) throw new Error('Missing disposable test directory');
  return directory;
}

function migration(version: number, sql: string): MigrationFile {
  return {
    version,
    filename: `${String(version).padStart(3, '0')}_test.sql`,
    sql,
    checksum: createHash('sha256').update(sql).digest('hex'),
  };
}

describe('SQLite migrations', () => {
  it('discovers consecutive checked-in SQL files with stable checksums', () => {
    const migrations = discoverMigrations();
    expect(migrations.map((entry) => entry.version)).toEqual(
      migrations.map((_, index) => index + 1),
    );
    expect(migrations.slice(0, 3).map((entry) => entry.filename)).toEqual([
      '001_resources.sql',
      '002_workflows.sql',
      '003_auth_audit.sql',
    ]);
    for (const entry of migrations) {
      expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('applies an empty database once and records checksums', () => {
    withDatabase((database) => {
      const migrations = discoverMigrations();
      expect(applyMigrations(database, migrations)).toEqual({
        applied: migrations.length,
        currentVersion: migrations.length,
      });
      const rows = database
        .prepare(
          `
        SELECT version, filename, checksum, schema_checksum
        FROM schema_migrations ORDER BY version
      `,
        )
        .all() as Array<{
        version: number;
        filename: string;
        checksum: string;
        schema_checksum: string;
      }>;
      expect(
        rows.map(({ version, filename, checksum }) => ({ version, filename, checksum })),
      ).toEqual(
        migrations.map(({ version, filename, checksum }) => ({ version, filename, checksum })),
      );
      expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.schema_checksum))).toBe(true);
      expect(database.prepare('SELECT count(*) AS total FROM local_identities').get()).toEqual({
        total: 0,
      });
      expect(applyMigrations(database, migrations)).toEqual({
        applied: 0,
        currentVersion: migrations.length,
      });
    });
  });

  it('refuses a changed migration file without changing the journal', () => {
    const directory = path.join(testDirectory(), 'migrations');
    mkdirSync(directory);
    const filename = path.join(directory, '001_example.sql');
    writeFileSync(filename, 'CREATE TABLE example (id INTEGER PRIMARY KEY);');
    const original = discoverMigrations(directory);
    withDatabase((database) => {
      applyMigrations(database, original);
      writeFileSync(filename, 'CREATE TABLE example (id INTEGER PRIMARY KEY, note TEXT);');
      const altered = discoverMigrations(directory);
      expect(altered[0]?.checksum).not.toBe(original[0]?.checksum);
      expect(() => applyMigrations(database, altered)).toThrow('history does not match');
      expect(database.prepare('SELECT checksum FROM schema_migrations').get()).toEqual({
        checksum: original[0]?.checksum,
      });
    });
  });

  it('refuses existing schema objects without a matching journal history', () => {
    withDatabase((database) => {
      database.exec('CREATE TABLE orphan (id INTEGER PRIMARY KEY);');
      expect(() => applyMigrations(database)).toThrow('untracked schema');
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get(),
      ).toBeUndefined();
    });

    withDatabase((database) => {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY, filename TEXT, checksum TEXT,
          schema_checksum TEXT, applied_at TEXT
        );
      `);
      expect(() => applyMigrations(database)).toThrow('no recorded migrations');
    });
  });

  it('detects schema drift after a recorded migration', () => {
    withDatabase((database) => {
      applyMigrations(database);
      database.exec('DROP TABLE audit_events;');
      expect(() => applyMigrations(database)).toThrow('schema does not match');
    });
  });

  it('rolls back schema and journal changes when a migration fails', () => {
    withDatabase((database) => {
      const migrations = [
        migration(1, 'CREATE TABLE example (id INTEGER PRIMARY KEY);'),
        migration(2, 'CREATE TABLE broken ('),
      ];
      expect(() => applyMigrations(database, migrations)).toThrow();
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'example'").get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get(),
      ).toBeUndefined();
    });
  });

  it('requires an explicit local database path in the CLI', () => {
    const directory = testDirectory();
    expect(() => runMigrationCommand([], {}, directory)).toThrow('Usage:');
    expect(() =>
      runMigrationCommand(
        ['--db-path', path.join(directory, 'demo.db')],
        {
          SECUREOPS_MODE: 'http-demo',
          SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
          SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
        },
        directory,
      ),
    ).toThrow('requires local-full mode');
  });
});
