import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../src/config.js';
import { ForbiddenError } from '../src/domain/errors.js';
import {
  actorRoles,
  authenticatedCliIdentityBrand,
  capabilities,
  createAuthenticatedCliActor,
  createMcpActor,
  hasCapability,
  requireCapability,
  type ActorContext,
  type ActorRole,
  type AuthenticatedCliIdentity,
  type Capability,
} from '../src/security/permissions.js';

const granted: Record<ActorRole, readonly Capability[]> = {
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
};

const workingDirectory = process.cwd();

function httpConfig(): AppConfig {
  return loadConfig(
    {
      SECUREOPS_MODE: 'http-demo',
      SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      SECUREOPS_HTTP_AUTH_TOKEN: 'a'.repeat(32),
    },
    workingDirectory,
  );
}

function authenticatedIdentity(role: 'reviewer' | 'auditor'): AuthenticatedCliIdentity {
  // Simulate the value that the separate CLI verifier must produce.
  return { id: `${role}-001`, role, [authenticatedCliIdentityBrand]: true };
}

describe('permission matrix', () => {
  it('makes every role/capability decision explicit and denies all other combinations', () => {
    for (const role of actorRoles) {
      for (const capability of capabilities) {
        expect(hasCapability(role, capability), `${role}: ${capability}`).toBe(
          granted[role].includes(capability),
        );
      }
    }
  });

  it('denies unknown runtime roles and capabilities', () => {
    expect(hasCapability('administrator', 'execute_change')).toBe(false);
    expect(hasCapability('agent', 'approve_change')).toBe(false);
    expect(hasCapability('__proto__', 'execute_change')).toBe(false);
    expect(hasCapability(null, 'list_resources')).toBe(false);
  });

  it('keeps model and HTTP capabilities separate from human review', () => {
    for (const role of ['agent', 'viewer'] as const) {
      expect(hasCapability(role, 'decide_proposal')).toBe(false);
      expect(hasCapability(role, 'review_proposals')).toBe(false);
    }
    expect(hasCapability('viewer', 'execute_change')).toBe(false);
    expect(hasCapability('viewer', 'evaluate_policy')).toBe(false);
    expect(hasCapability('auditor', 'decide_proposal')).toBe(false);
  });
});

describe('trusted actor contexts', () => {
  it('enforces every allowed and denied role/capability pair at the service guard', () => {
    const actors: Record<ActorRole, ActorContext> = {
      agent: createMcpActor(loadConfig({}, workingDirectory)),
      reviewer: createAuthenticatedCliActor(authenticatedIdentity('reviewer')),
      auditor: createAuthenticatedCliActor(authenticatedIdentity('auditor')),
      viewer: createMcpActor(httpConfig()),
    };
    for (const role of actorRoles) {
      for (const capability of capabilities) {
        if (granted[role].includes(capability)) {
          expect(() => requireCapability(actors[role], capability)).not.toThrow();
        } else {
          expect(() => requireCapability(actors[role], capability)).toThrow(ForbiddenError);
        }
      }
    }
  });

  it('creates a local agent only from a loaded local configuration', () => {
    const actor = createMcpActor(loadConfig({}, workingDirectory));
    expect(actor).toEqual({ role: 'agent', actorId: 'local-agent', source: 'local-mcp' });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(() => requireCapability(actor, 'propose_change')).not.toThrow();
    expect(() => requireCapability(actor, 'decide_proposal')).toThrow(ForbiddenError);
  });

  it('creates a read-only viewer from a loaded HTTP configuration', () => {
    const actor = createMcpActor(httpConfig());
    expect(actor).toEqual({ role: 'viewer', actorId: 'http-viewer', source: 'http-mcp' });
    for (const capability of capabilities) {
      if (granted.viewer.includes(capability)) {
        expect(() => requireCapability(actor, capability)).not.toThrow();
      } else {
        expect(() => requireCapability(actor, capability)).toThrow(ForbiddenError);
      }
    }
  });

  it('rejects a forged configuration and preserves the validated mode', () => {
    const fake = { mode: 'local-full' } as AppConfig;
    expect(() => createMcpActor(fake)).toThrow(ForbiddenError);
    const config = httpConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Reflect.set(config, 'mode', 'local-full')).toBe(false);
    expect(createMcpActor(config).role).toBe('viewer');
  });

  it('accepts only marked CLI identities and rejects model-supplied role claims', () => {
    const reviewer = createAuthenticatedCliActor(authenticatedIdentity('reviewer'));
    const auditor = createAuthenticatedCliActor(authenticatedIdentity('auditor'));
    expect(() => requireCapability(reviewer, 'decide_proposal')).not.toThrow();
    expect(() => requireCapability(reviewer, 'execute_change')).toThrow(ForbiddenError);
    expect(() => requireCapability(auditor, 'inspect_audit')).not.toThrow();
    expect(() => requireCapability(auditor, 'decide_proposal')).toThrow(ForbiddenError);
    expect(() =>
      createAuthenticatedCliActor({
        id: 'reviewer-001',
        role: 'reviewer',
      } as AuthenticatedCliIdentity),
    ).toThrow(ForbiddenError);
    expect(() =>
      createAuthenticatedCliActor({ ...authenticatedIdentity('reviewer'), id: '../unsafe' }),
    ).toThrow(ForbiddenError);
  });

  it('rejects forged actor objects even when their fields match a granted role', () => {
    const fake = { role: 'agent', actorId: 'local-agent', source: 'local-mcp' } as ActorContext;
    expect(() => requireCapability(fake, 'execute_change')).toThrow(ForbiddenError);
    expect(() =>
      requireCapability(JSON.parse(JSON.stringify(fake)) as ActorContext, 'list_resources'),
    ).toThrow(ForbiddenError);
  });

  it('does not treat execution capability as a human approval', () => {
    const agent = createMcpActor(loadConfig({}, workingDirectory));
    expect(() => requireCapability(agent, 'execute_change')).not.toThrow();
    expect(() => requireCapability(agent, 'decide_proposal')).toThrow(ForbiddenError);
    // The future execution service must check the authenticated decision,
    // current policy, and resource version inside its write transaction.
  });
});
