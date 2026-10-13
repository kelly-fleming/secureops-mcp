import { createHash } from 'node:crypto';
import { z } from 'zod';

import { changeActionSchema, demoSizeSchema, type ChangeAction } from '../../domain/change.js';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import { demoPolicySchema } from '../../domain/policy.js';
import { resourceIdSchema, resourceVersionSchema } from '../../domain/resource.js';
import type { SqliteConnection } from './connection.js';

const proposalIdSchema = z.string().regex(/^proposal-[a-z0-9-]{1,55}$/);
const actorIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const reasonSchema = z
  .string()
  .max(1_000)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .trim()
  .min(10);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
  });

export const proposalDraftSchema = z.strictObject({
  id: proposalIdSchema,
  resourceId: resourceIdSchema,
  proposerActorId: actorIdSchema,
  action: changeActionSchema,
  reason: reasonSchema,
  expectedResourceVersion: resourceVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  policySnapshot: demoPolicySchema,
  createdAt: timestampSchema,
});

export type ProposalDraft = z.infer<typeof proposalDraftSchema>;

export const proposalStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'executed',
  'stale',
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

const proposalRecordSchema = proposalDraftSchema.extend({
  status: proposalStatusSchema,
  approvalJustification: reasonSchema.nullable(),
  updatedAt: timestampSchema,
});
export type ProposalRecord = z.infer<typeof proposalRecordSchema>;

const proposalTransitionSchema = z.strictObject({
  id: proposalIdSchema,
  expectedStatus: proposalStatusSchema,
  targetStatus: proposalStatusSchema,
  updatedAt: timestampSchema,
  approvalJustification: reasonSchema.optional(),
});

const allowedTransitions: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ['pending_approval', 'stale'],
  pending_approval: ['approved', 'rejected', 'stale'],
  approved: ['executed', 'stale'],
  rejected: [],
  executed: [],
  stale: [],
};

export const proposalListOptionsSchema = z.strictObject({
  resourceId: resourceIdSchema.optional(),
  proposerActorId: actorIdSchema.optional(),
  status: proposalStatusSchema.optional(),
  limit: z.int().min(1).max(100).default(50),
  offset: z.int().min(0).max(10_000).default(0),
});
export type ProposalListOptions = z.input<typeof proposalListOptionsSchema>;

interface ProposalRow {
  readonly id: string;
  readonly resource_id: string;
  readonly proposer_actor_id: string;
  readonly action_type: string;
  readonly requested_change_json: string;
  readonly reason: string;
  readonly expected_resource_version: number;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly policy_snapshot_json: string;
  readonly status: string;
  readonly approval_justification: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const proposalColumns = `
  id, resource_id, proposer_actor_id, action_type, requested_change_json,
  reason, expected_resource_version, idempotency_key, request_fingerprint,
  policy_snapshot_json, status, approval_justification, created_at, updated_at
`;

const resizeChangeSchema = z.strictObject({ targetSize: demoSizeSchema });
const disableChangeSchema = z.strictObject({});
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

function parseStoredJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InternalError();
  }
}

function fromRow(row: ProposalRow): ProposalRecord {
  const requestedChange = parseStoredJson(row.requested_change_json);
  let action: ChangeAction;
  if (row.action_type === 'resize_compute') {
    const parsedChange = resizeChangeSchema.safeParse(requestedChange);
    if (!parsedChange.success) throw new InternalError();
    action = { type: 'resize_compute', targetSize: parsedChange.data.targetSize };
  } else if (row.action_type === 'disable_compute') {
    if (!disableChangeSchema.safeParse(requestedChange).success) throw new InternalError();
    action = { type: 'disable_compute' };
  } else {
    throw new InternalError();
  }

  const parsed = proposalRecordSchema.safeParse({
    id: row.id,
    resourceId: row.resource_id,
    proposerActorId: row.proposer_actor_id,
    action,
    reason: row.reason,
    expectedResourceVersion: row.expected_resource_version,
    idempotencyKey: row.idempotency_key,
    policySnapshot: parseStoredJson(row.policy_snapshot_json),
    status: row.status,
    approvalJustification: row.approval_justification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) throw new InternalError();
  if (
    parsed.data.updatedAt < parsed.data.createdAt ||
    (parsed.data.status === 'draft' && parsed.data.approvalJustification !== null) ||
    (['pending_approval', 'approved', 'rejected', 'executed'].includes(parsed.data.status) &&
      parsed.data.approvalJustification === null) ||
    parsed.data.approvalJustification !== row.approval_justification ||
    !fingerprintSchema.safeParse(row.request_fingerprint).success ||
    row.requested_change_json !== requestedChangeForAction(action) ||
    fingerprintDraft(parsed.data) !== row.request_fingerprint
  ) {
    throw new InternalError();
  }
  return parsed.data;
}

/** The database stores only the fields needed by each allowlisted action. */
export function requestedChangeForAction(action: ChangeAction): string {
  const parsed = changeActionSchema.safeParse(action);
  if (!parsed.success) throw new ValidationError();
  return parsed.data.type === 'resize_compute'
    ? JSON.stringify({ targetSize: parsed.data.targetSize })
    : '{}';
}

/** Stable request identity, independent of generated IDs and policy snapshots. */
export function fingerprintProposalRequest(input: unknown): string {
  const parsed = proposalDraftSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();

  return fingerprintDraft(parsed.data);
}

function fingerprintDraft(
  draft: Pick<ProposalDraft, 'resourceId' | 'expectedResourceVersion' | 'action' | 'reason'>,
): string {
  // A fixed-order tuple avoids ambiguity from object property insertion order.
  const canonicalRequest = JSON.stringify([
    draft.resourceId,
    draft.expectedResourceVersion,
    draft.action.type,
    requestedChangeForAction(draft.action),
    draft.reason,
  ]);
  return createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
}

export class SqliteProposalRepository {
  constructor(private readonly database: SqliteConnection) {}

  /** Nested calls use a savepoint, so an outer audit transaction can own commit. */
  createDraft(input: unknown): ProposalRecord {
    const parsed = proposalDraftSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const draft = parsed.data;
    const fingerprint = fingerprintDraft(draft);

    return this.database
      .transaction((): ProposalRecord => {
        const existing = this.database
          .prepare(
            `SELECT ${proposalColumns} FROM proposals WHERE proposer_actor_id = ? AND idempotency_key = ?`,
          )
          .get(draft.proposerActorId, draft.idempotencyKey) as ProposalRow | undefined;
        if (existing !== undefined) {
          const replay = fromRow(existing);
          if (existing.request_fingerprint !== fingerprint) throw new ConflictError();
          return replay;
        }

        if (
          this.database.prepare('SELECT 1 FROM proposals WHERE id = ?').get(draft.id) !== undefined
        ) {
          throw new ConflictError();
        }
        if (
          this.database.prepare('SELECT 1 FROM resources WHERE id = ?').get(draft.resourceId) ===
          undefined
        ) {
          throw new NotFoundError();
        }

        this.database
          .prepare(
            `
        INSERT INTO proposals (
          id, resource_id, proposer_actor_id, action_type, requested_change_json,
          reason, expected_resource_version, idempotency_key, request_fingerprint,
          policy_snapshot_json, status, approval_justification, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
      `,
          )
          .run(
            draft.id,
            draft.resourceId,
            draft.proposerActorId,
            draft.action.type,
            requestedChangeForAction(draft.action),
            draft.reason,
            draft.expectedResourceVersion,
            draft.idempotencyKey,
            fingerprint,
            JSON.stringify(draft.policySnapshot),
            draft.createdAt,
            draft.createdAt,
          );
        const inserted = this.database
          .prepare(`SELECT ${proposalColumns} FROM proposals WHERE id = ?`)
          .get(draft.id) as ProposalRow | undefined;
        if (inserted === undefined) throw new InternalError();
        return fromRow(inserted);
      })
      .immediate();
  }

  getById(id: string): ProposalRecord | null {
    if (!proposalIdSchema.safeParse(id).success) throw new ValidationError();
    const row = this.database
      .prepare(`SELECT ${proposalColumns} FROM proposals WHERE id = ?`)
      .get(id) as ProposalRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  getByActorAndKey(actorId: string, idempotencyKey: string): ProposalRecord | null {
    if (
      !actorIdSchema.safeParse(actorId).success ||
      !idempotencyKeySchema.safeParse(idempotencyKey).success
    ) {
      throw new ValidationError();
    }
    const row = this.database
      .prepare(
        `SELECT ${proposalColumns} FROM proposals WHERE proposer_actor_id = ? AND idempotency_key = ?`,
      )
      .get(actorId, idempotencyKey) as ProposalRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  /** Call inside the service's transaction with its policy checks and audit write. */
  transitionStatus(input: unknown): ProposalRecord {
    const parsed = proposalTransitionSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const transition = parsed.data;
    if (!allowedTransitions[transition.expectedStatus].includes(transition.targetStatus)) {
      throw new ValidationError();
    }
    const requestsApproval =
      transition.expectedStatus === 'draft' && transition.targetStatus === 'pending_approval';
    if (requestsApproval !== (transition.approvalJustification !== undefined)) {
      throw new ValidationError();
    }

    return this.database
      .transaction((): ProposalRecord => {
        const currentRow = this.database
          .prepare(`SELECT ${proposalColumns} FROM proposals WHERE id = ?`)
          .get(transition.id) as ProposalRow | undefined;
        if (currentRow === undefined) throw new NotFoundError();
        const current = fromRow(currentRow);
        if (
          current.status !== transition.expectedStatus ||
          transition.updatedAt < current.updatedAt
        ) {
          throw new ConflictError();
        }

        if (transition.targetStatus === 'approved' || transition.targetStatus === 'rejected') {
          const decision = this.database
            .prepare('SELECT 1 FROM approval_decisions WHERE proposal_id = ? AND decision = ?')
            .get(transition.id, transition.targetStatus);
          if (decision === undefined) throw new ConflictError();
        }
        if (transition.targetStatus === 'executed') {
          const execution = this.database
            .prepare('SELECT 1 FROM executions WHERE proposal_id = ?')
            .get(transition.id);
          if (execution === undefined) throw new ConflictError();
        }

        const update = requestsApproval
          ? this.database
              .prepare(
                `
            UPDATE proposals
            SET status = ?, approval_justification = ?, updated_at = ?
            WHERE id = ? AND status = ? AND updated_at = ?
          `,
              )
              .run(
                transition.targetStatus,
                transition.approvalJustification,
                transition.updatedAt,
                transition.id,
                transition.expectedStatus,
                current.updatedAt,
              )
          : this.database
              .prepare(
                `
            UPDATE proposals SET status = ?, updated_at = ?
            WHERE id = ? AND status = ? AND updated_at = ?
          `,
              )
              .run(
                transition.targetStatus,
                transition.updatedAt,
                transition.id,
                transition.expectedStatus,
                current.updatedAt,
              );
        if (update.changes !== 1) throw new ConflictError();

        const updatedRow = this.database
          .prepare(`SELECT ${proposalColumns} FROM proposals WHERE id = ?`)
          .get(transition.id) as ProposalRow | undefined;
        if (updatedRow === undefined) throw new InternalError();
        return fromRow(updatedRow);
      })
      .immediate();
  }

  list(options: ProposalListOptions = {}): ProposalRecord[] {
    const parsed = proposalListOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ValidationError();

    const predicates: string[] = [];
    const boundValues: string[] = [];
    if (parsed.data.resourceId !== undefined) {
      predicates.push('resource_id = ?');
      boundValues.push(parsed.data.resourceId);
    }
    if (parsed.data.proposerActorId !== undefined) {
      predicates.push('proposer_actor_id = ?');
      boundValues.push(parsed.data.proposerActorId);
    }
    if (parsed.data.status !== undefined) {
      predicates.push('status = ?');
      boundValues.push(parsed.data.status);
    }
    const whereClause = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
    const rows = this.database
      .prepare(
        `
      SELECT ${proposalColumns} FROM proposals
      ${whereClause}
      ORDER BY created_at, id
      LIMIT ? OFFSET ?
    `,
      )
      .all(...boundValues, parsed.data.limit, parsed.data.offset) as ProposalRow[];
    return rows.map(fromRow);
  }
}
