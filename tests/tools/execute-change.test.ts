import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../../src/application/approval-request-service.js';
import { ProposalService } from '../../src/application/proposal-service.js';
import { ReviewService } from '../../src/application/review-service.js';
import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { executeChangeOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerExecuteChangeTool } from '../../src/mcp/tools/execute-change.js';
import { derivePasswordVerifier } from '../../src/security/password.js';
import { createMcpActor } from '../../src/security/permissions.js';
import {
  authenticateCliActor,
  type ReviewerAuthRuntime,
} from '../../src/security/reviewer-auth.js';
import { buildProposalRequest } from '../helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

const requestedAt = '2026-01-01T01:00:00.000Z';
const decidedAt = '2026-01-01T02:00:00.000Z';
const reviewerPassphrase = 'fictional-mcp-execution-reviewer-passphrase';
const executionKey = 'mcp-execution-000001';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'execute-change-contract-client', version: '0.1.0' });
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
      toolRegistrars: { execute_change: registerExecuteChangeTool },
    },
    'local-full',
  );
}

function createDraft(database: SqliteConnection): string {
  const request = buildProposalRequest();
  return new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(createMcpActor(localConfig(database)), {
    resourceId: request.resourceId,
    action: { type: 'disable_compute' },
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
  }).proposalId;
}

async function approveProposal(database: SqliteConnection, proposalId: string): Promise<void> {
  new ApprovalRequestService(database, createFixedClock(requestedAt)).requestApproval(
    createMcpActor(localConfig(database)),
    { proposalId, justification: 'Independent review of this fictional proposal.' },
  );

  const verifier = await derivePasswordVerifier(reviewerPassphrase);
  try {
    database
      .prepare(
        `
      INSERT INTO local_identities (
        id, username, role, disabled, password_kdf, password_salt,
        password_verifier, scrypt_cost, scrypt_block_size,
        scrypt_parallelization, created_at, updated_at
      ) VALUES (?, ?, 'reviewer', 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        'identity-mcp-execution-reviewer',
        'mcp_execution_reviewer',
        verifier.passwordKdf,
        verifier.passwordSalt,
        verifier.passwordVerifier,
        verifier.scryptCost,
        verifier.scryptBlockSize,
        verifier.scryptParallelization,
        requestedAt,
        requestedAt,
      );
  } finally {
    verifier.passwordSalt.fill(0);
    verifier.passwordVerifier.fill(0);
  }
  const runtime: ReviewerAuthRuntime = {
    isInteractive: () => true,
    askUsername: async () => 'mcp_execution_reviewer',
    askPassphrase: async () => reviewerPassphrase,
    delay: async () => undefined,
  };
  const reviewer = await authenticateCliActor(database, 'reviewer', runtime);
  new ReviewService(database, createFixedClock(decidedAt), createSequentialIdGenerator()).review(
    reviewer,
    {
      proposalId,
      decision: 'approved',
      reason: 'Approved this fictional local change.',
    },
  );
}

function countRows(database: SqliteConnection, table: 'executions' | 'audit_events'): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

describe('execute_change MCP tool', () => {
  it('simulates an independently approved change once and returns the saved result on retry', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        await approveProposal(database, proposalId);
        const resourceId = buildProposalRequest().resourceId;
        const resources = new SqliteResourceRepository(database);
        const before = resources.getById(resourceId);
        if (before === null) throw new Error('Missing fictional resource.');
        const auditBefore = countRows(database, 'audit_events');

        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'execute_change',
          );
          expect(tool).toMatchObject({
            name: 'execute_change',
            annotations: { readOnlyHint: false, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { proposalId: expect.any(Object), idempotencyKey: expect.any(Object) },
            },
            outputSchema: { type: 'object' },
          });

          const input = { proposalId, idempotencyKey: executionKey };
          const first = await client.callTool({ name: 'execute_change', arguments: input });
          expect(first.isError).not.toBe(true);
          const output = executeChangeOutputSchema.parse(first.structuredContent);
          expect(output).toMatchObject({
            proposalId,
            status: 'executed',
            resourceId,
            resourceVersion: before.version + 1,
            executionId: expect.stringMatching(/^execution-[a-z0-9-]+$/),
            auditEventId: expect.stringMatching(/^event-[a-z0-9-]+$/),
            simulationNotice: 'Fictional demo data; estimates are not real bills or savings.',
          });
          expect(output.result.before).toEqual(before);
          expect(output.result.after.version).toBe(before.version + 1);
          expect(output.result.after.monthlyCostEstimateCents).toBe(0);
          expect(JSON.parse((first.content[0] as { text: string }).text)).toEqual(output);
          expect(JSON.stringify(first)).not.toContain(database.name);
          expect(resources.getById(resourceId)).toEqual(output.result.after);
          expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
            'executed',
          );
          expect(countRows(database, 'executions')).toBe(1);
          expect(countRows(database, 'audit_events')).toBe(auditBefore + 2);
          expect(
            database
              .prepare(
                `
          SELECT id FROM audit_events WHERE id = ? AND subject_id = ? AND action = 'execution_result'
        `,
              )
              .get(output.auditEventId, proposalId),
          ).toEqual({ id: output.auditEventId });

          const replay = await client.callTool({ name: 'execute_change', arguments: input });
          expect(replay.isError).not.toBe(true);
          expect(replay.structuredContent).toEqual(output);
          expect(countRows(database, 'executions')).toBe(1);
          expect(countRows(database, 'audit_events')).toBe(auditBefore + 2);
          expect(resources.getById(resourceId)).toEqual(output.result.after);

          const conflicting = await client.callTool({
            name: 'execute_change',
            arguments: { proposalId, idempotencyKey: 'mcp-execution-other-key' },
          });
          expect(conflicting).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'CONFLICT' } },
          });
        });
      },
      { seed: true },
    );
  });

  it('rejects draft, pending review, missing proposal, and authority claims without writes', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        const resourceId = buildProposalRequest().resourceId;
        const resources = new SqliteResourceRepository(database);
        const before = resources.getById(resourceId);
        const auditBefore = countRows(database, 'audit_events');

        await withClient(localServer(database), async (client) => {
          const draft = await client.callTool({
            name: 'execute_change',
            arguments: { proposalId, idempotencyKey: executionKey },
          });
          expect(draft).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'PRECONDITION_FAILED' } },
          });

          new ApprovalRequestService(database, createFixedClock(requestedAt)).requestApproval(
            createMcpActor(localConfig(database)),
            { proposalId, justification: 'Waiting for an independent reviewer.' },
          );
          const auditAfterRequest = countRows(database, 'audit_events');
          const pending = await client.callTool({
            name: 'execute_change',
            arguments: { proposalId, idempotencyKey: executionKey },
          });
          expect(pending).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'PRECONDITION_FAILED' } },
          });

          const missing = await client.callTool({
            name: 'execute_change',
            arguments: { proposalId: 'proposal-missing', idempotencyKey: executionKey },
          });
          expect(missing).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'NOT_FOUND' } },
          });

          for (const input of [
            { proposalId, idempotencyKey: executionKey, approved: true },
            { proposalId, idempotencyKey: executionKey, reviewerId: 'reviewer-001' },
            { proposalId, idempotencyKey: executionKey, command: 'run-something' },
            { proposalId, idempotencyKey: '../unsafe-key' },
          ]) {
            const invalid = await client.callTool({ name: 'execute_change', arguments: input });
            expect(invalid.isError).toBe(true);
            expect(JSON.stringify(invalid)).not.toContain(database.name);
          }
          expect(countRows(database, 'audit_events')).toBe(auditAfterRequest);
        });
        expect(auditBefore).toBe(1);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
          'pending_approval',
        );
        expect(resources.getById(resourceId)).toEqual(before);
        expect(countRows(database, 'executions')).toBe(0);
      },
      { seed: true },
    );
  });

  it('refuses an approved proposal after its resource version changes', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createDraft(database);
        await approveProposal(database, proposalId);
        const resources = new SqliteResourceRepository(database);
        const current = resources.getById(buildProposalRequest().resourceId);
        if (current === null) throw new Error('Missing fictional resource.');
        const update = resources.updateIfVersion(current, current.version);
        expect(update.status).toBe('updated');
        const auditBefore = countRows(database, 'audit_events');

        await withClient(localServer(database), async (client) => {
          const stale = await client.callTool({
            name: 'execute_change',
            arguments: { proposalId, idempotencyKey: executionKey },
          });
          expect(stale).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'CONFLICT' } },
          });
        });
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        expect(resources.getById(current.id)?.version).toBe(current.version + 1);
        expect(countRows(database, 'executions')).toBe(0);
        expect(countRows(database, 'audit_events')).toBe(auditBefore);
      },
      { seed: true },
    );
  });

  it('remains absent from HTTP and denies a viewer even if manually registered', async () => {
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
              toolRegistrars: { execute_change: registerExecuteChangeTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
              'execute_change',
            );
          });
          expect(readOnlyDatabase.readonly).toBe(true);
        } finally {
          readOnlyDatabase.close();
        }

        const viewerServer = new McpServer(
          { name: 'denied-execution-contract', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        registerExecuteChangeTool(viewerServer, {
          database: writableDatabase,
          actor: createMcpActor(config),
        });
        await withClient(viewerServer, async (client) => {
          const denied = await client.callTool({
            name: 'execute_change',
            arguments: { proposalId, idempotencyKey: executionKey },
          });
          expect(denied).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'FORBIDDEN' } },
          });
        });
        expect(new SqliteProposalRepository(writableDatabase).getById(proposalId)?.status).toBe(
          'draft',
        );
        expect(countRows(writableDatabase, 'executions')).toBe(0);
      },
      { seed: true },
    );
  });
});
