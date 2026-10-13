# Security policy

SecureOps MCP is an experimental personal hobby project, developed independently
of any company or commercial entity. It uses fictional resources and a local
SQLite database. It does not connect to cloud providers or change real
infrastructure. There is no commercial support or security certification.

The stdio server and reviewer CLI are intended for a trusted workstation. Anyone
who can run code as the database's OS owner can edit the database or inspect local
credentials; the audit hash chain does not protect against that access. The app
has internal read-only HTTP configuration and factory code, but no runnable HTTP
listener. See the [threat model](docs/threat-model.md) for the boundaries and limits.

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
