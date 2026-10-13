import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  openConfiguredDatabase,
  openInMemoryTestDatabase,
} from '../src/infra/sqlite/connection.js';

function testDirectory(): string {
  const directory = process.env.SECUREOPS_TEST_DIR;
  if (directory === undefined) throw new Error('Missing disposable test directory');
  return directory;
}

function localConfig(databasePath: string) {
  return loadConfig({ SECUREOPS_DB_PATH: databasePath }, testDirectory());
}

function httpConfig(databasePath: string) {
  return loadConfig(
    {
      SECUREOPS_MODE: 'http-demo',
      SECUREOPS_DB_PATH: databasePath,
      SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
    },
    testDirectory(),
  );
}

describe('SQLite connection factory', () => {
  it('creates the configured local database with foreign keys, WAL, and a bounded busy timeout', () => {
    const databasePath = path.join(testDirectory(), 'nested', 'local.db');
    const database = openConfiguredDatabase(localConfig(databasePath));

    try {
      expect(existsSync(databasePath)).toBe(true);
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);

      database.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
      `);
      expect(() => database.exec('INSERT INTO child (parent_id) VALUES (999);')).toThrow();
    } finally {
      database.close();
    }
  });

  it('opens an existing HTTP database read-only without changing its journal mode', () => {
    const databasePath = path.join(testDirectory(), 'viewer.db');
    const writer = openConfiguredDatabase(localConfig(databasePath));
    try {
      writer.exec(`
        CREATE TABLE example (id INTEGER PRIMARY KEY);
        INSERT INTO example (id) VALUES (1);
      `);
    } finally {
      writer.close();
    }

    const reader = openConfiguredDatabase(httpConfig(databasePath));
    try {
      expect(reader.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(reader.pragma('query_only', { simple: true })).toBe(1);
      expect(reader.pragma('busy_timeout', { simple: true })).toBe(5_000);
      expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(reader.prepare('SELECT id FROM example').get()).toEqual({ id: 1 });
      expect(() => reader.exec('INSERT INTO example (id) VALUES (2);')).toThrow();
    } finally {
      reader.close();
    }
  });

  it('rejects a missing HTTP database without creating it', () => {
    const databasePath = path.join(testDirectory(), 'missing.db');
    expect(() => openConfiguredDatabase(httpConfig(databasePath))).toThrow('existing regular file');
    expect(existsSync(databasePath)).toBe(false);
  });

  it('keeps in-memory test connections isolated', () => {
    const first = openInMemoryTestDatabase();
    const second = openInMemoryTestDatabase();
    try {
      first.exec(`
        CREATE TABLE isolated (id INTEGER PRIMARY KEY);
        INSERT INTO isolated (id) VALUES (1);
      `);
      expect(first.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(second.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(
        second
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'isolated'")
          .get(),
      ).toBeUndefined();
    } finally {
      first.close();
      second.close();
    }
  });
});
