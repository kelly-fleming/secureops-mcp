import { McpServer } from '@modelcontextprotocol/server';

import { modeOfLoadedConfig, type AppConfig } from '../config.js';
import { ForbiddenError } from '../domain/errors.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import { createMcpActor, type ActorContext } from '../security/permissions.js';

export type McpServerMode = AppConfig['mode'];

export const sharedToolNames = ['list_resources', 'get_resource', 'analyze_resource'] as const;

export const localToolNames = [
  'evaluate_policy',
  'propose_change',
  'request_approval',
  'execute_change',
  'get_audit_log',
] as const;

export type McpToolName = (typeof sharedToolNames)[number] | (typeof localToolNames)[number];

/** Each tool receives only its caller-owned connection and issued actor. */
export interface McpToolContext {
  readonly database: SqliteConnection;
  readonly actor: ActorContext;
}

export type McpToolRegistrar = (server: McpServer, context: McpToolContext) => void;

/** The caller loads configuration and owns the lifetime of the database connection. */
export interface McpServerDependencies {
  readonly config: AppConfig;
  readonly database: SqliteConnection;
  /** Trusted registrations; partial sets support isolated server construction. */
  readonly toolRegistrars?: Readonly<Partial<Record<McpToolName, McpToolRegistrar>>>;
}

/** Build one isolated SDK server; callers retain ownership of the connection. */
export function createMcpServer(
  dependencies: McpServerDependencies,
  mode: McpServerMode,
): McpServer {
  // A plain object claiming a mode must not select a more privileged tool set.
  if (modeOfLoadedConfig(dependencies.config) !== mode) throw new ForbiddenError();
  // The supplied connection must be the selected file and have the selected access mode.
  if (
    !dependencies.database.open ||
    dependencies.database.memory ||
    dependencies.database.name !== dependencies.config.database.path ||
    dependencies.database.readonly !== dependencies.config.database.readOnly
  ) {
    throw new ForbiddenError();
  }

  const server = new McpServer(
    { name: 'secureops-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const context: McpToolContext = Object.freeze({
    database: dependencies.database,
    actor: createMcpActor(dependencies.config),
  });
  for (const name of sharedToolNames) dependencies.toolRegistrars?.[name]?.(server, context);
  if (mode === 'local-full') {
    for (const name of localToolNames) dependencies.toolRegistrars?.[name]?.(server, context);
  }
  return server;
}
