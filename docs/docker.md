# Local Docker workflows

Run these commands from the repository root with Docker Desktop's Linux engine.
The images use Node 24, install the committed lockfile with `npm ci`, and build
the compiled CLI and stdio server. Host Node and host `node_modules` are not used.
Docker Engine with Compose v2 on Linux also supplies this environment. A fresh
clone needs only Docker and a terminal; no cloud credentials or public hosting
are required. All commands below assume Bash, including Git Bash on Windows.

## Manage containers with deploy.sh

Use Bash (Git Bash on Windows) for the repo's lifecycle script:

```bash
bash deploy.sh build
bash deploy.sh start
bash deploy.sh status
bash deploy.sh restart
bash deploy.sh stop
```

Commands also accept `secureops:build`, `secureops:start`, `secureops:restart`,
and `secureops:stop`. The script resolves the repo from its own location, so it
also works when invoked by an absolute path from another directory. Start and
restart build the current production source, seed only absent resources, and
run only `secureops`. Stop preserves the container and volume; restart recreates
the container with the current image while retaining resources, proposals,
reviewer identities, and audit history. Checks and demo services use the `tools`
profile so a plain `docker compose up -d` cannot run the destructive demo setup.

Run checks with `bash deploy.sh check` or `bash deploy.sh coverage`. To enroll
and review from a real terminal after starting:

```bash
proposal_id='replace-with-proposal-id'
bash deploy.sh cli reviewer:init --db-path data/demo/secureops-demo.db
bash deploy.sh cli proposals:list --db-path data/demo/secureops-demo.db
bash deploy.sh cli proposals:review --db-path data/demo/secureops-demo.db --proposal-id "$proposal_id"
```

Set `proposal_id` to the proposal ID to review. For an MCP client, launch
`bash` with arguments `["/absolute/path/to/deploy.sh", "mcp"]` after `start`.
This creates a separate protocol process inside the running container using
`docker compose exec -T`; the client owns that process's stdin and stdout.
Closing the client leaves the managed container running.
`bash deploy.sh logs` follows diagnostics; `bash deploy.sh help` lists all commands.

**Ports:** the implemented stdio application has no network listeners or
published ports, so it cannot conflict with other apps' port allocations.
The lifecycle script runs the local stdio app; it does not add an HTTP service.

`bash deploy.sh demo:setup` explicitly resets the disposable volume database
and creates a pending proposal. After review, use
`bash deploy.sh demo:resume <proposal-id>`. Normal build/start/stop/restart never
reset the database or remove volumes.

## Direct Docker commands

```bash
docker compose build secureops checks demo
docker compose run --rm -T checks
docker compose run --rm -T checks npm run test:coverage
docker compose run --rm -T secureops npm run db:seed -- --db-path data/demo/secureops-demo.db
```

The `secureops` image contains production dependencies, compiled code and SQL
migrations, fictional fixtures, and demo policies. The `checks` and `demo` images
include development dependencies. Live local databases, credentials, environment
files, Git history, and build outputs are excluded from the build context.
Dependencies are installed at image build time; startup does not reinstall them
or recreate reviewer identities.

## Connect an MCP client

Configure a stdio client to launch command `docker` with these arguments, using
the repository root as its working directory:

```json
["compose", "run", "--rm", "-T", "secureops"]
```

Keep `-T` for MCP: allocating a terminal can alter protocol frames. The server
uses `/app/data/demo/secureops-demo.db` inside the named `demo-data` volume.
The volume is separate from the host's `data/demo/secureops-demo.db`. Seed it
before requesting fictional resources. There is no HTTP listener or published
port; the implemented transport is stdio.

With Node available on the host, the dependency-free compiled smoke client can
verify initialization, all eight tools, twelve resources, a detail read,
refusal to execute a missing proposal, clean stdout, and shutdown:

```bash
node scripts/smoke-stdio.mjs docker compose run --rm -T secureops
```

This client reads the seeded database and attempts a missing proposal; it does
not create proposals or execute changes.

## Guided demo and terminal review

**Setup resets only this volume's disposable demo database, including identities
and audit history.** Use a real terminal for reviewer and audit commands. The
commands below explicitly allocate a terminal for masked passphrase prompts.
Keep `-T` for noninteractive demo steps and MCP protocol processes.

```bash
docker compose run --rm -T demo
docker compose run --rm --interactive --no-tty=false secureops npm run cli -- reviewer:init --db-path data/demo/secureops-demo.db
docker compose run --rm --interactive --no-tty=false secureops npm run cli -- proposals:list --db-path data/demo/secureops-demo.db
proposal_id='replace-with-printed-proposal-id'
docker compose run --rm --interactive --no-tty=false secureops npm run cli -- proposals:review --db-path data/demo/secureops-demo.db --proposal-id "$proposal_id"
docker compose run --rm -T demo npm run demo:local -- resume --proposal-id "$proposal_id"
docker compose run --rm --interactive --no-tty=false secureops npm run cli -- audit:verify --db-path data/demo/secureops-demo.db
```

The demo runner prints commands for its container environment; use the Docker
commands above when working from the host. Replace the sample `proposal_id`
with the proposal ID printed by setup; keep the variable quoted in later commands.
Reviewers authenticate on every protected CLI invocation. Approval permits a
fresh policy/version check before one simulated execution. Rejection leaves
the resource unchanged. Repeating an executed resume returns the saved result.
Each `run --rm` starts a fresh process while retaining the same named volume.

Leave the named volume intact to retain local demo state. `docker compose down`
does not remove it; adding `--volumes` would discard that state.

### Terminal troubleshooting

If the CLI reports `Proposal review requires an interactive terminal` (or the
equivalent for enrollment, listing, or audit), run it in Windows Terminal or
VS Code's integrated Terminal with a Bash/Git Bash profile, rather than a script
runner or output pane. Use `--interactive --no-tty=false` as shown above and avoid pipes
or output redirection. The CLI requires both stdin and stderr to be terminals.
If a standalone Git Bash window cannot attach a terminal, try a Git Bash profile
in Windows Terminal or VS Code's integrated Terminal.

Docker writes `Creating` / `Created` container progress to stderr. Read the CLI's
final result and run `echo "$?"` immediately after the command to check its exit
status; the container progress text alone does not prove
that review failed. After fixing a terminal problem, retry review with the same
proposal ID. Do not rerun demo setup merely to retry; it clears proposals and
reviewer identities.

For reproducible issue reports, include the command, Docker version, and exit
status. Do not include passphrases, tokens, or private database contents.
