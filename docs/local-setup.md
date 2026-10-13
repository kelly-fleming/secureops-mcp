# Local MCP setup

For a machine without Node 24 or native dependencies, follow the
[Docker setup and client configuration](docker.md). The commands in this guide
use host Node; the Docker guide runs everything in containers instead.

SecureOps MCP uses invented AWS, Azure, and GCP resources in a local SQLite database. The local stdio server and the disposable demo need no cloud subscription, provider credentials, or API key. Use Node 24 and run the commands below from the repository root. The checked-in `.nvmrc` records the Node major version; `.env.example` is a reference file and is not automatically loaded by the application.

## Prepare the disposable demo database

Bash (including Git Bash on Windows):

```bash
npm ci
npm run build
export SECUREOPS_MODE=local-full
npm run db:seed -- --db-path data/demo/secureops-demo.db
DEMO_DB="$(node -p 'process.cwd()')/data/demo/secureops-demo.db"
```

The seed command creates the exact disposable demo database, applies the numbered migrations, and inserts missing fictional fixture resources. Running seed again preserves existing resource changes and proposal workflow state. The absolute path saved in `DEMO_DB` points to the file created by these commands. Using Node's working directory provides a native path for the host server, including when Bash runs on Windows. This shell variable helps you copy the path into client settings; it does not configure an editor that is already running. See [demo database behavior](seed-reset.md) before using reset or the guided `npm run demo:local` command, since either reset path clears the demo review workflow and enrolled local identities.

## Select the same database in an MCP client

The compiled local stdio entry is `node dist/mcp/stdio.js`. It reads `SECUREOPS_MODE=local-full` (the default) and `SECUREOPS_DB_PATH` from its own process environment. If `SECUREOPS_DB_PATH` is absent, it selects `data/secureops.db`, which is a different database from the seeded demo file. A relative path is resolved from the server process's working directory, which an editor or Inspector may set differently from your terminal. Configure the client to pass the absolute demo path and local-full mode to the server process. Keep its command pointed at the compiled entry in this repository.

The server uses stdout for MCP JSON-RPC traffic. Any startup or shutdown errors are written to stderr so they cannot corrupt that protocol stream. Launch it through an MCP client to discover and call its tools; running the stdio entry in a terminal is not an interactive application menu.

## Connect from VS Code

Open this repository root as a local VS Code workspace folder after preparing the demo database above. Copy [the VS Code MCP example](../examples/vscode-mcp.json) into `.vscode/mcp.json`. If that file already exists, merge only its `servers.secureops` entry into the existing `servers` object so other configured servers remain available. The example uses VS Code's workspace `mcp.json` format; a portable root `.mcp.json` uses a different top-level `mcpServers` key and should not receive this file unchanged. See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) for the supported formats and fields.

The `node` command must be available to the VS Code process. The example passes the compiled `dist/mcp/stdio.js` path as one argument, sets its working directory to the workspace root, and gives the server `SECUREOPS_MODE=local-full` and the seeded demo database path. VS Code expands `${workspaceFolder}` to the opened repository folder, making those paths absolute even when its own launch directory differs. The example contains no API key, passphrase, or secret placeholder. If you opened a parent folder or a remote workspace, adjust the paths to the local repository and database that the server process can actually access.

In the Command Palette, run **MCP: List Servers**, select `secureops`, and start it if needed. VS Code may ask you to trust the workspace server before launching it. In Chat, use **Configure Tools** to inspect its discovered tools. This local server registers `list_resources`, `get_resource`, `analyze_resource`, `evaluate_policy`, `propose_change`, `request_approval`, `execute_change`, and `get_audit_log`. A reviewer decision is not an MCP tool; use the separate CLI below. [VS Code's MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers) describes server management and tool discovery.

Local MCP tools can list, inspect, analyze, preview, propose, request review, execute an independently approved simulated change, and read bounded audit summaries. They cannot approve a proposal or accept a reviewer passphrase. A human uses the authenticated, interactive [proposal CLI](cli.md) against the **same database file** for review. The [guided demo](seed-reset.md#guided-local-demonstration) prints the exact reviewer and resume commands for its pending proposal.

For direct tool exploration outside VS Code, follow [the MCP Inspector guide](../examples/inspector.md). It includes a fictional proposal walkthrough and an unrun acceptance checklist.

When reporting a setup problem, include the command, runtime version, and non-sensitive error text. Keep credentials and local secret paths out of reports.
