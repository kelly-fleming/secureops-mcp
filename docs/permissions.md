# Actor and capability boundary

`src/security/permissions.ts` defines the intended access matrix. `loadConfig` issues immutable configurations; the MCP server creates an agent for `local-full` or a viewer for `http-demo`. Reviewer and auditor contexts require `authenticateCliActor` in `src/security/reviewer-auth.ts`, called by a CLI command with a configured database connection it owns and closes. That function prompts for a masked passphrase on a terminal, checks the stored role and current enabled state, and issues an actor only after verification. A username supplied through a CLI flag or MCP input is never sufficient. The CLI identity marker blocks plain JSON role claims but does not itself authenticate a person.

`hasCapability` is a matrix lookup, not an authorization check. Application service methods must call `requireCapability` with an issued actor context before reading or writing protected data. A forged object with `role: 'agent'` is not an issued context. MCP handlers must never construct a CLI identity or accept a role, actor ID, decision, or credential from tool arguments.

| Service method or operation | Required capability |
| --- | --- |
| Resource list and detail | `list_resources`, `get_resource` respectively |
| Resource analysis | `analyze_resource` |
| Caller-facing policy preview | `evaluate_policy` |
| Proposal creation | `propose_change` |
| Request independent review | `request_approval` |
| Simulated execution | `execute_change` |
| Agent-facing redacted audit list | `get_audit_log` |
| CLI proposal review and decision | `review_proposals`, `decide_proposal` respectively |
| CLI audit inspection and chain verification | `inspect_audit`, `verify_audit` respectively |

Authenticated local reviewers and auditors have audit inspection and verification capabilities. The reviewer role can inspect the trace for its decisions through the audit CLI; agents and HTTP viewers cannot use these full audit capabilities. The CLI challenges for a passphrase on each invocation, and the read services recheck the current enabled local identity.

`src/application/resource-service.ts` implements the permission-checked list and detail methods. `src/application/proposal-service.ts` implements proposal creation under `docs/proposal-creation.md`, and `src/application/approval-request-service.ts` implements the pending-review transition under `docs/approval-request.md`. The local proposal CLI authenticates a reviewer on each invocation before calling the queue or decision service. `src/application/review-queue-service.ts` requires `review_proposals` and rechecks the enabled identity before returning pending rows. `src/application/review-service.ts` checks `decide_proposal` before input parsing, verifies that the authenticated CLI actor still names an enabled reviewer, and writes the decision, status, and safe audit event in one transaction. The audit CLI calls the capability-checked list and verification services, which recheck enabled local identity and do not mutate records. The pure policy evaluator and change preview may be used internally without actor input; any caller-facing service that exposes them must check the corresponding capability. Tool registration also limits what a client can see, but the service method remains the enforcement point.

An agent's `execute_change` capability permits it to ask for simulation. It cannot create an approval. Before any new resource write, the execution service must find an independently authenticated approved decision, confirm its reviewer remains enabled, and recheck proposal status, policy, resource version, and idempotency inside the write transaction. The capability matrix alone cannot establish those facts. An authorized exact retry of a completed execution returns its stored result without another write or a current-policy recheck.

`src/application/execution-preflight.ts` supplies the current approval, resource, preview, and policy checks inside the execution service's immediate transaction. Its output is valid only for that transaction and must not be cached across requests. `src/application/execution-service.ts` applies the synthetic update and persists its execution, proposal transition, and audit events atomically. It returns a saved result for a matching completed retry. The local stdio `execute_change` handler calls it with an issued agent actor and maps errors through the tool-result boundary.
