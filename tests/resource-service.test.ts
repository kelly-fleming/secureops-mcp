import { describe, expect, it } from 'vitest';

import { ResourceService, type ResourceReader } from '../src/application/resource-service.js';
import { loadConfig } from '../src/config.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../src/domain/errors.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { loadSeedResources } from '../src/infra/sqlite/seed.js';
import { getResourceOutputSchema, listResourcesOutputSchema } from '../src/mcp/schemas.js';
import {
  authenticatedCliIdentityBrand,
  createAuthenticatedCliActor,
  createMcpActor,
  type ActorContext,
} from '../src/security/permissions.js';
import { withTestDatabase } from './helpers/test-db.js';

const workingDirectory = process.cwd();

function agentActor(): ActorContext {
  return createMcpActor(loadConfig({ SECUREOPS_MODE: 'local-full' }, workingDirectory));
}

function viewerActor(): ActorContext {
  return createMcpActor(
    loadConfig(
      {
        SECUREOPS_MODE: 'http-demo',
        SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
        SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
      },
      workingDirectory,
    ),
  );
}

function cliActor(role: 'reviewer' | 'auditor'): ActorContext {
  return createAuthenticatedCliActor({
    id: `${role}-001`,
    role,
    [authenticatedCliIdentityBrand]: true,
  });
}

describe('resource read service', () => {
  it('lists only bounded summaries in stable ID order for agent and viewer', async () => {
    await withTestDatabase(
      (database) => {
        const service = new ResourceService(new SqliteResourceRepository(database));
        const expectedIds = loadSeedResources().map((resource) => resource.id);

        for (const actor of [agentActor(), viewerActor()]) {
          const result = service.listResources(actor);
          expect(result.resources.map((resource) => resource.id)).toEqual(expectedIds);
          expect(result.resources.every((resource) => !('providerResourceId' in resource))).toBe(
            true,
          );
          expect(result.resources.every((resource) => !('tags' in resource))).toBe(true);
          expect(listResourcesOutputSchema.safeParse(result).success).toBe(true);
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.resources)).toBe(true);
          expect(result.resources.every((resource) => Object.isFrozen(resource))).toBe(true);
        }
      },
      { seed: true },
    );
  });

  it('filters and paginates in the repository order', async () => {
    await withTestDatabase(
      (database) => {
        const service = new ResourceService(new SqliteResourceRepository(database));
        const actor = viewerActor();
        const fixtures = loadSeedResources();

        expect(
          service
            .listResources(actor, { provider: 'aws', environment: 'development' })
            .resources.map((resource) => resource.id),
        ).toEqual(
          fixtures
            .filter(
              (resource) => resource.provider === 'aws' && resource.environment === 'development',
            )
            .map((resource) => resource.id),
        );
        expect(
          service
            .listResources(actor, { provider: 'azure', kind: 'virtual-machine' })
            .resources.map((resource) => resource.id),
        ).toEqual(
          fixtures
            .filter(
              (resource) => resource.provider === 'azure' && resource.kind === 'virtual-machine',
            )
            .map((resource) => resource.id),
        );
        expect(
          service
            .listResources(actor, { limit: 2, offset: 2 })
            .resources.map((resource) => resource.id),
        ).toEqual(fixtures.slice(2, 4).map((resource) => resource.id));
        expect(service.listResources(actor, { offset: 10_000 }).resources).toEqual([]);
      },
      { seed: true },
    );
  });

  it('returns an immutable validated detail without database metadata', async () => {
    await withTestDatabase(
      (database) => {
        const service = new ResourceService(new SqliteResourceRepository(database));
        const resourceId = loadSeedResources()[0]!.id;

        for (const actor of [agentActor(), viewerActor(), cliActor('reviewer')]) {
          const result = service.getResource(actor, { resourceId });
          expect(result.resource.id).toBe(resourceId);
          expect(result.resource.providerResourceId).toMatch(/^demo\//);
          expect('created_at' in result.resource).toBe(false);
          expect('updated_at' in result.resource).toBe(false);
          expect(getResourceOutputSchema.safeParse(result).success).toBe(true);
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.resource)).toBe(true);
          expect(Object.isFrozen(result.resource.tags)).toBe(true);
          expect(Object.isFrozen(result.resource.governance)).toBe(true);
          expect(Object.isFrozen(result.resource.utilizationEstimate)).toBe(true);
        }
      },
      { seed: true },
    );
  });

  it('preserves validation and not-found failures without reading unintended data', async () => {
    await withTestDatabase(
      (database) => {
        const service = new ResourceService(new SqliteResourceRepository(database));
        const actor = agentActor();

        expect(() => service.getResource(actor, { resourceId: 'res-absent-001' })).toThrow(
          NotFoundError,
        );
        expect(() => service.getResource(actor, { resourceId: '../private' })).toThrow(
          ValidationError,
        );
        expect(() =>
          service.getResource(actor, {
            resourceId: loadSeedResources()[0]!.id,
            actorId: 'reviewer',
          }),
        ).toThrow(ValidationError);
        for (const filters of [
          { provider: "aws' OR 1=1 --" },
          { limit: 0 },
          { limit: 101 },
          { offset: -1 },
          { sortBy: 'monthly_cost_estimate_cents' },
        ]) {
          expect(() => service.listResources(actor, filters)).toThrow(ValidationError);
        }
      },
      { seed: true },
    );
  });

  it('rejects denied and forged actors before parsing inputs or consulting the reader', () => {
    let reads = 0;
    const reader: ResourceReader = {
      getById: () => {
        reads += 1;
        return null;
      },
      list: () => {
        reads += 1;
        return [];
      },
    };
    const service = new ResourceService(reader);
    const forged = { role: 'agent', actorId: 'local-agent', source: 'local-mcp' } as ActorContext;

    expect(() => service.listResources(cliActor('reviewer'), { limit: 0 })).toThrow(ForbiddenError);
    expect(() => service.getResource(cliActor('auditor'), null)).toThrow(ForbiddenError);
    expect(() => service.listResources(forged)).toThrow(ForbiddenError);
    expect(() => service.getResource(forged, { resourceId: 'res-aws-ec2-01' })).toThrow(
      ForbiddenError,
    );
    expect(reads).toBe(0);
  });

  it('fails closed when the reader supplies an invalid resource', () => {
    const reader: ResourceReader = {
      getById: () => ({ ...loadSeedResources()[0]!, owner: '' }),
      list: () => [{ ...loadSeedResources()[0]!, tags: { 'bad key': 'value' } }],
    };
    const service = new ResourceService(reader);
    const actor = agentActor();

    expect(() => service.getResource(actor, { resourceId: 'res-aws-ec2-01' })).toThrow(
      InternalError,
    );
    expect(() => service.listResources(actor)).toThrow(InternalError);
  });

  it('rejects a resource returned for the wrong requested ID', () => {
    const resource = loadSeedResources()[0]!;
    const reader: ResourceReader = {
      getById: () => resource,
      list: () => [],
    };
    const service = new ResourceService(reader);

    expect(() => service.getResource(agentActor(), { resourceId: 'res-absent-001' })).toThrow(
      InternalError,
    );
  });
});
