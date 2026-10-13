import { readFileSync, statSync } from 'node:fs';

import { resourceSchema, type Resource } from '../../domain/resource.js';
import type { SqliteConnection } from './connection.js';

const defaultFixtureUrl = new URL('../../../fixtures/resources.json', import.meta.url);
const maxFixtureBytes = 1_048_576;

/** Loads fictional seed input before any database transaction begins. */
export function loadSeedResources(fixtureUrl: URL = defaultFixtureUrl): readonly Resource[] {
  let bytes: Buffer;
  try {
    const file = statSync(fixtureUrl);
    if (!file.isFile() || file.size === 0 || file.size > maxFixtureBytes) {
      throw new Error('Invalid fixture file');
    }
    bytes = readFileSync(fixtureUrl);
  } catch {
    throw new Error('Seed fixture could not be read.');
  }
  if (bytes.length === 0 || bytes.length > maxFixtureBytes) {
    throw new Error('Seed fixture has an invalid size.');
  }

  let source: unknown;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    source = JSON.parse(json) as unknown;
  } catch {
    throw new Error('Seed fixture must contain valid UTF-8 JSON.');
  }

  return validateSeedResources(source);
}

function validateSeedResources(source: unknown): readonly Resource[] {
  const parsed = resourceSchema.array().min(1).safeParse(source);
  if (!parsed.success) {
    throw new Error('Seed fixture contains an invalid resource.');
  }

  const resources = parsed.data;
  const ids = new Set<string>();
  const providerIds = new Set<string>();
  let previousId = '';
  for (const resource of resources) {
    const providerId = `${resource.provider}\u0000${resource.providerResourceId}`;
    if (
      ids.has(resource.id) ||
      providerIds.has(providerId) ||
      resource.id <= previousId ||
      !resource.providerResourceId.startsWith(`demo/${resource.provider}/`) ||
      resource.version !== 1
    ) {
      throw new Error('Seed fixture identities must be unique, ordered, and fictional.');
    }
    ids.add(resource.id);
    providerIds.add(providerId);
    previousId = resource.id;
  }

  return resources;
}

interface ExistingResourceIdentity {
  readonly provider: string;
  readonly provider_resource_id: string;
}

function assertDemoInventory(database: SqliteConnection, resources: readonly Resource[]): void {
  const fixtureIdentities = new Map<string, string>(
    resources.map((resource): [string, string] => [
      resource.id,
      `${resource.provider}\u0000${resource.providerResourceId}`,
    ]),
  );
  const existing = database
    .prepare('SELECT id, provider, provider_resource_id FROM resources')
    .all() as Array<ExistingResourceIdentity & { readonly id: string }>;
  for (const row of existing) {
    if (fixtureIdentities.get(row.id) !== `${row.provider}\u0000${row.provider_resource_id}`) {
      throw new Error('Database contains a resource outside the fictional demo fixture.');
    }
  }
}

function insertMissingResources(
  database: SqliteConnection,
  resources: readonly Resource[],
  timestamp: string,
): number {
  const findExisting = database.prepare(
    'SELECT provider, provider_resource_id FROM resources WHERE id = ?',
  );
  const insert = database.prepare(`
    INSERT INTO resources (
      id, provider, provider_resource_id, kind, region, environment, owner,
      tags_json, monthly_cost_estimate_cents, utilization_metric, utilization_percent,
      protected_from_changes, has_restricted_tag, has_policy_violation,
      created_at, updated_at, version
    ) VALUES (
      @id, @provider, @provider_resource_id, @kind, @region, @environment, @owner,
      @tags_json, @monthly_cost_estimate_cents, @utilization_metric, @utilization_percent,
      @protected_from_changes, @has_restricted_tag, @has_policy_violation,
      @created_at, @updated_at, @version
    )
  `);

  let inserted = 0;
  for (const resource of resources) {
    const existing = findExisting.get(resource.id) as ExistingResourceIdentity | undefined;
    if (existing !== undefined) {
      if (
        existing.provider !== resource.provider ||
        existing.provider_resource_id !== resource.providerResourceId
      ) {
        throw new Error('A seed resource ID belongs to a different resource.');
      }
      // Repeat seeding preserves simulated changes, versions, and related workflow rows.
      continue;
    }

    insert.run({
      id: resource.id,
      provider: resource.provider,
      provider_resource_id: resource.providerResourceId,
      kind: resource.kind,
      region: resource.region,
      environment: resource.environment,
      owner: resource.owner,
      tags_json: JSON.stringify(resource.tags),
      monthly_cost_estimate_cents: resource.monthlyCostEstimateCents,
      utilization_metric: resource.utilizationEstimate.metric,
      utilization_percent: resource.utilizationEstimate.percent,
      protected_from_changes: Number(resource.governance.protectedFromChanges),
      has_restricted_tag: Number(resource.governance.hasRestrictedTag),
      has_policy_violation: Number(resource.governance.hasPolicyViolation),
      created_at: timestamp,
      updated_at: timestamp,
      version: resource.version,
    });
    inserted += 1;
  }
  return inserted;
}

/** Adds absent fictional resources without replacing changed resources or workflow state. */
export function seedDemoDatabase(
  database: SqliteConnection,
  resources: readonly Resource[] = loadSeedResources(),
): number {
  const validatedResources = validateSeedResources(resources);
  const timestamp = new Date().toISOString();
  const seed = database.transaction(() => {
    assertDemoInventory(database, validatedResources);
    return insertMissingResources(database, validatedResources, timestamp);
  });
  return seed.immediate();
}

/** Restores the disposable demo database to its fixture and empty-workflow baseline. */
export function resetDemoDatabase(
  database: SqliteConnection,
  resources: readonly Resource[] = loadSeedResources(),
): number {
  const validatedResources = validateSeedResources(resources);
  const timestamp = new Date().toISOString();
  return database
    .transaction(() => {
      assertDemoInventory(database, validatedResources);
      // Child rows go first so foreign keys remain enforced throughout the reset.
      database.prepare('DELETE FROM audit_events').run();
      database.prepare('DELETE FROM executions').run();
      database.prepare('DELETE FROM approval_decisions').run();
      database.prepare('DELETE FROM proposals').run();
      database.prepare('DELETE FROM local_identities').run();
      database.prepare('DELETE FROM resources').run();
      return insertMissingResources(database, validatedResources, timestamp);
    })
    .immediate();
}
