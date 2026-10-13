-- Local human CLI identities only. No MCP tool may enroll or authenticate a reviewer.
CREATE TABLE local_identities (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 3 AND 64),
  username TEXT NOT NULL UNIQUE CHECK (
    length(username) BETWEEN 3 AND 64 AND
    substr(username, 1, 1) GLOB '[a-z]' AND
    username NOT GLOB '*[^a-z0-9_-]*'
  ),
  role TEXT NOT NULL CHECK (role IN ('reviewer', 'auditor')),
  disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
  password_kdf TEXT NOT NULL CHECK (password_kdf = 'scrypt'),
  password_salt BLOB NOT NULL CHECK (length(password_salt) BETWEEN 16 AND 64),
  password_verifier BLOB NOT NULL CHECK (length(password_verifier) BETWEEN 32 AND 64),
  scrypt_cost INTEGER NOT NULL CHECK (
    scrypt_cost BETWEEN 16384 AND 65536 AND
    (scrypt_cost & (scrypt_cost - 1)) = 0
  ),
  scrypt_block_size INTEGER NOT NULL CHECK (scrypt_block_size BETWEEN 8 AND 16),
  scrypt_parallelization INTEGER NOT NULL CHECK (scrypt_parallelization BETWEEN 1 AND 4),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0 AND updated_at >= created_at)
) STRICT;

-- Application services append events in the transaction that changes state.
CREATE TABLE audit_events (
  sequence INT NOT NULL PRIMARY KEY CHECK (sequence >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 3 AND 64),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'reviewer', 'auditor', 'system')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('resource', 'proposal', 'execution', 'identity')
  ),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  event_json TEXT NOT NULL CHECK (
    length(event_json) <= 32768 AND
    json_valid(event_json) AND
    json_type(event_json) = 'object'
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
  previous_hash TEXT CHECK (
    previous_hash IS NULL OR
    (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')
  ),
  event_hash TEXT NOT NULL CHECK (
    length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (sequence = 1 AND previous_hash IS NULL) OR
    (sequence > 1 AND previous_hash IS NOT NULL)
  )
) STRICT;

CREATE INDEX audit_events_subject_sequence
  ON audit_events (subject_type, subject_id, sequence);
CREATE INDEX audit_events_actor_sequence
  ON audit_events (actor_type, actor_id, sequence);
