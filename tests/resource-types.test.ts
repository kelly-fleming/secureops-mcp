import { describe, expect, it } from 'vitest';

import { nextResourceVersion, resourceSchema } from '../src/domain/resource.js';
import type { Resource } from '../src/domain/resource.js';

const exampleResource: Resource = {
  id: 'res-aws-compute-01',
  providerResourceId: 'i-demo-001',
  provider: 'aws',
  kind: 'ec2-instance',
  region: 'us-east-1',
  environment: 'development',
  owner: 'team-ops',
  tags: { purpose: 'demo' },
  monthlyCostEstimateCents: 1299,
  utilizationEstimate: { metric: 'cpu', percent: 25 },
  governance: {
    protectedFromChanges: false,
    hasRestrictedTag: false,
    hasPolicyViolation: false,
  },
  version: 1,
};

describe('resourceSchema', () => {
  it.each([
    { provider: 'aws', kind: 'ec2-instance', region: 'us-east-1', metric: 'cpu' },
    { provider: 'aws', kind: 's3-bucket', region: 'us-east-1', metric: 'storage' },
    { provider: 'azure', kind: 'virtual-machine', region: 'eastus', metric: 'cpu' },
    { provider: 'azure', kind: 'storage-account', region: 'eastus', metric: 'storage' },
    { provider: 'gcp', kind: 'compute-instance', region: 'us-central1', metric: 'cpu' },
    { provider: 'gcp', kind: 'cloud-storage-bucket', region: 'us-central1', metric: 'storage' },
  ] as const)('accepts a synthetic $provider $kind', ({ provider, kind, region, metric }) => {
    const candidate = {
      ...exampleResource,
      provider,
      kind,
      region,
      utilizationEstimate: { metric, percent: 50 },
    };
    expect(resourceSchema.safeParse(candidate).success).toBe(true);
  });

  it('rejects a provider and kind that do not match', () => {
    expect(resourceSchema.safeParse({ ...exampleResource, provider: 'azure' }).success).toBe(false);
  });

  it('rejects a utilization metric that does not match the resource kind', () => {
    const candidate = {
      ...exampleResource,
      utilizationEstimate: { metric: 'storage', percent: 25 },
    };
    expect(resourceSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([0, 100])('accepts percentage boundary %s', (percent) => {
    const candidate = { ...exampleResource, utilizationEstimate: { metric: 'cpu', percent } };
    expect(resourceSchema.safeParse(candidate).success).toBe(true);
  });

  it.each([-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid utilization percentage %s',
    (percent) => {
      const candidate = { ...exampleResource, utilizationEstimate: { metric: 'cpu', percent } };
      expect(resourceSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it.each(['', '   ', 'team\nops'])('rejects an empty or unsafe owner %s', (owner) => {
    expect(resourceSchema.safeParse({ ...exampleResource, owner }).success).toBe(false);
  });

  it.each([-1, 1.5, 1_000_000_001])(
    'rejects invalid estimated cost %s',
    (monthlyCostEstimateCents) => {
      expect(
        resourceSchema.safeParse({ ...exampleResource, monthlyCostEstimateCents }).success,
      ).toBe(false);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid resource version %s',
    (version) => {
      expect(resourceSchema.safeParse({ ...exampleResource, version }).success).toBe(false);
    },
  );

  it('rejects too many tags and reserved tag keys', () => {
    const tooManyTags = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`tag${index}`, 'demo']),
    );
    expect(resourceSchema.safeParse({ ...exampleResource, tags: tooManyTags }).success).toBe(false);
    expect(
      resourceSchema.safeParse({ ...exampleResource, tags: { constructor: 'unsafe' } }).success,
    ).toBe(false);
  });

  it('rejects undeclared fields instead of silently dropping them', () => {
    expect(resourceSchema.safeParse({ ...exampleResource, credential: 'unsafe' }).success).toBe(
      false,
    );
  });
});

describe('nextResourceVersion', () => {
  it('increments a valid resource version by one', () => {
    expect(nextResourceVersion(1)).toBe(2);
  });

  it('rejects invalid or exhausted versions', () => {
    expect(() => nextResourceVersion(0)).toThrow();
    expect(() => nextResourceVersion(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});
