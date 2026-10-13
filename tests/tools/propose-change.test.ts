import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { loadSeedResources } from '../../src/infra/sqlite/seed.js';
import { proposeChangeOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerProposeChangeTool } from '../../src/mcp/tools/propose-change.js';
import { createMcpActor } from '../../src/security/permissions.js';
import { withTestDatabase } from '../helpers/test-db.js';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'propose-change-contract-client', version: '0.1.0' });
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
    { config, database, toolRegistrars: { propose_change: registerProposeChangeTool } },
    'local-full',
  );
}

function proposalRequest(idempotencyKey = 'mcp-proposal-0001') {
  return {
    resourceId: 'res-aws-ec2-01',
    action: { type: 'disable_compute' },
    reason: 'Synthetic idle resource review for a local demonstration.',
    idempotencyKey,
  };
}

describe('propose_change MCP tool', () => {
  it('creates only a draft, then replays the same identity without another audit event', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'propose_change',
          );
          expect(tool).toMatchObject({
            name: 'propose_change',
            title: 'Propose fictional resource change',
            annotations: { readOnlyHint: false, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                resourceId: expect.any(Object),
                action: expect.any(Object),
                reason: expect.any(Object),
                idempotencyKey: expect.any(Object),
              },
            },
            outputSchema: { type: 'object' },
          });

          const request = proposalRequest();
          const resources = new SqliteResourceRepository(database);
          const proposals = new SqliteProposalRepository(database);
          const before = resources.getById(request.resourceId);
          const first = await client.callTool({ name: 'propose_change', arguments: request });
          expect(first.isError).not.toBe(true);
          const output = proposeChangeOutputSchema.parse(first.structuredContent);
          expect(output.proposalId).toMatch(/^proposal-[a-z0-9-]+$/);
          expect(output.status).toBe('draft');
          expect(output.preview.before).toEqual(before);
          expect(output.preview.after.monthlyCostEstimateCents).toBe(0);
          expect(output.preview.after.version).toBe(before?.version);
          expect(output.evaluation.allowed).toBe(true);
          expect(output.evaluation.approvalRequired).toBe(true);
          expect(output.simulationNotice).toBe(
            'Fictional demo data; estimates are not real bills or savings.',
          );
          expect(JSON.parse((first.content[0] as { text: string }).text)).toEqual(output);
          expect(JSON.stringify(first)).not.toContain(database.name);
          expect(proposals.getById(output.proposalId)).toMatchObject({
            resourceId: request.resourceId,
            proposerActorId: 'local-agent',
            action: request.action,
            reason: request.reason,
            idempotencyKey: request.idempotencyKey,
            expectedResourceVersion: before?.version,
            status: 'draft',
          });

          const replay = await client.callTool({ name: 'propose_change', arguments: request });
          expect(replay.isError).not.toBe(true);
          expect(replay.structuredContent).toEqual(output);
          expect(proposals.list()).toHaveLength(1);
          const auditRows = database
            .prepare(
              `
          SELECT action, subject_id AS subjectId, event_json AS eventJson FROM audit_events
        `,
            )
            .all() as Array<{ action: string; subjectId: string; eventJson: string }>;
          expect(auditRows).toHaveLength(1);
          expect(auditRows[0]).toMatchObject({
            action: 'proposal_created',
            subjectId: output.proposalId,
          });
          expect(auditRows[0]!.eventJson).not.toContain(request.reason);
          expect(
            database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get(),
          ).toEqual({ count: 0 });
          expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
            count: 0,
          });
          expect(resources.getById(request.resourceId)).toEqual(before);

          const conflicting = await client.callTool({
            name: 'propose_change',
            arguments: { ...request, reason: 'A different fictional reason for this same key.' },
          });
          expect(conflicting).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'CONFLICT' } },
          });
          expect(proposals.list()).toHaveLength(1);
          expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
            count: 1,
          });
        });
      },
      { seed: true },
    );
  });

  it('rejects forged authority, denied candidates, and invalid requests without writes', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const request = proposalRequest();
          for (const input of [
            { ...request, proposerActorId: 'reviewer-001' },
            { ...request, reviewerId: 'reviewer-001' },
            { ...request, approved: true },
            { ...request, action: { type: 'run_script', command: 'unsafe' } },
            { ...request, idempotencyKey: '../invalid key' },
            { ...request, reason: 'short' },
          ]) {
            const result = await client.callTool({ name: 'propose_change', arguments: input });
            expect(result.isError).toBe(true);
            expect((result.content[0] as { text: string }).text).toMatch(/invalid|validation/i);
            expect(JSON.stringify(result)).not.toContain(database.name);
          }

          for (const resourceId of ['res-azure-vm-02', 'res-aws-ec2-02']) {
            const result = await client.callTool({
              name: 'propose_change',
              arguments: {
                ...request,
                resourceId,
                action: { type: 'resize_compute', targetSize: 'demo-small' },
              },
            });
            expect(result).toMatchObject({
              isError: true,
              structuredContent: { error: { code: 'PRECONDITION_FAILED' } },
            });
          }

          expect(new SqliteProposalRepository(database).list()).toEqual([]);
          expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
            count: 0,
          });
          const resources = new SqliteResourceRepository(database);
          for (const fixture of loadSeedResources())
            expect(resources.getById(fixture.id)).toEqual(fixture);
        });
      },
      { seed: true },
    );
  });

  it('keeps draft creation out of HTTP mode and denies a viewer actor', async () => {
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
              toolRegistrars: { propose_change: registerProposeChangeTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
              'propose_change',
            );
          });
          expect(readOnlyDatabase.readonly).toBe(true);
        } finally {
          readOnlyDatabase.close();
        }

        const viewer = createMcpActor(config);
        const viewerServer = new McpServer(
          { name: 'denied-proposal-contract', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        registerProposeChangeTool(viewerServer, { database: writableDatabase, actor: viewer });
        await withClient(viewerServer, async (client) => {
          const result = await client.callTool({
            name: 'propose_change',
            arguments: proposalRequest(),
          });
          expect(result).toMatchObject({
            isError: true,
            structuredContent: {
              error: { code: 'FORBIDDEN', message: 'Operation is not permitted.' },
            },
          });
        });
        expect(new SqliteProposalRepository(writableDatabase).list()).toEqual([]);
      },
      { seed: true },
    );
  });
});
