import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

/** Refuse any database outside a live withTestDatabase private directory. */
export function requirePrivateTestDatabasePath(databasePath: string): string {
  const configuredRoot = process.env.SECUREOPS_TEST_DIR;
  if (configuredRoot === undefined) throw new Error('Missing per-test temporary directory.');
  const root = realpathSync(configuredRoot);
  const file = realpathSync(databasePath);
  const directory = dirname(file);
  if (
    dirname(root) !== realpathSync(tmpdir()) ||
    !basename(root).startsWith('secureops-mcp-test-') ||
    dirname(directory) !== root ||
    !basename(directory).startsWith('db-') ||
    basename(file) !== 'test.db'
  ) {
    throw new Error('Contention workers require a private test database.');
  }
  return file;
}
