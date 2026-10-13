import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { loadSeedResources } from '../../src/infra/sqlite/seed.js';
import { getResourceOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerGetResourceTool } from '../../src/mcp/tools/get-resource.js';
import {
  authenticatedCliIdentityBrand,
  createAuthenticatedCliActor,
} from '../../src/security/permissions.js';
import { withTestDatabase } from '../helpers/test-db.js';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'get-resource-contract-client', version: '0.1.0' });
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

function localServer(database: SqliteConnection): McpServer {
  const config = loadConfig(
    { SECUREOPS_MODE: 'local-full', SECUREOPS_DB_PATH: database.name },
    process.cwd(),
  );
  return createMcpServer(
    { config, database, toolRegistrars: { get_resource: registerGetResourceTool } },
    'local-full',
  );
}

describe('get_resource MCP tool', () => {
  it('advertises a strict read-only detail and returns every approved field without mutation', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'get_resource',
          );
          expect(tool).toMatchObject({
            name: 'get_resource',
            title: 'Get fictional cloud resource',
            annotations: { readOnlyHint: true, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { resourceId: expect.any(Object) },
            },
            outputSchema: { type: 'object' },
          });

          const repository = new SqliteResourceRepository(database);
          for (const fixture of loadSeedResources()) {
            const before = repository.getById(fixture.id);
            const result = await client.callTool({
              name: 'get_resource',
              arguments: { resourceId: fixture.id },
            });
            expect(result.isError).not.toBe(true);
            const output = getResourceOutputSchema.parse(result.structuredContent);
            expect(output.resource).toEqual(fixture);
            expect(output.resource.id).toBe(fixture.id);
            expect(output.resource.monthlyCostEstimateCents).toBe(fixture.monthlyCostEstimateCents);
            expect(output.resource.version).toBe(fixture.version);
            expect(output.resource.tags).toEqual(fixture.tags);
            expect(output.resource.governance).toEqual(fixture.governance);
            expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(output);
            expect(repository.getById(fixture.id)).toEqual(before);
            expect(JSON.stringify(result)).not.toContain(database.name);
          }
        });
      },
      { seed: true },
    );
  });

  it('returns a safe not-found result and rejects invalid or extra input fields', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const missing = await client.callTool({
            name: 'get_resource',
            arguments: { resourceId: 'res-missing-001' },
          });
          expect(missing).toMatchObject({
            isError: true,
            structuredContent: {
              error: { code: 'NOT_FOUND', message: 'Requested item was not found.' },
            },
          });

          const existingId = loadSeedResources()[0]!.id;
          for (const input of [
            {},
            { resourceId: '../private' },
            { resourceId: 'real/aws/id' },
            { resourceId: existingId, actorId: 'reviewer-001' },
            { resourceId: existingId, approved: true },
          ]) {
            const result = await client.callTool({ name: 'get_resource', arguments: input });
            expect(result.isError).toBe(true);
            expect((result.content[0] as { text: string }).text).toMatch(/invalid|validation/i);
            expect(JSON.stringify(result)).not.toContain(database.name);
          }
          expect(new SqliteResourceRepository(database).getById(existingId)).toEqual(
            loadSeedResources()[0],
          );
        });
      },
      { seed: true },
    );
  });

  it('allows an HTTP viewer on a read-only connection and denies an auditor actor', async () => {
    await withTestDatabase(
      async (writableDatabase) => {
        const config = loadConfig(
          {
            SECUREOPS_MODE: 'http-demo',
            SECUREOPS_DB_PATH: writableDatabase.name,
            SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
            SECUREOPS_HTTP_AUTH_TOKEN: 'fictional-http-token-0123456789abcdef',
          },
          process.cwd(),
        );
        const readOnlyDatabase = openConfiguredDatabase(config);
        try {
          const server = createMcpServer(
            {
              config,
              database: readOnlyDatabase,
              toolRegistrars: { get_resource: registerGetResourceTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            const fixture = loadSeedResources()[0]!;
            const result = await client.callTool({
              name: 'get_resource',
              arguments: { resourceId: fixture.id },
            });
            expect(result.isError).not.toBe(true);
            expect(getResourceOutputSchema.parse(result.structuredContent).resource).toEqual(
              fixture,
            );
            expect(readOnlyDatabase.readonly).toBe(true);
          });
        } finally {
          readOnlyDatabase.close();
        }

        const auditor = createAuthenticatedCliActor({
          id: 'auditor-001',
          role: 'auditor',
          [authenticatedCliIdentityBrand]: true,
        });
        const auditorServer = new McpServer(
          { name: 'denied-detail-contract', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        registerGetResourceTool(auditorServer, { database: writableDatabase, actor: auditor });
        await withClient(auditorServer, async (client) => {
          const result = await client.callTool({
            name: 'get_resource',
            arguments: { resourceId: loadSeedResources()[0]!.id },
          });
          expect(result).toMatchObject({
            isError: true,
            structuredContent: {
              error: { code: 'FORBIDDEN', message: 'Operation is not permitted.' },
            },
          });
        });
      },
      { seed: true },
    );
  });
});
