import { z } from 'zod';

import { AuditService } from './audit-service.js';
import { buildChangePreview } from './change-preview.js';
import { evaluatePolicy } from './policy-service.js';
import { monthlyCostEstimateForDemoSize } from '../domain/change.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../domain/errors.js';
import { demoPolicySchema, loadDemoPolicy, PolicyConfigurationError } from '../domain/policy.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import {
  reviewDecisionSchema,
  SqliteDecisionRepository,
} from '../infra/sqlite/decision-repository.js';
import { SqliteProposalRepository } from '../infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../infra/sqlite/resource-repository.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

const reviewInputSchema = z.strictObject({
  proposalId: reviewDecisionSchema.shape.proposalId,
  decision: reviewDecisionSchema.shape.decision,
  reason: reviewDecisionSchema.shape.reason,
});

const reviewOutputSchema = z.strictObject({
  proposalId: reviewDecisionSchema.shape.proposalId,
  decisionId: reviewDecisionSchema.shape.id,
  status: reviewDecisionSchema.shape.decision,
  decidedAt: reviewDecisionSchema.shape.decidedAt,
});

export type ReviewResult = Readonly<z.infer<typeof reviewOutputSchema>>;

export interface ReviewClock {
  now(): Date;
}

export interface ReviewIdGenerator {
  nextId(prefix: string): string;
}

interface ReviewerRow {
  readonly role: string;
  readonly disabled: number;
}

/** Record a decision atomically; the reviewer CLI authenticates before invoking this service. */
export class ReviewService {
  private readonly proposals: SqliteProposalRepository;
  private readonly resources: SqliteResourceRepository;
  private readonly decisions: SqliteDecisionRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly database: SqliteConnection,
    private readonly clock: ReviewClock,
    private readonly ids: ReviewIdGenerator,
    private readonly loadPolicy: () => unknown = loadDemoPolicy,
  ) {
    this.proposals = new SqliteProposalRepository(database);
    this.resources = new SqliteResourceRepository(database);
    this.decisions = new SqliteDecisionRepository(database);
    this.audit = new AuditService(database, clock);
  }

  review(actor: ActorContext, input: unknown): ReviewResult {
    requireCapability(actor, 'decide_proposal');
    const parsedInput = reviewInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();

    return this.database
      .transaction((): ReviewResult => {
        const reviewer = this.database
          .prepare('SELECT role, disabled FROM local_identities WHERE id = ?')
          .get(actor.actorId) as ReviewerRow | undefined;
        if (reviewer?.role !== 'reviewer' || reviewer.disabled !== 0) throw new ForbiddenError();

        const proposal = this.proposals.getById(parsedInput.data.proposalId);
        if (proposal === null) throw new NotFoundError();
        if (proposal.status !== 'pending_approval') throw new ConflictError();
        if (proposal.proposerActorId === actor.actorId) throw new ForbiddenError();
        if (this.decisions.getByProposalId(proposal.id) !== null) throw new ConflictError();

        const resource = this.resources.getById(proposal.resourceId);
        if (resource === null || resource.version !== proposal.expectedResourceVersion) {
          throw new ConflictError();
        }
        if (resource.id !== proposal.resourceId) throw new InternalError();

        const policy = demoPolicySchema.safeParse(this.loadPolicy());
        if (!policy.success) throw new PolicyConfigurationError();
        // Rejection records a human decision even if the proposed change is no longer previewable.
        // Approval still requires the full current preview eligibility check.
        const preview =
          parsedInput.data.decision === 'approved'
            ? buildChangePreview({
                currentResource: resource,
                action: proposal.action,
                expectedResourceVersion: proposal.expectedResourceVersion,
              })
            : null;
        const proposedMonthlyCostEstimateCents =
          preview?.after.monthlyCostEstimateCents ??
          (proposal.action.type === 'resize_compute'
            ? monthlyCostEstimateForDemoSize(proposal.action.targetSize)
            : 0);
        const evaluation = evaluatePolicy({
          policy: policy.data,
          currentResource: resource,
          actionType: proposal.action.type,
          proposedMonthlyCostEstimateCents,
        });
        if (
          parsedInput.data.decision === 'approved' &&
          (!evaluation.allowed || !evaluation.approvalRequired)
        ) {
          throw new PreconditionError();
        }

        const now = this.clock.now();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new InternalError();
        const decidedAt = now.toISOString();
        const decision = this.decisions.insert({
          id: this.ids.nextId('decision'),
          proposalId: proposal.id,
          reviewerId: actor.actorId,
          decision: parsedInput.data.decision,
          reason: parsedInput.data.reason,
          decidedAt,
        });
        const updated = this.proposals.transitionStatus({
          id: proposal.id,
          expectedStatus: 'pending_approval',
          targetStatus: decision.decision,
          updatedAt: decidedAt,
        });
        if (updated.id !== proposal.id || updated.status !== decision.decision) {
          throw new InternalError();
        }

        const output = reviewOutputSchema.safeParse({
          proposalId: proposal.id,
          decisionId: decision.id,
          status: updated.status,
          decidedAt: decision.decidedAt,
        });
        if (!output.success) throw new InternalError();
        this.audit.recordReviewDecision(actor, {
          proposalId: proposal.id,
          resourceId: proposal.resourceId,
          resourceVersion: proposal.expectedResourceVersion,
          policyVersion: evaluation.policyVersion,
          decisionId: decision.id,
          decision: decision.decision,
        });
        return Object.freeze(output.data);
      })
      .immediate();
  }
}
