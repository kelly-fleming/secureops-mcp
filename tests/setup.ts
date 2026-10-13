import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

const tempPrefix = 'secureops-mcp-test-';
let temporaryDirectory: string | undefined;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), tempPrefix));
  // Tests write generated databases here; checked-in fixtures remain read-only.
  process.env.SECUREOPS_TEST_DIR = temporaryDirectory;
});

afterEach(() => {
  const directory = temporaryDirectory;
  temporaryDirectory = undefined;
  delete process.env.SECUREOPS_TEST_DIR;

  if (directory === undefined) return;

  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(tempPrefix)) {
    throw new Error('Refusing to remove a path outside the test temporary directory');
  }

  rmSync(target, { recursive: true, force: true });
});
