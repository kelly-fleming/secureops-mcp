-- Proposals are requests for simulated changes, not authorization to execute them.
CREATE TABLE proposals (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 3 AND 64),
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  proposer_actor_id TEXT NOT NULL CHECK (length(proposer_actor_id) BETWEEN 1 AND 128),
  action_type TEXT NOT NULL CHECK (action_type IN ('resize_compute', 'disable_compute')),
  requested_change_json TEXT NOT NULL
    CHECK (
      length(requested_change_json) <= 8192 AND
      json_valid(requested_change_json) AND
      json_type(requested_change_json) = 'object'
    ),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  expected_resource_version INTEGER NOT NULL
    CHECK (expected_resource_version BETWEEN 1 AND 9007199254740991),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  policy_snapshot_json TEXT NOT NULL
    CHECK (
      length(policy_snapshot_json) <= 65536 AND
      json_valid(policy_snapshot_json) AND
      json_type(policy_snapshot_json) = 'object'
    ),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'rejected', 'executed', 'stale')
  ),
  approval_justification TEXT
    CHECK (approval_justification IS NULL OR length(approval_justification) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0 AND updated_at >= created_at)
) STRICT;

-- Reusing a key for the same actor requires a repository-level payload comparison.
CREATE UNIQUE INDEX proposals_actor_idempotency_unique
  ON proposals (proposer_actor_id, idempotency_key);
CREATE INDEX proposals_resource_status_created
  ON proposals (resource_id, status, created_at, id);

-- Application services must permit only authenticated reviewer CLI writes here.
CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 3 AND 64),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL CHECK (length(reviewer_id) BETWEEN 1 AND 128),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  decided_at TEXT NOT NULL CHECK (length(decided_at) > 0)
) STRICT;

-- Failed attempts belong in the audit trail; this table records a completed simulation.
CREATE TABLE executions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 3 AND 64),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE RESTRICT,
  executor_actor_id TEXT NOT NULL CHECK (length(executor_actor_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  result_json TEXT NOT NULL
    CHECK (
      length(result_json) <= 16384 AND
      json_valid(result_json) AND
      json_type(result_json) = 'object'
    ),
  resource_version_after INTEGER NOT NULL
    CHECK (resource_version_after BETWEEN 1 AND 9007199254740991),
  executed_at TEXT NOT NULL CHECK (length(executed_at) > 0),
  FOREIGN KEY (proposal_id) REFERENCES approval_decisions(proposal_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX executions_actor_idempotency_unique
  ON executions (executor_actor_id, idempotency_key);
