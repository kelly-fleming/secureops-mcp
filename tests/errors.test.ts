import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../src/domain/errors.js';
import { toToolErrorResult } from '../src/mcp/tool-result.js';

describe('toToolErrorResult', () => {
  it.each([
    { create: () => new ValidationError(), code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    {
      create: () => new NotFoundError(),
      code: 'NOT_FOUND',
      message: 'Requested item was not found.',
    },
    {
      create: () => new ForbiddenError(),
      code: 'FORBIDDEN',
      message: 'Operation is not permitted.',
    },
    {
      create: () => new ConflictError(),
      code: 'CONFLICT',
      message: 'Request conflicts with current state.',
    },
    {
      create: () => new PreconditionError(),
      code: 'PRECONDITION_FAILED',
      message: 'Required precondition was not met.',
    },
    {
      create: () => new InternalError(),
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
    },
  ])('maps $code to a stable structured MCP error', ({ create, code, message }) => {
    const payload = { error: { code, message } };
    const result = toToolErrorResult(create());

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(payload);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(payload) }]);
  });

  it('redacts messages and causes from known operational errors', () => {
    const secret = 'password=private-value';
    const sql = 'SELECT * FROM reviewer_credentials';
    const error = new NotFoundError({ cause: new Error(`${secret}; ${sql}`) });
    Object.assign(error, {
      message: `${secret}; ${sql}`,
      category: 'forbidden',
      code: 'FORBIDDEN',
    });

    const result = toToolErrorResult(error);
    const serialized = JSON.stringify(result);
    expect(result.structuredContent).toEqual({
      error: { code: 'NOT_FOUND', message: 'Requested item was not found.' },
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(sql);
    expect(serialized).not.toContain('stack');
  });

  it.each([
    new Error('SELECT * FROM reviewer_credentials'),
    'password=private-value',
    { toString: () => 'sensitive local path' },
    null,
  ])('maps an unknown thrown value to a generic internal error', (unknownError) => {
    const result = toToolErrorResult(unknownError);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
        }),
      },
    ]);
  });
});
