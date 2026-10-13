import { z } from 'zod';

import { changeActionSchema, demoSizeSchema } from '../domain/change.js';
import {
  monthlyCostEstimateCentsSchema,
  resourceEnvironmentSchema,
  resourceIdSchema,
  resourceOwnerSchema,
  resourceRegionSchema,
  resourceSchema,
  resourceVersionSchema,
} from '../domain/resource.js';

export { changeActionSchema, demoSizeSchema };

export const paginationInputSchema = z.strictObject({
  limit: z.int().min(1).max(100).default(50),
  offset: z.int().min(0).max(10_000).default(0),
});

export const resourceFiltersInputSchema = z.strictObject({
  provider: z.enum(['aws', 'azure', 'gcp']).optional(),
  kind: z
    .enum([
      'ec2-instance',
      's3-bucket',
      'virtual-machine',
      'storage-account',
      'compute-instance',
      'cloud-storage-bucket',
    ])
    .optional(),
  environment: resourceEnvironmentSchema.optional(),
  ...paginationInputSchema.shape,
});

export const listResourcesInputSchema = resourceFiltersInputSchema;

export const getResourceInputSchema = z.strictObject({
  resourceId: resourceIdSchema,
});

export const analyzeResourceInputSchema = getResourceInputSchema;

export const proposalIdSchema = z.string().regex(/^proposal-[a-z0-9-]{1,55}$/);

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

// Reasons are untrusted display text; they never become commands or policy authority.
export const reasonSchema = z
  .string()
  .max(1_000)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .trim()
  .min(10);

export const justificationSchema = reasonSchema;

export const evaluatePolicyInputSchema = z.strictObject({
  resourceId: resourceIdSchema,
  action: changeActionSchema,
});

export const proposeChangeInputSchema = z.strictObject({
  resourceId: resourceIdSchema,
  action: changeActionSchema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const requestApprovalInputSchema = z.strictObject({
  proposalId: proposalIdSchema,
  justification: justificationSchema,
});

export const executeChangeInputSchema = z.strictObject({
  proposalId: proposalIdSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const getAuditLogInputSchema = z
  .strictObject({
    resourceId: resourceIdSchema.optional(),
    proposalId: proposalIdSchema.optional(),
    ...paginationInputSchema.shape,
  })
  .refine((filters) => filters.resourceId === undefined || filters.proposalId === undefined);

const displayTextSchema = z
  .string()
  .min(1)
  .max(500)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/);
const syntheticIdSchema = resourceIdSchema;
const simulationNoticeSchema = z.literal(
  'Fictional demo data; estimates are not real bills or savings.',
);
const utcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
  });

const resourceSummaryFields = {
  id: resourceIdSchema,
  region: resourceRegionSchema,
  environment: resourceEnvironmentSchema,
  owner: resourceOwnerSchema,
  monthlyCostEstimateCents: monthlyCostEstimateCentsSchema,
  version: resourceVersionSchema,
};

export const resourceSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...resourceSummaryFields,
    provider: z.literal('aws'),
    kind: z.literal('ec2-instance'),
  }),
  z.strictObject({
    ...resourceSummaryFields,
    provider: z.literal('aws'),
    kind: z.literal('s3-bucket'),
  }),
  z.strictObject({
    ...resourceSummaryFields,
    provider: z.literal('azure'),
    kind: z.literal('virtual-machine'),
  }),
  z.strictObject({
    ...resourceSummaryFields,
    provider: z.literal('azure'),
    kind: z.literal('storage-account'),
  }),
  z.strictObject({
    ...resourceSummaryFields,
    provider: z.literal('gcp'),
    kind: z.literal('compute-instance'),
  }),
  z.strictObject({
    ...resourceSummaryFields,
    provider: z.literal('gcp'),
    kind: z.literal('cloud-storage-bucket'),
  }),
]);

export const listResourcesOutputSchema = z.strictObject({
  resources: z.array(resourceSummarySchema).max(100),
});

export const getResourceOutputSchema = z.strictObject({
  resource: resourceSchema,
});

export const analysisObservationSchema = z.strictObject({
  code: z.enum(['idle', 'overprovisioned', 'protected', 'policy_attention', 'healthy']),
  confidence: z.enum(['low', 'medium', 'high']),
  message: displayTextSchema,
});

export const analyzeResourceOutputSchema = z.strictObject({
  resourceId: resourceIdSchema,
  observations: z.array(analysisObservationSchema).max(10),
  estimatedMonthlyCostChangeCents: z.int().min(-1_000_000_000).max(1_000_000_000),
  recommendation: displayTextSchema,
  simulationNotice: simulationNoticeSchema,
});

export const policyFindingSchema = z.strictObject({
  ruleId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  severity: z.enum(['info', 'warning', 'critical']),
  result: z.enum(['pass', 'deny', 'advisory', 'approval_required']),
  rationale: displayTextSchema,
});

export const policyEvaluationSchema = z.strictObject({
  allowed: z.boolean(),
  approvalRequired: z.boolean(),
  policyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  findings: z.array(policyFindingSchema).max(32),
});

export const changePreviewSchema = z.strictObject({
  before: resourceSchema,
  after: resourceSchema,
  estimatedMonthlyCostChangeCents: z.int().min(-1_000_000_000).max(1_000_000_000),
});

export const evaluatePolicyOutputSchema = z.strictObject({
  resourceId: resourceIdSchema,
  action: changeActionSchema,
  evaluation: policyEvaluationSchema,
  preview: changePreviewSchema,
  simulationNotice: simulationNoticeSchema,
});

export const proposeChangeOutputSchema = z.strictObject({
  proposalId: proposalIdSchema,
  status: z.literal('draft'),
  preview: changePreviewSchema,
  evaluation: policyEvaluationSchema,
  simulationNotice: simulationNoticeSchema,
});

export const requestApprovalOutputSchema = z.strictObject({
  proposalId: proposalIdSchema,
  status: z.literal('pending_approval'),
  reviewerInstructions: displayTextSchema,
});

export const executeChangeOutputSchema = z.strictObject({
  proposalId: proposalIdSchema,
  status: z.literal('executed'),
  resourceId: resourceIdSchema,
  resourceVersion: resourceVersionSchema,
  executionId: syntheticIdSchema,
  auditEventId: syntheticIdSchema,
  result: changePreviewSchema,
  simulationNotice: simulationNoticeSchema,
});

export const auditEventSummarySchema = z.strictObject({
  id: syntheticIdSchema,
  occurredAt: utcTimestampSchema,
  actorType: z.enum(['agent', 'reviewer', 'auditor', 'system']),
  action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  // Identity events stay in local CLI audit views, not the agent-facing tool.
  subjectType: z.enum(['resource', 'proposal', 'execution']),
  subjectId: syntheticIdSchema,
  summary: displayTextSchema,
});

export const getAuditLogOutputSchema = z.strictObject({
  events: z.array(auditEventSummarySchema).max(100),
});

export const toolErrorOutputSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'FORBIDDEN',
      'CONFLICT',
      'PRECONDITION_FAILED',
      'INTERNAL_ERROR',
    ]),
    message: displayTextSchema,
  }),
});

export type ListResourcesInput = z.infer<typeof listResourcesInputSchema>;
export type GetResourceInput = z.infer<typeof getResourceInputSchema>;
export type AnalyzeResourceInput = z.infer<typeof analyzeResourceInputSchema>;
export type ChangeActionInput = z.infer<typeof changeActionSchema>;
export type EvaluatePolicyInput = z.infer<typeof evaluatePolicyInputSchema>;
export type ProposeChangeInput = z.infer<typeof proposeChangeInputSchema>;
export type RequestApprovalInput = z.infer<typeof requestApprovalInputSchema>;
export type ExecuteChangeInput = z.infer<typeof executeChangeInputSchema>;
export type GetAuditLogInput = z.infer<typeof getAuditLogInputSchema>;
export type ListResourcesOutput = z.infer<typeof listResourcesOutputSchema>;
export type GetResourceOutput = z.infer<typeof getResourceOutputSchema>;
export type AnalyzeResourceOutput = z.infer<typeof analyzeResourceOutputSchema>;
export type EvaluatePolicyOutput = z.infer<typeof evaluatePolicyOutputSchema>;
export type ProposeChangeOutput = z.infer<typeof proposeChangeOutputSchema>;
export type RequestApprovalOutput = z.infer<typeof requestApprovalOutputSchema>;
export type ExecuteChangeOutput = z.infer<typeof executeChangeOutputSchema>;
export type GetAuditLogOutput = z.infer<typeof getAuditLogOutputSchema>;
