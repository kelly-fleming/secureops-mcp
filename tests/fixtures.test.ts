import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resourceSchema } from '../src/domain/resource.js';
import type { Resource } from '../src/domain/resource.js';

const fixtureUrl = new URL('../fixtures/resources.json', import.meta.url);

function loadResources(): Resource[] {
  const source: unknown = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  return resourceSchema.array().parse(source);
}

describe('synthetic resource fixtures', () => {
  it('contains at least twelve resources accepted by the domain schema', () => {
    const resources = loadResources();
    expect(resources.length).toBeGreaterThanOrEqual(12);
  });

  it('uses unique, clearly fictional IDs in deterministic order', () => {
    const resources = loadResources();
    const ids = resources.map((resource) => resource.id);
    const providerIds = resources.map((resource) => resource.providerResourceId);

    expect(new Set(ids).size).toBe(resources.length);
    expect(new Set(providerIds).size).toBe(resources.length);
    expect(ids).toEqual([...ids].sort());
    expect(providerIds.every((id) => id.startsWith('demo/'))).toBe(true);
    expect(resources.every((resource) => resource.version === 1)).toBe(true);
  });

  it('has two of each supported provider and kind combination', () => {
    const counts: Record<string, number> = {};
    for (const resource of loadResources()) {
      const key = `${resource.provider}/${resource.kind}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }

    expect(counts).toEqual({
      'aws/ec2-instance': 2,
      'aws/s3-bucket': 2,
      'azure/storage-account': 2,
      'azure/virtual-machine': 2,
      'gcp/cloud-storage-bucket': 2,
      'gcp/compute-instance': 2,
    });
  });

  it('offers safe and unsafe workflow scenarios without real measurements', () => {
    const resources = loadResources();
    expect(
      resources.some(
        (resource) =>
          resource.utilizationEstimate.metric === 'cpu' &&
          resource.utilizationEstimate.percent === 0 &&
          !resource.governance.protectedFromChanges &&
          !resource.governance.hasPolicyViolation,
      ),
    ).toBe(true);
    expect(
      resources.some(
        (resource) =>
          resource.utilizationEstimate.percent > 0 && resource.utilizationEstimate.percent <= 15,
      ),
    ).toBe(true);
    expect(
      resources.some(
        (resource) =>
          resource.utilizationEstimate.metric === 'cpu' &&
          resource.utilizationEstimate.percent >= 65,
      ),
    ).toBe(true);
    expect(
      resources.some(
        (resource) =>
          resource.environment === 'production' && resource.governance.protectedFromChanges,
      ),
    ).toBe(true);
    expect(
      resources.some(
        (resource) => resource.governance.hasRestrictedTag && resource.tags.access === 'restricted',
      ),
    ).toBe(true);
    expect(
      resources.some(
        (resource) =>
          resource.governance.hasPolicyViolation && resource.tags.retention === 'missing',
      ),
    ).toBe(true);
  });
});
