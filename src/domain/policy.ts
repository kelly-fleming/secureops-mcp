import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

const policyTextSchema = z
  .string()
  .max(300)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .trim()
  .min(1);

const commonRuleFields = {
  severity: z.enum(['info', 'warning', 'critical']),
  rationale: policyTextSchema,
};

export const policyRuleSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('deny_production'),
    type: z.literal('deny_environment'),
    effect: z.literal('deny'),
    environment: z.literal('production'),
  }),
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('deny_restricted'),
    type: z.literal('deny_restricted_resource'),
    effect: z.literal('deny'),
    governanceFlag: z.literal('hasRestrictedTag'),
    tagKeys: z.tuple([z.literal('classification'), z.literal('access')]),
    restrictedValue: z.literal('restricted'),
  }),
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('deny_protected'),
    type: z.literal('deny_protected_resource'),
    effect: z.literal('deny'),
    governanceFlag: z.literal('protectedFromChanges'),
  }),
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('require_owner'),
    type: z.literal('require_owner'),
    effect: z.literal('deny'),
    source: z.literal('resource.owner'),
  }),
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('allow_actions'),
    type: z.literal('allow_actions'),
    effect: z.literal('deny'),
    actions: z.tuple([z.literal('resize_compute'), z.literal('disable_compute')]),
  }),
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('limit_cost_increase'),
    type: z.literal('limit_monthly_cost_increase'),
    effect: z.literal('deny'),
    maximumMonthlyIncreaseCents: z.int().min(0).max(1_000_000_000),
  }),
  z.strictObject({
    ...commonRuleFields,
    id: z.literal('require_human_approval'),
    type: z.literal('require_human_approval'),
    effect: z.literal('require_approval'),
  }),
]);

export type PolicyRule = z.infer<typeof policyRuleSchema>;

const requiredRuleTypes = [
  'deny_environment',
  'deny_restricted_resource',
  'deny_protected_resource',
  'require_owner',
  'allow_actions',
  'limit_monthly_cost_increase',
  'require_human_approval',
] as const satisfies readonly PolicyRule['type'][];

export const demoPolicySchema = z
  .strictObject({
    version: z.string().regex(/^demo-v[1-9][0-9]{0,3}$/),
    description: policyTextSchema,
    rules: z.array(policyRuleSchema).length(requiredRuleTypes.length),
  })
  .superRefine((document, context) => {
    const seen = new Set<PolicyRule['type']>();
    for (const [index, rule] of document.rules.entries()) {
      if (seen.has(rule.type)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'type'],
          message: 'Duplicate policy rule type.',
        });
      }
      seen.add(rule.type);
    }
    for (const requiredType of requiredRuleTypes) {
      if (!seen.has(requiredType)) {
        context.addIssue({
          code: 'custom',
          path: ['rules'],
          message: `Missing policy rule: ${requiredType}.`,
        });
      }
    }
  });

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DemoPolicy = DeepReadonly<z.infer<typeof demoPolicySchema>>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Validate an untrusted policy document before any rule evaluation. */
export function parseDemoPolicy(value: unknown): DemoPolicy {
  return deepFreeze(demoPolicySchema.parse(value));
}

export class PolicyConfigurationError extends Error {
  constructor() {
    super('Demo policy configuration is unavailable or invalid.');
    this.name = 'PolicyConfigurationError';
  }
}

const demoPolicyUrl = new URL('../../config/demo-policies.json', import.meta.url);
const maximumPolicyBytes = 65_536;

/** Read the checked-in policy afresh so callers can compare its current version. */
export function loadDemoPolicy(): DemoPolicy {
  try {
    const file = statSync(demoPolicyUrl);
    if (!file.isFile() || file.size === 0 || file.size > maximumPolicyBytes) {
      throw new PolicyConfigurationError();
    }
    const content = readFileSync(demoPolicyUrl, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > maximumPolicyBytes) {
      throw new PolicyConfigurationError();
    }
    return parseDemoPolicy(JSON.parse(content) as unknown);
  } catch {
    // No local path, JSON detail, or parser text reaches routine diagnostics.
    throw new PolicyConfigurationError();
  }
}
