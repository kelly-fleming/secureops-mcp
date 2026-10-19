import { describe, expect, it } from 'vitest';

import { ProposalService } from '../src/application/proposal-service.js';
import { loadConfig } from '../src/config.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  PreconditionError,
  ValidationError,
} from '../src/domain/errors.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { proposeChangeOutputSchema } from '../src/mcp/schemas.js';
import { createMcpActor } from '../src/security/permissions.js';
import { buildProposalRequest, buildResource } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

function agentActor() {
  return createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, process.cwd()));
}

function viewerActor() {
  return createMcpActor(
    loadConfig(
      {
        SECUREOPS_MODE: 'http-demo',
        SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
        SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
      },
      process.cwd(),
    ),
  );
}

function request() {
  const built = buildProposalRequest();
  return {
    resourceId: built.resourceId,
    action: { type: 'disable_compute' } as const,
    reason: built.reason,
    idempotencyKey: built.idempotencyKey,
  };
}

describe('proposal creation service', () => {
  it('persists only a draft and returns a validated synthetic preview without changing the resource', async () => {
    await withTestDatabase(
      (database) => {
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const input = request();
        const before = resources.getById(input.resourceId);
        const output = service.proposeChange(agentActor(), input);

        expect(output.proposalId).toBe('proposal-000001');
        expect(output.status).toBe('draft');
        expect(output.preview.before).toEqual(before);
        expect(output.preview.after.version).toBe(before?.version);
        expect(output.preview.after.monthlyCostEstimateCents).toBe(0);
        expect(output.evaluation.allowed).toBe(true);
        expect(output.evaluation.approvalRequired).toBe(true);
        expect(proposeChangeOutputSchema.safeParse(output).success).toBe(true);
        expect(Object.isFrozen(output.preview.before)).toBe(true);
        expect(resources.getById(input.resourceId)).toEqual(before);
        expect(proposals.getById(output.proposalId)).toMatchObject({
          status: 'draft',
          proposerActorId: 'local-agent',
          expectedResourceVersion: before?.version,
          resourceId: input.resourceId,
          action: input.action,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get()).toEqual({
          count: 0,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
          count: 0,
        });
      },
      { seed: true },
    );
  });

  it('rejects policy-denied and malformed requests without creating a proposal', async () => {
    await withTestDatabase(
      (database) => {
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const productionResource = resources.getById('res-azure-vm-02');
        expect(productionResource?.environment).toBe('production');
        expect(() =>
          service.proposeChange(agentActor(), {
            ...request(),
            resourceId: 'res-azure-vm-02',
            action: { type: 'resize_compute', targetSize: 'demo-small' },
          }),
        ).toThrow(PreconditionError);
        expect(() =>
          service.proposeChange(agentActor(), {
            ...request(),
            action: { type: 'run_script', command: 'echo unsafe' },
          }),
        ).toThrow(ValidationError);
        expect(() =>
          service.proposeChange(agentActor(), {
            ...request(),
            proposerActorId: 'reviewer-001',
          }),
        ).toThrow(ValidationError);
        expect(proposals.list()).toEqual([]);
        expect(resources.getById('res-azure-vm-02')).toEqual(productionResource);
      },
      { seed: true },
    );
  });

  it('checks an issued agent permission before parsing or accessing a proposal', async () => {
    await withTestDatabase(
      (database) => {
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        expect(() => service.proposeChange(viewerActor(), { invalid: true })).toThrow(
          ForbiddenError,
        );
        expect(() =>
          service.proposeChange(
            {
              role: 'agent',
              actorId: 'local-agent',
              source: 'local-mcp',
            } as ReturnType<typeof agentActor>,
            request(),
          ),
        ).toThrow(ForbiddenError);
        expect(new SqliteProposalRepository(database).list()).toEqual([]);
      },
      { seed: true },
    );
  });

  it('rejects copied actors and JSON-parsed authority fields without workflow writes', async () => {
    await withTestDatabase(
      (database) => {
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const input = request();
        const original = resources.getById(input.resourceId);
        if (original === null) throw new Error('Missing fictional compute resource.');
        const issued = agentActor();
        const copiedActors = [
          { ...issued },
          JSON.parse(JSON.stringify(issued)) as ReturnType<typeof agentActor>,
        ];

        for (const copied of copiedActors) {
          expect(() => service.proposeChange(copied, { invalid: true })).toThrow(ForbiddenError);
          expect(() => service.proposeChange(copied, input)).toThrow(ForbiddenError);
        }

        for (const key of ['__proto__', 'constructor', 'prototype']) {
          const extraFields = JSON.parse(`{"${key}":{"role":"reviewer"}}`) as Record<
            string,
            unknown
          >;
          expect(Object.hasOwn(extraFields, key)).toBe(true);
          expect(() => service.proposeChange(issued, { ...input, ...extraFields })).toThrow(
            ValidationError,
          );
          expect(() =>
            service.proposeChange(issued, {
              ...input,
              action: { ...input.action, ...extraFields },
            }),
          ).toThrow(ValidationError);
        }

        expect(() =>
          service.proposeChange(issued, { ...input, reason: 'x'.repeat(1_001) }),
        ).toThrow(ValidationError);
        let deeplyNested: unknown = 'fictional leaf';
        for (let depth = 0; depth < 64; depth += 1) deeplyNested = { next: deeplyNested };
        expect(() =>
          service.proposeChange(issued, {
            ...input,
            action: { type: 'disable_compute', payload: deeplyNested },
          }),
        ).toThrow(ValidationError);

        expect(resources.getById(input.resourceId)).toEqual(original);
        expect(proposals.list()).toEqual([]);
        expect(database.prepare('SELECT COUNT(*) AS count FROM approval_decisions').get()).toEqual({
          count: 0,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
          count: 0,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 0,
        });
        expect(Object.hasOwn(Object.prototype, 'role')).toBe(false);
      },
      { seed: true },
    );
  });

  it('reuses an unchanged draft and reserves its key when the payload or resource version changes', async () => {
    await withTestDatabase(
      (database) => {
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const actor = agentActor();
        const input = request();
        const original = service.proposeChange(actor, input);

        expect(service.proposeChange(actor, input)).toEqual(original);
        expect(() =>
          service.proposeChange(actor, {
            ...input,
            reason: 'A different synthetic change reason.',
          }),
        ).toThrow(ConflictError);
        expect(proposals.list()).toHaveLength(1);

        const current = resources.getById(input.resourceId);
        if (current === null) throw new Error('Missing fictional compute resource.');
        expect(
          resources.updateIfVersion(
            {
              ...current,
              monthlyCostEstimateCents: current.monthlyCostEstimateCents + 100,
            },
            current.version,
          ).status,
        ).toBe('updated');
        expect(() => service.proposeChange(actor, input)).toThrow(ConflictError);
        expect(proposals.list()).toHaveLength(1);
        expect(proposals.getById(original.proposalId)?.expectedResourceVersion).toBe(1);
      },
      { seed: true },
    );
  });

  it('rolls back draft creation under a failed enclosing test transaction', async () => {
    await withTestDatabase(
      (database) => {
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const before = resources.getById(buildResource().id);
        const workflow = database.transaction(() => {
          service.proposeChange(agentActor(), request());
          throw new Error('Synthetic outer transaction failure');
        });

        expect(() => workflow.immediate()).toThrow('Synthetic outer transaction failure');
        expect(proposals.list()).toEqual([]);
        expect(resources.getById(buildResource().id)).toEqual(before);
      },
      { seed: true },
    );
  });

  it('rolls back its own draft transaction when the audit append fails', async () => {
    await withTestDatabase(
      (database) => {
        const resources = new SqliteResourceRepository(database);
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(
          database,
          createFixedClock(),
          createSequentialIdGenerator(),
        );
        const input = request();
        const before = resources.getById(input.resourceId);
        if (before === null) throw new Error('Missing fictional compute resource.');
        const actor = agentActor();
        const baseline = service.proposeChange(actor, {
          ...input,
          idempotencyKey: 'rollback-baseline-proposal-0001',
        });
        const auditHeadBefore = database
          .prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
          .get();
        expect(auditHeadBefore).toBeDefined();
        database.exec(`
          CREATE TRIGGER reject_proposal_audit BEFORE INSERT ON audit_events
          BEGIN SELECT RAISE(ABORT, 'synthetic audit append failure'); END;
        `);

        expect(() => service.proposeChange(actor, input)).toThrow(ConflictError);
        expect(database.inTransaction).toBe(false);
        expect(proposals.list().map((proposal) => proposal.id)).toEqual([baseline.proposalId]);
        expect(resources.getById(input.resourceId)).toEqual(before);
        expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
          count: 1,
        });
        expect(
          database
            .prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
            .get(),
        ).toEqual(auditHeadBefore);
      },
      { seed: true },
    );
  });

  it('treats an invalid generated proposal ID as an internal failure without writing', async () => {
    await withTestDatabase(
      (database) => {
        const proposals = new SqliteProposalRepository(database);
        const service = new ProposalService(database, createFixedClock(), {
          nextId: () => '../invalid',
        });
        expect(() => service.proposeChange(agentActor(), request())).toThrow(InternalError);
        expect(proposals.list()).toEqual([]);
      },
      { seed: true },
    );
  });
});
