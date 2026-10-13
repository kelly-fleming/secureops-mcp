import { ForbiddenError } from '../domain/errors.js';
import type { SqliteConnection } from '../infra/sqlite/connection.js';
import type { ActorContext } from '../security/permissions.js';

interface LocalIdentityState {
  readonly role: string;
  readonly disabled: number;
}

/** Call inside a read transaction after the service has checked its capability. */
export function requireEnabledAuditIdentity(database: SqliteConnection, actor: ActorContext): void {
  if (actor.role !== 'reviewer' && actor.role !== 'auditor') throw new ForbiddenError();
  const identity = database
    .prepare('SELECT role, disabled FROM local_identities WHERE id = ?')
    .get(actor.actorId) as LocalIdentityState | undefined;
  if (identity?.role !== actor.role || identity.disabled !== 0) throw new ForbiddenError();
}
