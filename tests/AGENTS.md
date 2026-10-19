# Test implementation guidance

Follow root `AGENTS.md`. Use private migrated databases from `tests/helpers/test-db.ts`, and keep test helpers out of production source. Authored assertions describe intended behavior; report observed results only after a check actually runs.

For worker-backed SQLite cases, keep the held-lock barrier and durable evidence distinct from a worker's start message. Close or terminate every worker before private database cleanup. If test work fails and cleanup also fails, preserve the original failure so it can be diagnosed; a cleanup-only failure should still fail the case.

Give tests that intentionally exhaust SQLite's production busy timeout a bounded test timeout longer than the database wait plus worker startup and cleanup. Keep throws out of finally blocks so cleanup does not replace the operation failure. Build worker messages with absent optional fields omitted under exactOptionalPropertyTypes.

When testing unsafe object keys through MCP, distinguish the SDK's outer record normalization from the application's strict input parser. Assert that stripped prototype keys grant no authority or execution, while direct service/schema cases still reject undeclared own keys. Do not require a transport rejection for a key the SDK safely removes before the tool callback.

Instruction rationale (2026-10-19 executed v0.2.0 checks): the five-second test default expired during SQLite's five-second busy wait, worker types failed strict compilation, and the SDK safely stripped **proto** before the application's schema saw it.

When reading package metadata for handshake expectations, construct a runtime object containing only the fields being compared. A TypeScript assertion changes the static type, not the JSON value passed to a matcher. Set child-process log levels explicitly when asserting diagnostics, and inspect stderr separately from protocol stdout.
