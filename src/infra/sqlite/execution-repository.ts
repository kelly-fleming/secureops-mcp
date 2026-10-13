import { z } from 'zod';

import { changeActionSchema, monthlyCostEstimateForDemoSize } from '../../domain/change.js';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../../domain/errors.js';
import {
  monthlyCostEstimateCentsSchema,
  resourceIdSchema,
  resourceVersionSchema,
} from '../../domain/resource.js';
import { changePreviewSchema } from '../../mcp/schemas.js';
import {
  proposalDraftSchema,
  requestedChangeForAction,
  SqliteProposalRepository,
} from './proposal-repository.js';
import type { SqliteConnection } from './connection.js';

const executionIdSchema = z.string().regex(/^execution-[a-z0-9-]{1,54}$/);
const actorIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });

export const executionResultSchema = z
  .strictObject({
    resourceId: resourceIdSchema,
    action: changeActionSchema,
    resourceVersionBefore: resourceVersionSchema,
    resourceVersionAfter: resourceVersionSchema,
    monthlyCostEstimateCentsAfter: monthlyCostEstimateCentsSchema,
    auditEventId: z.string().regex(/^event-[a-z0-9-]{1,58}$/),
    preview: changePreviewSchema,
  })
  .superRefine((result, context) => {
    if (result.resourceVersionAfter !== result.resourceVersionBefore + 1) {
      context.addIssue({
        code: 'custom',
        path: ['resourceVersionAfter'],
        message: 'Invalid resource version.',
      });
    }
    const expectedCost =
      result.action.type === 'resize_compute'
        ? monthlyCostEstimateForDemoSize(result.action.targetSize)
        : 0;
    if (result.monthlyCostEstimateCentsAfter !== expectedCost) {
      context.addIssue({
        code: 'custom',
        path: ['monthlyCostEstimateCentsAfter'],
        message: 'Invalid synthetic cost.',
      });
    }
    if (
      result.preview.before.id !== result.resourceId ||
      result.preview.after.id !== result.resourceId ||
      result.preview.before.version !== result.resourceVersionBefore ||
      result.preview.after.version !== result.resourceVersionAfter ||
      result.preview.after.monthlyCostEstimateCents !== result.monthlyCostEstimateCentsAfter ||
      result.preview.estimatedMonthlyCostChangeCents !==
        result.preview.after.monthlyCostEstimateCents -
          result.preview.before.monthlyCostEstimateCents
    ) {
      context.addIssue({
        code: 'custom',
        path: ['preview'],
        message: 'Inconsistent execution preview.',
      });
    }
  });
export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const executionRecordSchema = z
  .strictObject({
    id: executionIdSchema,
    proposalId: proposalDraftSchema.shape.id,
    executorActorId: actorIdSchema,
    idempotencyKey: idempotencyKeySchema,
    result: executionResultSchema,
    resourceVersionAfter: resourceVersionSchema,
    executedAt: timestampSchema,
  })
  .superRefine((record, context) => {
    if (record.resourceVersionAfter !== record.result.resourceVersionAfter) {
      context.addIssue({
        code: 'custom',
        path: ['resourceVersionAfter'],
        message: 'Inconsistent result version.',
      });
    }
  });
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

interface ExecutionRow {
  readonly id: string;
  readonly proposal_id: string;
  readonly executor_actor_id: string;
  readonly idempotency_key: string;
  readonly result_json: string;
  readonly resource_version_after: number;
  readonly executed_at: string;
}

const executionColumns = `
  id, proposal_id, executor_actor_id, idempotency_key,
  result_json, resource_version_after, executed_at
`;

function fromRow(row: ExecutionRow): ExecutionRecord {
  let result: unknown;
  try {
    result = JSON.parse(row.result_json) as unknown;
  } catch {
    throw new InternalError();
  }
  const parsed = executionRecordSchema.safeParse({
    id: row.id,
    proposalId: row.proposal_id,
    executorActorId: row.executor_actor_id,
    idempotencyKey: row.idempotency_key,
    result,
    resourceVersionAfter: row.resource_version_after,
    executedAt: row.executed_at,
  });
  if (!parsed.success || JSON.stringify(parsed.data.result) !== row.result_json) {
    throw new InternalError();
  }
  return deepFreeze(parsed.data);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

/** Storage primitive: the application service supplies an authorized actor and owns the write transaction. */
export class SqliteExecutionRepository {
  constructor(private readonly database: SqliteConnection) {}

  getByProposalId(proposalId: string): ExecutionRecord | null {
    if (!proposalDraftSchema.shape.id.safeParse(proposalId).success) throw new ValidationError();
    const row = this.database
      .prepare(
        `
      SELECT ${executionColumns} FROM executions WHERE proposal_id = ?
    `,
      )
      .get(proposalId) as ExecutionRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  getByActorAndKey(executorActorId: string, idempotencyKey: string): ExecutionRecord | null {
    if (
      !actorIdSchema.safeParse(executorActorId).success ||
      !idempotencyKeySchema.safeParse(idempotencyKey).success
    )
      throw new ValidationError();
    const row = this.database
      .prepare(
        `
      SELECT ${executionColumns} FROM executions
      WHERE executor_actor_id = ? AND idempotency_key = ?
    `,
      )
      .get(executorActorId, idempotencyKey) as ExecutionRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  insert(input: unknown): ExecutionRecord {
    const parsed = executionRecordSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    if (!this.database.inTransaction) throw new PreconditionError();
    const execution = parsed.data;
    const proposal = new SqliteProposalRepository(this.database).getById(execution.proposalId);
    if (proposal === null) throw new NotFoundError();
    if (
      proposal.resourceId !== execution.result.resourceId ||
      proposal.expectedResourceVersion !== execution.result.resourceVersionBefore ||
      proposal.action.type !== execution.result.action.type ||
      requestedChangeForAction(proposal.action) !==
        requestedChangeForAction(execution.result.action)
    ) {
      throw new ValidationError();
    }

    try {
      this.database
        .prepare(
          `
        INSERT INTO executions (
          id, proposal_id, executor_actor_id, idempotency_key,
          result_json, resource_version_after, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          execution.id,
          execution.proposalId,
          execution.executorActorId,
          execution.idempotencyKey,
          JSON.stringify(execution.result),
          execution.resourceVersionAfter,
          execution.executedAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new ConflictError();
      throw new InternalError();
    }
    const inserted = this.getByProposalId(execution.proposalId);
    if (inserted === null || inserted.id !== execution.id) throw new InternalError();
    return inserted;
  }
}
