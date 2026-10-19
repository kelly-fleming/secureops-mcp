import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { ConfigError, loadConfig } from '../config.js';
import { publicErrorFor } from '../domain/errors.js';
import {
  createDiagnosticLogger,
  startDiagnosticScope,
  type DiagnosticLogger,
} from '../infra/logging/logger.js';
import { openConfiguredDatabase } from '../infra/sqlite/connection.js';
import { applyMigrations, discoverMigrations } from '../infra/sqlite/migrate.js';
import { createMcpServer, type McpServerDependencies } from './server.js';
import { registerAnalyzeResourceTool } from './tools/analyze-resource.js';
import { registerEvaluatePolicyTool } from './tools/evaluate-policy.js';
import { registerExecuteChangeTool } from './tools/execute-change.js';
import { registerGetAuditLogTool } from './tools/get-audit-log.js';
import { registerGetResourceTool } from './tools/get-resource.js';
import { registerListResourcesTool } from './tools/list-resources.js';
import { registerProposeChangeTool } from './tools/propose-change.js';
import { registerRequestApprovalTool } from './tools/request-approval.js';

export interface LocalStdioOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly toolRegistrars?: McpServerDependencies['toolRegistrars'];
  readonly logger?: DiagnosticLogger;
}

/** Validate once, then construct an independently owned server and database per SDK invocation. */
export function createLocalStdioServerFactory(options: LocalStdioOptions = {}): () => McpServer {
  const config = loadConfig(
    options.environment ?? process.env,
    options.workingDirectory ?? process.cwd(),
  );
  if (config.mode !== 'local-full') throw new ConfigError('Local stdio requires local-full mode.');
  const logger =
    options.logger ??
    createDiagnosticLogger({
      level: config.logLevel,
      sink: {
        write: (line) => {
          process.stderr.write(line);
        },
      },
      clock: { now: () => new Date() },
      ids: { nextId: randomUUID },
    });
  const migrations = discoverMigrations();
  const toolRegistrars: NonNullable<McpServerDependencies['toolRegistrars']> = {
    ...options.toolRegistrars,
    list_resources: options.toolRegistrars?.list_resources ?? registerListResourcesTool,
    get_resource: options.toolRegistrars?.get_resource ?? registerGetResourceTool,
    analyze_resource: options.toolRegistrars?.analyze_resource ?? registerAnalyzeResourceTool,
    evaluate_policy: options.toolRegistrars?.evaluate_policy ?? registerEvaluatePolicyTool,
    propose_change: options.toolRegistrars?.propose_change ?? registerProposeChangeTool,
    request_approval: options.toolRegistrars?.request_approval ?? registerRequestApprovalTool,
    execute_change: options.toolRegistrars?.execute_change ?? registerExecuteChangeTool,
    get_audit_log: options.toolRegistrars?.get_audit_log ?? registerGetAuditLogTool,
  };

  return () => {
    const scope = startDiagnosticScope(logger, 'stdio');
    scope.record('info', 'started');
    let database: ReturnType<typeof openConfiguredDatabase> | undefined;
    try {
      database = openConfiguredDatabase(config);
      applyMigrations(database, migrations);
      const server = createMcpServer({ config, database, logger, toolRegistrars }, 'local-full');
      // serveStdio may discard a discovery probe before pinning a second instance.
      server.server.onclose = () => {
        try {
          if (database?.open) database.close();
        } finally {
          scope.record('info', 'stopped');
        }
      };
      scope.record('info', 'succeeded');
      return server;
    } catch (error) {
      if (database?.open) database.close();
      scope.record('error', 'failed', { errorCode: publicErrorFor(error).code });
      throw error;
    }
  };
}

/** Own the stdio transport while each SDK-created server owns its SQLite connection. */
export function startLocalStdio(options: LocalStdioOptions = {}): StdioServerHandle {
  const buildServer = createLocalStdioServerFactory(options);
  return serveStdio(() => {
    try {
      return buildServer();
    } catch {
      // SDK factory failures may happen after this function returns.
      process.stderr.write('SecureOps MCP initialization failed.\n');
      throw new Error('SecureOps MCP initialization failed.');
    }
  });
}

function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(path.resolve(entryPoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const handle = startLocalStdio();
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void handle.close().catch(() => {
        process.stderr.write('SecureOps MCP shutdown failed.\n');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch {
    process.stderr.write('SecureOps MCP startup failed.\n');
    process.exitCode = 1;
  }
}
