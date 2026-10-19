# Security policy

SecureOps MCP is an experimental personal hobby project, developed independently
of any company or commercial entity. It uses fictional resources and a local
SQLite database. It does not connect to cloud providers or change real
infrastructure. There is no commercial support or security certification.

## Supported security boundary

The runnable MCP server uses local stdio. It accepts only allowlisted fictional
resource operations through strict tool schemas and application capability
checks. An MCP tool can request review or a simulated execution, but cannot
authenticate a human or approve or reject a proposal. The separate CLI requires
a masked interactive passphrase challenge for each protected reviewer or auditor
command. Review rechecks current policy and the resource version inside its
write transaction. A new simulated execution also rechecks the independent
decision, current policy, and resource version in its write transaction. An
exact authorized retry of an already completed execution returns its saved
result without another write.

The stdio server and CLI are intended for a trusted workstation. A person who
can run code as the database's OS owner can edit the SQLite file and inspect
local credential material. Application-written audit events are linked by hashes,
but the same person can rewrite the chain; deleting its tail is undetectable
without a trusted external head record. Authentication is per protected CLI
command, with no persistent login rate limit. These controls do not provide
production identity isolation or protect a compromised OS account.

Operational diagnostics use fixed fields and validated synthetic IDs on stderr;
they are separate from transactional audit events and do not authorize actions.
The app has internal read-only HTTP configuration and a read-only server-factory
boundary, but no runnable HTTP listener or request-authentication layer. See the
[threat model](docs/threat-model.md), [permissions](docs/permissions.md),
[local authentication and audit storage](docs/auth-audit-storage.md), and
[workflow storage](docs/workflow-storage.md) for the detailed limits.

## Reporting a vulnerability

Email me at [kelly89.fleming@gmail.com](mailto:kelly89.fleming@gmail.com) for
confidential vulnerability reports. Please keep vulnerability details out of
public issues and pull requests.

Use GitHub's **Report a vulnerability** button under this repository's
**Security → Advisories**, when available, to send a confidential report. See
[GitHub's private reporting documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
Email remains available if GitHub's reporting option is unavailable.

Include the affected commit or version, a brief impact description, and
reproduction steps using fictional data. Do not include live credentials,
customer data, real provider resources, or private database contents. Avoid
posting exploit details in public issues or pull requests.

I review reports as time permits. Response or fix timelines are not guaranteed.
