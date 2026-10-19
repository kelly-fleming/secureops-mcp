# SecureOps MCP

[![CI](https://github.com/kelly-fleming/secureops-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kelly-fleming/secureops-mcp/actions/workflows/ci.yml)

SecureOps MCP is my experimental personal hobby project for trying out cloud resource governance workflows through the Model Context Protocol (MCP). I work on it in my own time, independently of any company or commercial entity. It uses a local SQLite database of fictional AWS, Azure, and GCP resources to demonstrate deterministic analysis, policy previews, change proposals, independent human review, simulated execution, and audit records. The runnable local server communicates over stdio; every resource change stays in synthetic local state.

**All resources, owners, utilization figures, and costs are invented.** This project does not connect to cloud accounts, change real infrastructure, calculate actual savings, certify compliance, or need provider credentials or a paid API key. Do not add customer data, real account identifiers, or secrets to its fixtures.

## Quick start

Clone this repository, open a terminal in its root directory, and start Docker
Desktop with its Linux engine (or use Docker Engine with Compose v2 on Linux).
Docker supplies Node 24, npm, native build tools, and all application dependencies;
you do not need to install them on your machine. The commands in this README
assume Bash, including Git Bash on Windows:

```bash
docker compose build secureops checks demo
docker compose run --rm -T checks
docker compose run --rm -T secureops npm run db:seed -- --db-path data/demo/secureops-demo.db
```

The combined check runs coverage once and enforces 80% aggregate line and branch
coverage separately for application, domain, and security source. Seed reports
twelve resources on a fresh database. To try proposal creation, human review,
and simulated execution, follow the
[Docker guided demo](docs/docker.md#guided-demo-and-terminal-review).
Its setup resets only the disposable Docker demo database. This is a terminal
and MCP application; there is no browser UI, localhost URL, or cloud account setup.
MCP clients launch `docker compose run --rm -T secureops` from this repository root;
see [Docker client configuration](docs/docker.md#connect-an-mcp-client).
For a single lifecycle entry point, use `bash deploy.sh start`, `stop`, `restart`,
`status`, or `check` from Git Bash or another Bash terminal. Start builds and
seeds absent fictional resources without resetting saved state. The current
stdio application opens no network ports.

If you prefer running without Docker, install Node 24 and run these commands from
the repository root in Bash. They install locked dependencies,
build the compiled server and CLI, and seed the exact disposable demo database:

```bash
npm ci
npm run build
npm run db:seed -- --db-path data/demo/secureops-demo.db
```

The seed command preserves existing fictional resource and proposal state on repeat runs. Connect an MCP client to `node dist/mcp/stdio.js` in `local-full` mode with `SECUREOPS_DB_PATH` set to the **absolute path** of `data/demo/secureops-demo.db`; otherwise the server's default `data/secureops.db` is a different file. [Local setup](docs/local-setup.md) gives Bash path commands, plus [VS Code](examples/vscode-mcp.json) and [MCP Inspector](examples/inspector.md) client examples. A terminal running the stdio entry by itself is not an interactive tool menu.

## What is implemented

The local stdio server registers these tools:

| Tools | Purpose |
| --- | --- |
| `list_resources`, `get_resource`, `analyze_resource` | Inspect fictional resources and deterministic observations. |
| `evaluate_policy` | Preview an allowlisted change against the current resource and policy without saving it. |
| `propose_change`, `request_approval` | Save a draft and request independent review; neither operation changes a resource. |
| `execute_change` | Update synthetic local state after an authenticated reviewer decision and fresh policy and version checks. |
| `get_audit_log` | Read bounded, redacted workflow summaries. |

The separate interactive CLI enrolls a first local reviewer, lists pending proposals, records an authenticated approval or rejection, and offers read-only audit listing and chain verification. The HTTP demo has configuration and server-factory boundaries, but this repository does not provide a runnable HTTP listener. [Scope and implementation status](docs/scope.md) describes the modes in more detail.

## How it fits together

```text
MCP client ── stdio ── tool handler ── application service ── SQLite
                                  ├── resource and change validation
                                  └── current policy assessment

Human reviewer ── interactive CLI ── authenticated decision ── SQLite
```

The MCP client supplies requests, not reviewer authority. The server issues the local agent's capabilities; strict tool schemas and application services enforce supported actions and state transitions. A human reviewer authenticates in the CLI, away from MCP arguments, and a later simulated execution rechecks the stored decision, current policy, and resource version inside a write transaction. Workflow changes append audit events in the same transaction. Hash-chain verification describes consistency of rows still present; it cannot protect a database file from someone who can rewrite it. See [workflow storage](docs/workflow-storage.md), [permissions](docs/permissions.md), and the [threat model](docs/threat-model.md) for the boundaries.

## Guided local demo

For Docker, use the [container demo commands](docs/docker.md#guided-demo-and-terminal-review);
the commands below require Node 24 and dependencies on the host.
After `npm ci` and `npm run build`, run `npm run demo:local` from the repository root. It **resets only the disposable demo database**, clearing earlier proposals, audit rows, and enrolled reviewer identities, then creates a fictional proposal and pauses at `pending_approval`. Keep the printed proposal ID. In a separate interactive terminal at the same repository root, use the printed commands to enroll the first reviewer and decide the pending proposal. The commands have this shape:

```bash
npm run demo:local
npm run cli -- reviewer:init --db-path data/demo/secureops-demo.db
npm run cli -- proposals:list --db-path data/demo/secureops-demo.db
proposal_id='replace-with-printed-proposal-id'
npm run cli -- proposals:review --db-path data/demo/secureops-demo.db --proposal-id "$proposal_id"
npm run demo:local -- resume --proposal-id "$proposal_id"
```

Replace the sample ID with the value printed by the runner. The reviewer CLI asks for a masked passphrase and an approval or rejection; the MCP agent cannot decide it. On first execution, resume uses the existing proposal without resetting the database and changes synthetic state only if the reviewer approved and current policy and resource state still permit it. An authorized exact repeat of a completed resume returns the saved execution without another change or a fresh policy check. See [demo reset and resume behavior](docs/seed-reset.md) and [CLI review guidance](docs/cli.md) before rerunning setup.

## Runtime and checks

The app uses Node 24, TypeScript, Zod, and local SQLite. MCP runs over stdio
using `@modelcontextprotocol/server` 2.3.1. There is no runnable HTTP listener.

`npm run check` runs lint, typechecks, the full test suite with coverage once,
build, and formatting checks. Coverage reports all `src/**/*.ts` files and
enforces the scoped thresholds described in the [Docker check guide](docs/docker.md#direct-docker-commands).
`npm run test:coverage` runs that coverage gate alone. Use
`docker compose run --rm -T checks` to run the combined checks without host
dependencies. This is experimental software; passing checks are not a guarantee
of production suitability.

For the design behind the demo, read the [architecture](docs/architecture.md),
[proposal state machine](docs/workflow.md), [CLI reference](docs/cli.md), and
[threat model](docs/threat-model.md). The [contribution guide](CONTRIBUTING.md)
covers development setup and pull requests. The [Code of Conduct](CODE_OF_CONDUCT.md)
and [security policy](SECURITY.md) describe participation and reporting.

The [MIT license](LICENSE) covers original work in this repository; dependencies
retain their own licenses. This hobby project has no commercial affiliation or
support commitment. You can clone it and experiment locally with the fictional
data.
