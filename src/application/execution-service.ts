import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { z } from 'zod';

import { AuditService } from './audit-service.js';
import { ExecutionPreflight } from './execution-preflight.js';
import { ConflictError, InternalError, ValidationError } from '../domain/errors.js';
import { loadDemoPolicy } from '../domain/policy.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import { SqliteDecisionRepository } from '../infra/sqlite/decision-repository.js';
import {
  SqliteExecutionRepository,
  type ExecutionRecord,
} from '../infra/sqlite/execution-repository.js';
import {
  requestedChangeForAction,
  SqliteProposalRepository,
} from '../infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../infra/sqlite/resource-repository.js';
import { executeChangeInputSchema, executeChangeOutputSchema } from '../mcp/schemas.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

export interface ExecutionClock {
  now(): Date;
}

export interface ExecutionIdGenerator {
  nextId(prefix: string): string;
}

const defaultClock: ExecutionClock = { now: () => new Date() };
const defaultIds: ExecutionIdGenerator = { nextId: (prefix) => `${prefix}-${randomUUID()}` };
const simulationNotice = 'Fictional demo data; estimates are not real bills or savings.' as const;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ExecuteChangeResult = DeepReadonly<z.infer<typeof executeChangeOutputSchema>>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function outputForExecution(execution: ExecutionRecord): ExecuteChangeResult {
  const parsed = executeChangeOutputSchema.safeParse({
    proposalId: execution.proposalId,
    status: 'executed',
    resourceId: execution.result.resourceId,
    resourceVersion: execution.resourceVersionAfter,
    executionId: execution.id,
    auditEventId: execution.result.auditEventId,
    result: execution.result.preview,
    simulationNotice,
  });
  if (!parsed.success) throw new InternalError();
  return deepFreeze(parsed.data);
}

/** Internal service; one immediate transaction owns every simulated state change and audit append. */
export class ExecutionService {
  private readonly preflight: ExecutionPreflight;
  private readonly executions: SqliteExecutionRepository;
  private readonly proposals: SqliteProposalRepository;
  private readonly decisions: SqliteDecisionRepository;
  private readonly resources: SqliteResourceRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly database: SqliteConnection,
    private readonly clock: ExecutionClock = defaultClock,
    private readonly ids: ExecutionIdGenerator = defaultIds,
    loadPolicy: () => unknown = loadDemoPolicy,
  ) {
    this.preflight = new ExecutionPreflight(database, loadPolicy);
    this.executions = new SqliteExecutionRepository(database);
    this.proposals = new SqliteProposalRepository(database);
    this.decisions = new SqliteDecisionRepository(database);
    this.resources = new SqliteResourceRepository(database);
    this.audit = new AuditService(database, clock, ids);
  }

  executeChange(actor: ActorContext, input: unknown): ExecuteChangeResult {
    requireCapability(actor, 'execute_change');
    const parsedInput = executeChangeInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();
    const request = parsedInput.data;

    return this.database
      .transaction((): ExecuteChangeResult => {
        const byKey = this.executions.getByActorAndKey(actor.actorId, request.idempotencyKey);
        const byProposal = this.executions.getByProposalId(request.proposalId);
        if (byKey !== null || byProposal !== null) {
          if (
            byKey === null ||
            byProposal === null ||
            byKey.id !== byProposal.id ||
            byKey.proposalId !== request.proposalId ||
            byKey.executorActorId !== actor.actorId ||
            byKey.idempotencyKey !== request.idempotencyKey
          )
            throw new ConflictError();

          const proposal = this.proposals.getById(request.proposalId);
          if (
            proposal === null ||
            proposal.status !== 'executed' ||
            proposal.resourceId !== byKey.result.resourceId ||
            proposal.expectedResourceVersion !== byKey.result.resourceVersionBefore ||
            proposal.updatedAt !== byKey.executedAt ||
            proposal.action.type !== byKey.result.action.type ||
            requestedChangeForAction(proposal.action) !==
              requestedChangeForAction(byKey.result.action)
          ) {
            throw new ConflictError();
          }
          const decision = this.decisions.getByProposalId(proposal.id);
          if (
            decision === null ||
            decision.decision !== 'approved' ||
            decision.reviewerId === proposal.proposerActorId ||
            decision.decidedAt > byKey.executedAt
          )
            throw new ConflictError();
          return outputForExecution(byKey);
        }

        const eligible = this.preflight.check(actor, { proposalId: request.proposalId });
        const now = this.clock.now();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new InternalError();
        const executedAt = now.toISOString();
        const executionId = this.ids.nextId('execution');
        const auditFields = {
          proposalId: eligible.proposalId,
          resourceId: eligible.resourceId,
          resourceVersion: eligible.expectedResourceVersion,
          policyVersion: eligible.policyVersion,
          actionType: eligible.action.type,
        };

        this.audit.recordExecutionAttempt(actor, auditFields);
        const update = this.resources.updateIfVersion(
          eligible.preview.after,
          eligible.expectedResourceVersion,
        );
        if (update.status !== 'updated') throw new ConflictError();
        const updatedResource = update.resource;
        const expectedAfter = {
          ...eligible.preview.after,
          version: eligible.expectedResourceVersion + 1,
        };
        if (!isDeepStrictEqual(updatedResource, expectedAfter)) throw new InternalError();

        const successEvent = this.audit.recordExecutionResult(actor, {
          ...auditFields,
          outcome: 'executed',
          executionId,
        });
        const execution = this.executions.insert({
          id: executionId,
          proposalId: eligible.proposalId,
          executorActorId: actor.actorId,
          idempotencyKey: request.idempotencyKey,
          result: {
            resourceId: eligible.resourceId,
            action: eligible.action,
            resourceVersionBefore: eligible.expectedResourceVersion,
            resourceVersionAfter: updatedResource.version,
            monthlyCostEstimateCentsAfter: updatedResource.monthlyCostEstimateCents,
            auditEventId: successEvent.id,
            preview: {
              before: eligible.preview.before,
              after: updatedResource,
              estimatedMonthlyCostChangeCents:
                updatedResource.monthlyCostEstimateCents -
                eligible.preview.before.monthlyCostEstimateCents,
            },
          },
          resourceVersionAfter: updatedResource.version,
          executedAt,
        });
        const transitioned = this.proposals.transitionStatus({
          id: eligible.proposalId,
          expectedStatus: 'approved',
          targetStatus: 'executed',
          updatedAt: executedAt,
        });
        if (transitioned.status !== 'executed') throw new InternalError();
        return outputForExecution(execution);
      })
      .immediate();
  }
}
