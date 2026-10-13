import { z } from 'zod';

import { buildChangePreview, type ChangePreview } from './change-preview.js';
import { evaluatePolicy } from './policy-service.js';
import type { ChangeAction } from '../domain/change.js';
import {
  ConflictError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../domain/errors.js';
import { demoPolicySchema, loadDemoPolicy, PolicyConfigurationError } from '../domain/policy.js';
import {
  proposalDraftSchema,
  SqliteProposalRepository,
} from '../infra/sqlite/proposal-repository.js';
import { SqliteDecisionRepository } from '../infra/sqlite/decision-repository.js';
import { SqliteResourceRepository } from '../infra/sqlite/resource-repository.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

const preflightInputSchema = z.strictObject({
  proposalId: proposalDraftSchema.shape.id,
});

export interface ExecutionPreflightResult {
  readonly proposalId: string;
  readonly resourceId: string;
  readonly expectedResourceVersion: number;
  readonly action: Readonly<ChangeAction>;
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly preview: ChangePreview;
}

function copyAction(action: ChangeAction): ChangeAction {
  return action.type === 'resize_compute'
    ? { type: 'resize_compute' as const, targetSize: action.targetSize }
    : { type: 'disable_compute' as const };
}

interface ReviewerRow {
  readonly role: string;
  readonly disabled: number;
}

/** Run inside the caller's immediate write transaction, immediately before simulated execution. */
export class ExecutionPreflight {
  private readonly proposals: SqliteProposalRepository;
  private readonly decisions: SqliteDecisionRepository;
  private readonly resources: SqliteResourceRepository;

  constructor(
    private readonly database: SqliteConnection,
    private readonly loadPolicy: () => unknown = loadDemoPolicy,
  ) {
    this.proposals = new SqliteProposalRepository(database);
    this.decisions = new SqliteDecisionRepository(database);
    this.resources = new SqliteResourceRepository(database);
  }

  check(actor: ActorContext, input: unknown): ExecutionPreflightResult {
    requireCapability(actor, 'execute_change');
    const parsedInput = preflightInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();
    if (!this.database.inTransaction) throw new PreconditionError();

    const proposal = this.proposals.getById(parsedInput.data.proposalId);
    if (proposal === null) throw new NotFoundError();
    // A completed execution wins over stale proposal status. The execution service
    // handles exact retries before asking preflight to authorize a new write.
    if (
      proposal.status === 'executed' ||
      this.database.prepare('SELECT 1 FROM executions WHERE proposal_id = ?').get(proposal.id) !==
        undefined
    )
      throw new ConflictError();
    if (proposal.status !== 'approved') throw new PreconditionError();

    const decision = this.decisions.getByProposalId(proposal.id);
    if (
      decision === null ||
      decision.decision !== 'approved' ||
      decision.reviewerId === proposal.proposerActorId ||
      decision.decidedAt !== proposal.updatedAt
    )
      throw new PreconditionError();
    const reviewer = this.database
      .prepare('SELECT role, disabled FROM local_identities WHERE id = ?')
      .get(decision.reviewerId) as ReviewerRow | undefined;
    if (reviewer?.role !== 'reviewer' || reviewer.disabled !== 0) throw new PreconditionError();

    const resource = this.resources.getById(proposal.resourceId);
    if (resource === null || resource.version !== proposal.expectedResourceVersion) {
      throw new ConflictError();
    }
    const preview = buildChangePreview({
      currentResource: resource,
      action: proposal.action,
      expectedResourceVersion: proposal.expectedResourceVersion,
    });

    const currentPolicy = demoPolicySchema.safeParse(this.loadPolicy());
    if (!currentPolicy.success) throw new PolicyConfigurationError();
    const evaluation = evaluatePolicy({
      policy: currentPolicy.data,
      currentResource: resource,
      actionType: proposal.action.type,
      proposedMonthlyCostEstimateCents: preview.after.monthlyCostEstimateCents,
    });
    if (!evaluation.allowed || !evaluation.approvalRequired) throw new PreconditionError();

    return Object.freeze({
      proposalId: proposal.id,
      resourceId: resource.id,
      expectedResourceVersion: proposal.expectedResourceVersion,
      action: Object.freeze(copyAction(proposal.action)),
      decisionId: decision.id,
      policyVersion: evaluation.policyVersion,
      preview,
    });
  }
}
