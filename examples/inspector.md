# Inspect the local SecureOps MCP server

Use this guide with the fictional demo database. First complete the install, build, and seed steps in [local setup](../docs/local-setup.md). Run the commands below from the repository root. The Inspector itself is fetched by `npx`; no paid API key or cloud account is needed. The [official MCP Inspector guide](https://modelcontextprotocol.io/docs/tools/inspector) describes its web client and local stdio invocation.

## Launch the Inspector

Bash (including Git Bash on Windows):

```bash
REPO_ROOT="$(node -p 'process.cwd()')"
DEMO_DB="$REPO_ROOT/data/demo/secureops-demo.db"
npx @modelcontextprotocol/inspector node dist/mcp/stdio.js -e SECUREOPS_MODE=local-full -e "SECUREOPS_DB_PATH=$DEMO_DB" --cwd "$REPO_ROOT"
```

The `-e` options configure the **spawned stdio server**, and `--cwd` keeps its compiled entry relative to this repository. `SECUREOPS_DB_PATH` is absolute so the server opens the same seeded file even if a client uses another working directory. If the connection panel shows settings, select **STDIO**, confirm `node` and `dist/mcp/stdio.js` with these environment values, then connect. Open the local URL printed by the Inspector; treat its per-launch URL token as private. The [Inspector server configuration reference](https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-server-configuration.md) documents these options.

The server reserves stdout for MCP traffic and writes diagnostics to stderr. Use the Inspector's tool interface to interact with it. Do not paste reviewer passphrases into tool arguments or Inspector settings. The database path is a local file path, not an API key.

## Explore a fictional workflow

In the Inspector **Tools** tab, refresh the tool list after connecting. The local server registers `list_resources`, `get_resource`, `analyze_resource`, `evaluate_policy`, `propose_change`, `request_approval`, `execute_change`, and `get_audit_log`. It does not register a reviewer decision tool. Enter the following JSON objects as tool arguments, one call at a time:

| Tool | Arguments | What to inspect |
| --- | --- | --- |
| `list_resources` | `{}` | Find fictional resources, including `res-aws-ec2-01`. |
| `get_resource` | `{"resourceId":"res-aws-ec2-01"}` | Read its current version and synthetic estimates. |
| `analyze_resource` | `{"resourceId":"res-aws-ec2-01"}` | Read deterministic observations; these do not authorize a change. |
| `evaluate_policy` | `{"resourceId":"res-aws-ec2-01","action":{"type":"disable_compute"}}` | Inspect the current policy findings and preview before proposing. |
| `propose_change` | `{"resourceId":"res-aws-ec2-01","action":{"type":"disable_compute"},"reason":"Inspector demo of an idle fictional instance","idempotencyKey":"inspector-demo-001"}` | Save the returned proposal ID. Reuse this key only for an exact retry while the proposal remains a draft; use a new key for a new proposal. |
| `request_approval` | `{"proposalId":"<returned proposal ID>","justification":"Please review this fictional idle instance proposal"}` | Replace the bracketed text with the exact returned ID; the proposal should become pending review. |

The displayed resource ID and example text are fictional. The proposal ID is an output value, not a secret or a literal ID to submit. If that resource was already changed in your selected database, inspect its current state before choosing another eligible fixture; reseeding does not restore changed resources. If an earlier walkthrough already used `inspector-demo-001`, choose a new idempotency key for the new proposal. Do not run `db:reset` or `npm run demo:local` between proposal submission and review because those commands clear this demo workflow.

Review happens in a separate interactive terminal opened at the repository root against the **same database**. If this is the first use of that database and it has no local reviewer identity, enroll one with `npm run cli -- reviewer:init --db-path data/demo/secureops-demo.db`. Then list pending proposals and review the ID returned by `propose_change`:

```bash
npm run cli -- proposals:list --db-path data/demo/secureops-demo.db
proposal_id='replace-with-returned-proposal-id'
npm run cli -- proposals:review --db-path data/demo/secureops-demo.db --proposal-id "$proposal_id"
```

Replace the sample value with the actual returned ID. The CLI prompts for an independently authenticated reviewer's masked passphrase and decision. No MCP argument, flag, or Inspector screen supplies reviewer authority. See [CLI review guidance](../docs/cli.md) for the eligibility and confirmation rules.

## Manual acceptance checklist

Use these checks to confirm your own local setup.

- [ ] The Inspector connects to the compiled local stdio server and discovers the eight named tools.
- [ ] `list_resources`, `get_resource`, and `analyze_resource` return fictional data for the selected resource.
- [ ] `evaluate_policy` shows current findings; `propose_change` returns a proposal ID; `request_approval` makes that proposal pending.
- [ ] A separate terminal's `proposals:list` shows the pending proposal in the same database, and an independently authenticated reviewer can decide it with `proposals:review`.
- [ ] The Inspector exposes no reviewer decision tool, passphrase, provider credential, or paid API-key requirement.

When reporting an issue, describe which steps you ran and their outcomes without sharing credentials or the Inspector URL token.
