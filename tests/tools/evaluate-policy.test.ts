import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { PolicyPreviewService } from '../../src/application/policy-preview-service.js';
import { loadConfig } from '../../src/config.js';
import {
  openConfiguredDatabase,
  type SqliteConnection,
} from '../../src/infra/sqlite/connection.js';
import { SqliteProposalRepository } from '../../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../../src/infra/sqlite/resource-repository.js';
import { loadSeedResources } from '../../src/infra/sqlite/seed.js';
import { evaluatePolicyOutputSchema } from '../../src/mcp/schemas.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { registerEvaluatePolicyTool } from '../../src/mcp/tools/evaluate-policy.js';
import {
  authenticatedCliIdentityBrand,
  createAuthenticatedCliActor,
  createMcpActor,
} from '../../src/security/permissions.js';
import { withTestDatabase } from '../helpers/test-db.js';

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'evaluate-policy-contract-client', version: '0.1.0' });
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
    { config, database, toolRegistrars: { evaluate_policy: registerEvaluatePolicyTool } },
    'local-full',
  );
}

describe('evaluate_policy MCP tool', () => {
  it('exposes transparent allowed and denied findings without writing resources or proposals', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const tool = (await client.listTools()).tools.find(
            (item) => item.name === 'evaluate_policy',
          );
          expect(tool).toMatchObject({
            name: 'evaluate_policy',
            title: 'Evaluate fictional change policy',
            annotations: { readOnlyHint: true, openWorldHint: false },
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { resourceId: expect.any(Object), action: expect.any(Object) },
            },
            outputSchema: { type: 'object' },
          });

          const resources = new SqliteResourceRepository(database);
          const proposals = new SqliteProposalRepository(database);
          const fixtures = loadSeedResources();
          expect(proposals.list()).toEqual([]);

          const cases = [
            {
              resourceId: 'res-aws-ec2-01',
              action: { type: 'resize_compute', targetSize: 'demo-small' },
              allowed: true,
              deniedRuleId: undefined,
              proposedCost: 5_000,
            },
            {
              resourceId: 'res-azure-vm-02',
              action: { type: 'resize_compute', targetSize: 'demo-small' },
              allowed: false,
              deniedRuleId: 'deny_production',
              proposedCost: 5_000,
            },
            {
              resourceId: 'res-aws-ec2-01',
              action: { type: 'resize_compute', targetSize: 'demo-large' },
              allowed: false,
              deniedRuleId: 'limit_cost_increase',
              proposedCost: 15_000,
            },
          ] as const;

          for (const scenario of cases) {
            const before = resources.getById(scenario.resourceId);
            const result = await client.callTool({
              name: 'evaluate_policy',
              arguments: { resourceId: scenario.resourceId, action: scenario.action },
            });
            expect(result.isError).not.toBe(true);
            const output = evaluatePolicyOutputSchema.parse(result.structuredContent);
            expect(output.resourceId).toBe(scenario.resourceId);
            expect(output.action).toEqual(scenario.action);
            expect(output.preview.before).toEqual(before);
            expect(output.preview.after.monthlyCostEstimateCents).toBe(scenario.proposedCost);
            expect(output.preview.after.version).toBe(before?.version);
            expect(output.evaluation.allowed).toBe(scenario.allowed);
            expect(output.evaluation.approvalRequired).toBe(true);
            expect(output.evaluation.policyVersion).toBe('demo-v1');
            expect(output.evaluation.findings.map((finding) => finding.ruleId)).toEqual([
              'deny_production',
              'deny_restricted',
              'deny_protected',
              'require_owner',
              'allow_actions',
              'limit_cost_increase',
              'require_human_approval',
            ]);
            expect(
              output.evaluation.findings.every((finding) => finding.rationale.length > 0),
            ).toBe(true);
            expect(output.evaluation.findings).toContainEqual(
              expect.objectContaining({
                ruleId: 'require_human_approval',
                result: 'approval_required',
              }),
            );
            if (scenario.deniedRuleId !== undefined) {
              expect(output.evaluation.findings).toContainEqual(
                expect.objectContaining({
                  ruleId: scenario.deniedRuleId,
                  result: 'deny',
                }),
              );
            } else {
              expect(output.evaluation.findings.some((finding) => finding.result === 'deny')).toBe(
                false,
              );
            }
            expect(output.simulationNotice).toBe(
              'Fictional demo data; estimates are not real bills or savings.',
            );
            expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(output);
            expect(JSON.stringify(result)).not.toContain(database.name);
            expect(resources.getById(scenario.resourceId)).toEqual(before);
            expect(proposals.list()).toEqual([]);
          }

          for (const fixture of fixtures) expect(resources.getById(fixture.id)).toEqual(fixture);
        });
      },
      { seed: true },
    );
  });

  it('rejects invalid actions, missing resources, and ineligible previews without writes', async () => {
    await withTestDatabase(
      async (database) => {
        await withClient(localServer(database), async (client) => {
          const missing = await client.callTool({
            name: 'evaluate_policy',
            arguments: {
              resourceId: 'res-missing-001',
              action: { type: 'resize_compute', targetSize: 'demo-small' },
            },
          });
          expect(missing).toMatchObject({
            isError: true,
            structuredContent: {
              error: { code: 'NOT_FOUND', message: 'Requested item was not found.' },
            },
          });

          for (const input of [
            { resourceId: 'res-aws-ec2-01', action: { type: 'delete_resource' } },
            {
              resourceId: 'res-aws-ec2-01',
              action: { type: 'resize_compute', targetSize: 'real-large' },
            },
            { resourceId: '../private', action: { type: 'disable_compute' } },
            { resourceId: 'res-aws-ec2-01', action: { type: 'disable_compute' }, approved: true },
          ]) {
            const result = await client.callTool({ name: 'evaluate_policy', arguments: input });
            expect(result.isError).toBe(true);
            expect((result.content[0] as { text: string }).text).toMatch(/invalid|validation/i);
            expect(JSON.stringify(result)).not.toContain(database.name);
          }

          for (const resourceId of ['res-aws-ec2-02', 'res-aws-s3-01', 'res-azure-vm-01']) {
            const result = await client.callTool({
              name: 'evaluate_policy',
              arguments: { resourceId, action: { type: 'disable_compute' } },
            });
            expect(result).toMatchObject({
              isError: true,
              structuredContent: { error: { code: 'PRECONDITION_FAILED' } },
            });
          }
          expect(new SqliteProposalRepository(database).list()).toEqual([]);
          const resources = new SqliteResourceRepository(database);
          for (const fixture of loadSeedResources())
            expect(resources.getById(fixture.id)).toEqual(fixture);
        });
      },
      { seed: true },
    );
  });

  it('rejects invalid reconstructed resources and denies unauthorized actors before parsing', () => {
    const fixture = loadSeedResources()[0]!;
    const actor = createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
    const invalidResource = new PolicyPreviewService({
      getById: () => ({ ...fixture, version: -1 }),
    });
    expect(() =>
      invalidResource.evaluatePolicy(actor, {
        resourceId: fixture.id,
        action: { type: 'disable_compute' },
      }),
    ).toThrow('An internal error occurred.');

    const wrongResource = new PolicyPreviewService({
      getById: () => loadSeedResources()[1]!,
    });
    expect(() =>
      wrongResource.evaluatePolicy(actor, {
        resourceId: fixture.id,
        action: { type: 'disable_compute' },
      }),
    ).toThrow('An internal error occurred.');

    const auditor = createAuthenticatedCliActor({
      id: 'auditor-001',
      role: 'auditor',
      [authenticatedCliIdentityBrand]: true,
    });
    let reads = 0;
    const denied = new PolicyPreviewService({
      getById: () => {
        reads += 1;
        return null;
      },
    });
    expect(() => denied.evaluatePolicy(auditor, null)).toThrow('Operation is not permitted.');
    expect(reads).toBe(0);
  });

  it('keeps the local tool absent from the HTTP viewer even if a registrar is supplied', async () => {
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
              toolRegistrars: { evaluate_policy: registerEvaluatePolicyTool },
            },
            'http-demo',
          );
          await withClient(server, async (client) => {
            expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
              'evaluate_policy',
            );
          });
        } finally {
          readOnlyDatabase.close();
        }
      },
      { seed: true },
    );
  });
});
