import { describe, expect, it } from 'vitest';

import { analyzeResource, type ResourceAnalysis } from '../src/application/analysis-service.js';
import { ValidationError } from '../src/domain/errors.js';
import { loadSeedResources } from '../src/infra/sqlite/seed.js';
import { analyzeResourceOutputSchema } from '../src/mcp/schemas.js';
import { buildResource } from './helpers/builders.js';

const fixtures = loadSeedResources();

function fixture(id: string) {
  const resource = fixtures.find((item) => item.id === id);
  if (resource === undefined) throw new Error(`Missing fictional test fixture: ${id}`);
  return resource;
}

function codes(analysis: ResourceAnalysis) {
  return analysis.observations.map((item) => item.code);
}

describe('deterministic fictional resource analysis', () => {
  it('reports the two idle compute fixtures without claiming savings or authorization', () => {
    for (const id of ['res-aws-ec2-01', 'res-gcp-compute-01']) {
      const analysis = analyzeResource(fixture(id));
      expect(analysis.resourceId).toBe(id);
      expect(codes(analysis)).toEqual(['idle']);
      expect(analysis.observations[0]?.confidence).toBe('medium');
      expect(analysis.estimatedMonthlyCostChangeCents).toBe(0);
      expect(analysis.simulationNotice).toBe(
        'Fictional demo data; estimates are not real bills or savings.',
      );
      expect(analysis.recommendation).toContain('owner');
      expect(analyzeResourceOutputSchema.safeParse(analysis).success).toBe(true);
    }
  });

  it('reports low CPU use with confidence based on fictional cost', () => {
    const analysis = analyzeResource(fixture('res-azure-vm-01'));
    expect(codes(analysis)).toEqual(['overprovisioned']);
    expect(analysis.observations[0]?.confidence).toBe('medium');
    expect(analysis.estimatedMonthlyCostChangeCents).toBe(0);

    const lowCost = analyzeResource(
      buildResource({
        monthlyCostEstimateCents: 9_999,
        utilizationEstimate: { metric: 'cpu', percent: 11 },
      }),
    );
    expect(codes(lowCost)).toEqual(['overprovisioned']);
    expect(lowCost.observations[0]?.confidence).toBe('low');
  });

  it('treats low storage use as a low-confidence review prompt', () => {
    for (const id of ['res-aws-s3-01', 'res-gcp-cloud-storage-01']) {
      const analysis = analyzeResource(fixture(id));
      expect(codes(analysis)).toEqual(['overprovisioned']);
      expect(analysis.observations[0]?.confidence).toBe('low');
      expect(analysis.recommendation).toContain('owner');
    }
  });

  it('keeps protected and policy-attention observations ahead of utilization', () => {
    const protectedAnalysis = analyzeResource(fixture('res-aws-ec2-02'));
    expect(codes(protectedAnalysis)).toEqual(['protected', 'policy_attention']);
    expect(protectedAnalysis.observations[0]?.confidence).toBe('high');
    expect(protectedAnalysis.recommendation).toContain('protected');

    const restrictedAnalysis = analyzeResource(fixture('res-aws-s3-02'));
    expect(codes(restrictedAnalysis)).toEqual(['policy_attention']);
    expect(restrictedAnalysis.recommendation).toContain('policy');

    const violationAnalysis = analyzeResource(fixture('res-azure-storage-01'));
    expect(codes(violationAnalysis)).toEqual(['policy_attention']);
  });

  it('surfaces a restricted tag even when its governance flag is absent', () => {
    const resource = buildResource();
    const analysis = analyzeResource(
      buildResource({
        tags: { ...resource.tags, classification: 'restricted' },
        utilizationEstimate: { metric: 'cpu', percent: 0 },
      }),
    );

    expect(codes(analysis)).toEqual(['policy_attention', 'idle']);
    expect(analysis.recommendation).toContain('policy');
    expect(analysis.observations.every((item) => !item.message.includes('restricted'))).toBe(true);
  });

  it('reports no heuristic trigger for a well-utilized development fixture', () => {
    const analysis = analyzeResource(fixture('res-azure-storage-02'));
    expect(codes(analysis)).toEqual(['healthy']);
    expect(analysis.observations[0]?.confidence).toBe('low');
    expect(analysis.recommendation).toContain('No adjustment');
  });

  it('uses inclusive utilization and cost boundaries', () => {
    const computeAtThreshold = analyzeResource(
      buildResource({
        monthlyCostEstimateCents: 10_000,
        utilizationEstimate: { metric: 'cpu', percent: 20 },
      }),
    );
    const computeAboveThreshold = analyzeResource(
      buildResource({ utilizationEstimate: { metric: 'cpu', percent: 20.01 } }),
    );
    const storage = fixture('res-aws-s3-01');
    const storageAtThreshold = analyzeResource({
      ...storage,
      utilizationEstimate: { metric: 'storage', percent: 10 },
    });
    const storageAboveThreshold = analyzeResource({
      ...storage,
      utilizationEstimate: { metric: 'storage', percent: 10.01 },
    });

    expect(codes(computeAtThreshold)).toEqual(['overprovisioned']);
    expect(computeAtThreshold.observations[0]?.confidence).toBe('medium');
    expect(codes(computeAboveThreshold)).toEqual(['healthy']);
    expect(codes(storageAtThreshold)).toEqual(['overprovisioned']);
    expect(codes(storageAboveThreshold)).toEqual(['healthy']);
  });

  it('returns the same immutable result without changing the input', () => {
    const input = fixture('res-azure-vm-01');
    const original = structuredClone(input);
    const first = analyzeResource(input);

    expect(analyzeResource(input)).toEqual(first);
    expect(input).toEqual(original);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.observations)).toBe(true);
    expect(first.observations.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it('rejects malformed or incomplete resources', () => {
    const invalidResources: unknown[] = [
      undefined,
      { ...buildResource(), owner: ' ' },
      { ...buildResource(), utilizationEstimate: undefined },
      { ...buildResource(), utilizationEstimate: { metric: 'cpu', percent: Number.NaN } },
      { ...buildResource(), utilizationEstimate: { metric: 'storage', percent: 5 } },
      { ...buildResource(), monthlyCostEstimateCents: Number.POSITIVE_INFINITY },
    ];
    for (const input of invalidResources) {
      expect(() => analyzeResource(input)).toThrow(ValidationError);
    }
  });
});
