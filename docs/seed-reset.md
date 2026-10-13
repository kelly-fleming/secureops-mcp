# Disposable demo database

From the project root in Bash (including Git Bash on Windows), under Node 24, build once and select the dedicated demo path explicitly:

```bash
npm ci
npm run build
npm run db:seed -- --db-path data/demo/secureops-demo.db
npm run db:reset -- --db-path data/demo/secureops-demo.db --force
npm run reviewer:init -- --db-path data/demo/secureops-demo.db
```

`db:seed` validates the checked-in fictional fixture, applies any missing numbered migrations, and inserts only absent resources. Running it again leaves changed resources, versions, and workflow records alone. A fixture ID already assigned to a different provider resource is an error. Neither command contacts a cloud provider or modifies `fixtures/resources.json`.

`db:reset` requires the exact path and `--force`. It removes demo audit events, executions, decisions, proposals, local reviewer identities, and resources in one SQLite transaction, then inserts the fixture baseline. It retains schema and migration history. Resetting also removes enrolled local reviewer credentials; enroll a new reviewer before demonstrating approval again. This is the sole intentional exception to the ordinary append-only audit rule, limited to the disposable demo database.

`reviewer:init` prompts on an interactive terminal for the first local reviewer after migrations are applied. It refuses a second bootstrap. The exact-path demo reset above clears local identities so a new first reviewer can be enrolled; that reset also clears the demo workflow and audit history.

`db:seed` and `db:reset` refuse HTTP demo mode, other database paths, symlinked demo path components, a database file with multiple hard links, and an existing resource inventory outside the fictional fixture. They never delete a database file or arbitrary filesystem content. Run them from the project root because `data/demo/secureops-demo.db` is resolved relative to the current working directory. Their success output contains only a resource count; failure output omits SQL, paths, and credentials.

`reviewer:init` also refuses HTTP demo mode and linked database files, but accepts any explicitly selected, existing local database with the current migrations. It outputs only the enrolled username after persistence and keeps passphrases, salt, verifier bytes, SQL, and local paths out of routine diagnostics.

## Guided local demonstration

From the project root, use Node 24 and install dependencies once with `npm ci`. Then run `npm run demo:local`. The runner forces the documented exact-path reset, lists fictional resources, analyzes and previews an idle compute change, and pauses with a `pending_approval` proposal. It needs no cloud account, API key, or reviewer passphrase. It prints the proposal ID and exact `npm run build`, reviewer enrollment, pending-list, and review commands for the same local database. Run the reviewer commands in an interactive terminal; the independent reviewer chooses a decision and enters a masked passphrase there.

After an approval, use the printed `npm run demo:local -- resume --proposal-id <proposal-id>` command. Resume checks the existing proposal without resetting it, invokes the execution service's current decision, policy, and resource checks, and prints a fictional execution and bounded audit trace. A pending, rejected, or stale proposal produces no execution. Repeating the same resume command returns the saved execution. Running setup again (`npm run demo:local` or `npm run demo:local -- setup`) intentionally resets only the disposable demo database and clears its reviewer identity and workflow; use resume for the existing proposal.
