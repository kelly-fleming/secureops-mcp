-- Resource fields mirror src/domain/resource.ts; timestamps are persistence metadata.
CREATE TABLE resources (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 3 AND 64),
  provider TEXT NOT NULL CHECK (provider IN ('aws', 'azure', 'gcp')),
  provider_resource_id TEXT NOT NULL CHECK (length(provider_resource_id) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (
    (provider = 'aws' AND kind IN ('ec2-instance', 's3-bucket')) OR
    (provider = 'azure' AND kind IN ('virtual-machine', 'storage-account')) OR
    (provider = 'gcp' AND kind IN ('compute-instance', 'cloud-storage-bucket'))
  ),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 2 AND 32),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 80),
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'object'),
  monthly_cost_estimate_cents INTEGER NOT NULL
    CHECK (monthly_cost_estimate_cents BETWEEN 0 AND 1000000000),
  utilization_metric TEXT NOT NULL CHECK (
    (kind IN ('ec2-instance', 'virtual-machine', 'compute-instance') AND utilization_metric = 'cpu') OR
    (kind IN ('s3-bucket', 'storage-account', 'cloud-storage-bucket') AND utilization_metric = 'storage')
  ),
  utilization_percent REAL NOT NULL CHECK (utilization_percent BETWEEN 0 AND 100),
  protected_from_changes INTEGER NOT NULL CHECK (protected_from_changes IN (0, 1)),
  has_restricted_tag INTEGER NOT NULL CHECK (has_restricted_tag IN (0, 1)),
  has_policy_violation INTEGER NOT NULL CHECK (has_policy_violation IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991)
) STRICT;

-- A provider identifier is unique within its provider, independent of resource kind.
CREATE UNIQUE INDEX resources_provider_identity_unique
  ON resources (provider, provider_resource_id);

-- The local ID provides a stable tie-breaker for filtered listings.
CREATE INDEX resources_provider_kind_environment_id
  ON resources (provider, kind, environment, id);
CREATE INDEX resources_environment_id
  ON resources (environment, id);
