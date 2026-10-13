const errorDefinitions = {
  validation: { code: 'VALIDATION_ERROR', publicMessage: 'Invalid request.' },
  notFound: { code: 'NOT_FOUND', publicMessage: 'Requested item was not found.' },
  forbidden: { code: 'FORBIDDEN', publicMessage: 'Operation is not permitted.' },
  conflict: { code: 'CONFLICT', publicMessage: 'Request conflicts with current state.' },
  precondition: {
    code: 'PRECONDITION_FAILED',
    publicMessage: 'Required precondition was not met.',
  },
  internal: { code: 'INTERNAL_ERROR', publicMessage: 'An internal error occurred.' },
} as const;

export type OperationalErrorCategory = keyof typeof errorDefinitions;
export type OperationalErrorCode = (typeof errorDefinitions)[OperationalErrorCategory]['code'];

export interface PublicOperationalError {
  readonly code: OperationalErrorCode;
  readonly message: string;
}

export abstract class OperationalError extends Error {
  readonly category: OperationalErrorCategory;
  readonly code: OperationalErrorCode;

  protected constructor(category: OperationalErrorCategory, options?: ErrorOptions) {
    const definition = errorDefinitions[category];
    super(definition.publicMessage, options);
    this.name = new.target.name;
    this.category = category;
    this.code = definition.code;
  }
}

// Optional causes are for internal diagnostics only; public messages remain fixed.
export class ValidationError extends OperationalError {
  constructor(options?: ErrorOptions) {
    super('validation', options);
  }
}

export class NotFoundError extends OperationalError {
  constructor(options?: ErrorOptions) {
    super('notFound', options);
  }
}

export class ForbiddenError extends OperationalError {
  constructor(options?: ErrorOptions) {
    super('forbidden', options);
  }
}

export class ConflictError extends OperationalError {
  constructor(options?: ErrorOptions) {
    super('conflict', options);
  }
}

export class PreconditionError extends OperationalError {
  constructor(options?: ErrorOptions) {
    super('precondition', options);
  }
}

export class InternalError extends OperationalError {
  constructor(options?: ErrorOptions) {
    super('internal', options);
  }
}

export function publicErrorFor(error: unknown): PublicOperationalError {
  let category: OperationalErrorCategory = 'internal';
  if (error instanceof ValidationError) category = 'validation';
  else if (error instanceof NotFoundError) category = 'notFound';
  else if (error instanceof ForbiddenError) category = 'forbidden';
  else if (error instanceof ConflictError) category = 'conflict';
  else if (error instanceof PreconditionError) category = 'precondition';

  const definition = errorDefinitions[category];

  // Classify by known error class; never read a thrown value's message or cause.
  return { code: definition.code, message: definition.publicMessage };
}
