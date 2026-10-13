import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { ResourceService } from '../../src/application/resource-service.js';
import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { loadSeedResources } from '../../src/infra/sqlite/seed.js';
import { analyzeResourceOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerAnalyzeResourceTool } from '../../src/mcp/tools/analyze-resource.js';
import {
  authenticatedCliIdentityBrand,
  createAuthenticatedCliActor,
  createMcpActor,
} from '../../src/security/permissions.js';
import { withTestDatabase } from '../helpers/test-db.js';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'analyze-resource-contract-client', version: '0.1.0' });
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
    { config, database, toolRegistrars: { analyze_resource: registerAnalyzeResourceTool } },
    'local-full',
  );
}

describe('analyze_resource MCP tool', () => {
  it('describes seeded snapshots deterministically without changing resources', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'analyze_resource',
          );
          expect(tool).toMatchObject({
            name: 'analyze_resource',
            title: 'Analyze fictional cloud resource',
            annotations: { readOnlyHint: true, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { resourceId: expect.any(Object) },
            },
            outputSchema: { type: 'object' },
          });

          const repository = new SqliteResourceRepository(database);
          const cases = [
            { id: 'res-aws-ec2-01', codes: ['idle'] },
            { id: 'res-azure-storage-02', codes: ['healthy'] },
            { id: 'res-aws-ec2-02', codes: ['protected', 'policy_attention'] },
            { id: 'res-aws-s3-02', codes: ['policy_attention'] },
          ];
          for (const scenario of cases) {
            const before = repository.getById(scenario.id);
            const first = await client.callTool({
              name: 'analyze_resource',
              arguments: { resourceId: scenario.id },
            });
            const second = await client.callTool({
              name: 'analyze_resource',
              arguments: { resourceId: scenario.id },
            });
            expect(first.isError).not.toBe(true);
            expect(second.isError).not.toBe(true);
            const output = analyzeResourceOutputSchema.parse(first.structuredContent);
            expect(second.structuredContent).toEqual(output);
            expect(output.resourceId).toBe(scenario.id);
            expect(output.observations.map((item) => item.code)).toEqual(scenario.codes);
            expect(output.estimatedMonthlyCostChangeCents).toBe(0);
            expect(output.recommendation.length).toBeGreaterThan(0);
            expect(output.simulationNotice).toBe(
              'Fictional demo data; estimates are not real bills or savings.',
            );
            expect(JSON.parse((first.content[0] as { text: string }).text)).toEqual(output);
            expect(repository.getById(scenario.id)).toEqual(before);
            expect(JSON.stringify(first)).not.toContain(database.name);
          }
        });
      },
      { seed: true },
    );
  });

  it('returns safe errors for missing and malformed resource IDs', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const missing = await client.callTool({
            name: 'analyze_resource',
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
            const result = await client.callTool({ name: 'analyze_resource', arguments: input });
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

  it('rejects an invalid reconstructed resource before producing observations', () => {
    const fixture = loadSeedResources()[0]!;
    const actor = createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
    const service = new ResourceService({
      getById: () => ({ ...fixture, version: -1 }),
      list: () => [],
    });
    expect(() => service.analyzeResource(actor, { resourceId: fixture.id })).toThrow(
      'An internal error occurred.',
    );
  });

  it('allows a read-only HTTP viewer and denies a reviewer before parsing or reading', async () => {
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
              toolRegistrars: { analyze_resource: registerAnalyzeResourceTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            const fixture = loadSeedResources()[0]!;
            const result = await client.callTool({
              name: 'analyze_resource',
              arguments: { resourceId: fixture.id },
            });
            expect(result.isError).not.toBe(true);
            expect(analyzeResourceOutputSchema.parse(result.structuredContent).resourceId).toBe(
              fixture.id,
            );
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
        let reads = 0;
        const service = new ResourceService({
          getById: () => {
            reads += 1;
            return null;
          },
          list: () => [],
        });
        expect(() => service.analyzeResource(reviewer, null)).toThrow(
          'Operation is not permitted.',
        );
        expect(reads).toBe(0);

        const reviewerServer = new McpServer(
          { name: 'denied-analysis-contract', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        registerAnalyzeResourceTool(reviewerServer, {
          database: writableDatabase,
          actor: reviewer,
        });
        await withClient(reviewerServer, async (client) => {
          const result = await client.callTool({
            name: 'analyze_resource',
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
