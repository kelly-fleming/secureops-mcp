# SecureOps MCP threat model

This document describes the security boundaries and limitations of this experimental personal hobby project. It is independent of any company or commercial entity. The code and tests do not establish production-grade identity isolation or security certification. See [scope](scope.md) for current runtime boundaries.

## Assets and security goals

- Synthetic resource state and proposal state: prevent an MCP host or HTTP viewer from bypassing policy, human review, or allowed state transitions.
- Human review decisions and reviewer credentials: keep approval authority in a separately authenticated local CLI, away from MCP tool arguments and model output.
- Local audit record: make application-written events traceable and detect alteration through application paths, while acknowledging that the database file is locally writable by its OS owner.
- HTTP demo credential and local configuration: avoid exposing secrets in tool results, logs, or unauthenticated network responses.

## Trust boundaries

| Boundary | Data or authority crossing it | Intended rule |
| --- | --- | --- |
| MCP host/model to local stdio server | Tool names, arguments, and text that may include adversarial instructions | Treat all model-provided content, including claimed identity or approval, as untrusted input. The server assigns the local agent capability; no MCP tool may approve or reject a proposal. |
| Human operator to local CLI | Reviewer or auditor commands and authentication material | Authenticate the person independently of the MCP session. Only an authorized reviewer may record an approval or rejection; an auditor has read-only audit access. Do not pass reviewer credentials through MCP. |
| Application services to SQLite | Synthetic resources, proposals, decisions, credentials, and audit events | Enforce policy and state checks at the transaction boundary. Application-level audit integrity protects against accidental or unauthorized changes through application APIs, not arbitrary file edits. |
| Internal HTTP configuration and factory | Bearer credential, network settings, and read-only tool registrations | Validate configuration and constrain database/tool access to reads. No HTTP listener exists, so request authentication and Origin enforcement are not implemented transport behavior. |
| Application to external systems | Potential cloud or model API calls | Make no live cloud or external LLM calls. All resource changes are simulations against local fictional data. |

## Local trust limit

The local OS user who can edit the SQLite file or execute arbitrary code with the application's privileges is outside this application's security boundary. Such a user can bypass CLI role checks, alter stored decisions or audit rows, or inspect local secrets directly. Application authentication and hash-linked audit events do not prevent that file-level attack. The design protects the workflow from untrusted model/tool input and unauthorized application-level operations; it is not a substitute for OS account isolation or a production identity system.

## Threats, controls, and residual risks

The controls below describe the current code and its limitations. This table is not a test report or a guarantee that every attack is covered.

| ID and threat | Attack path | Design control | Residual risk |
| --- | --- | --- | --- |
| T1: Prompt injection | Instructions hidden in resource tags, descriptions, tool arguments, or model output try to redirect the host into unsafe actions. | Treat those fields as data; validate tool inputs, bind agent capabilities on the server, and enforce policy and approval in application services regardless of model wording. | An MCP host may still display or act on misleading text outside this server; server-side authorization must remain decisive. |
| T2: Forged approval or identity | A model claims to be a reviewer, supplies an approval flag, or invents reviewer credentials in an MCP call. | Expose no MCP approve/reject tool; authenticate reviewers through the separate CLI and verify a persisted, authorized decision before execution. Ignore identity and approval claims in tool arguments. | Someone with reviewer credentials or same-OS code execution can still misuse local authority. |
| T3: Time-of-check/time-of-use race | A resource or policy changes after proposal preview or review but before simulated execution. | Store the expected resource version and policy snapshot; recheck current state and policy inside an atomic transaction before review decisions and execution. Fail closed on stale or newly denied proposals. | Direct database edits by a trusted OS user bypass application transactions. |
| T4: Replay and duplicate execution | Repeated approval requests or execution calls attempt to apply one proposal more than once. | Enforce explicit state transitions, scoped idempotency keys, unique database constraints, and an atomic execution record plus resource update. Return the prior result only for an exact authorized retry. | A file-level attacker can rewrite state or keys; valid new requests may still create distinct proposals. |
| T5: Audit alteration | An application path omits an event, changes an earlier event, or writes an event apart from the related state change. | Append audit events in the same transaction as state changes and link canonical event hashes; provide a read-only chain verifier. | Hash chaining detects some alterations but cannot prevent or reliably prove tampering by someone who can rewrite the database and recompute the chain. |
| T6: Malicious or oversized input | Unknown fields, SQL-like strings, extreme lengths, invalid numbers, or unsafe object keys reach handlers or storage. | Use strict bounded schemas, allowlisted actions, prepared database statements, bounded pagination, and safe public error mapping. | Valid but adversarial inputs can still consume bounded resources; implementation defects remain possible. |
| T7: Network exposure | Network configuration or a bearer credential is mishandled. | The runnable app uses stdio and publishes no ports. Internal HTTP configuration validates binding and credentials, and the factory limits tools and database access to reads. | There is no HTTP listener or request-authentication layer to assess; configuration alone does not make a secure network service. |
| T8: Sensitive logs and responses | Passphrases, bearer headers, local paths, SQL, or stack traces reach MCP stdout, HTTP responses, or routine logs. | Keep stdio protocol output separate from stderr diagnostics; redact secrets and sensitive paths; return stable safe errors and omit credentials from audit events. | Local users with access to process memory or diagnostic files may still see secrets, and redaction can miss unforeseen data shapes. |

## Related tests

These existing tests exercise related boundaries. Their presence does not prove
complete attack coverage or that a particular checkout passed them. Run the
checks described in [Docker setup](docker.md) for your local copy.

| Threat | Existing test files | Related checks |
| --- | --- | --- |
| T1: Untrusted tool/resource text | `tests/mcp-schemas.test.ts`; `tests/analysis-service.test.ts`; `tests/policy-service.test.ts` | Strict contracts, fixed observations, and policy-controlled eligibility. These are not a comprehensive prompt-injection assessment. |
| T2: Forged approval or identity | `tests/permissions.test.ts`; `tests/reviewer-auth.test.ts`; `tests/review-service.test.ts` | Issued capabilities, independently authenticated reviewers, and refusal of self-review. |
| T3: Stale state or policy | `tests/execution-preflight.test.ts`; `tests/execution-service.test.ts`; `tests/e2e/workflow.test.ts` | Rechecks before writes; these cases do not establish parallel-writer behavior. |
| T4: Replay | `tests/execution-service.test.ts`; `tests/e2e/workflow.test.ts` | Exact completed retries return the saved result without another write. |
| T5: Audit alteration | `tests/audit-verification.test.ts`; `tests/audit-service.test.ts` | Stored hash consistency and bounded read-only audit output. |
| T6: Malformed input | `tests/mcp-schemas.test.ts`; `tests/integration/mcp-contract.test.ts` | Rejection of malformed calls and safe public failures. |
| T7: HTTP building blocks | `tests/config.test.ts`; `tests/mcp-factory.test.ts` | Configuration and read-only factory boundaries; no HTTP request-level acceptance test. |
| T8: Sensitive responses | `tests/errors.test.ts`; `tests/tools/get-audit-log.test.ts`; `tests/stdio-contract.test.ts` | Generic errors, restricted audit fields, and protocol-only stdout. |
