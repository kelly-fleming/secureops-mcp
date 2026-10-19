import type { LogLevel } from '../../config.js';
import type { OperationalErrorCategory, OperationalErrorCode } from '../../domain/errors.js';
import { resourceIdSchema } from '../../domain/resource.js';

export const diagnosticOperations = [
  'stdio',
  'list_resources',
  'get_resource',
  'analyze_resource',
  'evaluate_policy',
  'propose_change',
  'request_approval',
  'execute_change',
  'get_audit_log',
  'db:migrate',
  'db:seed',
  'db:reset',
  'reviewer:init',
  'proposals:list',
  'proposals:review',
  'audit:list',
  'audit:verify',
] as const;

export type DiagnosticOperation = (typeof diagnosticOperations)[number];
export type DiagnosticSeverity = 'error' | 'warn' | 'info' | 'debug';
export type DiagnosticEvent = 'started' | 'succeeded' | 'failed' | 'stopped';

export interface DiagnosticFields {
  readonly resourceId?: unknown;
  readonly proposalId?: unknown;
  readonly errorCode?: unknown;
}

export interface DiagnosticSink {
  write(line: string): void | Promise<void>;
}

export interface DiagnosticClock {
  now(): Date;
}

export interface DiagnosticIdSource {
  nextId(): string;
}

export interface DiagnosticLoggerOptions {
  readonly level: LogLevel;
  readonly sink: DiagnosticSink;
  readonly clock: DiagnosticClock;
  readonly ids: DiagnosticIdSource;
}

export interface DiagnosticScope {
  readonly correlationId: string | null;
  record(severity: DiagnosticSeverity, event: DiagnosticEvent, fields?: DiagnosticFields): void;
}

export interface DiagnosticLogger {
  start(operation: DiagnosticOperation): DiagnosticScope;
}

const severityRank: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
const events = new Set<DiagnosticEvent>(['started', 'succeeded', 'failed', 'stopped']);
const operations = new Set<string>(diagnosticOperations);
const errorCategories: Readonly<Record<OperationalErrorCode, OperationalErrorCategory>> = {
  VALIDATION_ERROR: 'validation',
  NOT_FOUND: 'notFound',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  PRECONDITION_FAILED: 'precondition',
  INTERNAL_ERROR: 'internal',
};
const correlationIdPattern = /^[a-z0-9][a-z0-9-]{7,63}$/;
// Match the strict proposal ID contract without importing the MCP boundary into infrastructure.
const proposalIdPattern = /^proposal-[a-z0-9-]{1,55}$/;

const disabledScope: DiagnosticScope = Object.freeze({
  correlationId: null,
  record: () => undefined,
});

/** Keep even a faulty injected logger from changing the caller's result. */
export function startDiagnosticScope(
  logger: DiagnosticLogger | undefined,
  operation: DiagnosticOperation,
): DiagnosticScope {
  try {
    const scope = logger?.start(operation);
    if (scope === undefined) return disabledScope;
    return {
      correlationId: scope.correlationId,
      record(severity, event, fields): void {
        try {
          const pendingRecord = scope.record(severity, event, fields) as unknown;
          if (pendingRecord !== undefined) {
            void Promise.resolve(pendingRecord).catch(() => undefined);
          }
        } catch {
          // Diagnostics are best effort, including injected implementations.
        }
      },
    };
  } catch {
    return disabledScope;
  }
}

function enabled(level: LogLevel, severity: DiagnosticSeverity): boolean {
  return level !== 'silent' && severityRank[severity] <= severityRank[level];
}

/** Serialize only fields this module constructs; never serialize fields or an Error directly. */
export function createDiagnosticLogger(options: DiagnosticLoggerOptions): DiagnosticLogger {
  return {
    start(operation): DiagnosticScope {
      try {
        if (options.level === 'silent' || !operations.has(operation)) return disabledScope;
        const correlationId = options.ids.nextId();
        if (typeof correlationId !== 'string' || !correlationIdPattern.test(correlationId)) {
          return disabledScope;
        }
        return Object.freeze({
          correlationId,
          record(
            severity: DiagnosticSeverity,
            event: DiagnosticEvent,
            fields: DiagnosticFields = {},
          ): void {
            try {
              if (
                !Object.hasOwn(severityRank, severity) ||
                !enabled(options.level, severity) ||
                !events.has(event)
              ) {
                return;
              }
              const now = options.clock.now();
              if (!(now instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(now))) {
                return;
              }

              const record = Object.create(null) as Record<string, string>;
              record.severity = severity;
              record.timestamp = Date.prototype.toISOString.call(now);
              record.event = event;
              record.operation = operation;
              record.correlationId = correlationId;
              const resourceId = fields.resourceId;
              if (
                typeof resourceId === 'string' &&
                resourceIdSchema.safeParse(resourceId).success
              ) {
                record.resourceId = resourceId;
              }
              const proposalId = fields.proposalId;
              if (typeof proposalId === 'string' && proposalIdPattern.test(proposalId)) {
                record.proposalId = proposalId;
              }
              if (event === 'failed') {
                const requestedErrorCode = fields.errorCode;
                const errorCode: OperationalErrorCode =
                  typeof requestedErrorCode === 'string' &&
                  Object.hasOwn(errorCategories, requestedErrorCode)
                    ? (requestedErrorCode as OperationalErrorCode)
                    : 'INTERNAL_ERROR';
                record.errorCategory = errorCategories[errorCode];
                record.errorCode = errorCode;
              }
              const pendingWrite = options.sink.write(`${JSON.stringify(record)}\n`);
              if (pendingWrite !== undefined) {
                void Promise.resolve(pendingWrite).catch(() => undefined);
              }
            } catch {
              // Diagnostics must never change an operation or expose sink failures.
            }
          },
        });
      } catch {
        return disabledScope;
      }
    },
  };
}
