import { z } from 'zod';

import { ValidationError } from './errors.js';

export const demoSizeSchema = z.enum(['demo-small', 'demo-medium', 'demo-large']);

export const changeActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('resize_compute'), targetSize: demoSizeSchema }),
  z.strictObject({ type: z.literal('disable_compute') }),
]);

export type DemoSize = z.infer<typeof demoSizeSchema>;
export type ChangeAction = z.infer<typeof changeActionSchema>;

const monthlyCostEstimateCentsBySize = Object.freeze({
  'demo-small': 5_000,
  'demo-medium': 10_000,
  'demo-large': 15_000,
} as const satisfies Record<DemoSize, number>);

/** Synthetic monthly estimate for a named demo size; never a provider price. */
export function monthlyCostEstimateForDemoSize(value: unknown): number {
  const parsed = demoSizeSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError();
  return monthlyCostEstimateCentsBySize[parsed.data];
}
