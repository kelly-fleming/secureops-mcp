import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { InternalError, ValidationError } from '../domain/errors.js';
import { toToolErrorResult } from './tool-result.js';

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

type ToolOperationResult<Output> = Output | DeepReadonly<Output>;

/** Parse at the tool boundary and return matching text and structured results. */
export async function handleStructuredToolCall<Input, Output extends Record<string, unknown>>(
  input: unknown,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  operation: (
    parsedInput: Input,
  ) => ToolOperationResult<Output> | Promise<ToolOperationResult<Output>>,
): Promise<CallToolResult> {
  try {
    const parsedInput = inputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();
    const result = await operation(parsedInput.data);
    const parsedOutput = outputSchema.safeParse(result);
    if (!parsedOutput.success) throw new InternalError();
    return {
      content: [{ type: 'text', text: JSON.stringify(parsedOutput.data) }],
      structuredContent: parsedOutput.data,
    };
  } catch (error) {
    return toToolErrorResult(error);
  }
}
