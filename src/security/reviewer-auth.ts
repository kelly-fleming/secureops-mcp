import { input, password } from '@inquirer/prompts';

import type { SqliteConnection } from '../infra/sqlite/connection.js';
import {
  authenticatedCliIdentityBrand,
  createAuthenticatedCliActor,
  type ActorContext,
  type AuthenticatedCliIdentity,
} from './permissions.js';
import { verifyPasswordVerifier, type PasswordVerifier } from './password.js';

const localIdentityPattern = /^[a-z][a-z0-9_-]{2,63}$/;
const maximumAttempts = 3;
const retryDelayMs = 350;

// Unavailable identities still incur the normal scrypt work for a valid attempt.
// These bytes are a public dummy value, never an account credential.
const unavailableIdentityVerifier: PasswordVerifier = {
  passwordKdf: 'scrypt',
  passwordSalt: Buffer.alloc(32),
  passwordVerifier: Buffer.alloc(64),
  scryptCost: 16_384,
  scryptBlockSize: 8,
  scryptParallelization: 1,
};

type CliRole = 'reviewer' | 'auditor';

export class CliAuthenticationError extends Error {
  constructor() {
    super('Authentication failed.');
    this.name = 'CliAuthenticationError';
  }
}

export class CliTerminalRequiredError extends Error {
  constructor() {
    super('CLI authentication requires an interactive terminal.');
    this.name = 'CliTerminalRequiredError';
  }
}

export interface ReviewerAuthRuntime {
  isInteractive(): boolean;
  askUsername(attempt: number): Promise<string>;
  askPassphrase(): Promise<string>;
  delay(milliseconds: number): Promise<void>;
}

const promptContext = { input: process.stdin, output: process.stderr };
const defaultRuntime: ReviewerAuthRuntime = {
  isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
  askUsername: (attempt) =>
    input({ message: `Local username (${attempt}/${maximumAttempts})` }, promptContext),
  askPassphrase: () =>
    password(
      {
        message: 'Passphrase',
        mask: '*',
        toggleMask: false,
      },
      promptContext,
    ),
  delay: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

interface StoredLocalIdentity {
  readonly id: unknown;
  readonly role: unknown;
  readonly disabled: unknown;
  readonly passwordKdf: unknown;
  readonly passwordSalt: unknown;
  readonly passwordVerifier: unknown;
  readonly scryptCost: unknown;
  readonly scryptBlockSize: unknown;
  readonly scryptParallelization: unknown;
}

interface CredentialMatch {
  readonly id: string;
  readonly role: CliRole;
}

function readLocalIdentity(
  database: SqliteConnection,
  username: string,
): StoredLocalIdentity | undefined {
  return database
    .prepare(
      `
    SELECT id, role, disabled, password_kdf AS passwordKdf,
      password_salt AS passwordSalt, password_verifier AS passwordVerifier,
      scrypt_cost AS scryptCost, scrypt_block_size AS scryptBlockSize,
      scrypt_parallelization AS scryptParallelization
    FROM local_identities WHERE username = ?
  `,
    )
    .get(username) as StoredLocalIdentity | undefined;
}

function sameActiveIdentity(
  original: StoredLocalIdentity,
  current: StoredLocalIdentity | undefined,
  requiredRole: CliRole,
): boolean {
  return (
    current !== undefined &&
    current.id === original.id &&
    current.role === requiredRole &&
    current.disabled === 0 &&
    current.passwordKdf === original.passwordKdf &&
    current.scryptCost === original.scryptCost &&
    current.scryptBlockSize === original.scryptBlockSize &&
    current.scryptParallelization === original.scryptParallelization &&
    Buffer.isBuffer(original.passwordSalt) &&
    Buffer.isBuffer(current.passwordSalt) &&
    current.passwordSalt.equals(original.passwordSalt) &&
    Buffer.isBuffer(original.passwordVerifier) &&
    Buffer.isBuffer(current.passwordVerifier) &&
    current.passwordVerifier.equals(original.passwordVerifier)
  );
}

/** Return only identity data after the stored credential and current state agree. */
async function verifyLocalCredentials(
  database: SqliteConnection,
  username: unknown,
  passphrase: unknown,
  requiredRole: CliRole,
): Promise<CredentialMatch | null> {
  if (
    typeof username !== 'string' ||
    !localIdentityPattern.test(username) ||
    (requiredRole !== 'reviewer' && requiredRole !== 'auditor')
  ) {
    await verifyPasswordVerifier(passphrase, unavailableIdentityVerifier);
    return null;
  }

  const row = readLocalIdentity(database, username);

  if (
    row === undefined ||
    typeof row.id !== 'string' ||
    !localIdentityPattern.test(row.id) ||
    row.role !== requiredRole ||
    row.disabled !== 0
  ) {
    await verifyPasswordVerifier(passphrase, unavailableIdentityVerifier);
    return null;
  }
  if (!(await verifyPasswordVerifier(passphrase, row))) return null;

  // Scrypt runs asynchronously. Refuse credentials replaced or disabled meanwhile.
  if (!sameActiveIdentity(row, readLocalIdentity(database, username), requiredRole)) return null;

  return Object.freeze({ id: row.id, role: requiredRole });
}

/** Authenticate a human on a terminal; the caller owns and closes the database. */
export async function authenticateCliActor(
  database: SqliteConnection,
  requiredRole: CliRole,
  runtime: ReviewerAuthRuntime = defaultRuntime,
): Promise<ActorContext> {
  let interactive: boolean;
  try {
    interactive = runtime.isInteractive();
  } catch {
    throw new CliAuthenticationError();
  }
  if (!interactive) throw new CliTerminalRequiredError();
  if (requiredRole !== 'reviewer' && requiredRole !== 'auditor') {
    throw new CliAuthenticationError();
  }

  try {
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const username = await runtime.askUsername(attempt);
      const passphrase = await runtime.askPassphrase();
      const match = await verifyLocalCredentials(database, username, passphrase, requiredRole);
      if (match !== null) {
        const identity: AuthenticatedCliIdentity = Object.freeze({
          id: match.id,
          role: match.role,
          [authenticatedCliIdentityBrand]: true as const,
        });
        return createAuthenticatedCliActor(identity);
      }
      await runtime.delay(retryDelayMs);
    }
  } catch {
    // Prompt, database, and verifier errors must never surface secret or SQL text.
    throw new CliAuthenticationError();
  }

  throw new CliAuthenticationError();
}
