import { Worker } from 'node:worker_threads';

import type { SqliteConnection } from '../../src/infra/sqlite/connection.js';
import type { ExecuteChangeInput, ProposeChangeInput } from '../../src/mcp/schemas.js';
import { requirePrivateTestDatabasePath } from './contention-path.js';
import {
  isContentionReply,
  type ContentionCommand,
  type ContentionReply,
  type ReviewWork,
} from './contention-protocol.js';

const replyTimeoutMs = 12_000;
const terminationTimeoutMs = 5_000;

type ReplyKind = ContentionReply['kind'];
export type WorkOutcome =
  | Readonly<{ status: 'completed'; result: unknown }>
  | Readonly<{ status: 'refused'; errorCode: string }>;

function privateDatabasePath(database: SqliteConnection): string {
  if (!database.open || database.readonly) throw new Error('A writable test database is required.');
  return requirePrivateTestDatabasePath(database.name);
}

async function terminateWithinBound(worker: Worker): Promise<void> {
  if (worker.threadId === -1) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      worker.terminate().then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Contention worker did not terminate.')),
          terminationTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A separate thread with its own configured SQLite connection and bounded lifecycle. */
export class ContentionWorker {
  private nextRequestId = 1;
  private closed = false;

  private constructor(private readonly worker: Worker) {}

  static async start(database: SqliteConnection): Promise<ContentionWorker> {
    const databasePath = privateDatabasePath(database);
    const worker = new Worker(new URL('./contention-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: { databasePath },
    });
    const controller = new ContentionWorker(worker);
    try {
      const ready = await controller.waitFor(0, ['ready', 'failed']);
      if (ready.kind !== 'ready') throw new Error('Contention worker could not open its database.');
      return controller;
    } catch {
      await terminateWithinBound(worker);
      throw new Error('Contention worker did not start.');
    }
  }

  private waitFor(requestId: number, kinds: readonly ReplyKind[]): Promise<ContentionReply> {
    return new Promise((resolve, reject) => {
      const onMessage = (value: unknown): void => {
        if (!isContentionReply(value) || value.requestId !== requestId) return;
        if (!kinds.includes(value.kind)) return;
        cleanup();
        resolve(value);
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('Contention worker failed.'));
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error('Contention worker exited before replying.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Contention worker reply timed out.'));
      }, replyTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        this.worker.off('error', onError);
        this.worker.off('exit', onExit);
      };
      this.worker.on('message', onMessage);
      this.worker.on('error', onError);
      this.worker.on('exit', onExit);
    });
  }

  private post(
    kind: ContentionCommand['kind'],
    input?: ContentionCommand['input'],
    sequence?: number,
  ): number {
    if (this.closed) throw new Error('Contention worker is closed.');
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.worker.postMessage({
      requestId,
      kind,
      ...(input === undefined ? {} : { input }),
      ...(sequence === undefined ? {} : { sequence }),
    } satisfies ContentionCommand);
    return requestId;
  }

  async holdLock(): Promise<void> {
    const requestId = this.nextRequestId;
    const reply = this.waitFor(requestId, ['lock-held', 'busy', 'failed']);
    this.post('hold-lock');
    if ((await reply).kind !== 'lock-held') {
      throw new Error('Contention worker could not hold lock.');
    }
  }

  async releaseLock(): Promise<void> {
    const requestId = this.nextRequestId;
    const reply = this.waitFor(requestId, ['lock-released', 'failed']);
    this.post('release-lock');
    if ((await reply).kind !== 'lock-released') {
      throw new Error('Contention worker could not release lock.');
    }
  }

  async advanceResource(resourceId: string): Promise<void> {
    const requestId = this.nextRequestId;
    const reply = this.waitFor(requestId, ['resource-advanced', 'failed']);
    this.post('advance-resource', resourceId);
    if ((await reply).kind !== 'resource-advanced') {
      throw new Error('Contention worker could not advance resource.');
    }
  }

  async commitLock(): Promise<void> {
    const requestId = this.nextRequestId;
    const reply = this.waitFor(requestId, ['lock-released', 'failed']);
    this.post('commit-lock');
    if ((await reply).kind !== 'lock-released') {
      throw new Error('Contention worker could not commit lock.');
    }
  }

  run(
    kind: 'propose' | 'review' | 'execute',
    input: ProposeChangeInput | ReviewWork | ExecuteChangeInput,
    sequence: number,
  ): { started: Promise<void>; result: Promise<WorkOutcome> } {
    const requestId = this.nextRequestId;
    const startedReply = this.waitFor(requestId, [
      'operation-started',
      'operation-refused',
      'failed',
    ]);
    const finalReply = this.waitFor(requestId, [
      'operation-completed',
      'operation-refused',
      'failed',
    ]);
    this.post(kind, input, sequence);
    const started = startedReply.then((reply) => {
      if (reply.kind !== 'operation-started')
        throw new Error('Contention operation did not start.');
    });
    const result = finalReply.then((reply): WorkOutcome => {
      if (reply.kind === 'operation-completed') {
        return { status: 'completed', result: reply.result };
      }
      if (reply.kind === 'operation-refused' && typeof reply.errorCode === 'string') {
        return { status: 'refused', errorCode: reply.errorCode };
      }
      throw new Error('Contention operation failed.');
    });
    void started.catch(() => undefined);
    void result.catch(() => undefined);
    return { started, result };
  }

  /** The result is awaited separately so another worker can release a held lock. */
  attemptLock(): { started: Promise<void>; result: Promise<'acquired' | 'busy'> } {
    const requestId = this.nextRequestId;
    const startedReply = this.waitFor(requestId, ['attempt-started', 'failed']);
    const resultReply = this.waitFor(requestId, ['acquired', 'busy', 'failed']);
    this.post('attempt-lock');
    const started = startedReply.then((reply) => {
      if (reply.kind !== 'attempt-started') {
        throw new Error('Contention worker did not attempt lock.');
      }
    });
    const result = resultReply.then((reply): 'acquired' | 'busy' => {
      if (reply.kind === 'acquired' || reply.kind === 'busy') return reply.kind;
      throw new Error('Contention worker lock attempt failed.');
    });
    // Both promises are returned to callers; attach handlers so cleanup after a test failure
    // cannot produce an unrelated unhandled rejection before the caller awaits them.
    void started.catch(() => undefined);
    void result.catch(() => undefined);
    return { started, result };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.worker.threadId !== -1) {
        const requestId = this.nextRequestId;
        const reply = this.waitFor(requestId, ['closed', 'failed']);
        this.post('close');
        if ((await reply).kind !== 'closed') {
          throw new Error('Contention worker could not close its connection.');
        }
      }
    } finally {
      this.closed = true;
      await terminateWithinBound(this.worker);
    }
  }
}

/** All workers close or terminate before withTestDatabase removes its private file. */
export async function withContentionWorkers<T>(
  database: SqliteConnection,
  count: number,
  run: (workers: readonly ContentionWorker[]) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new RangeError('Contention worker count must be between one and four.');
  }
  const workers: ContentionWorker[] = [];
  let result: T;
  let cleanupFailed: boolean;
  try {
    for (let index = 0; index < count; index += 1) {
      workers.push(await ContentionWorker.start(database));
    }
    result = await run(Object.freeze([...workers]));
  } finally {
    const closures = await Promise.allSettled(workers.map((worker) => worker.close()));
    cleanupFailed = closures.some((closure) => closure.status === 'rejected');
  }
  if (cleanupFailed) throw new Error('A contention worker could not be stopped.');
  return result;
}
