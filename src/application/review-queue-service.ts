import { buildChangePreview, type ChangePreview } from './change-preview.js';
import { evaluatePolicy, type PolicyEvaluation } from './policy-service.js';
import { monthlyCostEstimateForDemoSize, type ChangeAction } from '../domain/change.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../domain/errors.js';
import {
  demoPolicySchema,
  loadDemoPolicy,
  PolicyConfigurationError,
  type DemoPolicy,
} from '../domain/policy.js';
import type { Resource } from '../domain/resource.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import {
  proposalDraftSchema,
  proposalListOptionsSchema,
  SqliteProposalRepository,
  type ProposalRecord,
} from '../infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../infra/sqlite/resource-repository.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

const queueOptionsSchema = proposalListOptionsSchema.pick({ limit: true, offset: true });

export interface PendingReviewResource {
  readonly id: string;
  readonly provider: Resource['provider'];
  readonly kind: Resource['kind'];
  readonly environment: Resource['environment'];
  readonly owner: string;
  readonly version: number;
  readonly monthlyCostEstimateCents: number;
}

export interface PendingReviewItem {
  readonly proposalId: string;
  readonly proposerActorId: string;
  /** Untrusted display text; terminal rendering must escape control characters. */
  readonly reason: string;
  /** Untrusted display text; terminal rendering must escape control characters. */
  readonly approvalJustification: string;
  readonly action: Readonly<ChangeAction>;
  readonly expectedResourceVersion: number;
  readonly resource: PendingReviewResource;
  readonly preview: ChangePreview | null;
  readonly policy: PolicyEvaluation;
  readonly readiness: 'ready' | 'stale' | 'ineligible' | 'policy_denied' | 'self_review_forbidden';
}

interface ReviewerRow {
  readonly role: string;
  readonly disabled: number;
}

function copyAction(action: ChangeAction): Readonly<ChangeAction> {
  return Object.freeze(
    action.type === 'resize_compute'
      ? { type: 'resize_compute' as const, targetSize: action.targetSize }
      : { type: 'disable_compute' as const },
  );
}

function summarizeResource(resource: Resource): PendingReviewResource {
  return Object.freeze({
    id: resource.id,
    provider: resource.provider,
    kind: resource.kind,
    environment: resource.environment,
    owner: resource.owner,
    version: resource.version,
    monthlyCostEstimateCents: resource.monthlyCostEstimateCents,
  });
}

/** Internal read-only queue; listing never grants or records a review decision. */
export class ReviewQueueService {
  private readonly proposals: SqliteProposalRepository;
  private readonly resources: SqliteResourceRepository;

  constructor(
    private readonly database: SqliteConnection,
    private readonly loadPolicy: () => unknown = loadDemoPolicy,
  ) {
    this.proposals = new SqliteProposalRepository(database);
    this.resources = new SqliteResourceRepository(database);
  }

  listPending(actor: ActorContext, options: unknown = {}): readonly PendingReviewItem[] {
    requireCapability(actor, 'review_proposals');
    const parsedOptions = queueOptionsSchema.safeParse(options);
    if (!parsedOptions.success) throw new ValidationError();

    return this.withReviewer(actor, (policy) =>
      Object.freeze(
        this.proposals
          .list({
            status: 'pending_approval',
            limit: parsedOptions.data.limit,
            offset: parsedOptions.data.offset,
          })
          .map((proposal) => this.assess(actor, proposal, policy)),
      ),
    );
  }

  getPending(actor: ActorContext, proposalId: unknown): PendingReviewItem {
    requireCapability(actor, 'review_proposals');
    const parsedId = proposalDraftSchema.shape.id.safeParse(proposalId);
    if (!parsedId.success) throw new ValidationError();

    return this.withReviewer(actor, (policy) => {
      const proposal = this.proposals.getById(parsedId.data);
      if (proposal === null || proposal.status !== 'pending_approval') throw new NotFoundError();
      return this.assess(actor, proposal, policy);
    });
  }

  private withReviewer<T>(actor: ActorContext, read: (policy: DemoPolicy) => T): T {
    return this.database.transaction((): T => {
      const reviewer = this.database
        .prepare('SELECT role, disabled FROM local_identities WHERE id = ?')
        .get(actor.actorId) as ReviewerRow | undefined;
      if (reviewer?.role !== 'reviewer' || reviewer.disabled !== 0) throw new ForbiddenError();

      const parsedPolicy = demoPolicySchema.safeParse(this.loadPolicy());
      if (!parsedPolicy.success) throw new PolicyConfigurationError();
      return read(parsedPolicy.data);
    })();
  }

  private assess(
    actor: ActorContext,
    proposal: ProposalRecord,
    currentPolicy: DemoPolicy,
  ): PendingReviewItem {
    const resource = this.resources.getById(proposal.resourceId);
    if (resource === null || proposal.approvalJustification === null) throw new InternalError();

    const proposedCost =
      proposal.action.type === 'resize_compute'
        ? monthlyCostEstimateForDemoSize(proposal.action.targetSize)
        : 0;
    const policy = evaluatePolicy({
      policy: currentPolicy,
      currentResource: resource,
      actionType: proposal.action.type,
      proposedMonthlyCostEstimateCents: proposedCost,
    });
    const stale = resource.version !== proposal.expectedResourceVersion;
    let preview: ChangePreview | null = null;
    if (!stale) {
      try {
        preview = buildChangePreview({
          currentResource: resource,
          action: proposal.action,
          expectedResourceVersion: proposal.expectedResourceVersion,
        });
      } catch (error) {
        if (!(error instanceof PreconditionError)) throw error;
      }
    }
    const readiness: PendingReviewItem['readiness'] =
      proposal.proposerActorId === actor.actorId
        ? 'self_review_forbidden'
        : stale
          ? 'stale'
          : preview === null
            ? 'ineligible'
            : !policy.allowed || !policy.approvalRequired
              ? 'policy_denied'
              : 'ready';

    return Object.freeze({
      proposalId: proposal.id,
      proposerActorId: proposal.proposerActorId,
      reason: proposal.reason,
      approvalJustification: proposal.approvalJustification,
      action: copyAction(proposal.action),
      expectedResourceVersion: proposal.expectedResourceVersion,
      resource: summarizeResource(resource),
      preview,
      policy,
      readiness,
    });
  }
}
