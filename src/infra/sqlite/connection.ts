import { lstatSync, mkdirSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { AppConfig } from '../../config.js';

const busyTimeoutMs = 5_000;

export type SqliteConnection = Database.Database;

/** Opens a configured connection. The caller owns it and must call close(). */
export function openConfiguredDatabase(config: AppConfig): SqliteConnection {
  // loadConfig resolves file paths; reject special SQLite targets such as :memory: here too.
  if (!path.isAbsolute(config.database.path)) {
    throw new Error('A configured database path must be absolute.');
  }

  if (config.mode === 'http-demo' && config.database.readOnly === true) {
    let isRegularFile: boolean;
    try {
      isRegularFile = statSync(config.database.path).isFile();
    } catch {
      throw new Error('The read-only demo database must be an existing regular file.');
    }
    if (!isRegularFile) {
      throw new Error('The read-only demo database must be an existing regular file.');
    }

    // fileMustExist is ignored by better-sqlite3 for read-only opens; the stat above is deliberate.
    return initializeConnection(
      new Database(config.database.path, {
        readonly: true,
        fileMustExist: true,
        timeout: busyTimeoutMs,
      }),
      'read-only',
    );
  }

  if (config.mode !== 'local-full' || config.database.readOnly !== false) {
    throw new Error('Database mode and access setting do not match.');
  }

  mkdirSync(path.dirname(config.database.path), { recursive: true });
  return initializeConnection(
    new Database(config.database.path, { timeout: busyTimeoutMs }),
    'writable-file',
  );
}

/** Opens an existing local database for protected reads without write access. */
export function openReadOnlyLocalDatabase(config: AppConfig): SqliteConnection {
  if (
    config.mode !== 'local-full' ||
    config.database.readOnly !== false ||
    !path.isAbsolute(config.database.path)
  ) {
    throw new Error('A configured local database is required.');
  }
  let entry: Stats;
  try {
    entry = lstatSync(config.database.path);
  } catch {
    throw new Error('An existing regular local database is required.');
  }
  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error('An existing regular local database is required.');
  }
  return initializeConnection(
    new Database(config.database.path, {
      readonly: true,
      fileMustExist: true,
      timeout: busyTimeoutMs,
    }),
    'read-only',
  );
}

/** Opens an isolated database for tests; application configuration cannot select it. */
export function openInMemoryTestDatabase(): SqliteConnection {
  return initializeConnection(new Database(':memory:', { timeout: busyTimeoutMs }), 'memory');
}

function initializeConnection(
  database: SqliteConnection,
  access: 'writable-file' | 'read-only' | 'memory',
): SqliteConnection {
  try {
    database.pragma('foreign_keys = ON');
    if (database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('SQLite foreign-key enforcement is unavailable.');
    }

    if (access === 'writable-file') {
      const journalMode = database.pragma('journal_mode = WAL', { simple: true });
      if (journalMode !== 'wal') {
        throw new Error('SQLite WAL mode is unavailable.');
      }
    } else if (access === 'read-only') {
      database.pragma('query_only = ON');
      if (database.pragma('query_only', { simple: true }) !== 1) {
        throw new Error('SQLite read-only query enforcement is unavailable.');
      }
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
