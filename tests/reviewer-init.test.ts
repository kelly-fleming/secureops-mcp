import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runReviewerInitCommand,
  type ReviewerInitRuntime,
} from '../src/cli/commands/reviewer-init.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { verifyPasswordVerifier } from '../src/security/password.js';
import { withTestDatabase } from './helpers/test-db.js';

const passphrase = 'fictional-reviewer-passphrase-001';

function databasePath(database: SqliteConnection): string {
  const entries = database.pragma('database_list') as Array<{ name: string; file: string }>;
  const main = entries.find((entry) => entry.name === 'main');
  if (main === undefined || main.file.length === 0) throw new Error('Missing test database path');
  return main.file;
}

function promptRuntime(overrides: Partial<ReviewerInitRuntime> = {}): ReviewerInitRuntime {
  return {
    isInteractive: () => true,
    askUsername: async () => 'reviewer_one',
    askPassphrase: async () => passphrase,
    ...overrides,
  };
}

function identityCount(database: SqliteConnection): number {
  const row = database.prepare('SELECT count(*) AS total FROM local_identities').get() as {
    total: number;
  };
  return row.total;
}

describe('reviewer bootstrap command', () => {
  it('refuses non-TTY enrollment before prompting or touching the database', async () => {
    let prompted = false;
    const runtime = promptRuntime({
      isInteractive: () => false,
      askUsername: async () => {
        prompted = true;
        return 'reviewer_one';
      },
    });
    await expect(runReviewerInitCommand([], {}, process.cwd(), runtime)).rejects.toThrow(
      'interactive terminal',
    );
    expect(prompted).toBe(false);
  });

  it('requires an explicit existing local database and rejects extra CLI input', async () => {
    await withTestDatabase(async (database) => {
      const selectedPath = databasePath(database);
      const runtime = promptRuntime();
      await expect(runReviewerInitCommand([], {}, process.cwd(), runtime)).rejects.toThrow(
        'Usage:',
      );
      await expect(
        runReviewerInitCommand(
          ['--db-path', selectedPath, '--passphrase', passphrase],
          {},
          process.cwd(),
          runtime,
        ),
      ).rejects.toThrow('Usage:');
      await expect(
        runReviewerInitCommand(
          ['--db-path', join(dirname(selectedPath), 'missing.db')],
          {},
          process.cwd(),
          runtime,
        ),
      ).rejects.toThrow('existing regular local database');
      await expect(
        runReviewerInitCommand(
          ['--db-path', selectedPath],
          {
            SECUREOPS_MODE: 'http-demo',
            SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
            SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
          },
          process.cwd(),
          runtime,
        ),
      ).rejects.toThrow('local-full mode');
      expect(identityCount(database)).toBe(0);
    });
  });

  it('persists a reviewer with only salted verifier material', async () => {
    await withTestDatabase(async (database) => {
      const result = await runReviewerInitCommand(
        ['--db-path', databasePath(database)],
        { SECUREOPS_MODE: 'local-full' },
        process.cwd(),
        promptRuntime(),
      );
      expect(result).toEqual({ username: 'reviewer_one' });
      expect(identityCount(database)).toBe(1);

      const row = database
        .prepare(
          `
        SELECT username, role, disabled, password_kdf AS passwordKdf,
          password_salt AS passwordSalt, password_verifier AS passwordVerifier,
          scrypt_cost AS scryptCost, scrypt_block_size AS scryptBlockSize,
          scrypt_parallelization AS scryptParallelization
        FROM local_identities
      `,
        )
        .get() as {
        username: string;
        role: string;
        disabled: number;
        passwordKdf: 'scrypt';
        passwordSalt: Buffer;
        passwordVerifier: Buffer;
        scryptCost: number;
        scryptBlockSize: number;
        scryptParallelization: number;
      };
      expect(row.username).toBe('reviewer_one');
      expect(row.role).toBe('reviewer');
      expect(row.disabled).toBe(0);
      expect(Buffer.isBuffer(row.passwordSalt)).toBe(true);
      expect(Buffer.isBuffer(row.passwordVerifier)).toBe(true);
      expect(row.passwordSalt.includes(Buffer.from(passphrase))).toBe(false);
      expect(row.passwordVerifier.includes(Buffer.from(passphrase))).toBe(false);
      expect(await verifyPasswordVerifier(passphrase, row)).toBe(true);
      expect(await verifyPasswordVerifier('fictional-reviewer-passphrase-002', row)).toBe(false);
      const columns = database.pragma('table_info(local_identities)') as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('password');
    });
  });

  it('refuses a second bootstrap before asking for another identity', async () => {
    await withTestDatabase(async (database) => {
      const args = ['--db-path', databasePath(database)];
      await runReviewerInitCommand(args, {}, process.cwd(), promptRuntime());
      let prompted = false;
      await expect(
        runReviewerInitCommand(
          args,
          {},
          process.cwd(),
          promptRuntime({
            askUsername: async () => {
              prompted = true;
              return 'reviewer_two';
            },
          }),
        ),
      ).rejects.toThrow('already exists');
      expect(prompted).toBe(false);
      expect(identityCount(database)).toBe(1);
    });
  });

  it('refuses invalid username, short passphrase, and mismatched confirmation', async () => {
    await withTestDatabase(async (database) => {
      const args = ['--db-path', databasePath(database)];
      await expect(
        runReviewerInitCommand(
          args,
          {},
          process.cwd(),
          promptRuntime({
            askUsername: async () => 'Reviewer One',
          }),
        ),
      ).rejects.toThrow('Invalid reviewer username');
      await expect(
        runReviewerInitCommand(
          args,
          {},
          process.cwd(),
          promptRuntime({
            askPassphrase: async () => 'short',
          }),
        ),
      ).rejects.toThrow('Invalid reviewer passphrase');

      let calls = 0;
      await expect(
        runReviewerInitCommand(
          args,
          {},
          process.cwd(),
          promptRuntime({
            askPassphrase: async () =>
              ++calls === 1 ? passphrase : 'fictional-reviewer-passphrase-002',
          }),
        ),
      ).rejects.toThrow('did not match');
      expect(identityCount(database)).toBe(0);
    });
  });
});
