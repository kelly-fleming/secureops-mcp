import { z } from 'zod';

import { changeActionSchema, monthlyCostEstimateForDemoSize } from '../domain/change.js';
import {
  ConflictError,
  InternalError,
  PreconditionError,
  ValidationError,
} from '../domain/errors.js';
import { resourceSchema, resourceVersionSchema } from '../domain/resource.js';
import { changePreviewSchema } from '../mcp/schemas.js';

const previewRequestSchema = z.strictObject({
  currentResource: z.unknown(),
  action: changeActionSchema,
  expectedResourceVersion: resourceVersionSchema,
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ChangePreview = DeepReadonly<z.infer<typeof changePreviewSchema>>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Preview a fictional change; policy and reviewer checks are separate gates. */
export function buildChangePreview(input: unknown): ChangePreview {
  const request = previewRequestSchema.safeParse(input);
  if (!request.success) throw new ValidationError();

  const parsedResource = resourceSchema.safeParse(request.data.currentResource);
  if (!parsedResource.success) throw new ValidationError();
  const before = parsedResource.data;
  if (before.version !== request.data.expectedResourceVersion) throw new ConflictError();
  if (before.governance.protectedFromChanges || before.utilizationEstimate.metric !== 'cpu') {
    throw new PreconditionError();
  }

  const action = request.data.action;
  let afterCandidate: unknown;
  if (action.type === 'resize_compute') {
    afterCandidate = {
      ...before,
      monthlyCostEstimateCents: monthlyCostEstimateForDemoSize(action.targetSize),
    };
  } else {
    if (before.environment === 'production' || before.utilizationEstimate.percent !== 0) {
      throw new PreconditionError();
    }
    afterCandidate = {
      ...before,
      monthlyCostEstimateCents: 0,
      utilizationEstimate: { metric: 'cpu', percent: 0 },
    };
  }

  const after = resourceSchema.safeParse(afterCandidate);
  if (!after.success) throw new InternalError();
  const output = changePreviewSchema.safeParse({
    before,
    after: after.data,
    estimatedMonthlyCostChangeCents:
      after.data.monthlyCostEstimateCents - before.monthlyCostEstimateCents,
  });
  if (!output.success) throw new InternalError();
  return deepFreeze(output.data);
}
