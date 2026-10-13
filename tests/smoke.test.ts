import { expect, test } from 'vitest';

import { APP_NAME } from '../src/index.js';

test('exports the SecureOps application name', () => {
  expect(APP_NAME).toBe('SecureOps MCP');
});
