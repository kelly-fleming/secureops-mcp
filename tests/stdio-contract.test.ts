import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withTestDatabase } from './helpers/test-db.js';

const timeoutMs = 10_000;

async function withinTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${operation}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('local stdio entry point', () => {
  it('handshakes over protocol-only stdout using a private database', async () => {
    await withTestDatabase(async (database) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL('../src/mcp/stdio.ts', import.meta.url))],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env: {
            ...process.env,
            SECUREOPS_MODE: 'local-full',
            SECUREOPS_DB_PATH: database.name,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );

      const frames: unknown[] = [];
      const invalidLines: string[] = [];
      const replies = new Map<number, unknown>();
      const waiting = new Map<number, (frame: unknown) => void>();
      let stdoutBuffer = '';
      let spawnError: Error | undefined;
      child.on('error', (error) => {
        spawnError = error;
      });
      child.stdin.on('error', (error) => {
        spawnError = error;
      });
      // 'close' waits for both output streams, so the final cleanliness check sees every byte.
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      );

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          try {
            const frame: unknown = JSON.parse(line);
            frames.push(frame);
            if (
              typeof frame === 'object' &&
              frame !== null &&
              'id' in frame &&
              typeof frame.id === 'number'
            ) {
              const resolve = waiting.get(frame.id);
              if (resolve === undefined) replies.set(frame.id, frame);
              else {
                waiting.delete(frame.id);
                resolve(frame);
              }
            }
          } catch {
            invalidLines.push(line);
          }
          newline = stdoutBuffer.indexOf('\n');
        }
      });
      // stderr is separate from protocol stdout and is drained even on a failing child.
      child.stderr.resume();

      const response = (id: number): Promise<unknown> => {
        const existing = replies.get(id);
        if (existing !== undefined) return Promise.resolve(existing);
        return new Promise((resolve) => waiting.set(id, resolve));
      };
      const request = (value: object): void => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
      };

      try {
        request({
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'stdio-contract-client', version: '0.1.0' },
          },
        });
        const initialized = await withinTimeout(
          Promise.race([
            response(1),
            closed.then(() => {
              throw new Error('Stdio server closed before initialize.');
            }),
          ]),
          'initialize response',
        );
        expect(initialized).toMatchObject({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'secureops-mcp' }, capabilities: { tools: {} } },
        });

        request({ method: 'notifications/initialized' });
        request({ id: 2, method: 'tools/list', params: {} });
        const listed = await withinTimeout(
          Promise.race([
            response(2),
            closed.then(() => {
              throw new Error('Stdio server closed before tools/list.');
            }),
          ]),
          'tools/list response',
        );
        expect(listed).toMatchObject({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: expect.any(Array) },
        });
        const tools = (listed as { result: { tools: Array<{ name: unknown }> } }).result.tools;
        expect(tools.every((tool) => typeof tool.name === 'string')).toBe(true);
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toEqual([
          'list_resources',
          'get_resource',
          'analyze_resource',
          'evaluate_policy',
          'propose_change',
          'request_approval',
          'execute_change',
          'get_audit_log',
        ]);
        expect(toolNames).not.toContain('decide_proposal');
        expect(toolNames).not.toContain('approve_proposal');
        expect(toolNames).not.toContain('reject_proposal');

        child.stdin.end();
        const exit = await withinTimeout(closed, 'stdio shutdown');
        expect(spawnError).toBeUndefined();
        expect(exit).toEqual({ code: 0, signal: null });
        expect(stdoutBuffer).toBe('');
        expect(invalidLines).toEqual([]);
        expect(frames.length).toBeGreaterThanOrEqual(2);
        for (const frame of frames) {
          expect(frame).toMatchObject({ jsonrpc: '2.0' });
          expect(
            typeof frame === 'object' &&
              frame !== null &&
              (('method' in frame && typeof frame.method === 'string') ||
                ('id' in frame &&
                  (typeof frame.id === 'number' || typeof frame.id === 'string') &&
                  ('result' in frame || 'error' in frame))),
          ).toBe(true);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await withinTimeout(closed, 'child cleanup');
      }
    });
  }, 30_000);
});
