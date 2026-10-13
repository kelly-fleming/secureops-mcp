import { z } from 'zod';

import { resourceIdSchema, resourceSchema, type Resource } from '../../src/domain/resource.js';
import { loadSeedResources } from '../../src/infra/sqlite/seed.js';

const firstFixture: Resource = (() => {
  const fixture = loadSeedResources()[0];
  if (fixture === undefined) throw new Error('A fictional resource fixture is required.');
  return fixture;
})();

/** Copies a fictional fixture and validates all provider, kind, and metric relationships. */
export function buildResource(overrides: Partial<Resource> = {}): Resource {
  return resourceSchema.parse({
    ...firstFixture,
    ...overrides,
    tags: overrides.tags ?? { ...firstFixture.tags },
    utilizationEstimate: overrides.utilizationEstimate ?? { ...firstFixture.utilizationEstimate },
    governance: overrides.governance ?? { ...firstFixture.governance },
  });
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// This test-only shape follows proposal storage. Application callers map its
// fields into the action-based input validated by proposeChangeInputSchema.
const proposalRequestSchema = z.strictObject({
  resourceId: resourceIdSchema,
  expectedResourceVersion: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  actionType: z.enum(['resize_compute', 'disable_compute']),
  requestedChange: z
    .record(z.string(), jsonValueSchema)
    .refine((change) => JSON.stringify(change).length <= 8_192, 'Requested change is too large.'),
  reason: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().min(1).max(128),
});

export type ProposalRequest = z.infer<typeof proposalRequestSchema>;

/** Builds a draft request for the fictional idle compute fixture. */
export function buildProposalRequest(overrides: Partial<ProposalRequest> = {}): ProposalRequest {
  const resource = buildResource();
  return proposalRequestSchema.parse({
    resourceId: resource.id,
    expectedResourceVersion: resource.version,
    actionType: 'disable_compute',
    requestedChange: {},
    reason: 'Synthetic change request for a local test.',
    idempotencyKey: 'test-proposal-000001',
    ...overrides,
  });
}
