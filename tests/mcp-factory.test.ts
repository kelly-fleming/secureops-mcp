import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../src/config.js';
import { ForbiddenError } from '../src/domain/errors.js';
import { createDiagnosticLogger } from '../src/infra/logging/logger.js';
import { openConfiguredDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';
import {
  createMcpServer,
  localToolNames,
  sharedToolNames,
  type McpToolName,
  type McpToolRegistrar,
} from '../src/mcp/server.js';
import { handleStructuredToolCall } from '../src/mcp/tool-handler.js';
import { projectIdentity, projectLockIdentity } from './helpers/project-metadata.js';
import { withTestDatabase } from './helpers/test-db.js';

const allToolNames = [...sharedToolNames, ...localToolNames];
const emptyInputSchema = z.strictObject({});

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'factory-contract-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return await run(client);
  } finally {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
}

function registrars(
  seen: Array<{ name: string; role: string; database: SqliteConnection }>,
): Partial<Record<McpToolName, McpToolRegistrar>> {
  const result: Partial<Record<McpToolName, McpToolRegistrar>> = {};
  for (const name of allToolNames) {
    result[name] = (server, context) => {
      seen.push({ name, role: context.actor.role, database: context.database });
      server.registerTool(
        name,
        {
          title: name,
          description: `Fictional ${name} contract tool`,
          inputSchema: emptyInputSchema,
        },
        async () => ({ content: [{ type: 'text', text: context.actor.role }] }),
      );
    };
  }
  return result;
}

describe('injectable MCP server factory', () => {
  it('keeps package and lockfile root identities aligned', () => {
    expect(projectLockIdentity).toMatchObject(projectIdentity);
    expect(projectLockIdentity.packages['']).toMatchObject(projectIdentity);
  });

  it('registers each local slot on an isolated server with its own issued actor and connection', async () => {
    await withTestDatabase(async (database) => {
      const config = loadConfig(
        {
          SECUREOPS_MODE: 'local-full',
          SECUREOPS_DB_PATH: database.name,
        },
        process.cwd(),
      );
      const seen: Array<{ name: string; role: string; database: SqliteConnection }> = [];
      const registrations = registrars(seen);
      const first = createMcpServer(
        { config, database, toolRegistrars: registrations },
        'local-full',
      );
      const second = createMcpServer(
        { config, database, toolRegistrars: registrations },
        'local-full',
      );

      await withClient(first, async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).toEqual(allToolNames);
        expect(names).not.toContain('decide_proposal');
        expect(names).not.toContain('approve_proposal');
        expect(client.getServerVersion()).toMatchObject(projectIdentity);
        expect(client.getServerCapabilities()?.tools).toBeDefined();
        const call = await client.callTool({ name: 'list_resources', arguments: {} });
        expect(call).toMatchObject({ content: [{ type: 'text', text: 'agent' }] });
      });
      await withClient(second, async (client) => {
        expect(client.getServerVersion()).toMatchObject(projectIdentity);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(allToolNames);
      });
      expect(seen).toHaveLength(allToolNames.length * 2);
      expect(seen.every((item) => item.role === 'agent' && item.database === database)).toBe(true);
      expect(database.open).toBe(true);
    });
  });

  it('registers only read slots for HTTP and supplies a viewer on the read-only connection', async () => {
    await withTestDatabase(async (writableDatabase) => {
      const config = loadConfig(
        {
          SECUREOPS_MODE: 'http-demo',
          SECUREOPS_DB_PATH: writableDatabase.name,
          SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
          SECUREOPS_HTTP_AUTH_TOKEN: 'fictional-http-token-0123456789abcdef',
        },
        process.cwd(),
      );
      const database = openConfiguredDatabase(config);
      try {
        const seen: Array<{ name: string; role: string; database: SqliteConnection }> = [];
        const server = createMcpServer(
          {
            config,
            database,
            toolRegistrars: registrars(seen),
          },
          'http-demo',
        );
        await withClient(server, async (client) => {
          const names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toEqual([...sharedToolNames]);
          expect(names).not.toContain('request_approval');
          expect(names).not.toContain('decide_proposal');
          expect(client.getServerVersion()).toMatchObject(projectIdentity);
          expect(client.getServerCapabilities()?.tools).toBeDefined();
          const call = await client.callTool({ name: 'list_resources', arguments: {} });
          expect(call).toMatchObject({ content: [{ type: 'text', text: 'viewer' }] });
        });
        expect(seen.map((item) => item.name)).toEqual([...sharedToolNames]);
        expect(seen.every((item) => item.role === 'viewer' && item.database === database)).toBe(
          true,
        );
        expect(database.open).toBe(true);
      } finally {
        database.close();
      }
    });
  });

  it('rejects a forged mode, writable HTTP connection, mismatched file, and closed connection', async () => {
    await withTestDatabase(async (database) => {
      const localConfig = loadConfig(
        {
          SECUREOPS_MODE: 'local-full',
          SECUREOPS_DB_PATH: database.name,
        },
        process.cwd(),
      );
      const httpConfig = loadConfig(
        {
          SECUREOPS_MODE: 'http-demo',
          SECUREOPS_DB_PATH: database.name,
          SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
          SECUREOPS_HTTP_AUTH_TOKEN: 'fictional-http-token-0123456789abcdef',
        },
        process.cwd(),
      );
      expect(() => createMcpServer({ config: localConfig, database }, 'http-demo')).toThrow(
        ForbiddenError,
      );
      expect(() => createMcpServer({ config: httpConfig, database }, 'http-demo')).toThrow(
        ForbiddenError,
      );
      expect(() => createMcpServer({ config: { ...localConfig }, database }, 'local-full')).toThrow(
        ForbiddenError,
      );
      await withTestDatabase((otherDatabase) => {
        expect(() =>
          createMcpServer({ config: localConfig, database: otherDatabase }, 'local-full'),
        ).toThrow(ForbiddenError);
      });
    });
    await withTestDatabase((database) => {
      const config = loadConfig(
        {
          SECUREOPS_MODE: 'local-full',
          SECUREOPS_DB_PATH: database.name,
        },
        process.cwd(),
      );
      const closedConnection = openConfiguredDatabase(config);
      closedConnection.close();
      expect(() => createMcpServer({ config, database: closedConnection }, 'local-full')).toThrow(
        ForbiddenError,
      );
    });
  });
});

describe('structured MCP handler boundary', () => {
  const inputSchema = z.strictObject({ count: z.int().min(1).max(10) });
  const outputSchema = z.strictObject({ doubled: z.int().min(2).max(20) });

  it('returns matching text and structured output for valid bounded input', async () => {
    const result = await handleStructuredToolCall(
      { count: 3 },
      inputSchema,
      outputSchema,
      ({ count }) => ({ doubled: count * 2 }),
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"doubled":6}' }],
      structuredContent: { doubled: 6 },
    });
  });

  it('rejects extra input before operation and maps invalid output or thrown secrets safely', async () => {
    let calls = 0;
    const invalidInput = await handleStructuredToolCall(
      { count: 3, actorId: 'reviewer' },
      inputSchema,
      outputSchema,
      ({ count }) => {
        calls += 1;
        return { doubled: count * 2 };
      },
    );
    expect(calls).toBe(0);
    expect(invalidInput.structuredContent).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    });

    const invalidOutput = await handleStructuredToolCall(
      { count: 3 },
      inputSchema,
      outputSchema,
      () => ({ doubled: Number.NaN }),
    );
    expect(invalidOutput.structuredContent).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
    });

    const secret = 'password=fictional-private-value';
    const thrown = await handleStructuredToolCall({ count: 3 }, inputSchema, outputSchema, () => {
      throw new Error(secret);
    });
    expect(thrown.isError).toBe(true);
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  it('records only bounded tool diagnostics and keeps logger sink failures out of results', async () => {
    const lines: string[] = [];
    let id = 0;
    const logger = createDiagnosticLogger({
      level: 'info',
      sink: {
        write(line) {
          lines.push(line);
          throw new Error('diagnostic sink failed');
        },
      },
      clock: { now: () => new Date('2026-10-18T00:00:00.000Z') },
      ids: { nextId: () => `trace-000${++id}` },
    });
    const secret = 'password=fictional-private-value';
    const successful = await handleStructuredToolCall(
      { count: 3 },
      inputSchema,
      outputSchema,
      ({ count }) => ({ doubled: count * 2 }),
      { logger, operation: 'list_resources' },
    );
    const failed = await handleStructuredToolCall(
      { count: 3 },
      inputSchema,
      outputSchema,
      () => {
        throw new Error(secret);
      },
      { logger, operation: 'list_resources' },
    );

    expect(successful.structuredContent).toEqual({ doubled: 6 });
    expect(failed.structuredContent).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
    });
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(({ event, correlationId }) => ({ event, correlationId }))).toEqual([
      { event: 'started', correlationId: 'trace-0001' },
      { event: 'succeeded', correlationId: 'trace-0001' },
      { event: 'started', correlationId: 'trace-0002' },
      { event: 'failed', correlationId: 'trace-0002' },
    ]);
    expect(records[3]).toMatchObject({ errorCode: 'INTERNAL_ERROR', errorCategory: 'internal' });
    expect(lines.join('')).not.toContain(secret);
  });
});
