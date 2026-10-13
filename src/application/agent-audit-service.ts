import type { z } from 'zod';

import { InternalError, ValidationError } from '../domain/errors.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import {
  getAuditLogInputSchema,
  getAuditLogOutputSchema,
  proposalIdSchema,
} from '../mcp/schemas.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

const workflowSummaries = {
  proposal_created: 'A fictional change proposal was created.',
  approval_requested: 'Independent review was requested for a fictional proposal.',
  review_decided: 'An independent reviewer decided a fictional proposal.',
  execution_attempted: 'A fictional change execution was attempted.',
  execution_result: 'An outcome was recorded for a fictional change execution.',
} as const;

type WorkflowAction = keyof typeof workflowSummaries;
const workflowActions = Object.keys(workflowSummaries);
const workflowActionPlaceholders = workflowActions.map(() => '?').join(', ');

interface AgentAuditRow {
  readonly id: unknown;
  readonly occurred_at: unknown;
  readonly actor_type: unknown;
  readonly action: unknown;
  readonly subject_type: unknown;
  readonly subject_id: unknown;
}

export type AgentAuditResult = Readonly<{
  events: readonly Readonly<z.infer<typeof getAuditLogOutputSchema>['events'][number]>[];
}>;

function summaryForAction(action: unknown): string {
  if (typeof action !== 'string' || !Object.hasOwn(workflowSummaries, action)) {
    throw new InternalError();
  }
  return workflowSummaries[action as WorkflowAction];
}

/** Agent trace is deliberately narrower than the authenticated CLI audit view. */
export class AgentAuditService {
  constructor(private readonly database: SqliteConnection) {}

  getAuditLog(actor: ActorContext, input: unknown = {}): AgentAuditResult {
    requireCapability(actor, 'get_audit_log');
    const parsedInput = getAuditLogInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();
    const { proposalId, resourceId, limit, offset } = parsedInput.data;

    return this.database.transaction((): AgentAuditResult => {
      // These clauses are fixed application SQL; user values remain bound parameters.
      const filter =
        proposalId !== undefined
          ? 'AND subject_id = ?'
          : resourceId !== undefined
            ? "AND json_extract(event_json, '$.resourceId') = ?"
            : '';
      const filterValues =
        proposalId !== undefined ? [proposalId] : resourceId !== undefined ? [resourceId] : [];
      const rows = this.database
        .prepare(
          `
        SELECT id, occurred_at, actor_type, action, subject_type, subject_id
        FROM audit_events
        WHERE subject_type = 'proposal'
          AND action IN (${workflowActionPlaceholders})
          ${filter}
        ORDER BY sequence LIMIT ? OFFSET ?
      `,
        )
        .all(...workflowActions, ...filterValues, limit, offset) as AgentAuditRow[];

      const output = getAuditLogOutputSchema.safeParse({
        events: rows.map((row) => {
          const subjectId = proposalIdSchema.safeParse(row.subject_id);
          if (!subjectId.success) throw new InternalError();
          return {
            id: row.id,
            occurredAt: row.occurred_at,
            actorType: row.actor_type,
            action: row.action,
            subjectType: row.subject_type,
            subjectId: subjectId.data,
            summary: summaryForAction(row.action),
          };
        }),
      });
      if (!output.success) throw new InternalError();
      return Object.freeze({
        events: Object.freeze(output.data.events.map((event) => Object.freeze(event))),
      });
    })();
  }
}
