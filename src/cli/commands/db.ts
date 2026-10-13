import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../config.js';
import { openConfiguredDatabase } from '../../infra/sqlite/connection.js';
import { applyMigrations, discoverMigrations } from '../../infra/sqlite/migrate.js';
import { loadSeedResources, resetDemoDatabase, seedDemoDatabase } from '../../infra/sqlite/seed.js';

type DatabaseAction = 'seed' | 'reset';

class DatabaseUsageError extends Error {}

function parseCommand(args: readonly string[]): { action: DatabaseAction; databasePath: string } {
  const [action, pathFlag, databasePath, confirmation] = args;
  if (
    (action !== 'seed' && action !== 'reset') ||
    pathFlag !== '--db-path' ||
    databasePath === undefined ||
    databasePath.length === 0 ||
    (action === 'seed' && args.length !== 3) ||
    (action === 'reset' && (args.length !== 4 || confirmation !== '--force'))
  ) {
    throw new DatabaseUsageError(
      'Usage: npm run db:seed -- --db-path data/demo/secureops-demo.db; ' +
        'npm run db:reset -- --db-path data/demo/secureops-demo.db --force',
    );
  }
  return { action, databasePath };
}

function assertSafePathEntry(entryPath: string, kind: 'directory' | 'file'): void {
  try {
    const entry = lstatSync(entryPath);
    if (
      entry.isSymbolicLink() ||
      (kind === 'directory' && !entry.isDirectory()) ||
      (kind === 'file' && (!entry.isFile() || entry.nlink !== 1))
    ) {
      throw new DatabaseUsageError('Demo database path is not a regular local path.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function assertDemoDatabasePath(selectedPath: string, workingDirectory: string): void {
  const demoDirectory = path.resolve(workingDirectory, 'data', 'demo');
  const expectedPath = path.join(demoDirectory, 'secureops-demo.db');
  const comparable = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(selectedPath) !== comparable(expectedPath)) {
    throw new DatabaseUsageError('Seed and reset require data/demo/secureops-demo.db.');
  }

  assertSafePathEntry(path.resolve(workingDirectory, 'data'), 'directory');
  assertSafePathEntry(demoDirectory, 'directory');
  assertSafePathEntry(expectedPath, 'file');
}

/** Seeds or resets only the explicitly selected, disposable local demo database. */
export function runDatabaseCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): { action: DatabaseAction; resourceCount: number } {
  const { action, databasePath } = parseCommand(args);
  const config = loadConfig({ ...environment, SECUREOPS_DB_PATH: databasePath }, workingDirectory);
  if (config.mode !== 'local-full') {
    throw new DatabaseUsageError('Database seed and reset require local-full mode.');
  }
  assertDemoDatabasePath(config.database.path, workingDirectory);

  // Reject invalid fixture and migration assets before opening or creating a database file.
  const resources = loadSeedResources();
  const migrations = discoverMigrations();
  const database = openConfiguredDatabase(config);
  try {
    applyMigrations(database, migrations);
    return {
      action,
      resourceCount:
        action === 'seed'
          ? seedDemoDatabase(database, resources)
          : resetDemoDatabase(database, resources),
    };
  } finally {
    database.close();
  }
}

function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(path.resolve(entryPoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const result = runDatabaseCommand(process.argv.slice(2));
    process.stdout.write(
      `${result.action === 'seed' ? 'Seeded' : 'Restored'} ${result.resourceCount} demo resources.\n`,
    );
  } catch (error) {
    // Filesystem, SQLite, and config errors may contain sensitive local details.
    const message =
      error instanceof DatabaseUsageError ? error.message : 'Demo database command failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
