import { describe, expect, it } from 'vitest';

import { AuditService } from '../src/application/audit-service.js';
import {
  AuditCommandError,
  runAuditListCommand,
  runAuditVerifyCommand,
  type AuditPromptRuntime,
} from '../src/cli/commands/audit.js';
import { CliUsageError, parseCliArgs } from '../src/cli/index.js';
import { loadConfig } from '../src/config.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor } from '../src/security/permissions.js';
import type { ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const environment = { SECUREOPS_MODE: 'local-full' };
const timestamp = '2026-01-01T00:00:00.000Z';
const passphrase = 'fictional-audit-cli-passphrase-001';
const firstChange = {
  proposalId: 'proposal-audit-001',
  resourceId: 'res-aws-ec2-01',
  resourceVersion: 1,
  policyVersion: 'demo-v1',
  actionType: 'disable_compute' as const,
};
const secondChange = {
  ...firstChange,
  proposalId: 'proposal-audit-002',
  resourceId: 'res-aws-ec2-02',
};

function databasePath(database: SqliteConnection): string {
  const entries = database.pragma('database_list') as Array<{ name: string; file: string }>;
  const main = entries.find((entry) => entry.name === 'main');
  if (main === undefined || main.file.length === 0)
    throw new Error('Missing private test database.');
  return main.file;
}

async function enrollReader(
  database: SqliteConnection,
  role: 'reviewer' | 'auditor',
): Promise<void> {
  const verifier = await derivePasswordVerifier(passphrase);
  try {
    database
      .prepare(
        `
      INSERT INTO local_identities (
        id, username, role, disabled, password_kdf, password_salt,
        password_verifier, scrypt_cost, scrypt_block_size,
        scrypt_parallelization, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        `identity-audit-${role}`,
        `audit_${role}`,
        role,
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
}

function appendTrace(database: SqliteConnection): void {
  const audit = new AuditService(
    database,
    createFixedClock(timestamp),
    createSequentialIdGenerator(),
  );
  const agent = createMcpActor(loadConfig(environment, process.cwd()));
  database
    .transaction(() => {
      audit.recordExecutionAttempt(agent, firstChange);
      audit.recordExecutionResult(agent, { ...firstChange, outcome: 'conflict' });
      audit.recordExecutionAttempt(agent, secondChange);
    })
    .immediate();
}

function promptRuntime(
  options: {
    readonly role?: 'reviewer' | 'auditor';
    readonly username?: string;
    readonly enteredPassphrase?: string;
    readonly interactive?: boolean;
  } = {},
): { runtime: AuditPromptRuntime; prompts: string[] } {
  const prompts: string[] = [];
  const interactive = options.interactive ?? true;
  const role = options.role ?? 'auditor';
  const authRuntime: ReviewerAuthRuntime = {
    isInteractive: () => interactive,
    askUsername: async () => {
      prompts.push('username');
      return options.username ?? `audit_${role}`;
    },
    askPassphrase: async () => {
      prompts.push('passphrase');
      return options.enteredPassphrase ?? passphrase;
    },
    delay: async () => undefined,
  };
  return {
    prompts,
    runtime: {
      isInteractive: () => interactive,
      chooseRole: async () => {
        prompts.push('role');
        return role;
      },
      authRuntime,
    },
  };
}

function storedAuditRows(database: SqliteConnection): unknown[] {
  return database.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
}

describe('authenticated read-only audit CLI', () => {
  it('lists bounded proposal and resource traces for authenticated reviewer and auditor without writes', async () => {
    await withTestDatabase(async (database) => {
      await enrollReader(database, 'reviewer');
      await enrollReader(database, 'auditor');
      appendTrace(database);
      const before = storedAuditRows(database);
      const path = databasePath(database);
      const reviewer = promptRuntime({ role: 'reviewer' });
      const auditor = promptRuntime();

      const proposalPage = await runAuditListCommand(
        { databasePath: path, proposalId: firstChange.proposalId, limit: 1, offset: 1 },
        environment,
        process.cwd(),
        reviewer.runtime,
      );
      const resourceTrace = await runAuditListCommand(
        { databasePath: path, resourceId: secondChange.resourceId, limit: 100, offset: 0 },
        environment,
        process.cwd(),
        auditor.runtime,
      );

      expect(reviewer.prompts).toEqual(['role', 'username', 'passphrase']);
      expect(auditor.prompts).toEqual(['role', 'username', 'passphrase']);
      expect(proposalPage).toContain('#2 ');
      expect(proposalPage).toContain(firstChange.proposalId);
      expect(proposalPage).not.toContain('#1 ');
      expect(proposalPage).not.toContain(secondChange.proposalId);
      expect(resourceTrace).toContain('#3 ');
      expect(resourceTrace).toContain(secondChange.resourceId);
      expect(resourceTrace).not.toContain(firstChange.resourceId);
      expect(resourceTrace).not.toContain('event_json');
      expect(storedAuditRows(database)).toEqual(before);
    });
  });

  it('reports intact and broken stored chains without revealing payloads or modifying rows', async () => {
    await withTestDatabase(async (database) => {
      await enrollReader(database, 'auditor');
      appendTrace(database);
      const path = databasePath(database);
      const before = storedAuditRows(database);

      const intact = await runAuditVerifyCommand(
        { databasePath: path },
        environment,
        process.cwd(),
        promptRuntime().runtime,
      );
      expect(intact).toContain('consistent: 3 of 3 stored events verified');
      expect(intact).toContain('A deleted tail cannot be detected');
      expect(storedAuditRows(database)).toEqual(before);

      database
        .prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 2')
        .run('{"tampered":true}');
      const tampered = storedAuditRows(database);
      const broken = await runAuditVerifyCommand(
        { databasePath: path },
        environment,
        process.cwd(),
        promptRuntime().runtime,
      );
      expect(broken).toContain('inconsistent at sequence 2 (hash_mismatch); 1 of 3');
      expect(broken).not.toContain('tampered');
      expect(storedAuditRows(database)).toEqual(tampered);
    });
  });

  it('does not print extra stored payload text from an audit listing', async () => {
    await withTestDatabase(async (database) => {
      await enrollReader(database, 'auditor');
      appendTrace(database);
      const sensitiveMarker = 'stored-payload-must-stay-hidden';
      database
        .prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 1')
        .run(JSON.stringify({ resourceId: firstChange.resourceId, note: sensitiveMarker }));
      const before = storedAuditRows(database);

      const output = await runAuditListCommand(
        { databasePath: databasePath(database), limit: 1 },
        environment,
        process.cwd(),
        promptRuntime().runtime,
      );
      expect(output).toContain(firstChange.resourceId);
      expect(output).not.toContain(sensitiveMarker);
      expect(output).toContain('listing does not verify integrity');
      expect(storedAuditRows(database)).toEqual(before);
    });
  });

  it('refuses nonterminal and invalid credentials before exposing audit data', async () => {
    await withTestDatabase(async (database) => {
      await enrollReader(database, 'reviewer');
      appendTrace(database);
      const path = databasePath(database);
      const before = storedAuditRows(database);
      const nonterminal = promptRuntime({ interactive: false });
      const wrongSecret = promptRuntime({ role: 'reviewer', enteredPassphrase: 'wrong-secret' });
      const wrongRole = promptRuntime({ role: 'auditor', username: 'audit_reviewer' });

      await expect(
        runAuditListCommand(
          { databasePath: path },
          environment,
          process.cwd(),
          nonterminal.runtime,
        ),
      ).rejects.toThrow(AuditCommandError);
      expect(nonterminal.prompts).toEqual([]);
      await expect(
        runAuditListCommand(
          { databasePath: path },
          environment,
          process.cwd(),
          wrongSecret.runtime,
        ),
      ).rejects.toThrow('Authentication failed.');
      await expect(
        runAuditVerifyCommand(
          { databasePath: path },
          environment,
          process.cwd(),
          wrongRole.runtime,
        ),
      ).rejects.toThrow('Authentication failed.');
      database
        .prepare('UPDATE local_identities SET disabled = 1 WHERE username = ?')
        .run('audit_reviewer');
      await expect(
        runAuditVerifyCommand(
          { databasePath: path },
          environment,
          process.cwd(),
          promptRuntime({ role: 'reviewer' }).runtime,
        ),
      ).rejects.toThrow('Authentication failed.');
      expect(storedAuditRows(database)).toEqual(before);
    });
  });

  it('rejects conflicting filters, out-of-range paging, and caller-supplied authority', async () => {
    await withTestDatabase(async (database) => {
      const path = databasePath(database);
      const prompts = promptRuntime();
      const before = storedAuditRows(database);

      expect(() =>
        parseCliArgs([
          'audit:list',
          '--db-path',
          path,
          '--proposal-id',
          firstChange.proposalId,
          '--resource-id',
          firstChange.resourceId,
        ]),
      ).toThrow(CliUsageError);
      expect(() => parseCliArgs(['audit:list', '--db-path', path, '--limit', '101'])).toThrow(
        CliUsageError,
      );
      expect(() => parseCliArgs(['audit:list', '--db-path', path, '--offset', '10001'])).toThrow(
        CliUsageError,
      );
      expect(() => parseCliArgs(['audit:verify', '--db-path', path, '--role', 'auditor'])).toThrow(
        CliUsageError,
      );
      await expect(
        runAuditListCommand(
          {
            databasePath: path,
            proposalId: firstChange.proposalId,
            resourceId: firstChange.resourceId,
          },
          environment,
          process.cwd(),
          prompts.runtime,
        ),
      ).rejects.toThrow(AuditCommandError);
      await expect(
        runAuditListCommand(
          { databasePath: path, limit: 0 },
          environment,
          process.cwd(),
          prompts.runtime,
        ),
      ).rejects.toThrow(AuditCommandError);
      expect(prompts.prompts).toEqual([]);
      expect(storedAuditRows(database)).toEqual(before);
    });
  });
});
