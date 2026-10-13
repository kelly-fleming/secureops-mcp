import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { applyMigrations } from '../../src/infra/sqlite/migrate.js';
import { seedDemoDatabase } from '../../src/infra/sqlite/seed.js';

export interface TestDatabaseOptions {
  readonly seed?: boolean;
}

function removeTestDirectory(directory: string, root: string): void {
  if (!existsSync(directory)) return;
  const target = realpathSync(directory);
  if (target !== directory || dirname(target) !== root || !basename(target).startsWith('db-')) {
    throw new Error('Refusing to remove a path outside the per-test directory.');
  }
  rmSync(target, { recursive: true, force: true });
}

function testDirectory(): string {
  const configured = process.env.SECUREOPS_TEST_DIR;
  if (configured === undefined) {
    throw new Error('Missing per-test temporary directory.');
  }
  let directory: string;
  try {
    directory = realpathSync(configured);
  } catch {
    throw new Error('Invalid per-test temporary directory.');
  }
  if (
    dirname(directory) !== realpathSync(tmpdir()) ||
    !basename(directory).startsWith('secureops-mcp-test-') ||
    !statSync(directory).isDirectory()
  ) {
    throw new Error('Invalid per-test temporary directory.');
  }
  return directory;
}

/** Creates a private SQLite file for one callback and always closes and removes it. */
export async function withTestDatabase<T>(
  run: (database: SqliteConnection) => T | Promise<T>,
  options: TestDatabaseOptions = {},
): Promise<T> {
  const root = testDirectory();
  const directory = realpathSync(mkdtempSync(join(root, 'db-')));
  let database: SqliteConnection | undefined;
  try {
    const config = loadConfig(
      { SECUREOPS_MODE: 'local-full', SECUREOPS_DB_PATH: join(directory, 'test.db') },
      root,
    );
    database = openConfiguredDatabase(config);
    applyMigrations(database);
    if (options.seed === true) {
      seedDemoDatabase(database);
    }
    return await run(database);
  } finally {
    try {
      database?.close();
    } finally {
      removeTestDirectory(directory, root);
    }
  }
}
