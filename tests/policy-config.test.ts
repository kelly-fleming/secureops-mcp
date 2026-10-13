import { describe, expect, it } from 'vitest';

import { demoPolicySchema, loadDemoPolicy, parseDemoPolicy } from '../src/domain/policy.js';
import { buildResource } from './helpers/builders.js';

interface MutablePolicyDocument {
  version: string;
  description: string;
  rules: Record<string, unknown>[];
}

function policyCopy(): MutablePolicyDocument {
  return structuredClone(loadDemoPolicy()) as unknown as MutablePolicyDocument;
}

function ruleById(document: MutablePolicyDocument, id: string): Record<string, unknown> {
  const rule = document.rules.find((candidate) => candidate.id === id);
  if (rule === undefined) throw new Error(`Missing test policy rule: ${id}`);
  return rule;
}

describe('demo policy configuration', () => {
  it('loads the checked-in fictional policy as a deeply frozen, complete document', () => {
    const policy = loadDemoPolicy();
    expect(policy.version).toBe('demo-v1');
    expect(policy.rules.map((rule) => rule.id)).toEqual([
      'deny_production',
      'deny_restricted',
      'deny_protected',
      'require_owner',
      'allow_actions',
      'limit_cost_increase',
      'require_human_approval',
    ]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(policy.rules.every((rule) => Object.isFrozen(rule))).toBe(true);
    expect(policy.rules.every((rule) => rule.rationale.length > 0)).toBe(true);
  });

  it.each(['demo-v0', 'v1', 'demo-v-1', 'demo-v10000', ''])(
    'rejects invalid version %s',
    (version) => {
      expect(demoPolicySchema.safeParse({ ...policyCopy(), version }).success).toBe(false);
    },
  );

  it('rejects unknown fields, mismatched IDs and effects, and unsafe text', () => {
    const document = policyCopy();
    expect(
      demoPolicySchema.safeParse({ ...document, databasePath: '/private/demo.db' }).success,
    ).toBe(false);
    ruleById(document, 'deny_production').id = 'forged_rule';
    expect(demoPolicySchema.safeParse(document).success).toBe(false);

    const wrongEffect = policyCopy();
    ruleById(wrongEffect, 'require_human_approval').effect = 'deny';
    expect(demoPolicySchema.safeParse(wrongEffect).success).toBe(false);

    const unsafe = policyCopy();
    ruleById(unsafe, 'deny_production').rationale = 'Unsafe\nscript';
    expect(demoPolicySchema.safeParse(unsafe).success).toBe(false);
    ruleById(unsafe, 'deny_production').rationale = '\nUnsafe';
    expect(demoPolicySchema.safeParse(unsafe).success).toBe(false);
    ruleById(unsafe, 'deny_production').rationale = 'Unsafe\r';
    expect(demoPolicySchema.safeParse(unsafe).success).toBe(false);
    ruleById(unsafe, 'deny_production').rationale = 'x'.repeat(301);
    expect(demoPolicySchema.safeParse(unsafe).success).toBe(false);
    expect(demoPolicySchema.safeParse({ ...policyCopy(), description: 'Unsafe\n' }).success).toBe(
      false,
    );
  });

  it('rejects duplicated or missing required rules', () => {
    const duplicate = policyCopy();
    duplicate.rules[1] = { ...ruleById(duplicate, 'deny_production') };
    expect(demoPolicySchema.safeParse(duplicate).success).toBe(false);

    const missing = policyCopy();
    missing.rules = missing.rules.filter((rule) => rule.id !== 'require_owner');
    expect(demoPolicySchema.safeParse(missing).success).toBe(false);
  });

  it.each([-1, 1.5, 1_000_000_001, Number.NaN, Number.POSITIVE_INFINITY, '5000'])(
    'rejects invalid monthly increase cap %s',
    (maximumMonthlyIncreaseCents) => {
      const document = policyCopy();
      ruleById(document, 'limit_cost_increase').maximumMonthlyIncreaseCents =
        maximumMonthlyIncreaseCents;
      expect(demoPolicySchema.safeParse(document).success).toBe(false);
    },
  );

  it('rejects unsupported actions, tag keys, and rule options', () => {
    const unsupported = policyCopy();
    ruleById(unsupported, 'allow_actions').actions = ['resize_compute', 'run_script'];
    expect(demoPolicySchema.safeParse(unsupported).success).toBe(false);

    const duplicate = policyCopy();
    ruleById(duplicate, 'allow_actions').actions = ['resize_compute', 'resize_compute'];
    expect(demoPolicySchema.safeParse(duplicate).success).toBe(false);

    const unsafeTag = policyCopy();
    ruleById(unsafeTag, 'deny_restricted').tagKeys = ['classification', '__proto__'];
    expect(demoPolicySchema.safeParse(unsafeTag).success).toBe(false);

    const extra = policyCopy();
    ruleById(extra, 'deny_production').command = 'echo unsafe';
    expect(demoPolicySchema.safeParse(extra).success).toBe(false);
  });

  it('defines the expected synthetic guard inputs without treating review as approval', () => {
    const document = policyCopy();
    const development = buildResource();
    const production = buildResource({ environment: 'production' });
    expect(development.environment).not.toBe(ruleById(document, 'deny_production').environment);
    expect(production.environment).toBe(ruleById(document, 'deny_production').environment);
    expect(ruleById(document, 'require_owner').source).toBe('resource.owner');
    expect(development.owner.length).toBeGreaterThan(0);
    expect(ruleById(document, 'limit_cost_increase').maximumMonthlyIncreaseCents).toBe(5000);
    expect(ruleById(document, 'require_human_approval').effect).toBe('require_approval');
    expect(parseDemoPolicy(document).rules).toHaveLength(7);
  });
});
