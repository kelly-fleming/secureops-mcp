import { describe, expect, it } from 'vitest';

import type { LogLevel } from '../src/config.js';
import {
  createDiagnosticLogger,
  startDiagnosticScope,
  type DiagnosticLogger,
  type DiagnosticSink,
} from '../src/infra/logging/logger.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';

function makeLogger(level: LogLevel, startAt = 1) {
  const lines: string[] = [];
  const sequence = createSequentialIdGenerator(startAt);
  const logger = createDiagnosticLogger({
    level,
    sink: {
      write: (line) => {
        lines.push(line);
      },
    },
    clock: createFixedClock(),
    ids: { nextId: () => sequence.nextId('correlation') },
  });
  return { logger, lines };
}

function parsedLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => {
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    return JSON.parse(line) as Record<string, unknown>;
  });
}

describe('allowlisted structured diagnostics', () => {
  it.each([
    { level: 'silent', severities: [] },
    { level: 'error', severities: ['error'] },
    { level: 'warn', severities: ['error', 'warn'] },
    { level: 'info', severities: ['error', 'warn', 'info'] },
    { level: 'debug', severities: ['error', 'warn', 'info', 'debug'] },
  ] as const)('filters records at $level', ({ level, severities }) => {
    const { logger, lines } = makeLogger(level);
    const scope = logger.start('propose_change');
    scope.record('error', 'failed', { errorCode: 'CONFLICT' });
    scope.record('warn', 'started');
    scope.record('info', 'succeeded');
    scope.record('debug', 'stopped');

    expect(parsedLines(lines).map((line) => line.severity)).toEqual(severities);
    if (level === 'silent') expect(scope.correlationId).toBeNull();
    else expect(scope.correlationId).toBe('correlation-000001');
  });

  it('reuses one generated correlation ID within a scope and isolates logger instances', () => {
    const first = makeLogger('info');
    const second = makeLogger('info', 11);
    const one = first.logger.start('request_approval');
    const next = first.logger.start('request_approval');
    const other = second.logger.start('audit:verify');

    one.record('info', 'started');
    one.record('info', 'succeeded');
    next.record('info', 'started');
    other.record('info', 'started');

    expect(parsedLines(first.lines).map((record) => record.correlationId)).toEqual([
      'correlation-000001',
      'correlation-000001',
      'correlation-000002',
    ]);
    expect(parsedLines(second.lines).map((record) => record.correlationId)).toEqual([
      'correlation-000011',
    ]);
  });

  it('emits fixed fields and only validated synthetic IDs and failure codes', () => {
    const { logger, lines } = makeLogger('error');
    const scope = logger.start('execute_change');
    scope.record('error', 'failed', {
      resourceId: 'res-aws-ec2-01',
      proposalId: 'proposal-000001',
      errorCode: 'PRECONDITION_FAILED',
    });

    expect(parsedLines(lines)).toEqual([
      {
        severity: 'error',
        timestamp: '2026-01-01T00:00:00.000Z',
        event: 'failed',
        operation: 'execute_change',
        correlationId: 'correlation-000001',
        resourceId: 'res-aws-ec2-01',
        proposalId: 'proposal-000001',
        errorCategory: 'precondition',
        errorCode: 'PRECONDITION_FAILED',
      },
    ]);
  });

  it('never serializes extra, cyclic, or malformed caller values', () => {
    const { logger, lines } = makeLogger('error');
    const hostile: Record<string, unknown> = { secret: 'fictional-private-token' };
    hostile.self = hostile;
    const fields = {
      resourceId: hostile,
      proposalId: 'proposal-invalid\nsecret',
      errorCode: hostile,
      reason: 'fictional untrusted review text',
      config: hostile,
      error: new Error('fictional SQL path and secret'),
    };
    logger.start('proposals:review').record('error', 'failed', fields);

    expect(parsedLines(lines)).toEqual([
      {
        severity: 'error',
        timestamp: '2026-01-01T00:00:00.000Z',
        event: 'failed',
        operation: 'proposals:review',
        correlationId: 'correlation-000001',
        errorCategory: 'internal',
        errorCode: 'INTERNAL_ERROR',
      },
    ]);
    expect(lines[0]).not.toContain('fictional-private-token');
    expect(lines[0]).not.toContain('fictional untrusted review text');
    expect(lines[0]).not.toContain('fictional SQL path and secret');
  });

  it('serializes the same optional value it validated when getters change their answer', () => {
    const { logger, lines } = makeLogger('error');
    const secret = 'fictional-private-token';
    let resourceReads = 0;
    let proposalReads = 0;
    let codeReads = 0;
    const fields = {
      get resourceId() {
        return ++resourceReads === 1 ? 'res-aws-ec2-01' : secret;
      },
      get proposalId() {
        return ++proposalReads === 1 ? 'proposal-000001' : secret;
      },
      get errorCode() {
        return ++codeReads === 1 ? 'CONFLICT' : secret;
      },
    };

    logger.start('execute_change').record('error', 'failed', fields);
    expect(parsedLines(lines)[0]).toMatchObject({
      resourceId: 'res-aws-ec2-01',
      proposalId: 'proposal-000001',
      errorCode: 'CONFLICT',
    });
    expect({ resourceReads, proposalReads, codeReads }).toEqual({
      resourceReads: 1,
      proposalReads: 1,
      codeReads: 1,
    });
    expect(lines[0]).not.toContain(secret);
  });

  it('ignores operation, event, and severity names outside the fixed allowlists', () => {
    const { logger, lines } = makeLogger('debug');
    const unknown = logger.start(
      'caller_supplied_operation' as Parameters<DiagnosticLogger['start']>[0],
    );
    unknown.record('error', 'failed');
    const scope = logger.start('stdio');
    scope.record('error', 'caller_event' as Parameters<typeof scope.record>[1]);
    scope.record('trace' as Parameters<typeof scope.record>[0], 'started');
    expect(unknown.correlationId).toBeNull();
    expect(lines).toEqual([]);
  });

  it('contains failures of the injected ID, clock, and synchronous sink', () => {
    const lines: string[] = [];
    const sink: DiagnosticSink = {
      write: (line) => {
        lines.push(line);
      },
    };
    const brokenIds = createDiagnosticLogger({
      level: 'info',
      sink,
      clock: createFixedClock(),
      ids: {
        nextId: () => {
          throw new Error('fictional ID failure');
        },
      },
    });
    expect(() => brokenIds.start('stdio').record('info', 'started')).not.toThrow();
    const invalidIds = createDiagnosticLogger({
      level: 'info',
      sink,
      clock: createFixedClock(),
      ids: { nextId: () => 'unsafe\nsecret' },
    });
    expect(invalidIds.start('stdio').correlationId).toBeNull();

    const brokenClock = createDiagnosticLogger({
      level: 'info',
      sink,
      clock: {
        now: () => {
          throw new Error('fictional clock failure');
        },
      },
      ids: { nextId: () => 'correlation-000003' },
    });
    expect(() => brokenClock.start('stdio').record('info', 'started')).not.toThrow();
    const brokenSink = createDiagnosticLogger({
      level: 'info',
      sink: {
        write: () => {
          throw new Error('fictional sink failure');
        },
      },
      clock: createFixedClock(),
      ids: { nextId: () => 'correlation-000004' },
    });
    expect(() => brokenSink.start('stdio').record('info', 'started')).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('contains a rejected asynchronous sink write', async () => {
    const logger = createDiagnosticLogger({
      level: 'error',
      sink: { write: () => Promise.reject(new Error('fictional async sink failure')) },
      clock: createFixedClock(),
      ids: { nextId: () => 'correlation-000001' },
    });
    expect(() => logger.start('stdio').record('error', 'failed')).not.toThrow();
    await Promise.resolve();
  });

  it('contains failures from an injected logger implementation', () => {
    const brokenStart: DiagnosticLogger = {
      start: () => {
        throw new Error('fictional logger start failure');
      },
    };
    const brokenRecord: DiagnosticLogger = {
      start: () => ({
        correlationId: 'correlation-000001',
        record: () => {
          throw new Error('fictional logger record failure');
        },
      }),
    };

    expect(() =>
      startDiagnosticScope(brokenStart, 'stdio').record('info', 'started'),
    ).not.toThrow();
    expect(() =>
      startDiagnosticScope(brokenRecord, 'stdio').record('info', 'started'),
    ).not.toThrow();
  });

  it('contains an asynchronous rejection from an injected logger implementation', async () => {
    const brokenRecord = {
      start: () => ({
        correlationId: 'correlation-000001',
        record: () => Promise.reject(new Error('fictional async logger failure')),
      }),
    } as DiagnosticLogger;

    expect(() =>
      startDiagnosticScope(brokenRecord, 'stdio').record('info', 'started'),
    ).not.toThrow();
    await Promise.resolve();
  });
});
