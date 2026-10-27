# Changelog

Significant changes to this experimental personal hobby project are
recorded here.

## 0.3.0 - 2026-10-27

### Changed

- Updated README documentation to link to the new guided walkthrough.
- Expanded developer-facing documentation explaining the distinction between illustrative examples, automated demonstration results, and independently verified behavior.

### Added

- Step-by-step fictional resource governance walkthrough covering resource inspection, analysis, policy evaluation, change proposals, independent approval, simulated execution, and audit inspection.
- Eight annotated walkthrough images documenting an automated MCP Inspector and authenticated CLI demonstration, including the blocked execution before approval.
- Representative MCP tool inputs, structured results, and error examples in examples/sample-tool-results.json to help developers understand tool contracts without running the application.
- Screenshot provenance and capture documentation identifying the environment, test scenario, observed behavior, and verification limitations.
- Root-level AGENTS.md with implementation guidance for coding agents working with the project's architecture, security boundaries, and testing conventions.

### Limitations

- All resources, costs, and changes remain fictional and local.  The application does not interact with real cloud infrastructure.
- The runnable MCP server continues to use stdio; no publicly accessible HTTP endpoint is introduced.
- Walkthrough screenshots demonstrate an automated scenario, not independent human acceptance or comprehensive security verification.

## 0.2.0 - 2026-10-19

### Changed

- Project package metadata and the MCP server's advertised identity now use
  `0.2.0`. Authored factory, integration, stdio, and compiled smoke contracts
  compare the server identity with package metadata; test-client versions remain
  independent.
- The combined local and Docker check now runs the full test suite with V8
  coverage once. The configured gate requires 80% aggregate line and branch
  coverage separately for application, domain, and security source, while the
  report still includes the broader source tree.
- Security guidance now describes the implemented CLI review and execution
  rechecks, local audit-chain limits, and the internal-only HTTP factory.

### Added

- Allowlisted, level-filtered operational diagnostics on stderr for handled MCP
  tools and local CLI commands. Diagnostics keep raw requests, credentials,
  reviewer text, paths, and thrown errors out of structured records; they are
  separate from transactional audit events.
- Authored adversarial authorization and literal-data regression cases for
  forged approval or identity claims, malformed inputs, denied writes, and
  restricted audit output.
- Authored independently executing SQLite writer-contention cases and
  service-owned rollback cases for proposal, review, and simulated execution
  workflows.

### Limitations

- Resources and changes remain fictional and local. The runnable MCP transport
  is stdio; reviewer decisions still require the interactive authenticated CLI.
  No HTTP listener or live cloud integration is included.
- An OS user who can rewrite the SQLite file can also rewrite its audit chain;
  a deleted tail cannot be detected without a trusted external head record.

## 0.1.0 - 2026-10-13

Initial release.

### Added

- Local MCP server with eight tools for inspecting fictional resources,
  evaluating policy, proposing changes, and simulating approved changes.
- Fictional AWS, Azure, and GCP resources stored in local SQLite.
- Interactive CLI for reviewer enrollment, proposal review, audit
  inspection, and audit-chain verification.
- Guided demo covering proposals, independent review, and execution.
- Docker setup for running the app and checks without host dependencies.
- Bash setup instructions and MCP client examples.

### Limitations

- All resources and changes are simulated; no cloud accounts are accessed.
- The runnable MCP transport is stdio; no browser UI or HTTP listener
  is included.
- Intended for local experimentation on a trusted workstation.
