import { requireEnabledAuditIdentity } from './audit-reader-auth.js';
import {
  canonicalAuditJson,
  computeAuditEventHash,
  storedEventSchema,
} from '../infra/sqlite/audit-repository.js';
import type { AuditEventRecord } from '../infra/sqlite/audit-repository.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

export type AuditChainFailure =
  | 'invalid_record'
  | 'noncanonical_payload'
  | 'sequence_gap'
  | 'predecessor_mismatch'
  | 'hash_mismatch';

type AuditVerificationSummary = Readonly<{
  totalEvents: number;
  verifiedEvents: number;
}>;

export type AuditVerificationReport =
  | (AuditVerificationSummary &
      Readonly<{
        valid: true;
        firstInvalidSequence: null;
        failure: null;
      }>)
  | (AuditVerificationSummary &
      Readonly<{
        valid: false;
        firstInvalidSequence: number;
        failure: AuditChainFailure;
      }>);

function decodeEvent(row: unknown): AuditEventRecord | null {
  if (typeof row !== 'object' || row === null) return null;
  const stored = row as Record<string, unknown>;
  const parsed = storedEventSchema.safeParse({
    sequence: stored.sequence,
    id: stored.id,
    actorType: stored.actor_type,
    actorId: stored.actor_id,
    action: stored.action,
    subjectType: stored.subject_type,
    subjectId: stored.subject_id,
    eventJson: stored.event_json,
    occurredAt: stored.occurred_at,
    previousHash: stored.previous_hash,
    eventHash: stored.event_hash,
  });
  return parsed.success ? parsed.data : null;
}

function hasCanonicalPayload(eventJson: string): boolean {
  try {
    return canonicalAuditJson(JSON.parse(eventJson) as unknown) === eventJson;
  } catch {
    return false;
  }
}

function failedReport(
  totalEvents: number,
  verifiedEvents: number,
  firstInvalidSequence: number,
  failure: AuditChainFailure,
): AuditVerificationReport {
  return Object.freeze({
    valid: false as const,
    totalEvents,
    verifiedEvents,
    firstInvalidSequence,
    failure,
  });
}

/** Internal read-only verifier; a caller with database-file write access can rewrite the chain. */
export class AuditVerificationService {
  constructor(private readonly database: SqliteConnection) {}

  verify(actor: ActorContext): AuditVerificationReport {
    requireCapability(actor, 'verify_audit');

    return this.database.transaction(() => {
      requireEnabledAuditIdentity(this.database, actor);
      const count = this.database.prepare('SELECT COUNT(*) AS total FROM audit_events').get() as {
        total: number;
      };
      const totalEvents = count.total;
      let verifiedEvents = 0;
      let expectedSequence = 1;
      let previousHash: string | null = null;

      const rows = this.database
        .prepare(
          `
        SELECT sequence, id, actor_type, actor_id, action, subject_type,
          subject_id, event_json, occurred_at, previous_hash, event_hash
        FROM audit_events ORDER BY sequence
      `,
        )
        .iterate();

      for (const row of rows) {
        const event = decodeEvent(row);
        if (event === null) {
          return failedReport(totalEvents, verifiedEvents, expectedSequence, 'invalid_record');
        }
        if (event.sequence !== expectedSequence) {
          return failedReport(totalEvents, verifiedEvents, expectedSequence, 'sequence_gap');
        }
        if (!hasCanonicalPayload(event.eventJson)) {
          return failedReport(
            totalEvents,
            verifiedEvents,
            expectedSequence,
            'noncanonical_payload',
          );
        }
        if (event.previousHash !== previousHash) {
          return failedReport(
            totalEvents,
            verifiedEvents,
            expectedSequence,
            'predecessor_mismatch',
          );
        }
        if (computeAuditEventHash(event) !== event.eventHash) {
          return failedReport(totalEvents, verifiedEvents, expectedSequence, 'hash_mismatch');
        }

        verifiedEvents += 1;
        expectedSequence += 1;
        previousHash = event.eventHash;
      }

      return Object.freeze({
        valid: true as const,
        totalEvents,
        verifiedEvents,
        firstInvalidSequence: null,
        failure: null,
      });
    })();
  }
}
