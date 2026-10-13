import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  ConflictError,
  InternalError,
  PreconditionError,
  ValidationError,
} from '../../domain/errors.js';
import type { SqliteConnection } from './connection.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });
const eventIdSchema = z.string().regex(/^event-[a-z0-9-]{1,58}$/);
const actorIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const subjectIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/);
const actionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
const sequenceSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const maximumEventBytes = 32_768;
const maximumDepth = 12;
const maximumEntries = 1_000;
const maximumNodes = 4_096;

const auditEventInputSchema = z.strictObject({
  id: eventIdSchema,
  actorType: z.enum(['agent', 'reviewer', 'auditor', 'system']),
  actorId: actorIdSchema,
  action: actionSchema,
  subjectType: z.enum(['resource', 'proposal', 'execution', 'identity']),
  subjectId: subjectIdSchema,
  payload: z.unknown(),
  occurredAt: timestampSchema,
});

export const storedEventSchema = auditEventInputSchema.omit({ payload: true }).extend({
  sequence: sequenceSchema,
  eventJson: z.string().min(2).max(maximumEventBytes),
  previousHash: hashSchema.nullable(),
  eventHash: hashSchema,
});

export type AuditEventRecord = Readonly<z.infer<typeof storedEventSchema>>;

interface AuditRow {
  readonly sequence: number;
  readonly id: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly action: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly event_json: string;
  readonly occurred_at: string;
  readonly previous_hash: string | null;
  readonly event_hash: string;
}

interface JsonBudget {
  nodesLeft: number;
  bytesLeft: number;
}

function consumeBytes(budget: JsonBudget, value: string): void {
  budget.bytesLeft -= Buffer.byteLength(value, 'utf8');
  if (budget.bytesLeft < 0) throw new ValidationError();
}

function normalizeJson(
  value: unknown,
  seen: WeakSet<object>,
  budget: JsonBudget,
  depth: number,
): unknown {
  budget.nodesLeft -= 1;
  if (depth > maximumDepth || budget.nodesLeft < 0) throw new ValidationError();
  if (typeof value === 'string') {
    consumeBytes(budget, value);
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new ValidationError();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        value.length > maximumEntries ||
        Object.keys(value).length !== value.length ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new ValidationError();
      return Array.from({ length: value.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (item === undefined || !('value' in item)) throw new ValidationError();
        return normalizeJson(item.value, seen, budget, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ValidationError();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) throw new ValidationError();
    const keys = ownKeys as string[];
    if (keys.length > maximumEntries) throw new ValidationError();
    return Object.fromEntries(
      keys.sort().map((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property === undefined || !property.enumerable || !('value' in property)) {
          throw new ValidationError();
        }
        consumeBytes(budget, key);
        return [key, normalizeJson(property.value, seen, budget, depth + 1)] as const;
      }),
    );
  } finally {
    seen.delete(value);
  }
}

/** Canonical JSON for an object-shaped event payload; callers still choose safe fields. */
export function canonicalAuditJson(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError();
  }
  const budget: JsonBudget = { nodesLeft: maximumNodes, bytesLeft: maximumEventBytes };
  const canonical = JSON.stringify(normalizeJson(payload, new WeakSet<object>(), budget, 0));
  if (Buffer.byteLength(canonical, 'utf8') > maximumEventBytes) throw new ValidationError();
  return canonical;
}

/** Hash exactly the text and field order stored in SQLite. */
export function computeAuditEventHash(
  event: Omit<AuditEventRecord, 'sequence' | 'eventHash'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.id,
        event.actorType,
        event.actorId,
        event.action,
        event.subjectType,
        event.subjectId,
        event.eventJson,
        event.occurredAt,
        event.previousHash,
      ]),
      'utf8',
    )
    .digest('hex');
}

function fromRow(row: AuditRow): AuditEventRecord {
  const parsed = storedEventSchema.safeParse({
    sequence: row.sequence,
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    eventJson: row.event_json,
    occurredAt: row.occurred_at,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
  });
  if (!parsed.success || (parsed.data.sequence === 1) !== (parsed.data.previousHash === null)) {
    throw new InternalError();
  }
  try {
    if (canonicalAuditJson(JSON.parse(parsed.data.eventJson) as unknown) !== row.event_json) {
      throw new InternalError();
    }
  } catch {
    throw new InternalError();
  }
  return Object.freeze(parsed.data);
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

/** Storage primitive: application services supply trusted actors and a write transaction. */
export class SqliteAuditRepository {
  constructor(private readonly database: SqliteConnection) {}

  append(input: unknown): AuditEventRecord {
    const parsed = auditEventInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    if (!this.database.inTransaction) throw new PreconditionError();
    const eventJson = canonicalAuditJson(parsed.data.payload);
    const head = this.database
      .prepare(
        `
      SELECT sequence, event_hash AS eventHash FROM audit_events
      ORDER BY sequence DESC LIMIT 1
    `,
      )
      .get() as { sequence: unknown; eventHash: unknown } | undefined;
    if (
      head !== undefined &&
      (!sequenceSchema.safeParse(head.sequence).success ||
        !hashSchema.safeParse(head.eventHash).success)
    )
      throw new InternalError();
    if (head?.sequence === Number.MAX_SAFE_INTEGER) throw new PreconditionError();
    const sequence = head === undefined ? 1 : (head.sequence as number) + 1;
    const previousHash = head === undefined ? null : (head.eventHash as string);
    const eventHash = computeAuditEventHash({
      id: parsed.data.id,
      actorType: parsed.data.actorType,
      actorId: parsed.data.actorId,
      action: parsed.data.action,
      subjectType: parsed.data.subjectType,
      subjectId: parsed.data.subjectId,
      eventJson,
      occurredAt: parsed.data.occurredAt,
      previousHash,
    });

    try {
      this.database
        .prepare(
          `
        INSERT INTO audit_events (
          sequence, id, actor_type, actor_id, action, subject_type,
          subject_id, event_json, occurred_at, previous_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          sequence,
          parsed.data.id,
          parsed.data.actorType,
          parsed.data.actorId,
          parsed.data.action,
          parsed.data.subjectType,
          parsed.data.subjectId,
          eventJson,
          parsed.data.occurredAt,
          previousHash,
          eventHash,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new ConflictError();
      throw new InternalError();
    }
    const row = this.database
      .prepare(
        `
      SELECT sequence, id, actor_type, actor_id, action, subject_type,
        subject_id, event_json, occurred_at, previous_hash, event_hash
      FROM audit_events WHERE sequence = ?
    `,
      )
      .get(sequence) as AuditRow | undefined;
    if (row === undefined) throw new InternalError();
    const inserted = fromRow(row);
    if (inserted.id !== parsed.data.id || inserted.eventHash !== eventHash)
      throw new InternalError();
    return inserted;
  }
}
