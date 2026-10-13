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
import { listResourcesOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerListResourcesTool } from '../../src/mcp/tools/list-resources.js';
import {
  authenticatedCliIdentityBrand,
  createAuthenticatedCliActor,
} from '../../src/security/permissions.js';
import { withTestDatabase } from '../helpers/test-db.js';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'list-resources-contract-client', version: '0.1.0' });
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
    { config, database, toolRegistrars: { list_resources: registerListResourcesTool } },
    'local-full',
  );
}

describe('list_resources MCP tool', () => {
  it('advertises a strict read-only tool and returns bounded summaries from all providers', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'list_resources',
          );
          expect(tool).toMatchObject({
            name: 'list_resources',
            title: 'List fictional cloud resources',
            annotations: { readOnlyHint: true, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: expect.any(Object),
                kind: expect.any(Object),
                environment: expect.any(Object),
                limit: expect.any(Object),
                offset: expect.any(Object),
              },
            },
            outputSchema: { type: 'object' },
          });

          const result = await client.callTool({ name: 'list_resources', arguments: {} });
          expect(result.isError).not.toBe(true);
          const output = listResourcesOutputSchema.parse(result.structuredContent);
          const fixtures = loadSeedResources();
          expect(output.resources.map((resource) => resource.id)).toEqual(
            fixtures.map((resource) => resource.id),
          );
          expect(new Set(output.resources.map((resource) => resource.provider))).toEqual(
            new Set(['aws', 'azure', 'gcp']),
          );
          expect(output.resources.every((resource) => !('tags' in resource))).toBe(true);
          expect(output.resources.every((resource) => !('providerResourceId' in resource))).toBe(
            true,
          );
          expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(output);
          expect(new SqliteResourceRepository(database).list()).toEqual(fixtures);
        });
      },
      { seed: true },
    );
  });

  it('filters by provider, kind, and environment and pages in stable ID order', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const fixtures = loadSeedResources();
          const cases = [
            {
              filters: { provider: 'aws' },
              expected: fixtures.filter((item) => item.provider === 'aws'),
            },
            {
              filters: { kind: 'virtual-machine' },
              expected: fixtures.filter((item) => item.kind === 'virtual-machine'),
            },
            {
              filters: { environment: 'development' },
              expected: fixtures.filter((item) => item.environment === 'development'),
            },
            {
              filters: { provider: 'azure', kind: 'virtual-machine', environment: 'production' },
              expected: fixtures.filter(
                (item) =>
                  item.provider === 'azure' &&
                  item.kind === 'virtual-machine' &&
                  item.environment === 'production',
              ),
            },
            { filters: { limit: 2, offset: 2 }, expected: fixtures.slice(2, 4) },
            { filters: { offset: 10_000 }, expected: [] },
          ];
          for (const { filters, expected } of cases) {
            const result = await client.callTool({ name: 'list_resources', arguments: filters });
            expect(result.isError).not.toBe(true);
            const output = listResourcesOutputSchema.parse(result.structuredContent);
            expect(output.resources.map((item) => item.id)).toEqual(
              expected.map((item) => item.id),
            );
          }
        });
      },
      { seed: true },
    );
  });

  it('rejects malformed filters without exposing the database path', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          for (const filters of [
            { provider: "aws' OR 1=1 --" },
            { kind: 'unknown-kind' },
            { environment: 'secret' },
            { limit: 0 },
            { limit: 101 },
            { offset: -1 },
            { owner: 'forged' },
          ]) {
            const result = await client.callTool({ name: 'list_resources', arguments: filters });
            expect(result.isError).toBe(true);
            expect((result.content[0] as { text: string }).text).toMatch(/invalid|validation/i);
            expect(JSON.stringify(result)).not.toContain(database.name);
          }
        });
      },
      { seed: true },
    );
  });

  it('serves an HTTP viewer from a read-only connection and denies a reviewer actor', async () => {
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
              toolRegistrars: { list_resources: registerListResourcesTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            const result = await client.callTool({ name: 'list_resources', arguments: {} });
            expect(result.isError).not.toBe(true);
            expect(
              listResourcesOutputSchema.parse(result.structuredContent).resources,
            ).toHaveLength(loadSeedResources().length);
            expect(readOnlyDatabase.readonly).toBe(true);
          });
        } finally {
          readOnlyDatabase.close();
        }

        const reviewer = createAuthenticatedCliActor({
          id: 'reviewer-001',
          role: 'reviewer',
          [authenticatedCliIdentityBrand]: true,
        });
        const reviewerServer = new McpServer(
          { name: 'denied-list-contract', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        registerListResourcesTool(reviewerServer, { database: writableDatabase, actor: reviewer });
        await withClient(reviewerServer, async (client) => {
          const result = await client.callTool({ name: 'list_resources', arguments: {} });
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
