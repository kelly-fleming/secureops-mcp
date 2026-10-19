import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { input, password } from '@inquirer/prompts';

import { createCliDiagnosticLogger, withCliDiagnostics } from '../diagnostics.js';
import { loadConfig } from '../../config.js';
import { openConfiguredDatabase, type SqliteConnection } from '../../infra/sqlite/connection.js';
import {
  applyMigrations,
  discoverMigrations,
  type MigrationFile,
} from '../../infra/sqlite/migrate.js';
import {
  derivePasswordVerifier,
  isAcceptablePassphrase,
  maximumPassphraseBytes,
  minimumPassphraseLength,
} from '../../security/password.js';

const usernamePattern = /^[a-z][a-z0-9_-]{2,63}$/;
const usage = 'Usage: npm run reviewer:init -- --db-path <existing local .db path>';
const existingIdentityMessage =
  'A local identity already exists. Further enrollment requires an authenticated reviewer flow or the documented demo reset.';

class ReviewerInitError extends Error {}

export interface ReviewerInitRuntime {
  isInteractive(): boolean;
  askUsername(): Promise<string>;
  askPassphrase(message: string): Promise<string>;
}

const promptContext = { input: process.stdin, output: process.stderr };
const defaultRuntime: ReviewerInitRuntime = {
  isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
  askUsername: () =>
    input(
      {
        message: 'Reviewer username',
        validate: (value) =>
          usernamePattern.test(value) ||
          'Use 3 to 64 lowercase ASCII letters, digits, underscores, or hyphens; start with a letter.',
      },
      promptContext,
    ),
  askPassphrase: (message) =>
    password(
      {
        message,
        mask: '*',
        toggleMask: false,
        validate: (value) =>
          isAcceptablePassphrase(value) ||
          `Use at least ${minimumPassphraseLength} characters and at most ${maximumPassphraseBytes} UTF-8 bytes.`,
      },
      promptContext,
    ),
};

function selectedDatabasePath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--db-path' || !args[1]) {
    throw new ReviewerInitError(usage);
  }
  return args[1];
}

function requireExistingRegularDatabase(databasePath: string): void {
  try {
    const entry = lstatSync(databasePath);
    if (entry.isFile() && entry.nlink === 1) return;
  } catch {
    // The enrollment command must not create a new database at a mistyped path.
  }
  throw new ReviewerInitError('Select an existing regular local database file.');
}

function requireAppliedMigrations(
  database: SqliteConnection,
  migrations: readonly MigrationFile[],
): void {
  // If a migration is pending, the outer rollback undoes its nested savepoint.
  database
    .transaction(() => {
      if (applyMigrations(database, migrations).applied !== 0) {
        throw new ReviewerInitError('Apply database migrations before reviewer enrollment.');
      }
    })
    .immediate();
}

function hasLocalIdentity(database: SqliteConnection): boolean {
  return database.prepare('SELECT 1 FROM local_identities LIMIT 1').get() !== undefined;
}

/** Bootstrap the first local reviewer through a real terminal only. */
export async function runReviewerInitCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  runtime: ReviewerInitRuntime = defaultRuntime,
): Promise<{ readonly username: string }> {
  if (!runtime.isInteractive())
    throw new ReviewerInitError('Reviewer enrollment requires an interactive terminal.');
  const databasePath = selectedDatabasePath(args);
  const config = loadConfig({ ...environment, SECUREOPS_DB_PATH: databasePath }, workingDirectory);
  if (config.mode !== 'local-full')
    throw new ReviewerInitError('Reviewer enrollment requires local-full mode.');

  requireExistingRegularDatabase(config.database.path);
  const migrations = discoverMigrations();
  const database = openConfiguredDatabase(config);
  try {
    requireAppliedMigrations(database, migrations);
    if (hasLocalIdentity(database)) throw new ReviewerInitError(existingIdentityMessage);

    const username = await runtime.askUsername();
    if (!usernamePattern.test(username)) throw new ReviewerInitError('Invalid reviewer username.');

    const passphrase = await runtime.askPassphrase('New reviewer passphrase');
    if (!isAcceptablePassphrase(passphrase))
      throw new ReviewerInitError('Invalid reviewer passphrase.');
    const confirmation = await runtime.askPassphrase('Confirm reviewer passphrase');
    if (confirmation !== passphrase) throw new ReviewerInitError('Passphrases did not match.');

    const derived = await derivePasswordVerifier(passphrase);
    try {
      database
        .transaction(() => {
          if (hasLocalIdentity(database)) throw new ReviewerInitError(existingIdentityMessage);
          const timestamp = new Date().toISOString();
          database
            .prepare(
              `
          INSERT INTO local_identities (
            id, username, role, disabled, password_kdf, password_salt,
            password_verifier, scrypt_cost, scrypt_block_size,
            scrypt_parallelization, created_at, updated_at
          ) VALUES (?, ?, 'reviewer', 0, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            )
            .run(
              `identity-${randomUUID()}`,
              username,
              derived.passwordKdf,
              derived.passwordSalt,
              derived.passwordVerifier,
              derived.scryptCost,
              derived.scryptBlockSize,
              derived.scryptParallelization,
              timestamp,
              timestamp,
            );
        })
        .immediate();
    } finally {
      derived.passwordSalt.fill(0);
      derived.passwordVerifier.fill(0);
    }
    return { username };
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
      'reviewer:init',
      () => runReviewerInitCommand(process.argv.slice(2)),
    );
    process.stdout.write(`Enrolled local reviewer ${result.username}.\n`);
  } catch (error) {
    const message =
      error instanceof ReviewerInitError
        ? error.message
        : error instanceof Error &&
            (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')
          ? 'Reviewer enrollment canceled.'
          : 'Reviewer enrollment failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
