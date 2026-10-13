import { describe, expect, it } from 'vitest';

import { buildChangePreview } from '../src/application/change-preview.js';
import {
  changeActionSchema,
  demoSizeSchema,
  monthlyCostEstimateForDemoSize,
} from '../src/domain/change.js';
import { ConflictError, PreconditionError, ValidationError } from '../src/domain/errors.js';
import { loadSeedResources } from '../src/infra/sqlite/seed.js';
import { changePreviewSchema } from '../src/mcp/schemas.js';
import { buildResource } from './helpers/builders.js';

function request(overrides: Record<string, unknown> = {}) {
  const currentResource = buildResource();
  return {
    currentResource,
    action: { type: 'resize_compute', targetSize: 'demo-small' },
    expectedResourceVersion: currentResource.version,
    ...overrides,
  };
}

function fixture(id: string) {
  const resource = loadSeedResources().find((item) => item.id === id);
  if (resource === undefined) throw new Error(`Missing fictional fixture: ${id}`);
  return resource;
}

describe('fictional change preview', () => {
  it('uses the shared strict action contract and all three synthetic cost presets', () => {
    const resource = buildResource();
    const presets = [
      { size: 'demo-small', cents: 5_000 },
      { size: 'demo-medium', cents: 10_000 },
      { size: 'demo-large', cents: 15_000 },
    ] as const;

    for (const { size, cents } of presets) {
      const action = { type: 'resize_compute', targetSize: size };
      const preview = buildChangePreview(request({ action }));
      expect(changeActionSchema.safeParse(action).success).toBe(true);
      expect(demoSizeSchema.safeParse(size).success).toBe(true);
      expect(monthlyCostEstimateForDemoSize(size)).toBe(cents);
      expect(preview.before).toEqual(resource);
      expect(preview.after.monthlyCostEstimateCents).toBe(cents);
      expect(preview.after.utilizationEstimate).toEqual(resource.utilizationEstimate);
      expect(preview.after.version).toBe(resource.version);
      expect(preview.estimatedMonthlyCostChangeCents).toBe(
        cents - resource.monthlyCostEstimateCents,
      );
      expect(changePreviewSchema.safeParse(preview).success).toBe(true);
    }
  });

  it('previews an idle nonproduction disable without changing identity or version', () => {
    for (const environment of ['development', 'staging'] as const) {
      const resource = buildResource({ environment });
      const preview = buildChangePreview(
        request({
          currentResource: resource,
          action: { type: 'disable_compute' },
        }),
      );
      expect(preview.before).toEqual(resource);
      expect(preview.after).toEqual({
        ...resource,
        monthlyCostEstimateCents: 0,
        utilizationEstimate: { metric: 'cpu', percent: 0 },
      });
      expect(preview.estimatedMonthlyCostChangeCents).toBe(-resource.monthlyCostEstimateCents);
      expect(changePreviewSchema.safeParse(preview).success).toBe(true);
    }
  });

  it('previews supported compute kinds without using provider-specific prices', () => {
    for (const id of ['res-aws-ec2-01', 'res-azure-vm-01', 'res-gcp-compute-01']) {
      const resource = fixture(id);
      const preview = buildChangePreview(
        request({
          currentResource: resource,
          expectedResourceVersion: resource.version,
        }),
      );
      expect(preview.after.provider).toBe(resource.provider);
      expect(preview.after.kind).toBe(resource.kind);
      expect(preview.after.monthlyCostEstimateCents).toBe(5_000);
    }
  });

  it('rejects storage and protected targets for either action', () => {
    const storage = fixture('res-aws-s3-01');
    const protectedCompute = fixture('res-aws-ec2-02');
    for (const action of [
      { type: 'resize_compute', targetSize: 'demo-small' },
      { type: 'disable_compute' },
    ]) {
      expect(() =>
        buildChangePreview(
          request({
            currentResource: storage,
            expectedResourceVersion: storage.version,
            action,
          }),
        ),
      ).toThrow(PreconditionError);
      expect(() =>
        buildChangePreview(
          request({
            currentResource: protectedCompute,
            expectedResourceVersion: protectedCompute.version,
            action,
          }),
        ),
      ).toThrow(PreconditionError);
    }
  });

  it('rejects disable when CPU is nonzero or the environment is production', () => {
    const busy = buildResource({ utilizationEstimate: { metric: 'cpu', percent: 0.01 } });
    const production = buildResource({ environment: 'production' });
    for (const resource of [busy, production]) {
      expect(() =>
        buildChangePreview(
          request({
            currentResource: resource,
            action: { type: 'disable_compute' },
          }),
        ),
      ).toThrow(PreconditionError);
    }
  });

  it('can preview a production resize while leaving its separate policy decision unresolved', () => {
    const resource = buildResource({ environment: 'production' });
    const preview = buildChangePreview(request({ currentResource: resource }));
    expect(preview.after.environment).toBe('production');
    expect(preview.after.version).toBe(resource.version);
    expect('allowed' in preview).toBe(false);
    expect('approved' in preview).toBe(false);
  });

  it('rejects stale and malformed versions', () => {
    const resource = buildResource({ version: 2 });
    expect(() =>
      buildChangePreview(
        request({
          currentResource: resource,
          expectedResourceVersion: 1,
        }),
      ),
    ).toThrow(ConflictError);
    for (const expectedResourceVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildChangePreview(request({ expectedResourceVersion }))).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects unknown actions, arbitrary sizes, scripts, and malformed resources', () => {
    for (const action of [
      { type: 'run_script', command: 'echo unsafe' },
      { type: 'resize_compute', targetSize: 'arbitrary' },
      { type: 'resize_compute', targetSize: 'demo-small', script: 'echo unsafe' },
      { type: 'disable_compute', command: 'echo unsafe' },
    ]) {
      expect(() => buildChangePreview(request({ action }))).toThrow(ValidationError);
    }
    expect(() => monthlyCostEstimateForDemoSize('arbitrary')).toThrow(ValidationError);
    expect(() =>
      buildChangePreview(request({ currentResource: { ...buildResource(), owner: '' } })),
    ).toThrow(ValidationError);
    expect(() => buildChangePreview(request({ extraAuthority: 'reviewer' }))).toThrow(
      ValidationError,
    );
  });

  it('is deterministic, does not mutate its input, and freezes returned snapshots', () => {
    const input = request();
    const original = structuredClone(input);
    const first = buildChangePreview(input);

    expect(buildChangePreview(input)).toEqual(first);
    expect(input).toEqual(original);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.before)).toBe(true);
    expect(Object.isFrozen(first.before.tags)).toBe(true);
    expect(Object.isFrozen(first.after)).toBe(true);
    expect(Object.isFrozen(first.after.governance)).toBe(true);
  });
});
