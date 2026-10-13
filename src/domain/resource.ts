import { z } from 'zod';

export const resourceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
const providerResourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
export const resourceRegionSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const resourceEnvironmentSchema = z.enum(['development', 'staging', 'production']);
export const resourceOwnerSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/);

const identityFields = {
  // These are application and fictional provider identifiers, not live cloud references.
  id: resourceIdSchema,
  providerResourceId: providerResourceIdSchema,
  region: resourceRegionSchema,
  environment: resourceEnvironmentSchema,
  owner: resourceOwnerSchema,
};

const awsIdentitySchema = z.strictObject({
  ...identityFields,
  provider: z.literal('aws'),
  kind: z.enum(['ec2-instance', 's3-bucket']),
});

const azureIdentitySchema = z.strictObject({
  ...identityFields,
  provider: z.literal('azure'),
  kind: z.enum(['virtual-machine', 'storage-account']),
});

const gcpIdentitySchema = z.strictObject({
  ...identityFields,
  provider: z.literal('gcp'),
  kind: z.enum(['compute-instance', 'cloud-storage-bucket']),
});

export const resourceIdentitySchema = z.discriminatedUnion('provider', [
  awsIdentitySchema,
  azureIdentitySchema,
  gcpIdentitySchema,
]);

export type ResourceIdentity = z.infer<typeof resourceIdentitySchema>;

const tagKeySchema = z.string().regex(/^(?!(?:constructor|prototype)$)[a-z][a-z0-9_.-]{0,31}$/);
const tagValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/);
const tagsSchema = z
  .record(tagKeySchema, tagValueSchema)
  .refine((tags) => Object.keys(tags).length <= 20, 'A resource can have at most 20 tags');
const percentEstimateSchema = z.number().finite().min(0).max(100);
export const resourceVersionSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
export const monthlyCostEstimateCentsSchema = z.int().min(0).max(1_000_000_000);

const governanceSchema = z.strictObject({
  protectedFromChanges: z.boolean(),
  hasRestrictedTag: z.boolean(),
  hasPolicyViolation: z.boolean(),
});

const resourceFields = {
  tags: tagsSchema,
  // These are fictional monthly estimates in cents, never actual provider bills.
  monthlyCostEstimateCents: monthlyCostEstimateCentsSchema,
  governance: governanceSchema,
  version: resourceVersionSchema,
};

const computeFields = {
  ...resourceFields,
  utilizationEstimate: z.strictObject({
    metric: z.literal('cpu'),
    percent: percentEstimateSchema,
  }),
};

const storageFields = {
  ...resourceFields,
  utilizationEstimate: z.strictObject({
    metric: z.literal('storage'),
    percent: percentEstimateSchema,
  }),
};

// A resource's kind determines both its provider and the estimate it can report.
export const resourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...awsIdentitySchema.shape, ...computeFields, kind: z.literal('ec2-instance') }),
  z.strictObject({ ...awsIdentitySchema.shape, ...storageFields, kind: z.literal('s3-bucket') }),
  z.strictObject({
    ...azureIdentitySchema.shape,
    ...computeFields,
    kind: z.literal('virtual-machine'),
  }),
  z.strictObject({
    ...azureIdentitySchema.shape,
    ...storageFields,
    kind: z.literal('storage-account'),
  }),
  z.strictObject({
    ...gcpIdentitySchema.shape,
    ...computeFields,
    kind: z.literal('compute-instance'),
  }),
  z.strictObject({
    ...gcpIdentitySchema.shape,
    ...storageFields,
    kind: z.literal('cloud-storage-bucket'),
  }),
]);

export type Resource = z.infer<typeof resourceSchema>;

export function nextResourceVersion(currentVersion: number): number {
  resourceVersionSchema.parse(currentVersion);
  if (currentVersion === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Resource version cannot be incremented safely');
  }
  // The caller must check the expected version inside the write transaction.
  return currentVersion + 1;
}
