import { z } from 'zod';

import {
  ConflictError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../../domain/errors.js';
import type { SqliteConnection } from './connection.js';

const decisionIdSchema = z.string().regex(/^decision-[a-z0-9-]{1,55}$/);
const proposalIdSchema = z.string().regex(/^proposal-[a-z0-9-]{1,55}$/);
const reviewerIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const decisionReasonSchema = z
  .string()
  .max(1_000)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .trim()
  .min(1);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });

export const reviewDecisionSchema = z.strictObject({
  id: decisionIdSchema,
  proposalId: proposalIdSchema,
  reviewerId: reviewerIdSchema,
  decision: z.enum(['approved', 'rejected']),
  reason: decisionReasonSchema,
  decidedAt: timestampSchema,
});
export type ReviewDecisionRecord = z.infer<typeof reviewDecisionSchema>;

interface DecisionRow {
  readonly id: string;
  readonly proposal_id: string;
  readonly reviewer_id: string;
  readonly decision: string;
  readonly reason: string;
  readonly decided_at: string;
}

function fromRow(row: DecisionRow): ReviewDecisionRecord {
  const parsed = reviewDecisionSchema.safeParse({
    id: row.id,
    proposalId: row.proposal_id,
    reviewerId: row.reviewer_id,
    decision: row.decision,
    reason: row.reason,
    decidedAt: row.decided_at,
  });
  if (!parsed.success || parsed.data.reason !== row.reason) throw new InternalError();
  return parsed.data;
}

function isConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

export class SqliteDecisionRepository {
  constructor(private readonly database: SqliteConnection) {}

  getByProposalId(proposalId: string): ReviewDecisionRecord | null {
    if (!proposalIdSchema.safeParse(proposalId).success) throw new ValidationError();
    const row = this.database
      .prepare(
        `
      SELECT id, proposal_id, reviewer_id, decision, reason, decided_at
      FROM approval_decisions WHERE proposal_id = ?
    `,
      )
      .get(proposalId) as DecisionRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  /** Storage only: the caller authenticates the reviewer and owns the write transaction. */
  insert(input: unknown): ReviewDecisionRecord {
    const parsed = reviewDecisionSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    if (!this.database.inTransaction) throw new PreconditionError();
    const decision = parsed.data;
    if (this.getByProposalId(decision.proposalId) !== null) throw new ConflictError();
    if (
      this.database.prepare('SELECT 1 FROM proposals WHERE id = ?').get(decision.proposalId) ===
      undefined
    ) {
      throw new NotFoundError();
    }

    try {
      this.database
        .prepare(
          `
        INSERT INTO approval_decisions (id, proposal_id, reviewer_id, decision, reason, decided_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          decision.id,
          decision.proposalId,
          decision.reviewerId,
          decision.decision,
          decision.reason,
          decision.decidedAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new ConflictError();
      throw new InternalError();
    }
    const inserted = this.getByProposalId(decision.proposalId);
    if (inserted === null || inserted.id !== decision.id) throw new InternalError();
    return inserted;
  }
}
