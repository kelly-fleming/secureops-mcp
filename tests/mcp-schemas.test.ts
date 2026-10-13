import { describe, expect, it } from 'vitest';

import {
  analyzeResourceInputSchema,
  analyzeResourceOutputSchema,
  evaluatePolicyInputSchema,
  evaluatePolicyOutputSchema,
  executeChangeInputSchema,
  executeChangeOutputSchema,
  getAuditLogInputSchema,
  getAuditLogOutputSchema,
  getResourceInputSchema,
  getResourceOutputSchema,
  listResourcesInputSchema,
  listResourcesOutputSchema,
  proposeChangeInputSchema,
  proposeChangeOutputSchema,
  requestApprovalInputSchema,
  requestApprovalOutputSchema,
  toolErrorOutputSchema,
} from '../src/mcp/schemas.js';
import { buildResource } from './helpers/builders.js';

const resource = buildResource();
const proposalId = 'proposal-demo-001';
const action = { type: 'disable_compute' } as const;
const simulationNotice = 'Fictional demo data; estimates are not real bills or savings.';
const summary = {
  id: resource.id,
  provider: resource.provider,
  kind: resource.kind,
  region: resource.region,
  environment: resource.environment,
  owner: resource.owner,
  monthlyCostEstimateCents: resource.monthlyCostEstimateCents,
  version: resource.version,
};
const preview = { before: resource, after: resource, estimatedMonthlyCostChangeCents: 0 };
const evaluation = {
  allowed: true,
  approvalRequired: true,
  policyVersion: 'demo-v1',
  findings: [
    { ruleId: 'demo_rule', severity: 'info', result: 'pass', rationale: 'Fictional rule passed.' },
  ],
};
const auditEvent = {
  id: 'event-demo-001',
  occurredAt: '2026-01-01T00:00:00.000Z',
  actorType: 'agent',
  action: 'proposal_created',
  subjectType: 'proposal',
  subjectId: proposalId,
  summary: 'Fictional proposal created.',
};

describe('MCP tool inputs', () => {
  it('accepts only bounded read filters and applies pagination defaults', () => {
    expect(listResourcesInputSchema.parse({ provider: 'aws' })).toEqual({
      provider: 'aws',
      limit: 50,
      offset: 0,
    });
    expect(getResourceInputSchema.safeParse({ resourceId: resource.id }).success).toBe(true);
    expect(analyzeResourceInputSchema.safeParse({ resourceId: resource.id }).success).toBe(true);
    expect(getAuditLogInputSchema.parse({ resourceId: resource.id })).toEqual({
      resourceId: resource.id,
      limit: 50,
      offset: 0,
    });
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: '10' },
    { limit: Number.NaN },
    { limit: Number.POSITIVE_INFINITY },
    { offset: -1 },
    { offset: 10_001 },
    { offset: Number.NEGATIVE_INFINITY },
    { sortBy: 'owner' },
    { databasePath: '/tmp/demo.db' },
  ])('rejects unsupported list input %j', (candidate) => {
    expect(listResourcesInputSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects invalid identifiers and caller-supplied authority', () => {
    expect(getResourceInputSchema.safeParse({ resourceId: '../database' }).success).toBe(false);
    expect(
      analyzeResourceInputSchema.safeParse({ resourceId: resource.id, actorId: 'reviewer' })
        .success,
    ).toBe(false);
    expect(getAuditLogInputSchema.safeParse({ proposalId: 'proposal-../secret' }).success).toBe(
      false,
    );
    expect(
      requestApprovalInputSchema.safeParse({
        proposalId: 'proposal-',
        justification: 'Fictional reason.',
      }).success,
    ).toBe(false);
    expect(
      getAuditLogInputSchema.safeParse({ resourceId: resource.id, sql: 'SELECT * FROM resources' })
        .success,
    ).toBe(false);
  });

  it('accepts only allowlisted change actions and constrained workflow fields', () => {
    expect(evaluatePolicyInputSchema.safeParse({ resourceId: resource.id, action }).success).toBe(
      true,
    );
    expect(
      proposeChangeInputSchema.safeParse({
        resourceId: resource.id,
        action: { type: 'resize_compute', targetSize: 'demo-small' },
        reason: 'Fictional capacity adjustment.',
        idempotencyKey: 'proposal-key-001',
      }).success,
    ).toBe(true);
    expect(
      requestApprovalInputSchema.safeParse({
        proposalId,
        justification: 'Fictional reviewer request.',
      }).success,
    ).toBe(true);
    expect(
      executeChangeInputSchema.safeParse({
        proposalId,
        idempotencyKey: 'execution-key-001',
      }).success,
    ).toBe(true);
  });

  it.each([
    { type: 'run_script', command: 'rm -rf /' },
    { type: 'disable_compute', script: 'echo unsafe' },
    { type: 'resize_compute', targetSize: 'arbitrary' },
    { type: 'resize_compute', targetSize: 'demo-small', command: 'echo unsafe' },
  ])('rejects script-like or unsupported action %j', (candidate) => {
    expect(
      evaluatePolicyInputSchema.safeParse({ resourceId: resource.id, action: candidate }).success,
    ).toBe(false);
  });

  it('rejects forged approvals, credentials, and malformed workflow text', () => {
    const validProposal = {
      resourceId: resource.id,
      action,
      reason: 'Fictional change request.',
      idempotencyKey: 'proposal-key-001',
    };
    expect(
      proposeChangeInputSchema.safeParse({ ...validProposal, actorId: 'reviewer-1' }).success,
    ).toBe(false);
    expect(
      proposeChangeInputSchema.safeParse({ ...validProposal, reason: 'x'.repeat(1_001) }).success,
    ).toBe(false);
    expect(
      proposeChangeInputSchema.safeParse({ ...validProposal, reason: 'too short' }).success,
    ).toBe(false);
    expect(
      proposeChangeInputSchema.safeParse({ ...validProposal, reason: 'reason\nscript' }).success,
    ).toBe(false);
    expect(
      proposeChangeInputSchema.safeParse({ ...validProposal, idempotencyKey: '../unsafe' }).success,
    ).toBe(false);
    expect(
      proposeChangeInputSchema.safeParse({ ...validProposal, idempotencyKey: 'short' }).success,
    ).toBe(false);
    expect(
      requestApprovalInputSchema.safeParse({
        proposalId,
        justification: 'Fictional reason.',
        approved: true,
      }).success,
    ).toBe(false);
    expect(
      executeChangeInputSchema.safeParse({
        proposalId,
        idempotencyKey: 'execution-key-001',
        bearerToken: 'secret',
      }).success,
    ).toBe(false);
  });
});

describe('MCP tool outputs', () => {
  it('accepts bounded structured results for every proposed tool', () => {
    const results = {
      listResources: listResourcesOutputSchema.safeParse({ resources: [summary] }),
      getResource: getResourceOutputSchema.safeParse({ resource }),
      analyzeResource: analyzeResourceOutputSchema.safeParse({
        resourceId: resource.id,
        observations: [
          { code: 'idle', confidence: 'medium', message: 'Fictional low utilization.' },
        ],
        estimatedMonthlyCostChangeCents: 0,
        recommendation: 'Consider a fictional adjustment.',
        simulationNotice,
      }),
      evaluatePolicy: evaluatePolicyOutputSchema.safeParse({
        resourceId: resource.id,
        action,
        evaluation,
        preview,
        simulationNotice,
      }),
      proposeChange: proposeChangeOutputSchema.safeParse({
        proposalId,
        status: 'draft',
        preview,
        evaluation,
        simulationNotice,
      }),
      requestApproval: requestApprovalOutputSchema.safeParse({
        proposalId,
        status: 'pending_approval',
        reviewerInstructions: 'Use the local reviewer CLI.',
      }),
      executeChange: executeChangeOutputSchema.safeParse({
        proposalId,
        status: 'executed',
        resourceId: resource.id,
        resourceVersion: resource.version,
        executionId: 'execution-demo-001',
        auditEventId: 'event-demo-001',
        result: preview,
        simulationNotice,
      }),
      getAuditLog: getAuditLogOutputSchema.safeParse({ events: [auditEvent] }),
      toolError: toolErrorOutputSchema.safeParse({
        error: { code: 'CONFLICT', message: 'Request conflicts with current state.' },
      }),
    };
    for (const [name, result] of Object.entries(results)) {
      expect(result.success, name).toBe(true);
    }
  });

  it('rejects oversized collections and invalid provider-kind summaries', () => {
    expect(
      listResourcesOutputSchema.safeParse({ resources: Array(101).fill(summary) }).success,
    ).toBe(false);
    expect(getAuditLogOutputSchema.safeParse({ events: Array(101).fill(auditEvent) }).success).toBe(
      false,
    );
    expect(
      listResourcesOutputSchema.safeParse({ resources: [{ ...summary, provider: 'azure' }] })
        .success,
    ).toBe(false);
    expect(
      listResourcesOutputSchema.safeParse({ resources: [{ ...summary, owner: 'x'.repeat(81) }] })
        .success,
    ).toBe(false);
    expect(
      listResourcesOutputSchema.safeParse({ resources: [{ ...summary, owner: '   ' }] }).success,
    ).toBe(false);
  });

  it('rejects nonfinite estimates, invalid timestamps, and private fields', () => {
    expect(
      listResourcesOutputSchema.safeParse({
        resources: [{ ...summary, monthlyCostEstimateCents: Number.NaN }],
      }).success,
    ).toBe(false);
    expect(
      analyzeResourceOutputSchema.safeParse({
        resourceId: resource.id,
        observations: [],
        estimatedMonthlyCostChangeCents: Number.POSITIVE_INFINITY,
        recommendation: 'Fictional recommendation.',
        simulationNotice,
      }).success,
    ).toBe(false);
    expect(
      getAuditLogOutputSchema.safeParse({
        events: [{ ...auditEvent, occurredAt: '2026-02-30T00:00:00.000Z' }],
      }).success,
    ).toBe(false);
    expect(
      getAuditLogOutputSchema.safeParse({ events: [{ ...auditEvent, subjectType: 'identity' }] })
        .success,
    ).toBe(false);
    expect(
      getResourceOutputSchema.safeParse({ resource, databasePath: '/tmp/demo.db' }).success,
    ).toBe(false);
    expect(
      getResourceOutputSchema.safeParse({ resource: { ...resource, credential: 'secret' } })
        .success,
    ).toBe(false);
    expect(
      toolErrorOutputSchema.safeParse({
        error: { code: 'INTERNAL_ERROR', message: 'Internal error.', stack: 'private' },
      }).success,
    ).toBe(false);
  });
});
