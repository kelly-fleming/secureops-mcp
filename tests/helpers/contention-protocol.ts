import type { ProposeChangeInput, ExecuteChangeInput } from '../../src/mcp/schemas.js';

export type ContentionCommand = Readonly<{
  requestId: number;
  kind:
    | 'hold-lock'
    | 'release-lock'
    | 'commit-lock'
    | 'advance-resource'
    | 'attempt-lock'
    | 'propose'
    | 'review'
    | 'execute'
    | 'close';
  input?: ProposeChangeInput | ExecuteChangeInput | ReviewWork | string;
  sequence?: number;
}>;

export type ReviewWork = Readonly<{
  username: string;
  passphrase: string;
  proposalId: string;
  decision: 'approved' | 'rejected';
  reason: string;
  denyCurrentPolicy?: boolean;
}>;

export type ContentionReply = Readonly<{
  requestId: number;
  kind:
    | 'ready'
    | 'lock-held'
    | 'lock-released'
    | 'resource-advanced'
    | 'attempt-started'
    | 'operation-started'
    | 'operation-completed'
    | 'operation-refused'
    | 'acquired'
    | 'busy'
    | 'closed'
    | 'failed';
  result?: unknown;
  errorCode?: string;
}>;

export function isContentionCommand(value: unknown): value is ContentionCommand {
  if (typeof value !== 'object' || value === null) return false;
  const command = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(command.requestId) &&
    (command.requestId as number) > 0 &&
    (command.kind === 'hold-lock' ||
      command.kind === 'release-lock' ||
      command.kind === 'commit-lock' ||
      command.kind === 'advance-resource' ||
      command.kind === 'attempt-lock' ||
      command.kind === 'propose' ||
      command.kind === 'review' ||
      command.kind === 'execute' ||
      command.kind === 'close')
  );
}

export function isContentionReply(value: unknown): value is ContentionReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(reply.requestId) &&
    (reply.requestId as number) >= 0 &&
    (reply.kind === 'ready' ||
      reply.kind === 'lock-held' ||
      reply.kind === 'lock-released' ||
      reply.kind === 'resource-advanced' ||
      reply.kind === 'attempt-started' ||
      reply.kind === 'operation-started' ||
      reply.kind === 'operation-completed' ||
      reply.kind === 'operation-refused' ||
      reply.kind === 'acquired' ||
      reply.kind === 'busy' ||
      reply.kind === 'closed' ||
      reply.kind === 'failed')
  );
}
