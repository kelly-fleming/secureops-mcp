# Local CLI router

Run these examples in Bash (including Git Bash on Windows). After building under Node 24, use `npm run cli -- --help` to see all command names and flags. Use `npm run cli -- <command> --help` for one command. Importing `src/cli/index.ts` does not run a command.

The router dispatches the local database, reviewer, proposal, and audit commands. Every command needs an explicit `--db-path`; the selected path is still checked by the command and `loadConfig` before opening SQLite. For example:

```bash
npm run build
npm run cli -- db:migrate --db-path data/demo/secureops-demo.db
npm run cli -- db:seed --db-path data/demo/secureops-demo.db
npm run cli -- db:reset --db-path data/demo/secureops-demo.db --force
npm run cli -- reviewer:init --db-path data/demo/secureops-demo.db
```

Through the router, `db:reset` needs both `--force` and an interactive terminal. The older dedicated `npm run db:reset` script still requires the exact demo path and `--force`, but does not add a terminal check. `reviewer:init` requires an interactive terminal and still prompts for a masked passphrase; no flag accepts a passphrase. The existing dedicated npm scripts remain available. Seed and reset operate only on the exact disposable demo database path. The router returns fixed, generic diagnostics rather than printing SQLite errors, local paths, configuration, or prompt contents.

`proposals:list` and `proposals:review` require an interactive terminal and a masked reviewer passphrase challenge on each invocation. They use only an explicitly selected, existing, migrated local database. For example:

```bash
npm run cli -- proposals:list --db-path data/demo/secureops-demo.db
npm run cli -- proposals:review --db-path data/demo/secureops-demo.db --proposal-id proposal-demo-001
```

Use an actual pending proposal ID from the list for the second command. Listing displays bounded pending requests with fictional resource details, current policy findings, and a change preview when eligible. Review shows one selected proposal, asks for a decision and reason, then requires confirmation before saving. A stale proposal or one submitted by the same reviewer cannot be decided. When the current policy denies approval or the preview is ineligible, the reviewer may reject it. The command prints the decision ID and status only after persistence. The decision service rechecks current state and policy inside its write transaction. No command-line approval or rejection flag exists.

`audit:list` and `audit:verify` require an interactive reviewer or auditor role choice followed by a masked passphrase challenge on every invocation. The selected role must match an enabled local identity. Both commands open an explicitly selected existing local database read-only, then check its complete migration history and schema before authentication and audit reads. For example:

```bash
npm run cli -- audit:list --db-path data/demo/secureops-demo.db --proposal-id proposal-demo-001
npm run cli -- audit:list --db-path data/demo/secureops-demo.db --resource-id res-aws-ec2-01 --limit 50
npm run cli -- audit:verify --db-path data/demo/secureops-demo.db
```

Listing shows bounded event metadata without raw payload text; it does not establish integrity. Verification reports consistency of the rows currently stored. A removed tail is undetectable without a trusted external head record.
