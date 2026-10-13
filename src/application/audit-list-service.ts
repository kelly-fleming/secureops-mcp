import { z } from 'zod';

import { requireEnabledAuditIdentity } from './audit-reader-auth.js';
import { InternalError, ValidationError } from '../domain/errors.js';
import { resourceIdSchema } from '../domain/resource.js';
import { storedEventSchema, type AuditEventRecord } from '../infra/sqlite/audit-repository.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import { proposalDraftSchema } from '../infra/sqlite/proposal-repository.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

const listOptionsSchema = z
  .strictObject({
    proposalId: proposalDraftSchema.shape.id.optional(),
    resourceId: resourceIdSchema.optional(),
    limit: z.int().min(1).max(100).default(50),
    offset: z.int().min(0).max(10_000).default(0),
  })
  .refine((options) => options.proposalId === undefined || options.resourceId === undefined);

// Parse only the one payload field needed for filtering/display. All other stored
// fields remain untrusted and are deliberately absent from the returned item.
const resourcePayloadSchema = z.object({ resourceId: resourceIdSchema.optional() });

interface AuditRow {
  readonly sequence: unknown;
  readonly id: unknown;
  readonly actor_type: unknown;
  readonly actor_id: unknown;
  readonly action: unknown;
  readonly subject_type: unknown;
  readonly subject_id: unknown;
  readonly event_json: unknown;
  readonly occurred_at: unknown;
  readonly previous_hash: unknown;
  readonly event_hash: unknown;
}

export interface AuditListItem {
  readonly sequence: number;
  readonly id: AuditEventRecord['id'];
  readonly actorType: AuditEventRecord['actorType'];
  readonly actorId: AuditEventRecord['actorId'];
  readonly action: AuditEventRecord['action'];
  readonly subjectType: AuditEventRecord['subjectType'];
  readonly subjectId: AuditEventRecord['subjectId'];
  readonly resourceId: string | null;
  readonly occurredAt: AuditEventRecord['occurredAt'];
}

function toSafeItem(row: AuditRow): AuditListItem {
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
  if (!parsed.success) throw new InternalError();

  let payload: unknown;
  try {
    payload = JSON.parse(parsed.data.eventJson) as unknown;
  } catch {
    throw new InternalError();
  }
  const resource = resourcePayloadSchema.safeParse(payload);
  if (!resource.success) throw new InternalError();
  let resourceId: string | null = resource.data.resourceId ?? null;
  if (parsed.data.subjectType === 'resource') {
    const subjectId = resourceIdSchema.safeParse(parsed.data.subjectId);
    if (!subjectId.success || (resourceId !== null && resourceId !== subjectId.data)) {
      throw new InternalError();
    }
    resourceId = subjectId.data;
  }

  return Object.freeze({
    sequence: parsed.data.sequence,
    id: parsed.data.id,
    actorType: parsed.data.actorType,
    actorId: parsed.data.actorId,
    action: parsed.data.action,
    subjectType: parsed.data.subjectType,
    subjectId: parsed.data.subjectId,
    resourceId,
    occurredAt: parsed.data.occurredAt,
  });
}

/** Read-only trace listing; use AuditVerificationService to assess chain integrity. */
export class AuditListService {
  constructor(private readonly database: SqliteConnection) {}

  list(actor: ActorContext, options: unknown = {}): readonly AuditListItem[] {
    requireCapability(actor, 'inspect_audit');
    const parsed = listOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ValidationError();

    return this.database.transaction(() => {
      requireEnabledAuditIdentity(this.database, actor);
      let where = '';
      const boundValues: string[] = [];
      if (parsed.data.proposalId !== undefined) {
        where = "WHERE subject_type = 'proposal' AND subject_id = ?";
        boundValues.push(parsed.data.proposalId);
      } else if (parsed.data.resourceId !== undefined) {
        where = `WHERE (
          (subject_type = 'resource' AND subject_id = ?)
          OR json_extract(event_json, '$.resourceId') = ?
        )`;
        boundValues.push(parsed.data.resourceId, parsed.data.resourceId);
      }
      const rows = this.database
        .prepare(
          `
        SELECT sequence, id, actor_type, actor_id, action, subject_type,
          subject_id, event_json, occurred_at, previous_hash, event_hash
        FROM audit_events ${where}
        ORDER BY sequence LIMIT ? OFFSET ?
      `,
        )
        .all(...boundValues, parsed.data.limit, parsed.data.offset) as AuditRow[];
      return Object.freeze(rows.map(toSafeItem));
    })();
  }
}
