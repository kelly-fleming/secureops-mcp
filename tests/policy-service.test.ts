import { describe, expect, it } from 'vitest';

import {
  evaluatePolicy,
  type PolicyEvaluation,
  type PolicyFinding,
} from '../src/application/policy-service.js';
import { ValidationError } from '../src/domain/errors.js';
import { loadDemoPolicy, PolicyConfigurationError } from '../src/domain/policy.js';
import { policyEvaluationSchema } from '../src/mcp/schemas.js';
import { buildResource } from './helpers/builders.js';

function evaluationRequest(overrides: Record<string, unknown> = {}) {
  const currentResource = buildResource();
  return {
    policy: loadDemoPolicy(),
    currentResource,
    actionType: 'disable_compute',
    proposedMonthlyCostEstimateCents: currentResource.monthlyCostEstimateCents,
    ...overrides,
  };
}

function expectRuleResult(
  evaluation: PolicyEvaluation,
  ruleId: PolicyFinding['ruleId'],
  result: PolicyFinding['result'],
) {
  expect(evaluation.findings.find((finding) => finding.ruleId === ruleId)?.result).toBe(result);
}

describe('pure policy evaluation', () => {
  it('allows a fictional development proposal while explicitly requiring independent approval', () => {
    const request = evaluationRequest();
    const evaluation = evaluatePolicy(request);

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.approvalRequired).toBe(true);
    expect(evaluation.policyVersion).toBe(request.policy.version);
    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(
      request.policy.rules.map((rule) => rule.id),
    );
    expect(evaluation.findings.map((finding) => finding.result)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'approval_required',
    ]);
    expect(policyEvaluationSchema.safeParse(evaluation).success).toBe(true);
  });

  it('returns the same findings without mutating the request', () => {
    const request = evaluationRequest();
    const originalRequest = structuredClone(request);
    const first = evaluatePolicy(request);

    expect(evaluatePolicy(request)).toEqual(first);
    expect(request).toEqual(originalRequest);
    expect(Object.isFrozen(first.findings)).toBe(true);
    expect(first.findings.every((finding) => Object.isFrozen(finding))).toBe(true);
  });

  it('denies a production-labeled resource', () => {
    const evaluation = evaluatePolicy(
      evaluationRequest({ currentResource: buildResource({ environment: 'production' }) }),
    );

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.approvalRequired).toBe(true);
    expectRuleResult(evaluation, 'deny_production', 'deny');
    expectRuleResult(evaluation, 'require_human_approval', 'approval_required');
  });

  it('denies restricted resources by governance flag or configured access tag', () => {
    const resource = buildResource();
    const flagged = evaluatePolicy(
      evaluationRequest({
        currentResource: buildResource({
          governance: { ...resource.governance, hasRestrictedTag: true },
        }),
      }),
    );
    const tagged = evaluatePolicy(
      evaluationRequest({
        currentResource: buildResource({ tags: { ...resource.tags, access: 'restricted' } }),
      }),
    );

    for (const evaluation of [flagged, tagged]) {
      expect(evaluation.allowed).toBe(false);
      expectRuleResult(evaluation, 'deny_restricted', 'deny');
    }
  });

  it('denies protected resources even when the other rules pass', () => {
    const resource = buildResource();
    const evaluation = evaluatePolicy(
      evaluationRequest({
        currentResource: buildResource({
          governance: { ...resource.governance, protectedFromChanges: true },
        }),
      }),
    );

    expect(evaluation.allowed).toBe(false);
    expectRuleResult(evaluation, 'deny_protected', 'deny');
  });

  it('fails closed for a missing owner', () => {
    expect(() =>
      evaluatePolicy(evaluationRequest({ currentResource: { ...buildResource(), owner: ' ' } })),
    ).toThrow(ValidationError);
  });

  it('denies an unsupported action', () => {
    const evaluation = evaluatePolicy(evaluationRequest({ actionType: 'run_script' }));
    expect(evaluation.allowed).toBe(false);
    expectRuleResult(evaluation, 'allow_actions', 'deny');
  });

  it('allows a cost increase at the cap and denies one cent above it', () => {
    const currentCost = buildResource().monthlyCostEstimateCents;
    const atCap = evaluatePolicy(
      evaluationRequest({ proposedMonthlyCostEstimateCents: currentCost + 5_000 }),
    );
    const aboveCap = evaluatePolicy(
      evaluationRequest({ proposedMonthlyCostEstimateCents: currentCost + 5_001 }),
    );
    const lowerCost = evaluatePolicy(evaluationRequest({ proposedMonthlyCostEstimateCents: 0 }));

    expect(atCap.allowed).toBe(true);
    expectRuleResult(atCap, 'limit_cost_increase', 'pass');
    expect(aboveCap.allowed).toBe(false);
    expectRuleResult(aboveCap, 'limit_cost_increase', 'deny');
    expectRuleResult(lowerCost, 'limit_cost_increase', 'pass');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, 1_000_000_001])(
    'rejects invalid proposed monthly cost %s',
    (proposedMonthlyCostEstimateCents) => {
      expect(() => evaluatePolicy(evaluationRequest({ proposedMonthlyCostEstimateCents }))).toThrow(
        ValidationError,
      );
    },
  );

  it('rejects malformed policy documents and missing preview inputs', () => {
    const policy = loadDemoPolicy();
    expect(() =>
      evaluatePolicy(evaluationRequest({ policy: { ...policy, rules: policy.rules.slice(1) } })),
    ).toThrow(PolicyConfigurationError);
    expect(() =>
      evaluatePolicy(evaluationRequest({ proposedMonthlyCostEstimateCents: undefined })),
    ).toThrow(ValidationError);
  });
});
