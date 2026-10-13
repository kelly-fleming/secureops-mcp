import { z } from 'zod';

import { ValidationError } from '../domain/errors.js';
import { demoPolicySchema, PolicyConfigurationError, type PolicyRule } from '../domain/policy.js';
import {
  monthlyCostEstimateCentsSchema,
  resourceSchema,
  type Resource,
} from '../domain/resource.js';

const evaluationRequestSchema = z.strictObject({
  policy: z.unknown(),
  currentResource: z.unknown(),
  actionType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  proposedMonthlyCostEstimateCents: monthlyCostEstimateCentsSchema,
});

export interface PolicyFinding {
  readonly ruleId: PolicyRule['id'];
  readonly severity: PolicyRule['severity'];
  readonly result: 'pass' | 'deny' | 'approval_required';
  readonly rationale: string;
}

export interface PolicyEvaluation {
  /** Eligible to request review; never permission to execute. */
  readonly allowed: boolean;
  /** Execution always needs independent review, including when this proposal is denied. */
  readonly approvalRequired: boolean;
  readonly policyVersion: string;
  readonly findings: readonly PolicyFinding[];
}

function resultForRule(
  rule: PolicyRule,
  resource: Resource,
  actionType: string,
  proposedMonthlyCostEstimateCents: number,
): PolicyFinding['result'] {
  switch (rule.type) {
    case 'deny_environment':
      return resource.environment === rule.environment ? 'deny' : 'pass';
    case 'deny_restricted_resource':
      return resource.governance[rule.governanceFlag] ||
        rule.tagKeys.some((key) => resource.tags[key] === rule.restrictedValue)
        ? 'deny'
        : 'pass';
    case 'deny_protected_resource':
      return resource.governance[rule.governanceFlag] ? 'deny' : 'pass';
    case 'require_owner':
      return resource.owner.trim().length > 0 ? 'pass' : 'deny';
    case 'allow_actions':
      return rule.actions.some((allowedAction) => allowedAction === actionType) ? 'pass' : 'deny';
    case 'limit_monthly_cost_increase':
      return proposedMonthlyCostEstimateCents - resource.monthlyCostEstimateCents >
        rule.maximumMonthlyIncreaseCents
        ? 'deny'
        : 'pass';
    case 'require_human_approval':
      return 'approval_required';
    default:
      throw new PolicyConfigurationError();
  }
}

/** Pure eligibility evaluation; execution must check a real reviewer decision. */
export function evaluatePolicy(request: unknown): PolicyEvaluation {
  const parsedRequest = evaluationRequestSchema.safeParse(request);
  if (!parsedRequest.success) throw new ValidationError();

  const parsedPolicy = demoPolicySchema.safeParse(parsedRequest.data.policy);
  if (!parsedPolicy.success) throw new PolicyConfigurationError();

  const parsedResource = resourceSchema.safeParse(parsedRequest.data.currentResource);
  if (!parsedResource.success) throw new ValidationError();

  const { actionType, proposedMonthlyCostEstimateCents } = parsedRequest.data;
  const findings: PolicyFinding[] = parsedPolicy.data.rules.map((rule) =>
    Object.freeze({
      ruleId: rule.id,
      severity: rule.severity,
      result: resultForRule(
        rule,
        parsedResource.data,
        actionType,
        proposedMonthlyCostEstimateCents,
      ),
      rationale: rule.rationale,
    }),
  );

  return Object.freeze({
    allowed: findings.every((finding) => finding.result !== 'deny'),
    approvalRequired: true,
    policyVersion: parsedPolicy.data.version,
    findings: Object.freeze(findings),
  });
}
