import type { z } from 'zod';

import { AuditService } from './audit-service.js';
import { buildChangePreview, type ChangePreview } from './change-preview.js';
import { evaluatePolicy, type PolicyEvaluation } from './policy-service.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../domain/errors.js';
import { demoPolicySchema, loadDemoPolicy, PolicyConfigurationError } from '../domain/policy.js';
import { resourceSchema } from '../domain/resource.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import {
  SqliteProposalRepository,
  type ProposalRecord,
} from '../infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../infra/sqlite/resource-repository.js';
import { requestApprovalInputSchema, requestApprovalOutputSchema } from '../mcp/schemas.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

export interface ApprovalRequestAssessment {
  readonly preview: ChangePreview;
  readonly evaluation: PolicyEvaluation;
}

export interface ApprovalRequestClock {
  now(): Date;
}

export type RequestApprovalResult = Readonly<z.infer<typeof requestApprovalOutputSchema>>;

function reviewerInstructionsFor(proposalId: string): string {
  return (
    'From the project root, an independent reviewer runs in an interactive terminal: ' +
    `npm run cli -- proposals:review --db-path "<absolute path to the same local .db>" --proposal-id ${proposalId}`
  );
}

/** Current eligibility only; reviewer authentication and decisions remain separate. */
export function assessDraftForApproval(
  proposal: ProposalRecord,
  resource: unknown,
  policy: unknown,
): ApprovalRequestAssessment {
  if (proposal.status !== 'draft') throw new ConflictError();

  const parsedResource = resourceSchema.safeParse(resource);
  if (!parsedResource.success || parsedResource.data.id !== proposal.resourceId) {
    throw new InternalError();
  }
  if (parsedResource.data.version !== proposal.expectedResourceVersion) {
    throw new ConflictError();
  }

  const parsedPolicy = demoPolicySchema.safeParse(policy);
  if (!parsedPolicy.success) throw new PolicyConfigurationError();

  const preview = buildChangePreview({
    currentResource: parsedResource.data,
    action: proposal.action,
    expectedResourceVersion: proposal.expectedResourceVersion,
  });
  const evaluation = evaluatePolicy({
    policy: parsedPolicy.data,
    currentResource: parsedResource.data,
    actionType: proposal.action.type,
    proposedMonthlyCostEstimateCents: preview.after.monthlyCostEstimateCents,
  });
  if (!evaluation.allowed || !evaluation.approvalRequired) throw new PreconditionError();

  return { preview, evaluation };
}

export class ApprovalRequestService {
  private readonly proposals: SqliteProposalRepository;
  private readonly resources: SqliteResourceRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly database: SqliteConnection,
    private readonly clock: ApprovalRequestClock,
    private readonly loadPolicy: () => unknown = loadDemoPolicy,
  ) {
    this.proposals = new SqliteProposalRepository(database);
    this.resources = new SqliteResourceRepository(database);
    this.audit = new AuditService(database, clock);
  }

  requestApproval(actor: ActorContext, input: unknown): RequestApprovalResult {
    requireCapability(actor, 'request_approval');
    const parsedInput = requestApprovalInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();

    return this.database
      .transaction((): RequestApprovalResult => {
        const proposal = this.proposals.getById(parsedInput.data.proposalId);
        if (proposal === null) throw new NotFoundError();
        if (proposal.proposerActorId !== actor.actorId) throw new ForbiddenError();
        if (proposal.status !== 'draft') throw new ConflictError();

        const resource = this.resources.getById(proposal.resourceId);
        if (resource === null) throw new ConflictError();
        const assessment = assessDraftForApproval(proposal, resource, this.loadPolicy());

        const now = this.clock.now();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new InternalError();
        const updated = this.proposals.transitionStatus({
          id: proposal.id,
          expectedStatus: 'draft',
          targetStatus: 'pending_approval',
          approvalJustification: parsedInput.data.justification,
          updatedAt: now.toISOString(),
        });
        if (
          updated.id !== proposal.id ||
          updated.status !== 'pending_approval' ||
          updated.approvalJustification !== parsedInput.data.justification
        ) {
          throw new InternalError();
        }

        const output = requestApprovalOutputSchema.safeParse({
          proposalId: updated.id,
          status: updated.status,
          reviewerInstructions: reviewerInstructionsFor(updated.id),
        });
        if (!output.success) throw new InternalError();
        this.audit.recordApprovalRequested(actor, {
          proposalId: updated.id,
          resourceId: proposal.resourceId,
          resourceVersion: proposal.expectedResourceVersion,
          policyVersion: assessment.evaluation.policyVersion,
        });
        return Object.freeze(output.data);
      })
      .immediate();
  }
}
