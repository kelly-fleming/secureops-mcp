import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { ReviewService } from '../../src/application/review-service.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { loadSeedResources } from '../../src/infra/sqlite/seed.js';
import {
  analyzeResourceOutputSchema,
  evaluatePolicyOutputSchema,
  executeChangeOutputSchema,
  getAuditLogOutputSchema,
  getResourceOutputSchema,
  listResourcesOutputSchema,
  proposeChangeOutputSchema,
  requestApprovalOutputSchema,
  toolErrorOutputSchema,
} from '../../src/mcp/schemas.js';
import { createLocalStdioServerFactory } from '../../src/mcp/stdio.js';
import { derivePasswordVerifier } from '../../src/security/password.js';
import {
  authenticateCliActor,
  type ReviewerAuthRuntime,
} from '../../src/security/reviewer-auth.js';
import { createFixedClock, createSequentialIdGenerator } from '../helpers/fakes.js';
import { withTestDatabase } from '../helpers/test-db.js';

// Keep this independent of the factory's slot arrays so a missing registration fails.
const expectedToolNames = [
  'list_resources',
  'get_resource',
  'analyze_resource',
  'evaluate_policy',
  'propose_change',
  'request_approval',
  'execute_change',
  'get_audit_log',
] as const;

const readOnlyToolNames = new Set([
  'list_resources',
  'get_resource',
  'analyze_resource',
  'evaluate_policy',
  'get_audit_log',
]);

const resourceId = 'res-aws-ec2-01';
const reviewerPassphrase = 'fictional-integration-reviewer-passphrase';

async function callAndParse<Output>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
  schema: { parse(value: unknown): Output },
): Promise<Output> {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  const output = schema.parse(result.structuredContent);
  const textContent = result.content.find((item) => item.type === 'text');
  if (textContent?.type !== 'text') throw new Error('Missing MCP text result.');
  expect(JSON.parse(textContent.text)).toEqual(output);
  return output;
}

async function expectPublicError(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
  code: string,
  message: string,
): Promise<void> {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  const output = toolErrorOutputSchema.parse(result.structuredContent);
  expect(output).toEqual({ error: { code, message } });
  const textContent = result.content.find((item) => item.type === 'text');
  if (textContent?.type !== 'text') throw new Error('Missing MCP error text result.');
  expect(JSON.parse(textContent.text)).toEqual(output);
}

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'mcp-integration-contract-client', version: '0.1.0' });
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

describe('local MCP tool contracts', () => {
  it('initializes the production registration set in order without a reviewer-decision tool', async () => {
    await withTestDatabase(
      async (database) => {
        const buildServer = createLocalStdioServerFactory({
          environment: {
            SECUREOPS_MODE: 'local-full',
            SECUREOPS_DB_PATH: database.name,
          },
          workingDirectory: process.cwd(),
        });
        await withClient(buildServer(), async (client) => {
          expect(client.getServerCapabilities()?.tools).toBeDefined();
          const tools = (await client.listTools()).tools;
          expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
          for (const tool of tools) {
            expect(tool.inputSchema).toMatchObject({
              type: 'object',
              additionalProperties: false,
            });
            expect(tool.outputSchema).toMatchObject({ type: 'object' });
            expect(tool.annotations).toMatchObject({
              readOnlyHint: readOnlyToolNames.has(tool.name),
              openWorldHint: false,
            });
          }
          expect(tools.map((tool) => tool.name)).not.toContain('decide_proposal');
          expect(tools.map((tool) => tool.name)).not.toContain('approve_proposal');
          expect(tools.map((tool) => tool.name)).not.toContain('reject_proposal');
        });
        expect(database.open).toBe(true);
      },
      { seed: true },
    );
  });

  it('returns the declared shape for every tool through real fictional SQLite state', async () => {
    await withTestDatabase(
      async (database) => {
        const buildServer = createLocalStdioServerFactory({
          environment: {
            SECUREOPS_MODE: 'local-full',
            SECUREOPS_DB_PATH: database.name,
          },
          workingDirectory: process.cwd(),
        });
        await withClient(buildServer(), async (client) => {
          const resources = new SqliteResourceRepository(database);
          const original = resources.getById(resourceId);
          if (original === null) throw new Error('Missing fictional resource.');

          const listed = await callAndParse(
            client,
            'list_resources',
            { limit: 100 },
            listResourcesOutputSchema,
          );
          expect(listed.resources).toHaveLength(loadSeedResources().length);
          expect(listed.resources).toContainEqual(
            expect.objectContaining({
              id: resourceId,
              version: original.version,
            }),
          );

          const detail = await callAndParse(
            client,
            'get_resource',
            { resourceId },
            getResourceOutputSchema,
          );
          expect(detail.resource).toEqual(original);

          const analysis = await callAndParse(
            client,
            'analyze_resource',
            { resourceId },
            analyzeResourceOutputSchema,
          );
          expect(analysis.resourceId).toBe(resourceId);
          expect(analysis.observations.map((item) => item.code)).toContain('idle');
          expect(analysis.estimatedMonthlyCostChangeCents).toBe(0);

          const action = { type: 'disable_compute' } as const;
          const policy = await callAndParse(
            client,
            'evaluate_policy',
            { resourceId, action },
            evaluatePolicyOutputSchema,
          );
          expect(policy.evaluation).toMatchObject({ allowed: true, approvalRequired: true });
          expect(policy.preview.before).toEqual(original);
          expect(policy.preview.after.version).toBe(original.version);
          expect(resources.getById(resourceId)).toEqual(original);

          const proposal = await callAndParse(
            client,
            'propose_change',
            {
              resourceId,
              action,
              reason: 'Fictional idle compute change for an independent reviewer.',
              idempotencyKey: 'integration-proposal-0001',
            },
            proposeChangeOutputSchema,
          );
          expect(proposal.status).toBe('draft');
          expect(proposal.preview.before).toEqual(original);
          expect(new SqliteProposalRepository(database).getById(proposal.proposalId)?.status).toBe(
            'draft',
          );

          const request = await callAndParse(
            client,
            'request_approval',
            {
              proposalId: proposal.proposalId,
              justification: 'Please review this fictional proposal independently.',
            },
            requestApprovalOutputSchema,
          );
          expect(request.status).toBe('pending_approval');
          expect(request.reviewerInstructions).toContain('proposals:review');
          const pendingProposal = new SqliteProposalRepository(database).getById(
            proposal.proposalId,
          );
          if (pendingProposal?.status !== 'pending_approval') {
            throw new Error('Expected the fictional proposal to await review.');
          }
          expect(resources.getById(resourceId)).toEqual(original);

          const verifier = await derivePasswordVerifier(reviewerPassphrase);
          const identityTime = pendingProposal.updatedAt;
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
                'identity-integration-reviewer',
                'integration_reviewer',
                verifier.passwordKdf,
                verifier.passwordSalt,
                verifier.passwordVerifier,
                verifier.scryptCost,
                verifier.scryptBlockSize,
                verifier.scryptParallelization,
                identityTime,
                identityTime,
              );
          } finally {
            verifier.passwordSalt.fill(0);
            verifier.passwordVerifier.fill(0);
          }
          const runtime: ReviewerAuthRuntime = {
            isInteractive: () => true,
            askUsername: async () => 'integration_reviewer',
            askPassphrase: async () => reviewerPassphrase,
            delay: async () => undefined,
          };
          const reviewer = await authenticateCliActor(database, 'reviewer', runtime);
          const reviewed = new ReviewService(
            database,
            createFixedClock(pendingProposal.updatedAt),
            createSequentialIdGenerator(),
          ).review(reviewer, {
            proposalId: proposal.proposalId,
            decision: 'approved',
            reason: 'Approved this fictional local change.',
          });
          expect(reviewed.status).toBe('approved');
          expect(resources.getById(resourceId)).toEqual(original);

          const executed = await callAndParse(
            client,
            'execute_change',
            {
              proposalId: proposal.proposalId,
              idempotencyKey: 'integration-execution-0001',
            },
            executeChangeOutputSchema,
          );
          expect(executed).toMatchObject({
            proposalId: proposal.proposalId,
            status: 'executed',
            resourceId,
            resourceVersion: original.version + 1,
          });
          expect(executed.result.before).toEqual(original);
          expect(executed.result.after.monthlyCostEstimateCents).toBe(0);
          expect(resources.getById(resourceId)).toEqual(executed.result.after);
          expect(new SqliteProposalRepository(database).getById(proposal.proposalId)?.status).toBe(
            'executed',
          );

          const audit = await callAndParse(
            client,
            'get_audit_log',
            {
              proposalId: proposal.proposalId,
            },
            getAuditLogOutputSchema,
          );
          expect(audit.events.map((event) => event.action)).toEqual([
            'proposal_created',
            'approval_requested',
            'review_decided',
            'execution_attempted',
            'execution_result',
          ]);
          expect(audit.events.every((event) => event.subjectId === proposal.proposalId)).toBe(true);
          expect(audit.events).toContainEqual(
            expect.objectContaining({
              id: executed.auditEventId,
              action: 'execution_result',
            }),
          );
          const serializedAudit = JSON.stringify(audit);
          expect(serializedAudit).not.toContain(reviewerPassphrase);
          expect(serializedAudit).not.toContain('Approved this fictional local change.');
          expect(serializedAudit).not.toContain(database.name);
        });
      },
      { seed: true },
    );
  });

  it('rejects malformed calls and returns public errors without exposing internal data', async () => {
    await withTestDatabase(
      async (database) => {
        const buildServer = createLocalStdioServerFactory({
          environment: {
            SECUREOPS_MODE: 'local-full',
            SECUREOPS_DB_PATH: database.name,
          },
          workingDirectory: process.cwd(),
        });
        await withClient(buildServer(), async (client) => {
          const original = new SqliteResourceRepository(database).getById(resourceId);
          if (original === null) throw new Error('Missing fictional resource.');
          for (const name of expectedToolNames) {
            const invalid = await client.callTool({
              name,
              arguments: { actorId: 'forged-actor' },
            });
            expect(invalid.isError).toBe(true);
            const serialized = JSON.stringify(invalid);
            expect(serialized).not.toContain(database.name);
          }

          await expectPublicError(
            client,
            'get_resource',
            {
              resourceId: 'res-aws-ec2-99',
            },
            'NOT_FOUND',
            'Requested item was not found.',
          );
          await expectPublicError(
            client,
            'request_approval',
            {
              proposalId: 'proposal-missing',
              justification: 'Fictional independent review request.',
            },
            'NOT_FOUND',
            'Requested item was not found.',
          );
          await expectPublicError(
            client,
            'execute_change',
            {
              proposalId: 'proposal-missing',
              idempotencyKey: 'integration-missing-execution-0001',
            },
            'NOT_FOUND',
            'Requested item was not found.',
          );
          expect(new SqliteResourceRepository(database).getById(resourceId)).toEqual(original);
          const auditCount = database
            .prepare('SELECT COUNT(*) AS count FROM audit_events')
            .get() as { count: number };
          expect(auditCount.count).toBe(0);
        });
      },
      { seed: true },
    );
  });
});
