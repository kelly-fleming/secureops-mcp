import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { AgentAuditService } from '../../src/application/agent-audit-service.js';
import { ApprovalRequestService } from '../../src/application/approval-request-service.js';
import { ProposalService } from '../../src/application/proposal-service.js';
import { loadConfig } from '../../src/config.js';
import { ForbiddenError } from '../../src/domain/errors.js';
import { SqliteAuditRepository } from '../../src/infra/sqlite/audit-repository.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { getAuditLogOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerGetAuditLogTool } from '../../src/mcp/tools/get-audit-log.js';
import { createMcpActor } from '../../src/security/permissions.js';
import { buildProposalRequest } from '../helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

const firstResourceId = 'res-aws-ec2-01';
const secondResourceId = 'res-gcp-compute-01';
const fictionalReason = 'Fictional reason that must stay out of the agent audit trace.';
const fictionalJustification = 'Fictional review justification that must stay private.';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'get-audit-log-contract-client', version: '0.1.0' });
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

function localConfig(database: SqliteConnection) {
  return loadConfig(
    { SECUREOPS_MODE: 'local-full', SECUREOPS_DB_PATH: database.name },
    process.cwd(),
  );
}

function localServer(database: SqliteConnection): McpServer {
  return createMcpServer(
    {
      config: localConfig(database),
      database,
      toolRegistrars: { get_audit_log: registerGetAuditLogTool },
    },
    'local-full',
  );
}

function createWorkflowEvents(database: SqliteConnection): {
  firstProposalId: string;
  secondProposalId: string;
} {
  const actor = createMcpActor(localConfig(database));
  const proposals = new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  );
  const request = buildProposalRequest();
  const firstProposalId = proposals.proposeChange(actor, {
    resourceId: firstResourceId,
    action: { type: 'disable_compute' },
    reason: fictionalReason,
    idempotencyKey: request.idempotencyKey,
  }).proposalId;
  const secondProposalId = proposals.proposeChange(actor, {
    resourceId: secondResourceId,
    action: { type: 'disable_compute' },
    reason: fictionalReason,
    idempotencyKey: 'audit-second-proposal-0001',
  }).proposalId;
  new ApprovalRequestService(
    database,
    createFixedClock('2026-01-01T01:00:00.000Z'),
  ).requestApproval(actor, {
    proposalId: firstProposalId,
    justification: fictionalJustification,
  });
  // A valid identity event may appear in the CLI trace but never in the agent view.
  database
    .transaction(() =>
      new SqliteAuditRepository(database).append({
        id: 'event-identity-test',
        actorType: 'system',
        actorId: 'system-test',
        action: 'identity_enrolled',
        subjectType: 'identity',
        subjectId: 'identity-test',
        payload: { status: 'enrolled' },
        occurredAt: '2026-01-01T02:00:00.000Z',
      }),
    )
    .immediate();
  return { firstProposalId, secondProposalId };
}

function auditCount(database: SqliteConnection): number {
  return (database.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number })
    .count;
}

describe('get_audit_log MCP tool', () => {
  it('returns bounded fixed summaries with proposal and resource filters without changing the trace', async () => {
    await withTestDatabase(
      async (database) => {
        const { firstProposalId, secondProposalId } = createWorkflowEvents(database);
        const countBefore = auditCount(database);

        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'get_audit_log',
          );
          expect(tool).toMatchObject({
            name: 'get_audit_log',
            annotations: { readOnlyHint: true, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                proposalId: expect.any(Object),
                resourceId: expect.any(Object),
                limit: expect.any(Object),
                offset: expect.any(Object),
              },
            },
            outputSchema: { type: 'object' },
          });

          const all = await client.callTool({ name: 'get_audit_log', arguments: {} });
          expect(all.isError).not.toBe(true);
          const output = getAuditLogOutputSchema.parse(all.structuredContent);
          expect(output.events.map((event) => [event.subjectId, event.action])).toEqual([
            [firstProposalId, 'proposal_created'],
            [secondProposalId, 'proposal_created'],
            [firstProposalId, 'approval_requested'],
          ]);
          expect(output.events[0]?.summary).toBe('A fictional change proposal was created.');
          expect(JSON.parse((all.content[0] as { text: string }).text)).toEqual(output);
          for (const event of output.events) {
            expect(Object.keys(event).sort()).toEqual([
              'action',
              'actorType',
              'id',
              'occurredAt',
              'subjectId',
              'subjectType',
              'summary',
            ]);
            expect(event.subjectType).toBe('proposal');
          }
          const serialized = JSON.stringify(all);
          for (const excluded of [
            fictionalReason,
            fictionalJustification,
            'identity-test',
            'system-test',
            'eventJson',
            'eventHash',
            'previousHash',
            database.name,
          ])
            expect(serialized).not.toContain(excluded);

          const byProposal = await client.callTool({
            name: 'get_audit_log',
            arguments: { proposalId: firstProposalId },
          });
          expect(getAuditLogOutputSchema.parse(byProposal.structuredContent).events).toHaveLength(
            2,
          );
          const byResource = await client.callTool({
            name: 'get_audit_log',
            arguments: { resourceId: secondResourceId },
          });
          expect(
            getAuditLogOutputSchema
              .parse(byResource.structuredContent)
              .events.map((event) => event.subjectId),
          ).toEqual([secondProposalId]);
          const page = await client.callTool({
            name: 'get_audit_log',
            arguments: { limit: 1, offset: 2 },
          });
          expect(
            getAuditLogOutputSchema
              .parse(page.structuredContent)
              .events.map((event) => event.action),
          ).toEqual(['approval_requested']);
          const unmatched = await client.callTool({
            name: 'get_audit_log',
            arguments: { resourceId: 'res-aws-ec2-99' },
          });
          expect(getAuditLogOutputSchema.parse(unmatched.structuredContent).events).toEqual([]);
        });
        expect(auditCount(database)).toBe(countBefore);
      },
      { seed: true },
    );
  });

  it('returns an empty trace and rejects malformed or overbroad filters', async () => {
    await withTestDatabase(async (database) => {
      await withClient(localServer(database), async (client) => {
        const empty = await client.callTool({ name: 'get_audit_log', arguments: {} });
        expect(getAuditLogOutputSchema.parse(empty.structuredContent)).toEqual({ events: [] });
        for (const input of [
          { proposalId: 'proposal-example', resourceId: firstResourceId },
          { limit: 101 },
          { offset: -1 },
          { proposalId: '../unsafe' },
          { actorId: 'local-agent' },
        ]) {
          const invalid = await client.callTool({ name: 'get_audit_log', arguments: input });
          expect(invalid.isError).toBe(true);
          expect(JSON.stringify(invalid)).not.toContain(database.name);
        }
      });
      expect(auditCount(database)).toBe(0);
    });
  });

  it('checks the issued capability before parsing and keeps the tool out of HTTP mode', async () => {
    await withTestDatabase(async (writableDatabase) => {
      const httpConfig = loadConfig(
        {
          SECUREOPS_MODE: 'http-demo',
          SECUREOPS_DB_PATH: writableDatabase.name,
          SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
          SECUREOPS_HTTP_AUTH_TOKEN: 'fictional-http-token-0123456789abcdef',
        },
        process.cwd(),
      );
      const viewer = createMcpActor(httpConfig);
      expect(() =>
        new AgentAuditService(writableDatabase).getAuditLog(viewer, { limit: 0 }),
      ).toThrow(ForbiddenError);

      const readOnlyDatabase = openConfiguredDatabase(httpConfig);
      try {
        const server = createMcpServer(
          {
            config: httpConfig,
            database: readOnlyDatabase,
            toolRegistrars: { get_audit_log: registerGetAuditLogTool },
          },
          'http-demo',
        );
        await withClient(server, async (client) => {
          expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
            'get_audit_log',
          );
        });
        expect(readOnlyDatabase.readonly).toBe(true);
      } finally {
        readOnlyDatabase.close();
      }

      const viewerServer = new McpServer(
        { name: 'denied-audit-contract', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      registerGetAuditLogTool(viewerServer, { database: writableDatabase, actor: viewer });
      await withClient(viewerServer, async (client) => {
        const denied = await client.callTool({ name: 'get_audit_log', arguments: {} });
        expect(denied).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'FORBIDDEN' } },
        });
      });
      expect(auditCount(writableDatabase)).toBe(0);
    });
  });
});
