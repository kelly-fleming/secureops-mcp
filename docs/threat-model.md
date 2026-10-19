# SecureOps MCP threat model

This document describes the security boundaries and limitations of this experimental personal hobby project. It is independent of any company or commercial entity. The code and tests do not establish production-grade identity isolation or security certification. See [scope](scope.md) for current runtime boundaries.

## Assets and security goals

- Synthetic resource state and proposal state: prevent an MCP host or internal HTTP viewer context from bypassing policy, human review, or allowed state transitions.
- Human review decisions and reviewer credentials: keep approval authority in a separately authenticated local CLI, away from MCP tool arguments and model output.
- Local audit record: keep state changes and their events atomic, and report consistency of stored rows without claiming external attestation.
- HTTP demo credential and local configuration: keep the in-memory bearer credential out of tool results and operational diagnostics. There is no runnable HTTP response path.

## Trust boundaries

| Boundary | Data or authority crossing it | Intended rule |
| --- | --- | --- |
| MCP host/model to local stdio server | Tool names, arguments, and text that may include adversarial instructions | Parse strict tool schemas and treat resource tags, owner text, and reasons as literal data. Issue agent capabilities from validated server configuration; no MCP tool authenticates a human or decides a proposal. |
| Human operator to local CLI | Reviewer or auditor commands and authentication material | Enroll with a masked interactive passphrase, then challenge on each protected command. Recheck that the authenticated identity is enabled before a protected decision or read. An auditor cannot decide a proposal. Prompt stubs in tests do not prove physical terminal masking. |
| Application services to SQLite | Synthetic resources, proposals, decisions, credentials, and audit events | Require issued capabilities, recheck current policy and resource version inside immediate write transactions, and append audit events with state changes. Storage rows alone do not authenticate a reviewer or authorize execution. |
| Internal HTTP configuration and factory | Bearer credential, network settings, and read-only tool registrations | Validate configuration and constrain database/tool access to reads. No HTTP listener exists, so request authentication and Origin enforcement are not implemented transport behavior. |
| Runnable entries to stderr | Operational lifecycle and failure records | Emit only fixed operation/event names, safe failure codes, and validated synthetic IDs through an allowlisted logger. MCP stdout remains protocol traffic; operational records are separate from SQLite audit events. |
| Application to external systems | Potential cloud or model API calls | Make no live cloud or external LLM calls. All resource changes are simulations against local fictional data. |

## Local trust limit

The local OS user who can edit the SQLite file or execute arbitrary code with the application's privileges is outside this application's security boundary. Such a user can bypass CLI role checks, alter stored decisions or audit rows, or inspect local secrets directly. Application authentication and hash-linked audit events do not prevent that file-level attack. A deleted audit tail, including the entire chain, leaves no sequence gap and is undetectable without a trusted external head record. Authentication has a retry bound per command but no persistent login rate limit. The design is not a substitute for OS account isolation or a production identity system.

## Threats, controls, and residual risks

The controls below describe the current code and its limitations. This table is not a test report or a guarantee that every attack is covered.

| ID and threat | Attack path | Design control | Residual risk |
| --- | --- | --- | --- |
| T1: Prompt injection | Instructions in resource tags, owner text, proposal reasons, or tool arguments try to redirect the host. | Strict MCP schemas and capability-checked services treat that text as literal data; fixed analysis text and current policy checks decide application behavior. | A separate MCP host may still display or act on misleading text; this server cannot control the host's decisions. |
| T2: Forged approval or identity | A model claims reviewer authority or supplies an approval, role, or credential in a tool call. | No MCP tool authenticates or decides a proposal. A masked CLI challenge issues a reviewer actor; the decision service rechecks its enabled identity, prevents self-review, and writes the decision atomically. | A credential holder or same-OS attacker can misuse local authority. Prompt stubs specify behavior but do not establish terminal masking in a real console. |
| T3: Stale resource or policy | State changes after a proposal preview or queue display. | Proposal and review services check the expected resource version and current policy in immediate transactions. A new execution rechecks the approved independent decision, current policy, and resource version in its own write transaction. Approval requires a fresh eligible preview; a reviewer may still reject when tightened policy denies or the preview becomes ineligible, provided the expected resource version still matches. | A direct file edit by the OS owner bypasses application transactions. Separately scheduled calls on one thread do not establish overlapping-writer contention. |
| T4: Replay or duplicate execution | Reused keys or concurrent requests try to create duplicate drafts or apply a proposal twice. | Actor-scoped proposal keys reserve exact draft retries; execution keys, unique rows, and immediate transactions permit one simulated write. An exact authorized completed retry returns its historical saved result without reapplying current policy or writing again; a new execution uses fresh checks. | A same-OS file owner can rewrite rows; a distinct valid request may create another proposal. |
| T5: Audit alteration | An event is omitted, modified, or separated from its state change. | Application services append closed audit payloads in the same transaction as writes. The read-only verifier checks canonical stored rows, sequence, predecessor links, and hashes. | A database-file owner can rewrite and rehash the chain. Deleting a tail leaves no gap and requires a trusted external head to detect. A valid report describes only rows still present. |
| T6: Malicious or oversized input | Unknown fields, SQL-like text, extreme lengths, invalid numbers, or unsafe object keys reach handlers or storage. | Strict bounded schemas, allowlisted actions, prepared statements, bounded pagination, and fixed public error mapping constrain application inputs. | Valid but adversarial input can still consume bounded resources, and implementation defects remain possible. |
| T7: Network exposure | An HTTP bind or bearer credential is mistaken for a protected public service. | The runnable app uses stdio and publishes no port. Internal HTTP configuration validates bind and credential settings; its factory accepts a read-only existing database and registers resource-read tools only. | No HTTP listener, request authentication, or Origin enforcement runs in this repository. HTTP configuration is not evidence of a secure network service. |
| T8: Sensitive diagnostics or responses | Passphrases, bearer values, paths, SQL, stacks, or review text reach MCP stdout, CLI output, or logs. | MCP stdout carries protocol frames; stderr operational diagnostics construct fixed JSON fields, validated synthetic IDs, and safe failure codes. MCP errors use fixed public results; audit payload builders omit secrets and untrusted text. | CLI prompts also use stderr, so that stream is not pure JSON lines. A same-OS user can inspect process memory or local diagnostic files. Allowlists reduce exposure but do not prove absence of defects. |

## Related tests

The linked files contain authored assertions, not results. They were not run for
this documentation update; their presence does not prove complete attack coverage
or that this checkout passed them. Use [Docker setup](docker.md) and the
[CLI guide](cli.md) to reproduce local checks and an interactive review. The
[MCP Inspector example](../examples/inspector.md) shows the client boundary.

The separate-connection cases in the service tests call synchronous SQLite code
one after another and establish serialized behavior only. The authored
[worker contention cases](../tests/integration/concurrency.test.ts) use independent
workers, a held write lock, and a `SQLITE_BUSY` observation or durable state
checks. A worker's “started” reply precedes lock acquisition and is not itself
proof of contention. The authored
[workflow rollback cases](../tests/integration/workflow-rollback.test.ts) inspect
state after a service-owned transaction fails, rather than relying on an outer
test transaction. Prompt runtimes in CLI and authentication tests are stubs; they
do not prove a real terminal hides a passphrase.

| Threat | Existing test files | Related checks |
| --- | --- | --- |
| T1: Untrusted tool/resource text | [MCP schemas](../tests/mcp-schemas.test.ts), [analysis](../tests/analysis-service.test.ts), [MCP contract](../tests/integration/mcp-contract.test.ts) | Strict inputs, fixed observations, and literal handling of untrusted text; no comprehensive prompt-injection assessment. |
| T2: Forged approval or identity | [permissions](../tests/permissions.test.ts), [reviewer authentication](../tests/reviewer-auth.test.ts), [enrollment](../tests/reviewer-init.test.ts), [review service](../tests/review-service.test.ts) | Issued capabilities, enabled-identity checks, refusal of self-review, and stubbed masked-prompt behavior. |
| T3: Stale state or policy | [review service](../tests/review-service.test.ts), [execution preflight](../tests/execution-preflight.test.ts), [worker contention](../tests/integration/concurrency.test.ts), [workflow rollback](../tests/integration/workflow-rollback.test.ts) | Current policy/version checks, allowed rejection under newly denied policy, worker outcomes under held locks, and service-owned rollback. |
| T4: Replay | [proposal service](../tests/proposal-service.test.ts), [execution service](../tests/execution-service.test.ts), [worker contention](../tests/integration/concurrency.test.ts), [end-to-end workflow](../tests/e2e/workflow.test.ts) | Exact draft identity, exact completed execution retry, conflicting keys, and one durable simulated update. |
| T5: Audit alteration | [audit verification](../tests/audit-verification.test.ts), [audit service](../tests/audit-service.test.ts), [workflow rollback](../tests/integration/workflow-rollback.test.ts) | Canonical hash/sequence checks, explicit deleted-tail limit, closed audit payloads, and rollback of failed writes. |
| T6: Malformed input | [MCP schemas](../tests/mcp-schemas.test.ts), [MCP contract](../tests/integration/mcp-contract.test.ts), [error mapping](../tests/errors.test.ts) | Malformed-call rejection and fixed public failures. |
| T7: HTTP building blocks | [configuration](../tests/config.test.ts), [MCP factory](../tests/mcp-factory.test.ts) | Validated mode and credential configuration plus read-only factory restrictions; no HTTP request-level acceptance case exists. |
| T8: Sensitive diagnostics and responses | [logger](../tests/logger.test.ts), [stdio contract](../tests/stdio-contract.test.ts), [CLI parser](../tests/cli-parser.test.ts), [agent audit tool](../tests/tools/get-audit-log.test.ts) | Allowlisted JSON fields, failure isolation, protocol-only stdout, CLI result preservation, and bounded audit summaries. |
