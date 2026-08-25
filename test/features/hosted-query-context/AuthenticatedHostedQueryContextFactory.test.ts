import {
  type HostedPermission,
  type HostedPrincipal,
  parseHostedSessionId,
  parseOperatorSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  parseActorId,
  parseAuthorizedScope,
  parseRequestId,
  parseSessionId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import { AuthenticatedHostedQueryContextFactory } from '../../../src/features/hosted-query-context/core/application/AuthenticatedHostedQueryContextFactory';

import type {
  AuthenticatedHostedPrincipal,
  AuthenticatedHostedPrincipalSourcePort,
  AuthenticatedHostedSessionId,
  HostedQueryContextIdentityPort,
} from '../../../src/features/hosted-query-context/core/application/ports';

const USER_ID = parseUserId('user_owner0001');
const OIDC_SESSION_ID = parseHostedSessionId('session-oidc_00000001');
const PERSONAL_SESSION_ID = parseOperatorSessionId('session-personal_00000001');

function principal(
  input: {
    readonly authenticationMethod?: HostedPrincipal['authenticationMethod'];
    readonly permissions?: readonly HostedPermission[];
    readonly sessionId?: HostedPrincipal['sessionId'];
  } = {}
): HostedPrincipal {
  return Object.freeze({
    userId: USER_ID,
    displayName: 'Hosted operator',
    role: 'owner',
    permissions: Object.freeze([...(input.permissions ?? ['hosted.query'])]),
    authenticationMethod: input.authenticationMethod ?? 'oidc',
    sessionId: input.sessionId === undefined ? OIDC_SESSION_ID : input.sessionId,
  });
}

function authentication(
  overrides: Partial<AuthenticatedHostedPrincipal> = {}
): AuthenticatedHostedPrincipal {
  return Object.freeze({
    principal: principal(),
    authenticatedSessionId: OIDC_SESSION_ID,
    ...overrides,
  });
}

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: 'deployment_hosted-query-test',
    bootId: 'boot_hosted-query-test',
    claudeRoot: { kind: 'claude', reference: '/runtime/claude' },
    appDataRoot: { kind: 'app-data', reference: '/runtime/app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: '/runtime/workspace' }],
    tempRoot: { kind: 'temp', reference: '/runtime/temp' },
    logsRoot: { kind: 'logs', reference: '/runtime/logs' },
  });
}

function harness(initialAuthentication: AuthenticatedHostedPrincipal | null = authentication()) {
  let currentAuthentication = initialAuthentication;
  let requestSequence = 0;
  const authenticationSource: AuthenticatedHostedPrincipalSourcePort = {
    authenticatedPrincipalFor: vi.fn(() => currentAuthentication),
  };
  const identity: HostedQueryContextIdentityPort = {
    projectActorId: vi.fn(() => parseActorId('actor_server-projected')),
    projectSessionId: vi.fn(() => parseSessionId('session_server-projected')),
    createRequestId: vi.fn(() => parseRequestId(`request_server-${++requestSequence}`)),
  };
  const clock = { nowMs: vi.fn(() => 1_000) };
  const factory = new AuthenticatedHostedQueryContextFactory({
    authentication: authenticationSource,
    identity,
    runtimeInstance: runtimeInstance(),
    clock,
    policy: Object.freeze({
      authorizedScope: parseAuthorizedScope('scope_server-owned'),
      requiredPermission: 'hosted.query',
      timeoutMs: 5_000,
    }),
  });
  return {
    authenticationSource,
    clock,
    factory,
    identity,
    setAuthentication(value: AuthenticatedHostedPrincipal | null) {
      currentAuthentication = value;
    },
  };
}

describe('AuthenticatedHostedQueryContextFactory', () => {
  it('builds an immutable context exclusively from server-owned sources', () => {
    const test = harness();
    const signal = new AbortController().signal;
    const request = {
      body: {
        actorId: 'actor_wire',
        sessionId: 'session_wire',
        deploymentId: 'deployment_wire',
        bootId: 'boot_wire',
        requestId: 'request_wire',
        authorizedScope: 'scope_wire',
        deadlineAtMs: 99_999_999,
      },
    };

    const result = test.factory.create(request, signal);

    expect(result).toEqual({
      kind: 'success',
      context: {
        actorId: 'actor_server-projected',
        sessionId: 'session_server-projected',
        deploymentId: 'deployment_hosted-query-test',
        bootId: 'boot_hosted-query-test',
        requestId: 'request_server-1',
        authorizedScope: 'scope_server-owned',
        deadlineAtMs: 6_000,
        signal,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.kind === 'success' && Object.isFrozen(result.context)).toBe(true);
    expect(test.identity.projectActorId).toHaveBeenCalledWith(USER_ID);
    expect(test.identity.projectSessionId).toHaveBeenCalledWith(OIDC_SESSION_ID);
  });

  it('caches exactly one successful context per request', () => {
    const test = harness();
    const request = {};
    const signal = new AbortController().signal;

    const first = test.factory.create(request, signal);
    test.setAuthentication(null);
    const second = test.factory.create(request, signal);
    const third = test.factory.create({}, signal);

    expect(second).toBe(first);
    expect(third).toMatchObject({ kind: 'failure', code: 'authentication_required' });
    expect(test.authenticationSource.authenticatedPrincipalFor).toHaveBeenCalledTimes(2);
    expect(test.identity.createRequestId).toHaveBeenCalledTimes(1);
    expect(test.clock.nowMs).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-aborted signal before authentication, identity, or cache insertion', () => {
    const test = harness();
    const request = {};
    const controller = new AbortController();
    controller.abort();

    const cancelled = test.factory.create(request, controller.signal);

    expect(cancelled).toEqual({ kind: 'failure', code: 'request_cancelled' });
    expect(Object.isFrozen(cancelled)).toBe(true);
    expect(test.authenticationSource.authenticatedPrincipalFor).not.toHaveBeenCalled();
    expect(test.clock.nowMs).not.toHaveBeenCalled();
    expect(test.identity.projectActorId).not.toHaveBeenCalled();
    expect(test.identity.createRequestId).not.toHaveBeenCalled();

    const retry = test.factory.create(request, new AbortController().signal);
    expect(retry).toMatchObject({ kind: 'success' });
    expect(test.authenticationSource.authenticatedPrincipalFor).toHaveBeenCalledOnce();
    expect(test.identity.createRequestId).toHaveBeenCalledOnce();
  });

  it('does not cache a request cancelled by the authentication source', () => {
    const test = harness();
    const request = {};
    const controller = new AbortController();
    vi.mocked(test.authenticationSource.authenticatedPrincipalFor).mockImplementationOnce(() => {
      controller.abort();
      return authentication();
    });

    const cancelled = test.factory.create(request, controller.signal);

    expect(cancelled).toEqual({ kind: 'failure', code: 'request_cancelled' });
    expect(Object.isFrozen(cancelled)).toBe(true);
    expect(test.clock.nowMs).not.toHaveBeenCalled();
    expect(test.identity.projectActorId).not.toHaveBeenCalled();

    const retry = test.factory.create(request, new AbortController().signal);
    expect(retry).toMatchObject({ kind: 'success' });
    expect(test.authenticationSource.authenticatedPrincipalFor).toHaveBeenCalledTimes(2);
    expect(test.identity.createRequestId).toHaveBeenCalledOnce();
  });

  it('does not finish or cache identity projection after cancellation', () => {
    const test = harness();
    const request = {};
    const controller = new AbortController();
    vi.mocked(test.identity.projectActorId).mockImplementationOnce(() => {
      controller.abort();
      return parseActorId('actor_cancelled-projection');
    });

    const cancelled = test.factory.create(request, controller.signal);

    expect(cancelled).toEqual({ kind: 'failure', code: 'request_cancelled' });
    expect(Object.isFrozen(cancelled)).toBe(true);
    expect(test.identity.projectSessionId).not.toHaveBeenCalled();
    expect(test.identity.createRequestId).not.toHaveBeenCalled();

    const retry = test.factory.create(request, new AbortController().signal);
    expect(retry).toMatchObject({ kind: 'success' });
    expect(test.authenticationSource.authenticatedPrincipalFor).toHaveBeenCalledTimes(2);
    expect(test.identity.createRequestId).toHaveBeenCalledOnce();
  });

  it('fails closed instead of rebinding a cached request to another signal', () => {
    const test = harness();
    const request = {};
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;

    const first = test.factory.create(request, firstSignal);
    const rebound = test.factory.create(request, secondSignal);

    expect(first).toMatchObject({ kind: 'success' });
    expect(rebound).toEqual({ kind: 'failure', code: 'signal_rebinding' });
    expect(Object.isFrozen(rebound)).toBe(true);
    expect(first.kind === 'success' && first.context.signal).toBe(firstSignal);
    expect(test.authenticationSource.authenticatedPrincipalFor).toHaveBeenCalledTimes(1);
  });

  it('accepts a personal principal with a null principal session only when auth supplies one', () => {
    const personal = principal({ authenticationMethod: 'personal', sessionId: null });
    const test = harness(
      authentication({ principal: personal, authenticatedSessionId: PERSONAL_SESSION_ID })
    );

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toMatchObject({ kind: 'success' });
    expect(test.identity.projectSessionId).toHaveBeenCalledWith(PERSONAL_SESSION_ID);
  });

  it('snapshots alternating authentication proxies exactly once before validation', () => {
    const envelopeReads: Record<string, number> = {};
    const principalReads: Record<string, number> = {};
    const nextRead = (reads: Record<string, number>, property: PropertyKey) => {
      const key = String(property);
      const count = (reads[key] ?? 0) + 1;
      reads[key] = count;
      return count;
    };
    const proxyPrincipal = new Proxy({} as HostedPrincipal, {
      get: (_target, property) => {
        const count = nextRead(principalReads, property);
        switch (property) {
          case 'userId':
            return count === 1 ? USER_ID : 'user_invalid';
          case 'authenticationMethod':
            return count === 1 ? 'oidc' : 'personal';
          case 'permissions':
            return count === 1 ? ['hosted.query'] : ['hosted.events'];
          case 'sessionId':
            return count === 1 ? OIDC_SESSION_ID : parseHostedSessionId('session-oidc_00000002');
          default:
            return undefined;
        }
      },
    });
    const proxyEvidence = new Proxy({} as AuthenticatedHostedPrincipal, {
      get: (_target, property) => {
        const count = nextRead(envelopeReads, property);
        switch (property) {
          case 'principal':
            return count === 1 ? proxyPrincipal : null;
          case 'authenticatedSessionId':
            return count === 1 ? OIDC_SESSION_ID : parseHostedSessionId('session-oidc_00000003');
          default:
            return undefined;
        }
      },
    });
    const test = harness(proxyEvidence);

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toMatchObject({ kind: 'success' });
    expect(envelopeReads).toEqual({ principal: 1, authenticatedSessionId: 1 });
    expect(principalReads).toEqual({
      userId: 1,
      authenticationMethod: 1,
      permissions: 1,
      sessionId: 1,
    });
    expect(test.identity.projectActorId).toHaveBeenCalledWith(USER_ID);
    expect(test.identity.projectSessionId).toHaveBeenCalledWith(OIDC_SESSION_ID);
  });

  it('contains throwing permission evidence as a frozen failure with no context', () => {
    const throwingPrincipal = Object.defineProperties({} as HostedPrincipal, {
      userId: { get: () => USER_ID },
      authenticationMethod: { get: () => 'oidc' },
      permissions: {
        get: () => {
          throw new Error('untrusted-permissions-getter');
        },
      },
      sessionId: { get: () => OIDC_SESSION_ID },
    });
    const test = harness(authentication({ principal: throwingPrincipal }));

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toEqual({ kind: 'failure', code: 'authentication_invalid' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(test.clock.nowMs).not.toHaveBeenCalled();
    expect(test.identity.projectActorId).not.toHaveBeenCalled();
    expect(test.identity.createRequestId).not.toHaveBeenCalled();
  });

  it('evaluates a plain permission snapshot without calling an untrusted includes method', () => {
    const poisonedIncludes = vi.fn(() => {
      throw new Error('untrusted-permissions-includes');
    });
    const permissionEvidence: HostedPermission[] = ['hosted.query'];
    Object.defineProperty(permissionEvidence, 'includes', { value: poisonedIncludes });
    const evidencePrincipal = Object.freeze({
      ...principal(),
      permissions: permissionEvidence,
    });
    const test = harness(authentication({ principal: evidencePrincipal }));

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toMatchObject({ kind: 'success' });
    expect(poisonedIncludes).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'noncanonical user ID',
      value: authentication({
        principal: Object.freeze({
          ...principal(),
          userId: 'user_bad' as HostedPrincipal['userId'],
        }),
      }),
    },
    {
      name: 'noncanonical authentication method',
      value: authentication({
        principal: Object.freeze({
          ...principal(),
          authenticationMethod: 'saml' as HostedPrincipal['authenticationMethod'],
        }),
      }),
    },
    {
      name: 'noncanonical permission',
      value: authentication({
        principal: principal({ permissions: ['hosted.root' as HostedPermission] }),
      }),
    },
    {
      name: 'noncanonical principal session',
      value: authentication({
        principal: principal({ sessionId: 'session_bad' as HostedPrincipal['sessionId'] }),
      }),
    },
  ])('rejects $name from the immutable snapshot', ({ value }) => {
    const test = harness(value);

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toEqual({ kind: 'failure', code: 'authentication_invalid' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(test.clock.nowMs).not.toHaveBeenCalled();
    expect(test.identity.createRequestId).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing authentication',
      value: null,
      code: 'authentication_required',
    },
    {
      name: 'missing authenticated session',
      value: authentication({ authenticatedSessionId: '' as AuthenticatedHostedSessionId }),
      code: 'authenticated_session_required',
    },
    {
      name: 'non-personal null principal session',
      value: authentication({ principal: principal({ sessionId: null }) }),
      code: 'principal_session_required',
    },
    {
      name: 'mismatched principal session',
      value: authentication({
        authenticatedSessionId: parseHostedSessionId('session-oidc_00000002'),
      }),
      code: 'principal_session_mismatch',
    },
    {
      name: 'missing fixed permission',
      value: authentication({ principal: principal({ permissions: ['hosted.events'] }) }),
      code: 'permission_denied',
    },
  ])('returns an immutable typed failure for $name', ({ value, code }) => {
    const test = harness(value);

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toEqual({ kind: 'failure', code });
    expect(Object.isFrozen(result)).toBe(true);
    expect(test.identity.createRequestId).not.toHaveBeenCalled();
  });

  it('contains dependency faults without logging identity data', () => {
    const test = harness();
    vi.mocked(test.authenticationSource.authenticatedPrincipalFor).mockImplementation(() => {
      throw new Error(`must-not-log:${USER_ID}`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = test.factory.create({}, new AbortController().signal);

    expect(result).toEqual({ kind: 'failure', code: 'context_unavailable' });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
