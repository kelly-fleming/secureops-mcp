# Changelog

Significant changes to this experimental personal hobby project are
recorded here.

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