import type { z } from 'zod';

import { buildChangePreview } from './change-preview.js';
import { evaluatePolicy as evaluatePolicyRules } from './policy-service.js';
import { InternalError, NotFoundError, ValidationError } from '../domain/errors.js';
import { loadDemoPolicy } from '../domain/policy.js';
import { resourceSchema, type Resource } from '../domain/resource.js';
import { evaluatePolicyInputSchema, evaluatePolicyOutputSchema } from '../mcp/schemas.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type PolicyPreviewResult = DeepReadonly<z.infer<typeof evaluatePolicyOutputSchema>>;

export interface PolicyPreviewResourceReader {
  getById(id: string): Resource | null;
}

const simulationNotice = 'Fictional demo data; estimates are not real bills or savings.' as const;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Explain current policy for a fictional candidate without recording or authorizing a change. */
export class PolicyPreviewService {
  constructor(
    private readonly resourceReader: PolicyPreviewResourceReader,
    private readonly loadCurrentPolicy: () => unknown = loadDemoPolicy,
  ) {}

  evaluatePolicy(actor: ActorContext, input: unknown): PolicyPreviewResult {
    requireCapability(actor, 'evaluate_policy');
    const request = evaluatePolicyInputSchema.safeParse(input);
    if (!request.success) throw new ValidationError();

    const resource = this.resourceReader.getById(request.data.resourceId);
    if (resource === null) throw new NotFoundError();
    const parsedResource = resourceSchema.safeParse(resource);
    if (!parsedResource.success || parsedResource.data.id !== request.data.resourceId) {
      throw new InternalError();
    }

    const preview = buildChangePreview({
      currentResource: parsedResource.data,
      action: request.data.action,
      expectedResourceVersion: parsedResource.data.version,
    });
    // This finding describes proposal eligibility; execution must recheck policy and review.
    const evaluation = evaluatePolicyRules({
      policy: this.loadCurrentPolicy(),
      currentResource: parsedResource.data,
      actionType: request.data.action.type,
      proposedMonthlyCostEstimateCents: preview.after.monthlyCostEstimateCents,
    });
    const output = evaluatePolicyOutputSchema.safeParse({
      resourceId: parsedResource.data.id,
      action: request.data.action,
      evaluation,
      preview,
      simulationNotice,
    });
    if (!output.success) throw new InternalError();
    return deepFreeze(output.data);
  }
}
