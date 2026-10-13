import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { openInMemoryTestDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';

const migration = readFileSync(
  new URL('../src/infra/sqlite/migrations/003_auth_audit.sql', import.meta.url),
  'utf8',
);

const identityRow = {
  id: 'reviewer-001',
  username: 'reviewer_one',
  role: 'reviewer',
  disabled: 0,
  password_kdf: 'scrypt',
  password_salt: Buffer.alloc(16, 1),
  password_verifier: Buffer.alloc(64, 2),
  scrypt_cost: 16384,
  scrypt_block_size: 8,
  scrypt_parallelization: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const identityInsert = `
  INSERT INTO local_identities (
    id, username, role, disabled, password_kdf, password_salt, password_verifier,
    scrypt_cost, scrypt_block_size, scrypt_parallelization, created_at, updated_at
  ) VALUES (
    @id, @username, @role, @disabled, @password_kdf, @password_salt, @password_verifier,
    @scrypt_cost, @scrypt_block_size, @scrypt_parallelization, @created_at, @updated_at
  )
`;

const auditRow = {
  sequence: 1,
  id: 'audit-001',
  actor_type: 'reviewer',
  actor_id: 'reviewer-001',
  action: 'proposal.reviewed',
  subject_type: 'proposal',
  subject_id: 'proposal-001',
  event_json: '{"decision":"approved"}',
  occurred_at: '2026-01-01T01:00:00.000Z',
  previous_hash: null as string | null,
  event_hash: 'a'.repeat(64),
};

const auditInsert = `
  INSERT INTO audit_events (
    sequence, id, actor_type, actor_id, action, subject_type, subject_id,
    event_json, occurred_at, previous_hash, event_hash
  ) VALUES (
    @sequence, @id, @actor_type, @actor_id, @action, @subject_type, @subject_id,
    @event_json, @occurred_at, @previous_hash, @event_hash
  )
`;

function withMigratedDatabase(run: (database: SqliteConnection) => void): void {
  const database = openInMemoryTestDatabase();
  try {
    database.exec(migration);
    run(database);
  } finally {
    database.close();
  }
}

function insertIdentity(
  database: SqliteConnection,
  overrides: Partial<typeof identityRow> = {},
): void {
  database.prepare(identityInsert).run({ ...identityRow, ...overrides });
}

function insertAudit(database: SqliteConnection, overrides: Partial<typeof auditRow> = {}): void {
  database.prepare(auditInsert).run({ ...auditRow, ...overrides });
}

describe('identity and audit migration', () => {
  it('stores only salted verifier material and has no plaintext password column', () => {
    withMigratedDatabase((database) => {
      const columns = database.pragma('table_info(local_identities)') as Array<{ name: string }>;
      const names = columns.map((column) => column.name);
      expect(names).toContain('password_salt');
      expect(names).toContain('password_verifier');
      expect(names).not.toContain('password');
      expect(names).not.toContain('approval_token');

      insertIdentity(database);
      expect(
        database.prepare('SELECT username, role, disabled FROM local_identities').get(),
      ).toEqual({
        username: 'reviewer_one',
        role: 'reviewer',
        disabled: 0,
      });
    });
  });

  it('requires unique normalized names and the two CLI roles', () => {
    withMigratedDatabase((database) => {
      insertIdentity(database);
      expect(() => insertIdentity(database, { id: 'reviewer-002' })).toThrow();
      expect(() =>
        insertIdentity(database, { id: 'reviewer-003', username: 'Reviewer_Two' }),
      ).toThrow();
      expect(() =>
        insertIdentity(database, { id: 'reviewer-004', username: 'reviewer two' }),
      ).toThrow();
      expect(() =>
        insertIdentity(database, { id: 'reviewer-005', username: 'reviewer_two', role: 'admin' }),
      ).toThrow();
      insertIdentity(database, {
        id: 'auditor-001',
        username: 'auditor_one',
        role: 'auditor',
        disabled: 1,
      });
      expect(
        database
          .prepare('SELECT role, disabled FROM local_identities WHERE id = ?')
          .get('auditor-001'),
      ).toEqual({ role: 'auditor', disabled: 1 });
    });
  });

  it('rejects incomplete verifiers and invalid scrypt parameters', () => {
    withMigratedDatabase((database) => {
      expect(() => insertIdentity(database, { password_salt: Buffer.alloc(8) })).toThrow();
      expect(() => insertIdentity(database, { password_verifier: Buffer.alloc(16) })).toThrow();
      expect(() => insertIdentity(database, { password_kdf: 'plaintext' })).toThrow();
      expect(() => insertIdentity(database, { scrypt_cost: 20000 })).toThrow();
      expect(() => insertIdentity(database, { disabled: 2 })).toThrow();
    });
  });

  it('stores ordered events with actor, subject, and predecessor fields', () => {
    withMigratedDatabase((database) => {
      insertAudit(database);
      insertAudit(database, {
        sequence: 2,
        id: 'audit-002',
        actor_type: 'agent',
        actor_id: 'local-agent',
        action: 'proposal.executed',
        previous_hash: auditRow.event_hash,
        event_hash: 'b'.repeat(64),
      });
      expect(
        database
          .prepare(
            'SELECT sequence, actor_type, subject_type, previous_hash FROM audit_events ORDER BY sequence',
          )
          .all(),
      ).toEqual([
        { sequence: 1, actor_type: 'reviewer', subject_type: 'proposal', previous_hash: null },
        {
          sequence: 2,
          actor_type: 'agent',
          subject_type: 'proposal',
          previous_hash: auditRow.event_hash,
        },
      ]);
    });
  });

  it('requires explicit valid sequencing, actors, JSON, and hash fields', () => {
    withMigratedDatabase((database) => {
      expect(() => insertAudit(database, { sequence: 0 })).toThrow();
      expect(() => insertAudit(database, { sequence: 1, previous_hash: 'a'.repeat(64) })).toThrow();
      expect(() => insertAudit(database, { actor_type: 'viewer' })).toThrow();
      expect(() => insertAudit(database, { actor_id: '' })).toThrow();
      expect(() => insertAudit(database, { subject_id: '' })).toThrow();
      expect(() => insertAudit(database, { event_json: '[]' })).toThrow();
      expect(() => insertAudit(database, { event_json: '{broken' })).toThrow();
      expect(() => insertAudit(database, { event_hash: 'A'.repeat(64) })).toThrow();
      insertAudit(database);
      expect(() => insertAudit(database, { sequence: 1, id: 'audit-002' })).toThrow();
      expect(() => insertAudit(database, { sequence: 2, id: 'audit-003' })).toThrow();
      expect(() =>
        insertAudit(database, {
          sequence: 2,
          id: 'audit-004',
          previous_hash: 'A'.repeat(64),
        }),
      ).toThrow();
    });
  });

  it('indexes audit subjects and actors in sequence order', () => {
    withMigratedDatabase((database) => {
      const indexes = database.pragma('index_list(audit_events)') as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining(['audit_events_subject_sequence', 'audit_events_actor_sequence']),
      );
    });
  });
});
