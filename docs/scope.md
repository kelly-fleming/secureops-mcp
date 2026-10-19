# SecureOps MCP scope

SecureOps MCP is an experimental personal hobby project, developed independently
of any company or commercial entity. It explores cloud resource governance
workflows through MCP using wholly fictional AWS, Azure, and GCP resources.
Provider names identify simulated resource kinds; they do not imply a provider
account connection or endorsement.

## Local workflow

The runnable app uses MCP over stdio and a local SQLite database. An MCP agent
can inspect resources, analyze them, preview policy, propose a change, and request
review. A human reviewer authenticates through the separate interactive CLI to
approve or reject a pending proposal. Approval permits a simulated execution only
after fresh policy, decision, and resource-version checks. No operation changes
real infrastructure.

| Actor | Access | Boundary |
| --- | --- | --- |
| Local MCP agent | Inspect, preview, propose, request review, and simulate an approved change | Cannot approve or reject; identity claims in tool input grant no authority. |
| Human reviewer | Authenticated interactive CLI | May approve an eligible pending proposal or reject a pending proposal even if its preview or policy now denies it; either decision requires the expected resource version to match, and self-review is forbidden. |
| Human auditor | Authenticated interactive CLI | May inspect and verify audit records without approval authority. |
| Internal HTTP viewer context | Read-only server factory | Resource read registrations only; no runnable HTTP listener. |

## MCP tools

| Tools | Local stdio behavior |
| --- | --- |
| `list_resources`, `get_resource`, `analyze_resource` | Read fictional resources and deterministic observations. |
| `evaluate_policy` | Preview an allowlisted action against current policy without saving it. |
| `propose_change`, `request_approval` | Create a draft and request independent review. |
| `execute_change` | Simulate an independently approved change after policy and state rechecks. |
| `get_audit_log` | Read bounded, redacted workflow summaries. |

Reviewer enrollment, decisions, and audit verification are CLI operations,
never MCP tools. See [CLI commands](cli.md) and [Docker setup](docker.md).

The internal `http-demo` configuration and factory use a read-only database and
resource-only tool registrations. Configuration includes credential and network
settings, but these building blocks do not provide a runnable network service.

## Data and limits

- Resource IDs, owners, tags, utilization, and cost figures are invented.
  Costs are synthetic estimates, not actual bills or savings forecasts.
- Running the app requires no cloud subscription, provider credentials, or paid
  API key. It makes no live cloud or external LLM calls.
- Fixtures are part of this repository; each person controls their local database.
  The app does not import customer code or organization inventories.
- Keep real account identifiers, customer data, credentials, and proprietary
  material out of fixtures, examples, and reports.
- This experiment is not a production governance service or compliance
  certification. See the [threat model](threat-model.md) for security limits.
