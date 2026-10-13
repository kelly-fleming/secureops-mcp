import { z } from 'zod';

import { InternalError, PreconditionError, ValidationError } from '../../domain/errors.js';
import {
  nextResourceVersion,
  resourceIdSchema,
  resourceSchema,
  type Resource,
} from '../../domain/resource.js';
import type { SqliteConnection } from './connection.js';

export const resourceListOptionsSchema = z.strictObject({
  provider: z.enum(['aws', 'azure', 'gcp']).optional(),
  kind: z
    .enum([
      'ec2-instance',
      's3-bucket',
      'virtual-machine',
      'storage-account',
      'compute-instance',
      'cloud-storage-bucket',
    ])
    .optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  limit: z.int().min(1).max(100).default(50),
  offset: z.int().min(0).max(10_000).default(0),
});

export type ResourceListOptions = z.input<typeof resourceListOptionsSchema>;

export type ResourceUpdateResult =
  | { readonly status: 'updated'; readonly resource: Resource }
  | { readonly status: 'missing' }
  | { readonly status: 'stale' };

const expectedVersionSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

interface ResourceRow {
  readonly id: string;
  readonly provider: string;
  readonly provider_resource_id: string;
  readonly kind: string;
  readonly region: string;
  readonly environment: string;
  readonly owner: string;
  readonly tags_json: string;
  readonly monthly_cost_estimate_cents: number;
  readonly utilization_metric: string;
  readonly utilization_percent: number;
  readonly protected_from_changes: number;
  readonly has_restricted_tag: number;
  readonly has_policy_violation: number;
  readonly version: number;
}

const resourceColumns = `
  id, provider, provider_resource_id, kind, region, environment, owner,
  tags_json, monthly_cost_estimate_cents, utilization_metric, utilization_percent,
  protected_from_changes, has_restricted_tag, has_policy_violation, version
`;

function storedBoolean(value: number): boolean {
  if (value !== 0 && value !== 1) {
    throw new InternalError();
  }
  return value === 1;
}

function fromRow(row: ResourceRow): Resource {
  let tags: unknown;
  try {
    tags = JSON.parse(row.tags_json) as unknown;
  } catch {
    throw new InternalError();
  }

  const parsed = resourceSchema.safeParse({
    id: row.id,
    provider: row.provider,
    providerResourceId: row.provider_resource_id,
    kind: row.kind,
    region: row.region,
    environment: row.environment,
    owner: row.owner,
    tags,
    monthlyCostEstimateCents: row.monthly_cost_estimate_cents,
    utilizationEstimate: {
      metric: row.utilization_metric,
      percent: row.utilization_percent,
    },
    governance: {
      protectedFromChanges: storedBoolean(row.protected_from_changes),
      hasRestrictedTag: storedBoolean(row.has_restricted_tag),
      hasPolicyViolation: storedBoolean(row.has_policy_violation),
    },
    version: row.version,
  });
  if (!parsed.success) {
    throw new InternalError();
  }
  return parsed.data;
}

function sameIdentity(current: Resource, replacement: Resource): boolean {
  return (
    current.id === replacement.id &&
    current.provider === replacement.provider &&
    current.providerResourceId === replacement.providerResourceId &&
    current.kind === replacement.kind &&
    current.region === replacement.region &&
    current.environment === replacement.environment &&
    current.owner === replacement.owner
  );
}

export class SqliteResourceRepository {
  constructor(private readonly database: SqliteConnection) {}

  getById(id: string): Resource | null {
    if (!resourceIdSchema.safeParse(id).success) {
      throw new ValidationError();
    }
    const row = this.database
      .prepare(`SELECT ${resourceColumns} FROM resources WHERE id = ?`)
      .get(id) as ResourceRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  list(options: ResourceListOptions = {}): Resource[] {
    const parsed = resourceListOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ValidationError();
    }

    const { provider, kind, environment, limit, offset } = parsed.data;
    // Only these fixed SQL fragments are composed; every caller value remains bound.
    const predicates: string[] = [];
    const boundValues: string[] = [];
    if (provider !== undefined) {
      predicates.push('provider = ?');
      boundValues.push(provider);
    }
    if (kind !== undefined) {
      predicates.push('kind = ?');
      boundValues.push(kind);
    }
    if (environment !== undefined) {
      predicates.push('environment = ?');
      boundValues.push(environment);
    }
    const whereClause = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
    const rows = this.database
      .prepare(
        `SELECT ${resourceColumns} FROM resources
         ${whereClause}
         ORDER BY id
         LIMIT ? OFFSET ?`,
      )
      .all(...boundValues, limit, offset) as ResourceRow[];
    return rows.map(fromRow);
  }

  /** Join an outer execution transaction so its audit event commits with this update. */
  updateIfVersion(replacement: Resource, expectedVersion: number): ResourceUpdateResult {
    const parsed = resourceSchema.safeParse(replacement);
    if (
      !parsed.success ||
      !expectedVersionSchema.safeParse(expectedVersion).success ||
      parsed.data.version !== expectedVersion
    ) {
      throw new ValidationError();
    }

    return this.database
      .transaction((): ResourceUpdateResult => {
        const row = this.database
          .prepare(`SELECT ${resourceColumns} FROM resources WHERE id = ?`)
          .get(parsed.data.id) as ResourceRow | undefined;
        if (row === undefined) {
          return { status: 'missing' };
        }

        const current = fromRow(row);
        if (current.version !== expectedVersion) {
          return { status: 'stale' };
        }
        if (!sameIdentity(current, parsed.data)) {
          throw new ValidationError();
        }
        if (current.version === Number.MAX_SAFE_INTEGER) {
          throw new PreconditionError();
        }

        const updatedRow = this.database
          .prepare(
            `UPDATE resources SET
             tags_json = @tags,
             monthly_cost_estimate_cents = @cost,
             utilization_percent = @utilization,
             protected_from_changes = @protected,
             has_restricted_tag = @restricted,
             has_policy_violation = @violation,
             updated_at = @updatedAt,
             version = @nextVersion
           WHERE id = @id AND version = @expectedVersion
           RETURNING ${resourceColumns}`,
          )
          .get({
            id: current.id,
            expectedVersion,
            tags: JSON.stringify(parsed.data.tags),
            cost: parsed.data.monthlyCostEstimateCents,
            utilization: parsed.data.utilizationEstimate.percent,
            protected: Number(parsed.data.governance.protectedFromChanges),
            restricted: Number(parsed.data.governance.hasRestrictedTag),
            violation: Number(parsed.data.governance.hasPolicyViolation),
            updatedAt: new Date().toISOString(),
            nextVersion: nextResourceVersion(current.version),
          }) as ResourceRow | undefined;
        if (updatedRow === undefined) {
          return { status: 'stale' };
        }
        return { status: 'updated', resource: fromRow(updatedRow) };
      })
      .immediate();
  }
}
