import { describe, expect, it } from 'vitest';

import { AuditService } from '../src/application/audit-service.js';
import { AuditVerificationService } from '../src/application/audit-verification-service.js';
import { loadConfig } from '../src/config.js';
import { ForbiddenError } from '../src/domain/errors.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { derivePasswordVerifier } from '../src/security/password.js';
import { createMcpActor, type ActorContext } from '../src/security/permissions.js';
import { authenticateCliActor, type ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const passphrase = 'fictional-audit-verification-passphrase';
const change = {
  proposalId: 'proposal-audit-001',
  resourceId: 'res-aws-ec2-01',
  resourceVersion: 1,
  policyVersion: 'demo-v1',
  actionType: 'disable_compute' as const,
};

async function authenticatedAuditor(database: SqliteConnection): Promise<ActorContext> {
  const verifier = await derivePasswordVerifier(passphrase);
  try {
    database
      .prepare(
        `
      INSERT INTO local_identities (
        id, username, role, disabled, password_kdf, password_salt,
        password_verifier, scrypt_cost, scrypt_block_size,
        scrypt_parallelization, created_at, updated_at
      ) VALUES (?, ?, 'auditor', 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        'identity-audit-verifier',
        'audit_verifier',
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
  const runtime: ReviewerAuthRuntime = {
    isInteractive: () => true,
    askUsername: async () => 'audit_verifier',
    askPassphrase: async () => passphrase,
    delay: async () => undefined,
  };
  return authenticateCliActor(database, 'auditor', runtime);
}

function appendThreeEvents(database: SqliteConnection): void {
  const audit = new AuditService(
    database,
    createFixedClock(timestamp),
    createSequentialIdGenerator(),
  );
  const agent = createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
  database
    .transaction(() => {
      audit.recordExecutionAttempt(agent, change);
      audit.recordExecutionResult(agent, { ...change, outcome: 'conflict' });
      audit.recordExecutionAttempt(agent, change);
    })
    .immediate();
}

describe('audit-chain verification', () => {
  it('reports a valid chain and checks every event without changing records', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      appendThreeEvents(database);
      const before = database.prepare('SELECT * FROM audit_events ORDER BY sequence').all();

      expect(new AuditVerificationService(database).verify(auditor)).toEqual({
        valid: true,
        totalEvents: 3,
        verifiedEvents: 3,
        firstInvalidSequence: null,
        failure: null,
      });
      expect(database.prepare('SELECT * FROM audit_events ORDER BY sequence').all()).toEqual(
        before,
      );
    });
  });

  it('reports a changed canonical payload at its first bad hash', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      appendThreeEvents(database);
      database
        .prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 2')
        .run('{"tampered":true}');

      expect(new AuditVerificationService(database).verify(auditor)).toEqual({
        valid: false,
        totalEvents: 3,
        verifiedEvents: 1,
        firstInvalidSequence: 2,
        failure: 'hash_mismatch',
      });
    });
  });

  it('distinguishes noncanonical stored JSON from a changed canonical payload', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      appendThreeEvents(database);
      database
        .prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 2')
        .run('{ "tampered": true }');

      expect(new AuditVerificationService(database).verify(auditor)).toEqual({
        valid: false,
        totalEvents: 3,
        verifiedEvents: 1,
        firstInvalidSequence: 2,
        failure: 'noncanonical_payload',
      });
    });
  });

  it('reports the first missing sequence after a deleted middle entry', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      appendThreeEvents(database);
      database.prepare('DELETE FROM audit_events WHERE sequence = 2').run();

      expect(new AuditVerificationService(database).verify(auditor)).toEqual({
        valid: false,
        totalEvents: 2,
        verifiedEvents: 1,
        firstInvalidSequence: 2,
        failure: 'sequence_gap',
      });
    });
  });

  it('reports a broken predecessor when later entries are reordered', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      appendThreeEvents(database);
      database
        .transaction(() => {
          database.prepare('UPDATE audit_events SET sequence = 4 WHERE sequence = 2').run();
          database.prepare('UPDATE audit_events SET sequence = 2 WHERE sequence = 3').run();
          database.prepare('UPDATE audit_events SET sequence = 3 WHERE sequence = 4').run();
        })
        .immediate();

      expect(new AuditVerificationService(database).verify(auditor)).toEqual({
        valid: false,
        totalEvents: 3,
        verifiedEvents: 1,
        firstInvalidSequence: 2,
        failure: 'predecessor_mismatch',
      });
    });
  });

  it('cannot identify a removed tail without an external head record', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      appendThreeEvents(database);
      database.prepare('DELETE FROM audit_events WHERE sequence = 3').run();

      expect(new AuditVerificationService(database).verify(auditor)).toEqual({
        valid: true,
        totalEvents: 2,
        verifiedEvents: 2,
        firstInvalidSequence: null,
        failure: null,
      });
    });
  });

  it('accepts an empty chain and rejects an unprivileged actor', async () => {
    await withTestDatabase(async (database) => {
      const auditor = await authenticatedAuditor(database);
      const service = new AuditVerificationService(database);
      const agent = createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));

      expect(service.verify(auditor)).toEqual({
        valid: true,
        totalEvents: 0,
        verifiedEvents: 0,
        firstInvalidSequence: null,
        failure: null,
      });
      expect(() => service.verify(agent)).toThrow(ForbiddenError);
    });
  });
});
