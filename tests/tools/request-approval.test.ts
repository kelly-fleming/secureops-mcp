import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { ProposalService } from '../../src/application/proposal-service.js';
import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { requestApprovalOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerRequestApprovalTool } from '../../src/mcp/tools/request-approval.js';
import { createMcpActor } from '../../src/security/permissions.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

const justification = 'Please review this fictional draft through the independent CLI.';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'request-approval-contract-client', version: '0.1.0' });
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
      toolRegistrars: { request_approval: registerRequestApprovalTool },
    },
    'local-full',
  );
}

function createDraft(database: SqliteConnection): string {
  return new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(createMcpActor(localConfig(database)), {
    resourceId: 'res-aws-ec2-01',
    action: { type: 'disable_compute' },
    reason: 'Synthetic idle compute draft for an independent review.',
    idempotencyKey: 'request-approval-0001',
  }).proposalId;
}

describe('request_approval MCP tool', () => {
  it('moves only the proposer draft to pending review and leaves the resource unchanged', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        const proposals = new SqliteProposalRepository(database);
        const resources = new SqliteResourceRepository(database);
        const draft = proposals.getById(proposalId);
        const resourceBefore = resources.getById('res-aws-ec2-01');
        if (draft === null || resourceBefore === null) {
          throw new Error('Missing fictional proposal or resource.');
        }
        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'request_approval',
          );
          expect(tool).toMatchObject({
            name: 'request_approval',
            title: 'Request independent review',
            annotations: { readOnlyHint: false, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { proposalId: expect.any(Object), justification: expect.any(Object) },
            },
            outputSchema: { type: 'object' },
          });

          const result = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId, justification },
          });
          expect(result.isError).not.toBe(true);
          const output = requestApprovalOutputSchema.parse(result.structuredContent);
          expect(output).toEqual({
            proposalId,
            status: 'pending_approval',
            reviewerInstructions:
              'From the project root, an independent reviewer runs in an interactive terminal: ' +
              `npm run cli -- proposals:review --db-path "<absolute path to the same local .db>" --proposal-id ${proposalId}`,
          });
          expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(output);
          expect(JSON.stringify(result)).not.toContain(database.name);
          expect(proposals.getById(proposalId)).toMatchObject({
            resourceId: draft.resourceId,
            proposerActorId: draft.proposerActorId,
            action: draft.action,
            reason: draft.reason,
            expectedResourceVersion: draft.expectedResourceVersion,
            status: 'pending_approval',
            approvalJustification: justification,
          });
          expect(resources.getById('res-aws-ec2-01')).toEqual(resourceBefore);
          expect(
            database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get(),
          ).toEqual({ count: 0 });
          expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
            count: 0,
          });

          const auditRows = database
            .prepare(
              `
          SELECT action, subject_id AS subjectId, event_json AS eventJson
          FROM audit_events ORDER BY sequence
        `,
            )
            .all() as Array<{ action: string; subjectId: string; eventJson: string }>;
          expect(auditRows.map((row) => row.action)).toEqual([
            'proposal_created',
            'approval_requested',
          ]);
          expect(auditRows[1]!.subjectId).toBe(proposalId);
          expect(auditRows[1]!.eventJson).not.toContain(justification);

          const duplicate = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId, justification },
          });
          expect(duplicate).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'CONFLICT' } },
          });
          expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
            count: 2,
          });
        });
      },
      { seed: true },
    );
  });

  it('rejects malformed input and attempts to supply reviewer authority', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        await withClient(localServer(database), async (client) => {
          for (const input of [
            { proposalId, justification, reviewerId: 'reviewer-001' },
            { proposalId, justification, approved: true },
            { proposalId, justification, passphrase: 'fictional-secret' },
            { proposalId: '../private', justification },
            { proposalId, justification: 'short' },
          ]) {
            const result = await client.callTool({ name: 'request_approval', arguments: input });
            expect(result.isError).toBe(true);
            expect((result.content[0] as { text: string }).text).toMatch(/invalid|validation/i);
            expect(JSON.stringify(result)).not.toContain(database.name);
          }
          const missing = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId: 'proposal-missing', justification },
          });
          expect(missing).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'NOT_FOUND' } },
          });
        });
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('draft');
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 1,
        });
      },
      { seed: true },
    );
  });

  it('rejects a stale resource and a draft already marked stale', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        const resources = new SqliteResourceRepository(database);
        const current = resources.getById('res-aws-ec2-01');
        if (current === null) throw new Error('Missing fictional resource.');
        resources.updateIfVersion(
          {
            ...current,
            monthlyCostEstimateCents: current.monthlyCostEstimateCents + 100,
          },
          current.version,
        );

        await withClient(localServer(database), async (client) => {
          const staleVersion = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId, justification },
          });
          expect(staleVersion).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'CONFLICT' } },
          });
        });
        const proposals = new SqliteProposalRepository(database);
        expect(proposals.getById(proposalId)?.status).toBe('draft');
        proposals.transitionStatus({
          id: proposalId,
          expectedStatus: 'draft',
          targetStatus: 'stale',
          updatedAt: '2026-01-01T02:00:00.000Z',
        });
        await withClient(localServer(database), async (client) => {
          const staleDraft = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId, justification },
          });
          expect(staleDraft).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'CONFLICT' } },
          });
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 1,
        });
      },
      { seed: true },
    );
  });

  it('keeps a draft when current policy denies its unchanged resource version', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        // Preserve the version to isolate the current-policy check from stale-version rejection.
        database
          .prepare('UPDATE resources SET environment = ? WHERE id = ?')
          .run('production', 'res-aws-ec2-01');

        await withClient(localServer(database), async (client) => {
          const denied = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId, justification },
          });
          expect(denied).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'PRECONDITION_FAILED' } },
          });
        });
        expect(new SqliteProposalRepository(database).getById(proposalId)).toMatchObject({
          status: 'draft',
          approvalJustification: null,
          expectedResourceVersion: 1,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 1,
        });
      },
      { seed: true },
    );
  });

  it('keeps the tool out of HTTP and denies a viewer even with a writable connection', async () => {
    await withTestDatabase(
      async (writableDatabase) => {
        const proposalId = createDraft(writableDatabase);
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
              toolRegistrars: { request_approval: registerRequestApprovalTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
              'request_approval',
            );
          });
          expect(readOnlyDatabase.readonly).toBe(true);
        } finally {
          readOnlyDatabase.close();
        }

        const viewerServer = new McpServer(
          { name: 'denied-approval-request-contract', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        registerRequestApprovalTool(viewerServer, {
          database: writableDatabase,
          actor: createMcpActor(config),
        });
        await withClient(viewerServer, async (client) => {
          const denied = await client.callTool({
            name: 'request_approval',
            arguments: { proposalId, justification },
          });
          expect(denied).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'FORBIDDEN' } },
          });
        });
        expect(new SqliteProposalRepository(writableDatabase).getById(proposalId)?.status).toBe(
          'draft',
        );
      },
      { seed: true },
    );
  });
});
