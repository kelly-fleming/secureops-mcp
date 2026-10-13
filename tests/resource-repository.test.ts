import { describe, expect, it } from 'vitest';

import { InternalError, ValidationError } from '../src/domain/errors.js';
import { openInMemoryTestDatabase, type SqliteConnection } from '../src/infra/sqlite/connection.js';
import { applyMigrations } from '../src/infra/sqlite/migrate.js';
import {
  SqliteResourceRepository,
  type ResourceListOptions,
} from '../src/infra/sqlite/resource-repository.js';
import { loadSeedResources, seedDemoDatabase } from '../src/infra/sqlite/seed.js';

function withSeededDatabase(run: (database: SqliteConnection) => void): void {
  const database = openInMemoryTestDatabase();
  try {
    applyMigrations(database);
    seedDemoDatabase(database);
    run(database);
  } finally {
    database.close();
  }
}

describe('SQLite resource repository', () => {
  it('reconstructs validated domain resources and returns null for a missing ID', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const fixtures = loadSeedResources();
      expect(repository.list()).toEqual(fixtures);
      expect(repository.getById(fixtures[0]!.id)).toEqual(fixtures[0]);
      expect(repository.getById('res-absent-001')).toBeNull();
    });
  });

  it('filters by provider, kind, and environment in ID order with bounded pagination', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const fixtures = loadSeedResources();
      const matching = fixtures.filter(
        (resource) => resource.provider === 'aws' && resource.environment === 'development',
      );
      expect(repository.list({ provider: 'aws', environment: 'development' })).toEqual(matching);
      expect(repository.list({ kind: 'virtual-machine' })).toEqual(
        fixtures.filter((resource) => resource.kind === 'virtual-machine'),
      );
      expect(
        repository.list({ provider: 'aws', kind: 'ec2-instance', limit: 1, offset: 1 }),
      ).toEqual(
        fixtures
          .filter((resource) => resource.provider === 'aws' && resource.kind === 'ec2-instance')
          .slice(1, 2),
      );
      expect(repository.list({ limit: 2, offset: 2 })).toEqual(fixtures.slice(2, 4));
      expect(repository.list({ offset: 10_000 })).toEqual([]);
    });
  });

  it('rejects invalid filters, pagination, unknown fields, and SQL injection strings', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const originalCount = repository.list().length;
      for (const options of [
        { provider: "aws' OR 1=1 --" },
        { kind: 'ec2-instance; DROP TABLE resources' },
        { limit: 0 },
        { limit: 101 },
        { offset: -1 },
        { offset: 10_001 },
        { offset: 1.5 },
        { sortBy: 'monthly_cost_estimate_cents' },
      ]) {
        expect(() => repository.list(options as ResourceListOptions)).toThrow(ValidationError);
      }
      expect(() => repository.getById("res-aws-ec2-01' OR 1=1 --")).toThrow(ValidationError);
      expect(repository.list().length).toBe(originalCount);
    });
  });

  it('rejects invalid reconstructed rows instead of returning partial data', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const id = loadSeedResources()[0]!.id;
      database
        .prepare('UPDATE resources SET tags_json = ? WHERE id = ?')
        .run('{"bad key":"value"}', id);
      expect(() => repository.getById(id)).toThrow(InternalError);
      expect(() => repository.list()).toThrow(InternalError);

      database.pragma('ignore_check_constraints = ON');
      try {
        database.prepare('UPDATE resources SET tags_json = ? WHERE id = ?').run('{broken', id);
      } finally {
        database.pragma('ignore_check_constraints = OFF');
      }
      expect(() => repository.getById(id)).toThrow(InternalError);
    });
  });

  it('updates mutable fields once and rejects stale or missing versions', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const current = repository.getById('res-aws-ec2-01');
      if (current?.kind !== 'ec2-instance') throw new Error('Missing compute fixture');
      const originalMetadata = database
        .prepare('SELECT created_at FROM resources WHERE id = ?')
        .get(current.id);
      const replacement = {
        ...current,
        tags: { ...current.tags, note: "synthetic'); DROP TABLE resources; --" },
        monthlyCostEstimateCents: current.monthlyCostEstimateCents + 100,
        utilizationEstimate: { ...current.utilizationEstimate, percent: 5 },
      };

      expect(repository.updateIfVersion(replacement, 1)).toEqual({
        status: 'updated',
        resource: { ...replacement, version: 2 },
      });
      expect(repository.getById(current.id)).toEqual({ ...replacement, version: 2 });
      expect(
        database.prepare('SELECT created_at FROM resources WHERE id = ?').get(current.id),
      ).toEqual(originalMetadata);
      expect(repository.updateIfVersion(replacement, 1)).toEqual({ status: 'stale' });
      expect(repository.getById(current.id)?.version).toBe(2);
      expect(repository.updateIfVersion({ ...replacement, id: 'res-absent-001' }, 1)).toEqual({
        status: 'missing',
      });
      expect(repository.list().length).toBe(loadSeedResources().length);
    });
  });

  it('rejects replacement versions and identity changes without writing', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const current = repository.getById('res-aws-ec2-01');
      if (current?.kind !== 'ec2-instance') throw new Error('Missing compute fixture');
      expect(() => repository.updateIfVersion({ ...current, version: 2 }, 1)).toThrow(
        ValidationError,
      );
      expect(() => repository.updateIfVersion({ ...current, owner: 'other-team' }, 1)).toThrow(
        ValidationError,
      );
      expect(repository.getById(current.id)).toEqual(current);
    });
  });

  it('rolls back an update when the enclosing workflow transaction fails', () => {
    withSeededDatabase((database) => {
      const repository = new SqliteResourceRepository(database);
      const current = repository.getById('res-aws-ec2-01');
      if (current?.kind !== 'ec2-instance') throw new Error('Missing compute fixture');
      const replacement = {
        ...current,
        monthlyCostEstimateCents: current.monthlyCostEstimateCents + 100,
      };
      const workflow = database.transaction(() => {
        expect(repository.updateIfVersion(replacement, current.version).status).toBe('updated');
        throw new Error('Audit write failed');
      });

      expect(() => workflow.immediate()).toThrow('Audit write failed');
      expect(repository.getById(current.id)).toEqual(current);
    });
  });
});
