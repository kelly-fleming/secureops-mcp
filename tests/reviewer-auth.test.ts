import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor, requireCapability } from '../src/security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { withTestDatabase } from './helpers/test-db.js';

const passphrase = 'fictional-reviewer-passphrase-001';
const wrongPassphrase = 'fictional-reviewer-passphrase-002';
const timestamp = '2026-01-01T00:00:00.000Z';

async function insertIdentity(
  database: SqliteConnection,
  username: string,
  role: 'reviewer' | 'auditor',
  disabled = false,
): Promise<string> {
  const id = `identity-${username}`;
  const verifier = await derivePasswordVerifier(passphrase);
  try {
    database
      .prepare(
        `
      INSERT INTO local_identities (
        id, username, role, disabled, password_kdf, password_salt,
        password_verifier, scrypt_cost, scrypt_block_size,
        scrypt_parallelization, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        username,
        role,
        Number(disabled),
        verifier.passwordKdf,
        verifier.passwordSalt,
        verifier.passwordVerifier,
        verifier.scryptCost,
        verifier.scryptBlockSize,
        verifier.scryptParallelization,
        timestamp,
        timestamp,
      );
  } finally {
    verifier.passwordSalt.fill(0);
    verifier.passwordVerifier.fill(0);
  }
  return id;
}

function promptRuntime(
  username: string,
  enteredPassphrase: string,
  attempts: number[] = [],
  delays: number[] = [],
): ReviewerAuthRuntime {
  return {
    isInteractive: () => true,
    askUsername: async (attempt) => {
      attempts.push(attempt);
      return username;
    },
    askPassphrase: async () => enteredPassphrase,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  };
}

describe('interactive CLI identity authentication', () => {
  it('issues a reviewer actor only after a matching enabled credential', async () => {
    await withTestDatabase(async (database) => {
      const id = await insertIdentity(database, 'reviewer_one', 'reviewer');
      const actor = await authenticateCliActor(
        database,
        'reviewer',
        promptRuntime('reviewer_one', passphrase),
      );
      expect(actor).toEqual({ role: 'reviewer', actorId: id, source: 'authenticated-cli' });
      expect(Object.isFrozen(actor)).toBe(true);
      expect(() => requireCapability(actor, 'review_proposals')).not.toThrow();
      expect(() => requireCapability(actor, 'decide_proposal')).not.toThrow();
      expect(() => requireCapability(actor, 'inspect_audit')).not.toThrow();
      expect(() => requireCapability(actor, 'verify_audit')).not.toThrow();
      expect(database.prepare('SELECT count(*) AS total FROM local_identities').get()).toEqual({
        total: 1,
      });
    });
  });

  it('uses the same generic failure for wrong, unknown, and disabled accounts', async () => {
    await withTestDatabase(async (database) => {
      await insertIdentity(database, 'reviewer_one', 'reviewer');
      await insertIdentity(database, 'reviewer_two', 'reviewer', true);
      for (const [username, enteredPassphrase] of [
        ['reviewer_one', wrongPassphrase],
        ['unknown_user', passphrase],
        ['reviewer_two', passphrase],
      ] as const) {
        await expect(
          authenticateCliActor(database, 'reviewer', promptRuntime(username, enteredPassphrase)),
        ).rejects.toMatchObject({
          name: 'CliAuthenticationError',
          message: 'Authentication failed.',
        });
      }
      expect(database.prepare('SELECT count(*) AS total FROM local_identities').get()).toEqual({
        total: 2,
      });
    });
  });

  it('separates auditor access from reviewer decisions', async () => {
    await withTestDatabase(async (database) => {
      const id = await insertIdentity(database, 'auditor_one', 'auditor');
      await expect(
        authenticateCliActor(database, 'reviewer', promptRuntime('auditor_one', passphrase)),
      ).rejects.toThrow('Authentication failed.');

      const actor = await authenticateCliActor(
        database,
        'auditor',
        promptRuntime('auditor_one', passphrase),
      );
      expect(actor.actorId).toBe(id);
      expect(actor.role).toBe('auditor');
      expect(() => requireCapability(actor, 'inspect_audit')).not.toThrow();
      expect(() => requireCapability(actor, 'verify_audit')).not.toThrow();
      expect(() => requireCapability(actor, 'decide_proposal')).toThrow();
    });
  });

  it('requires a terminal before prompting', async () => {
    await withTestDatabase(async (database) => {
      let prompted = false;
      const runtime = promptRuntime('reviewer_one', passphrase);
      runtime.isInteractive = () => false;
      runtime.askUsername = async () => {
        prompted = true;
        return 'reviewer_one';
      };
      await expect(authenticateCliActor(database, 'reviewer', runtime)).rejects.toThrow(
        'interactive terminal',
      );
      expect(prompted).toBe(false);
    });
  });

  it('bounds retries and delays every failed attempt', async () => {
    await withTestDatabase(async (database) => {
      await insertIdentity(database, 'reviewer_one', 'reviewer');
      const attempts: number[] = [];
      const delays: number[] = [];
      await expect(
        authenticateCliActor(
          database,
          'reviewer',
          promptRuntime('reviewer_one', wrongPassphrase, attempts, delays),
        ),
      ).rejects.toThrow('Authentication failed.');
      expect(attempts).toEqual([1, 2, 3]);
      expect(delays).toHaveLength(3);
      expect(delays.every((milliseconds) => milliseconds >= 200 && milliseconds <= 1_000)).toBe(
        true,
      );
    });
  });

  it('does not expose a thrown prompt error or entered secret', async () => {
    await withTestDatabase(async (database) => {
      const runtime = promptRuntime('reviewer_one', passphrase);
      runtime.askPassphrase = async () => {
        throw new Error(`prompt failed: ${passphrase}`);
      };
      await expect(authenticateCliActor(database, 'reviewer', runtime)).rejects.toMatchObject({
        name: 'CliAuthenticationError',
        message: 'Authentication failed.',
      });
    });
  });

  it('rejects agent and viewer role claims without prompting', async () => {
    await withTestDatabase(async (database) => {
      let prompted = false;
      const runtime = promptRuntime('reviewer_one', passphrase);
      runtime.askUsername = async () => {
        prompted = true;
        return 'reviewer_one';
      };
      for (const role of ['agent', 'viewer'] as const) {
        // Exercise the runtime guard against a caller that bypasses TypeScript.
        await expect(authenticateCliActor(database, role as never, runtime)).rejects.toThrow(
          'Authentication failed.',
        );
      }
      expect(prompted).toBe(false);

      const agent = createMcpActor(loadConfig({}, process.cwd()));
      expect(() => requireCapability(agent, 'decide_proposal')).toThrow();
    });
  });
});
