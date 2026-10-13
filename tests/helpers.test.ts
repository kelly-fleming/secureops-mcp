import { describe, expect, it } from 'vitest';

import { resourceSchema } from '../src/domain/resource.js';
import { buildProposalRequest, buildResource } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

describe('isolated test helpers', () => {
  it('keeps simultaneous seeded databases independent', async () => {
    const id = buildResource().id;
    await withTestDatabase(
      async (first) => {
        first.prepare('UPDATE resources SET version = 2 WHERE id = ?').run(id);
        await withTestDatabase(
          (second) => {
            expect(second.prepare('SELECT version FROM resources WHERE id = ?').get(id)).toEqual({
              version: 1,
            });
            second.prepare('UPDATE resources SET version = 3 WHERE id = ?').run(id);
            expect(first.prepare('SELECT version FROM resources WHERE id = ?').get(id)).toEqual({
              version: 2,
            });
          },
          { seed: true },
        );
      },
      { seed: true },
    );
  });

  it('returns immutable fixed time and independent ID sequences', () => {
    const clock = createFixedClock('2026-01-01T00:00:00.000Z');
    const firstInstant = clock.now();
    firstInstant.setUTCFullYear(2030);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(() => createFixedClock('2026-01-01')).toThrow(RangeError);

    const first = createSequentialIdGenerator();
    const second = createSequentialIdGenerator();
    expect(first.nextId('proposal')).toBe('proposal-000001');
    expect(first.nextId('proposal')).toBe('proposal-000002');
    expect(second.nextId('proposal')).toBe('proposal-000001');
    expect(() => first.nextId('bad prefix')).toThrow(RangeError);
  });

  it('builds separate fictional resources and rejects invalid combinations', () => {
    const first = buildResource();
    const second = buildResource();
    first.tags.purpose = 'changed-in-test';
    expect(second.tags.purpose).toBe('sandbox');
    expect(resourceSchema.parse(second)).toEqual(second);
    expect(() => buildResource({ provider: 'gcp' })).toThrow();
  });

  it('builds storage-compatible proposal inputs without accepting invalid values', () => {
    const request = buildProposalRequest();
    expect(request).toMatchObject({
      resourceId: buildResource().id,
      expectedResourceVersion: 1,
      actionType: 'disable_compute',
      requestedChange: {},
    });
    expect(() => buildProposalRequest({ reason: '' })).toThrow();
    expect(() => buildProposalRequest({ requestedChange: { targetSize: Number.NaN } })).toThrow();
  });
});
