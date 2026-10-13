import type { z } from 'zod';

import { AuditService } from './audit-service.js';
import { buildChangePreview, type ChangePreview } from './change-preview.js';
import { evaluatePolicy, type PolicyEvaluation } from './policy-service.js';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '../domain/errors.js';
import { demoPolicySchema, loadDemoPolicy, PolicyConfigurationError } from '../domain/policy.js';
import { resourceSchema, type Resource } from '../domain/resource.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import {
  proposalDraftSchema,
  requestedChangeForAction,
  SqliteProposalRepository,
} from '../infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../infra/sqlite/resource-repository.js';
import { proposeChangeInputSchema, proposeChangeOutputSchema } from '../mcp/schemas.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

export interface ProposalResourceReader {
  getById(id: string): Resource | null;
}

export interface PreparedProposalCandidate {
  readonly request: z.infer<typeof proposeChangeInputSchema>;
  readonly resource: Resource;
  readonly preview: ChangePreview;
  readonly evaluation: PolicyEvaluation;
  readonly policySnapshot: z.infer<typeof demoPolicySchema>;
}

export interface ProposalClock {
  now(): Date;
}

export interface ProposalIdGenerator {
  nextId(prefix: string): string;
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ProposeChangeResult = DeepReadonly<z.infer<typeof proposeChangeOutputSchema>>;

const simulationNotice = 'Fictional demo data; estimates are not real bills or savings.' as const;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function resultForCandidate(
  proposalId: string,
  candidate: PreparedProposalCandidate,
): ProposeChangeResult {
  const output = proposeChangeOutputSchema.safeParse({
    proposalId,
    status: 'draft',
    preview: candidate.preview,
    evaluation: candidate.evaluation,
    simulationNotice,
  });
  if (!output.success) throw new InternalError();
  return deepFreeze(output.data);
}

/** Internal eligibility assessment; the caller-facing service must authorize before calling it. */
export function prepareProposalCandidate(
  input: unknown,
  resourceReader: ProposalResourceReader,
  policy: unknown,
  expectedResourceVersion?: number,
): PreparedProposalCandidate {
  const parsedInput = proposeChangeInputSchema.safeParse(input);
  if (!parsedInput.success) throw new ValidationError();

  const parsedPolicy = demoPolicySchema.safeParse(policy);
  if (!parsedPolicy.success) throw new PolicyConfigurationError();

  const resource = resourceReader.getById(parsedInput.data.resourceId);
  if (resource === null) throw new NotFoundError();
  if (resource.id !== parsedInput.data.resourceId) throw new InternalError();
  const parsedResource = resourceSchema.safeParse(resource);
  if (!parsedResource.success) throw new InternalError();
  if (
    expectedResourceVersion !== undefined &&
    parsedResource.data.version !== expectedResourceVersion
  ) {
    throw new ConflictError();
  }

  const preview = buildChangePreview({
    currentResource: parsedResource.data,
    action: parsedInput.data.action,
    expectedResourceVersion: parsedResource.data.version,
  });
  const evaluation = evaluatePolicy({
    policy: parsedPolicy.data,
    currentResource: parsedResource.data,
    actionType: parsedInput.data.action.type,
    proposedMonthlyCostEstimateCents: preview.after.monthlyCostEstimateCents,
  });
  if (!evaluation.allowed) throw new PreconditionError();

  return {
    request: parsedInput.data,
    resource: parsedResource.data,
    preview,
    evaluation,
    policySnapshot: parsedPolicy.data,
  };
}

export class ProposalService {
  private readonly resourceReader: SqliteResourceRepository;
  private readonly proposals: SqliteProposalRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly database: SqliteConnection,
    private readonly clock: ProposalClock,
    private readonly ids: ProposalIdGenerator,
    private readonly loadPolicy: () => unknown = loadDemoPolicy,
  ) {
    this.resourceReader = new SqliteResourceRepository(database);
    this.proposals = new SqliteProposalRepository(database);
    this.audit = new AuditService(database, clock);
  }

  proposeChange(actor: ActorContext, input: unknown): ProposeChangeResult {
    requireCapability(actor, 'propose_change');
    const parsedInput = proposeChangeInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();

    return this.database
      .transaction((): ProposeChangeResult => {
        const existing = this.proposals.getByActorAndKey(
          actor.actorId,
          parsedInput.data.idempotencyKey,
        );
        if (existing !== null) {
          if (
            existing.resourceId !== parsedInput.data.resourceId ||
            existing.reason !== parsedInput.data.reason ||
            requestedChangeForAction(existing.action) !==
              requestedChangeForAction(parsedInput.data.action) ||
            existing.status !== 'draft'
          ) {
            throw new ConflictError();
          }
          const candidate = prepareProposalCandidate(
            parsedInput.data,
            this.resourceReader,
            existing.policySnapshot,
            existing.expectedResourceVersion,
          );
          return resultForCandidate(existing.id, candidate);
        }

        const candidate = prepareProposalCandidate(
          parsedInput.data,
          this.resourceReader,
          this.loadPolicy(),
        );
        const generatedTime = this.clock.now();
        if (!(generatedTime instanceof Date) || !Number.isFinite(generatedTime.getTime())) {
          throw new InternalError();
        }
        const draft = proposalDraftSchema.safeParse({
          id: this.ids.nextId('proposal'),
          resourceId: candidate.resource.id,
          proposerActorId: actor.actorId,
          action: candidate.request.action,
          reason: candidate.request.reason,
          expectedResourceVersion: candidate.resource.version,
          idempotencyKey: candidate.request.idempotencyKey,
          policySnapshot: candidate.policySnapshot,
          createdAt: generatedTime.toISOString(),
        });
        if (!draft.success) throw new InternalError();
        const created = this.proposals.createDraft(draft.data);
        if (created.status !== 'draft' || created.id !== draft.data.id) throw new InternalError();
        const result = resultForCandidate(created.id, candidate);
        this.audit.recordProposalCreated(actor, {
          proposalId: created.id,
          resourceId: created.resourceId,
          resourceVersion: created.expectedResourceVersion,
          policyVersion: candidate.evaluation.policyVersion,
        });
        return result;
      })
      .immediate();
  }
}
