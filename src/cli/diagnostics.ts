import { randomUUID } from 'node:crypto';

import { diagnosticLogLevel } from '../config.js';
import { publicErrorFor } from '../domain/errors.js';
import {
  createDiagnosticLogger,
  startDiagnosticScope,
  type DiagnosticFields,
  type DiagnosticLogger,
  type DiagnosticOperation,
} from '../infra/logging/logger.js';

/** The command caller owns stderr; only the validated level crosses into the logger. */
export function createCliDiagnosticLogger(
  environment: NodeJS.ProcessEnv,
  sink: { write(line: string): void | Promise<void> } = {
    write: (line) => {
      process.stderr.write(line);
    },
  },
): DiagnosticLogger | undefined {
  const level = diagnosticLogLevel(environment);
  if (level === null) return undefined;
  return createDiagnosticLogger({
    level,
    sink,
    clock: { now: () => new Date() },
    ids: { nextId: randomUUID },
  });
}

/** One scope spans the command, including any masked authentication prompt. */
export async function withCliDiagnostics<T>(
  logger: DiagnosticLogger | undefined,
  operation: DiagnosticOperation,
  run: () => T | Promise<T>,
  ids: Pick<DiagnosticFields, 'proposalId' | 'resourceId'> = {},
): Promise<T> {
  const scope = startDiagnosticScope(logger, operation);
  scope.record('info', 'started', ids);
  try {
    const result = await run();
    scope.record('info', 'succeeded', ids);
    return result;
  } catch (error) {
    scope.record('error', 'failed', { ...ids, errorCode: publicErrorFor(error).code });
    throw error;
  }
}
