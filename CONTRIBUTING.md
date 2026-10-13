# Contributing to SecureOps MCP

SecureOps MCP is an experimental personal hobby project, developed independently of any company or commercial entity. Contributions should preserve its fictional data and its separation between MCP agent actions and independently authenticated human review. Read the [project scope](docs/scope.md), [architecture](docs/architecture.md), [workflow](docs/workflow.md), [permissions](docs/permissions.md), and [threat model](docs/threat-model.md) before changing those boundaries.

## Set up a local development copy

If Node or native dependencies are unavailable on your machine, use the
[Docker setup](docs/docker.md). Docker builds from the lockfile and runs the same
checks with Node 24. No host npm installation is needed for that path.

Use Node 24 from the repository root in Bash (including Git Bash on Windows):

```bash
npm ci
```

The available checks are `npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:coverage`, `npm run build`, `npm run format:check`, and the combined `npm run check`. Run the relevant checks before a pull request and report their actual results. [Local setup](docs/local-setup.md) explains the separate compiled server, disposable demo database, and interactive reviewer CLI. A written command list is not evidence that a check passed.

## Coding standards

- Follow the repository's TypeScript, ESLint, and Prettier configuration. Keep names explicit, inputs and outputs validated at their boundaries, and error responses free of secrets or local paths.
- Keep proposal, review, execution, and audit changes within the trust and transaction boundaries in [workflow storage](docs/workflow-storage.md) and [auth and audit storage](docs/auth-audit-storage.md). Never grant reviewer authority through an MCP argument or resource text.
- Use fictional resource examples only. Do not add cloud credentials, real account or customer identifiers, private inventories, proprietary assets, or copied third-party source to fixtures, examples, tests, or documentation.
- Add focused tests when behavior changes, and update documentation when commands, tool contracts, or trust boundaries change. Include the commands you ran and their actual results in your pull request; distinguish checks you did not run.

## Pull request checklist

- [ ] The change has a clear purpose and stays within the [project scope](docs/scope.md).
- [ ] New examples and fixtures are invented; no secrets, customer data, or proprietary material are included.
- [ ] Relevant tests and documentation describe the changed behavior and its trust boundary.
- [ ] The pull request states which checks were actually run, their outcomes, and any checks still pending.
- [ ] Any new dependency or externally sourced material has its license and attribution reviewed; existing notices are preserved.

Submit only work you have the right to license. By contributing your original work to this project, you agree to license that contribution under the root [MIT license](LICENSE). Third-party dependencies and externally sourced material retain their own license terms; the root license does not grant rights to them.

Report suspected vulnerabilities through the private route in the [security policy](SECURITY.md). Do not post exploit details, credentials, or private data in a public issue or pull request. Community behavior and conduct reporting are covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
