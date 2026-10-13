import type { CallToolResult } from '@modelcontextprotocol/server';

import { publicErrorFor } from '../domain/errors.js';

export function toToolErrorResult(error: unknown): CallToolResult {
  const payload = { error: publicErrorFor(error) };

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}
