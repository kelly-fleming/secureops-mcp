import { modeOfLoadedConfig, type AppConfig } from '../config.js';
import { ForbiddenError } from '../domain/errors.js';

export const actorRoles = ['agent', 'reviewer', 'auditor', 'viewer'] as const;
export type ActorRole = (typeof actorRoles)[number];

export const capabilities = [
  'list_resources',
  'get_resource',
  'analyze_resource',
  'evaluate_policy',
  'propose_change',
  'request_approval',
  'execute_change',
  'get_audit_log',
  'review_proposals',
  'decide_proposal',
  'inspect_audit',
  'verify_audit',
] as const;
export type Capability = (typeof capabilities)[number];

// Only authenticated local reviewer/auditor actors may inspect the full audit
// record; the caller-facing CLI must authenticate before invoking these services.
// Execution remains subject to a separately authenticated approval and fresh
// policy/resource checks; this matrix grants no approval by itself.
const roleCapabilities = {
  agent: [
    'list_resources',
    'get_resource',
    'analyze_resource',
    'evaluate_policy',
    'propose_change',
    'request_approval',
    'execute_change',
    'get_audit_log',
  ],
  reviewer: [
    'get_resource',
    'evaluate_policy',
    'review_proposals',
    'decide_proposal',
    'inspect_audit',
    'verify_audit',
  ],
  auditor: ['inspect_audit', 'verify_audit'],
  viewer: ['list_resources', 'get_resource', 'analyze_resource'],
} as const satisfies Record<ActorRole, readonly Capability[]>;

/** Matrix lookup only. Service authorization must use requireCapability. */
export function hasCapability(role: unknown, capability: unknown): boolean {
  if (
    typeof role !== 'string' ||
    typeof capability !== 'string' ||
    !Object.hasOwn(roleCapabilities, role)
  ) {
    return false;
  }

  return (roleCapabilities[role as ActorRole] as readonly string[]).includes(capability);
}

export type ActorContext = Readonly<
  | { role: 'agent'; actorId: 'local-agent'; source: 'local-mcp' }
  | { role: 'viewer'; actorId: 'http-viewer'; source: 'http-mcp' }
  | { role: 'reviewer' | 'auditor'; actorId: string; source: 'authenticated-cli' }
>;

// The reviewer-auth module must add this symbol only after checking a
// passphrase, disabled status, and stored role. JSON tool arguments cannot
// carry symbol keys. This marker does not authenticate arbitrary in-process
// code that can import it; the separate CLI verifier remains authoritative.
export const authenticatedCliIdentityBrand: unique symbol = Symbol('authenticatedCliIdentity');
export interface AuthenticatedCliIdentity {
  readonly id: string;
  readonly role: 'reviewer' | 'auditor';
  readonly [authenticatedCliIdentityBrand]: true;
}

const issuedActors = new WeakSet<object>();

function issueActor(context: ActorContext): ActorContext {
  const actor = Object.freeze(context);
  issuedActors.add(actor);
  return actor;
}

/** Reject any configuration object that was not issued by loadConfig. */
export function createMcpActor(config: AppConfig): ActorContext {
  const mode = modeOfLoadedConfig(config);
  if (mode === 'local-full') {
    return issueActor({ role: 'agent', actorId: 'local-agent', source: 'local-mcp' });
  }
  if (mode === 'http-demo') {
    return issueActor({ role: 'viewer', actorId: 'http-viewer', source: 'http-mcp' });
  }
  throw new ForbiddenError();
}

/** Accept only an identity returned by the separate CLI authentication flow. */
export function createAuthenticatedCliActor(identity: AuthenticatedCliIdentity): ActorContext {
  if (
    typeof identity !== 'object' ||
    identity === null ||
    identity[authenticatedCliIdentityBrand] !== true ||
    (identity.role !== 'reviewer' && identity.role !== 'auditor') ||
    !/^[a-z][a-z0-9_-]{2,63}$/.test(identity.id)
  ) {
    throw new ForbiddenError();
  }
  return issueActor({ role: identity.role, actorId: identity.id, source: 'authenticated-cli' });
}

/** Reject unissued actors before checking their allowed operation. */
export function requireCapability(actor: ActorContext, capability: Capability): void {
  if (!issuedActors.has(actor) || !hasCapability(actor.role, capability)) {
    throw new ForbiddenError();
  }
}
