export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(prefix: string): string;
}

const defaultTimestamp = '2026-01-01T00:00:00.000Z';
const idPrefixPattern = /^[a-z][a-z0-9-]{0,56}$/;
const lastSequence = 999_999;

/** Returns a fresh Date each time so callers cannot mutate the fixed instant. */
export function createFixedClock(timestamp: string = defaultTimestamp): Clock {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== timestamp) {
    throw new RangeError('Fixed clock requires a canonical UTC ISO timestamp.');
  }
  const epochMilliseconds = instant.getTime();
  return { now: () => new Date(epochMilliseconds) };
}

/** Each generator owns its sequence; make a new one for each test or service instance. */
export function createSequentialIdGenerator(startAt = 1): IdGenerator {
  if (!Number.isSafeInteger(startAt) || startAt < 1 || startAt > lastSequence) {
    throw new RangeError('ID sequence start is out of range.');
  }
  let nextSequence = startAt;
  return {
    nextId(prefix: string): string {
      if (!idPrefixPattern.test(prefix)) {
        throw new RangeError('ID prefix is invalid.');
      }
      if (nextSequence > lastSequence) {
        throw new RangeError('ID sequence is exhausted.');
      }
      const id = `${prefix}-${String(nextSequence).padStart(6, '0')}`;
      nextSequence += 1;
      return id;
    },
  };
}
