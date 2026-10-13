import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SqliteConnection } from './connection.js';

const migrationDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));
const migrationNamePattern = /^([0-9]{3})_[a-z][a-z0-9_-]*\.sql$/;
const maxMigrationBytes = 1_048_576;

export interface MigrationFile {
  readonly version: number;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: number;
  readonly currentVersion: number;
}

interface JournalRow {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
  readonly schema_checksum: string;
}

interface SchemaObject {
  readonly name: string;
  readonly type: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

const createJournalSql = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
    filename TEXT NOT NULL UNIQUE CHECK (length(filename) BETWEEN 1 AND 128),
    checksum TEXT NOT NULL CHECK (
      length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'
    ),
    schema_checksum TEXT NOT NULL CHECK (
      length(schema_checksum) = 64 AND schema_checksum NOT GLOB '*[^0-9a-f]*'
    ),
    applied_at TEXT NOT NULL CHECK (length(applied_at) > 0)
  ) STRICT
`;

function readApplicationSchema(database: SqliteConnection): SchemaObject[] {
  return database
    .prepare(
      `
      SELECT name, type, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
      ORDER BY type, name
    `,
    )
    .all() as SchemaObject[];
}

function schemaChecksum(database: SqliteConnection): string {
  const schema = readApplicationSchema(database);
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

/** Checks the complete migration history and current schema without writing. */
export function requireCurrentMigrations(
  database: SqliteConnection,
  migrations: readonly MigrationFile[] = discoverMigrations(),
): void {
  if (migrations.length === 0) throw new Error('No SQL migrations were supplied.');
  database.transaction(() => {
    const journal = database
      .prepare("SELECT type FROM sqlite_schema WHERE name = 'schema_migrations'")
      .get() as { type: string } | undefined;
    if (journal?.type !== 'table') throw new Error('Migration journal is missing.');
    const appliedRows = database
      .prepare(
        'SELECT version, filename, checksum, schema_checksum FROM schema_migrations ORDER BY version',
      )
      .all() as JournalRow[];
    if (appliedRows.length !== migrations.length) {
      throw new Error('Database migrations are not current.');
    }
    for (const [index, applied] of appliedRows.entries()) {
      const expected = migrations[index];
      if (
        expected === undefined ||
        applied.version !== expected.version ||
        applied.filename !== expected.filename ||
        applied.checksum !== expected.checksum
      ) {
        throw new Error('Applied migration history does not match the SQL files.');
      }
    }
    if (appliedRows[appliedRows.length - 1]?.schema_checksum !== schemaChecksum(database)) {
      throw new Error('Database schema does not match the migration journal.');
    }
  })();
}

/** Reads numbered SQL assets without opening or changing a database. */
export function discoverMigrations(
  directory: string = migrationDirectory,
): readonly MigrationFile[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error('Migration directory could not be read.');
  }

  const sqlFiles = entries.filter((entry) => entry.name.endsWith('.sql'));
  if (sqlFiles.length === 0) {
    throw new Error('No SQL migrations were found.');
  }
  sqlFiles.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const migrations = sqlFiles.map((entry, index): MigrationFile => {
    const match = migrationNamePattern.exec(entry.name);
    if (!entry.isFile() || match === null || Number(match[1]) !== index + 1) {
      throw new Error('SQL migrations must be regular files with consecutive numbered names.');
    }

    const filePath = path.join(directory, entry.name);
    let bytes: Buffer;
    try {
      const fileSize = statSync(filePath).size;
      if (fileSize === 0 || fileSize > maxMigrationBytes) {
        throw new Error('Invalid migration size');
      }
      bytes = readFileSync(filePath);
    } catch {
      throw new Error('A SQL migration could not be read.');
    }
    if (bytes.length === 0 || bytes.length > maxMigrationBytes) {
      throw new Error('A SQL migration has an invalid size.');
    }

    let sql: string;
    try {
      sql = decoder.decode(bytes);
    } catch {
      throw new Error('A SQL migration is not valid UTF-8.');
    }
    if (sql.trim().length === 0) {
      throw new Error('A SQL migration is empty.');
    }

    return Object.freeze({
      version: index + 1,
      filename: entry.name,
      sql,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  return Object.freeze(migrations);
}

/** Applies trusted, discovered SQL files and their journal rows atomically. */
export function applyMigrations(
  database: SqliteConnection,
  migrations: readonly MigrationFile[] = discoverMigrations(),
): MigrationResult {
  const newestMigration = migrations[migrations.length - 1];
  if (newestMigration === undefined) {
    throw new Error('No SQL migrations were supplied.');
  }
  if (database.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('SQLite foreign-key enforcement is required for migrations.');
  }

  const migrate = database.transaction((): MigrationResult => {
    const schemaObjects = database
      .prepare("SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all() as Pick<SchemaObject, 'name' | 'type'>[];
    const journal = schemaObjects.find((object) => object.name === 'schema_migrations');

    if (journal === undefined) {
      if (schemaObjects.length !== 0) {
        throw new Error('Database has an untracked schema; refusing to migrate.');
      }
      database.exec(createJournalSql);
    } else if (journal.type !== 'table') {
      throw new Error('Migration journal is not a table.');
    }

    const appliedRows = database
      .prepare(
        'SELECT version, filename, checksum, schema_checksum FROM schema_migrations ORDER BY version',
      )
      .all() as JournalRow[];
    if (journal !== undefined && appliedRows.length === 0) {
      throw new Error('Database has a migration journal but no recorded migrations.');
    }

    for (const [index, applied] of appliedRows.entries()) {
      const current = migrations[index];
      if (
        applied.version !== index + 1 ||
        current === undefined ||
        applied.filename !== current.filename ||
        applied.checksum !== current.checksum
      ) {
        throw new Error('Applied migration history does not match the SQL files.');
      }
    }
    const lastApplied = appliedRows[appliedRows.length - 1];
    if (lastApplied !== undefined && lastApplied.schema_checksum !== schemaChecksum(database)) {
      throw new Error('Database schema does not match the migration journal.');
    }

    const insertJournal = database.prepare(`
      INSERT INTO schema_migrations (version, filename, checksum, schema_checksum, applied_at)
      VALUES (@version, @filename, @checksum, @schema_checksum, @applied_at)
    `);
    for (const migration of migrations.slice(appliedRows.length)) {
      database.exec(migration.sql);
      insertJournal.run({
        version: migration.version,
        filename: migration.filename,
        checksum: migration.checksum,
        schema_checksum: schemaChecksum(database),
        applied_at: new Date().toISOString(),
      });
    }

    return {
      applied: migrations.length - appliedRows.length,
      currentVersion: newestMigration.version,
    };
  });

  return migrate.immediate();
}
