import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliDiagnosticLogger, withCliDiagnostics } from '../diagnostics.js';
import { loadConfig } from '../../config.js';
import { openConfiguredDatabase } from '../../infra/sqlite/connection.js';
import {
  applyMigrations,
  discoverMigrations,
  type MigrationResult,
} from '../../infra/sqlite/migrate.js';

class MigrationUsageError extends Error {}

function selectedDatabasePath(args: readonly string[]): string {
  if (
    args.length !== 2 ||
    args[0] !== '--db-path' ||
    args[1] === undefined ||
    args[1].length === 0
  ) {
    throw new MigrationUsageError('Usage: npm run db:migrate -- --db-path <local .db path>');
  }
  return args[1];
}

/** Runs only when a caller explicitly selects a local database. */
export function runMigrationCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): MigrationResult {
  const databasePath = selectedDatabasePath(args);
  const config = loadConfig({ ...environment, SECUREOPS_DB_PATH: databasePath }, workingDirectory);
  if (config.mode !== 'local-full') {
    throw new MigrationUsageError('db:migrate requires local-full mode.');
  }

  const migrations = discoverMigrations();
  const database = openConfiguredDatabase(config);
  try {
    return applyMigrations(database, migrations);
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
    const result = await withCliDiagnostics(
      createCliDiagnosticLogger(process.env),
      'db:migrate',
      () => runMigrationCommand(process.argv.slice(2)),
    );
    process.stdout.write(
      `Applied ${result.applied} migration(s); schema version ${result.currentVersion}.\n`,
    );
  } catch (error) {
    // SQLite errors may contain SQL or a local path; CLI diagnostics stay fixed.
    const message =
      error instanceof MigrationUsageError ? error.message : 'Database migration failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
