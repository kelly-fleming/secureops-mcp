import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { InternalError, ValidationError } from '../domain/errors.js';
import { resourceIdSchema, resourceVersionSchema } from '../domain/resource.js';
import { type AuditEventRecord, SqliteAuditRepository } from '../infra/sqlite/audit-repository.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import { reviewDecisionSchema } from '../infra/sqlite/decision-repository.js';
import { proposalDraftSchema } from '../infra/sqlite/proposal-repository.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

const proposalEventSchema = z.strictObject({
  proposalId: proposalDraftSchema.shape.id,
  resourceId: resourceIdSchema,
  resourceVersion: resourceVersionSchema,
  policyVersion: z.string().regex(/^demo-v[1-9][0-9]{0,3}$/),
});

const reviewEventSchema = proposalEventSchema.extend({
  decisionId: reviewDecisionSchema.shape.id,
  decision: reviewDecisionSchema.shape.decision,
});

const executionAttemptSchema = proposalEventSchema.extend({
  actionType: z.enum(['resize_compute', 'disable_compute']),
});

const executionResultSchema = executionAttemptSchema
  .extend({
    outcome: z.enum(['executed', 'precondition_failed', 'conflict', 'internal_failure']),
    executionId: z
      .string()
      .regex(/^execution-[a-z0-9-]{1,54}$/)
      .optional(),
  })
  .superRefine((event, context) => {
    if ((event.outcome === 'executed') !== (event.executionId !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Execution ID and outcome disagree.' });
    }
  });

type ProposalEvent = z.infer<typeof proposalEventSchema>;
type ReviewEvent = z.infer<typeof reviewEventSchema>;
type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;
type ExecutionResult = z.infer<typeof executionResultSchema>;

export interface AuditClock {
  now(): Date;
}

export interface AuditIdGenerator {
  nextId(prefix: string): string;
}

const defaultAuditIds: AuditIdGenerator = {
  nextId: () => `event-${randomUUID()}`,
};

/** Constructs only application-owned event fields; the caller owns the write transaction. */
export class AuditService {
  private readonly events: SqliteAuditRepository;

  constructor(
    database: SqliteConnection,
    private readonly clock: AuditClock,
    private readonly ids: AuditIdGenerator = defaultAuditIds,
  ) {
    this.events = new SqliteAuditRepository(database);
  }

  recordProposalCreated(actor: ActorContext, input: unknown): AuditEventRecord {
    requireCapability(actor, 'propose_change');
    const parsed = proposalEventSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const event = parsed.data;
    return this.append(actor, 'proposal_created', event, {
      proposalId: event.proposalId,
      resourceId: event.resourceId,
      resourceVersion: event.resourceVersion,
      policyVersion: event.policyVersion,
      status: 'draft',
      outcome: 'created',
    });
  }

  recordApprovalRequested(actor: ActorContext, input: unknown): AuditEventRecord {
    requireCapability(actor, 'request_approval');
    const parsed = proposalEventSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const event = parsed.data;
    return this.append(actor, 'approval_requested', event, {
      proposalId: event.proposalId,
      resourceId: event.resourceId,
      resourceVersion: event.resourceVersion,
      policyVersion: event.policyVersion,
      status: 'pending_approval',
      outcome: 'requested',
    });
  }

  recordReviewDecision(actor: ActorContext, input: unknown): AuditEventRecord {
    requireCapability(actor, 'decide_proposal');
    const parsed = reviewEventSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const event = parsed.data;
    return this.append(actor, 'review_decided', event, {
      proposalId: event.proposalId,
      resourceId: event.resourceId,
      resourceVersion: event.resourceVersion,
      policyVersion: event.policyVersion,
      decisionId: event.decisionId,
      status: event.decision,
      outcome: 'decided',
    });
  }

  recordExecutionAttempt(actor: ActorContext, input: unknown): AuditEventRecord {
    requireCapability(actor, 'execute_change');
    const parsed = executionAttemptSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const event = parsed.data;
    return this.append(actor, 'execution_attempted', event, {
      proposalId: event.proposalId,
      resourceId: event.resourceId,
      resourceVersion: event.resourceVersion,
      policyVersion: event.policyVersion,
      actionType: event.actionType,
      outcome: 'attempted',
    });
  }

  /** A failed result belongs in a new transaction after its state transaction rolls back. */
  recordExecutionResult(actor: ActorContext, input: unknown): AuditEventRecord {
    requireCapability(actor, 'execute_change');
    const parsed = executionResultSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError();
    const event = parsed.data;
    return this.append(actor, 'execution_result', event, {
      proposalId: event.proposalId,
      resourceId: event.resourceId,
      resourceVersion: event.resourceVersion,
      policyVersion: event.policyVersion,
      actionType: event.actionType,
      outcome: event.outcome,
      ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
    });
  }

  private append(
    actor: ActorContext,
    action:
      | 'proposal_created'
      | 'approval_requested'
      | 'review_decided'
      | 'execution_attempted'
      | 'execution_result',
    event: ProposalEvent | ReviewEvent | ExecutionAttempt | ExecutionResult,
    payload: Record<string, string | number>,
  ): AuditEventRecord {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new InternalError();
    return this.events.append({
      id: this.ids.nextId('event'),
      actorType: actor.role,
      actorId: actor.actorId,
      action,
      subjectType: 'proposal',
      subjectId: event.proposalId,
      payload,
      occurredAt: now.toISOString(),
    });
  }
}
