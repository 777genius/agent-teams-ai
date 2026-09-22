import {
  HOSTED_PERMISSIONS,
  type HostedPermission,
  type HostedPrincipal,
  parseHostedSessionId,
  parseOperatorSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { createQueryContext } from '@shared/contracts/hosted';

import type {
  AuthenticatedHostedQueryContextFactoryDependencies,
  AuthenticatedHostedQueryContextFactoryPort,
  AuthenticatedHostedQueryContextFailure,
  AuthenticatedHostedQueryContextFailureCode,
  AuthenticatedHostedQueryContextResult,
  AuthenticatedHostedQueryContextSuccess,
  AuthenticatedHostedSessionId,
} from './ports';

const HOSTED_PERMISSION_SET = new Set<HostedPermission>(HOSTED_PERMISSIONS);

const FAILURES: Readonly<
  Record<AuthenticatedHostedQueryContextFailureCode, AuthenticatedHostedQueryContextFailure>
> = Object.freeze(
  Object.fromEntries(
    [
      'request_invalid',
      'request_cancelled',
      'signal_invalid',
      'signal_rebinding',
      'authentication_required',
      'authentication_invalid',
      'authenticated_session_required',
      'principal_session_required',
      'principal_session_mismatch',
      'permission_denied',
      'context_unavailable',
    ].map((code) => [code, Object.freeze({ kind: 'failure', code })])
  ) as Record<AuthenticatedHostedQueryContextFailureCode, AuthenticatedHostedQueryContextFailure>
);

function failure(
  code: AuthenticatedHostedQueryContextFailureCode
): AuthenticatedHostedQueryContextFailure {
  return FAILURES[code];
}

function isRequestKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isServerSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function isAuthenticationMethod(value: unknown): value is HostedPrincipal['authenticationMethod'] {
  return value === 'desktop-local-owner' || value === 'oidc' || value === 'personal';
}

interface AuthenticationEvidenceSnapshot {
  readonly principal: Readonly<{
    userId: unknown;
    authenticationMethod: unknown;
    permissions: readonly unknown[];
    sessionId: unknown;
  }>;
  readonly authenticatedSessionId: unknown;
}

interface ValidatedAuthenticationSnapshot {
  readonly principal: Readonly<
    Pick<HostedPrincipal, 'userId' | 'authenticationMethod' | 'permissions' | 'sessionId'>
  >;
  readonly authenticatedSessionId: AuthenticatedHostedSessionId;
}

type AuthenticationRead =
  | { readonly ok: true; readonly value: ValidatedAuthenticationSnapshot }
  | { readonly ok: false; readonly failure: AuthenticatedHostedQueryContextFailure };

function invalidAuthentication(
  code: AuthenticatedHostedQueryContextFailureCode
): AuthenticationRead {
  return Object.freeze({ ok: false, failure: failure(code) });
}

function snapshotAuthentication(
  value: unknown
): AuthenticationRead | AuthenticationEvidenceSnapshot {
  if (value === null) {
    return invalidAuthentication('authentication_required');
  }
  if (typeof value !== 'object') {
    return invalidAuthentication('authentication_invalid');
  }

  try {
    const principal = Reflect.get(value, 'principal') as unknown;
    const authenticatedSessionId = Reflect.get(value, 'authenticatedSessionId') as unknown;
    if (typeof principal !== 'object' || principal === null) {
      return invalidAuthentication('authentication_invalid');
    }

    const userId = Reflect.get(principal, 'userId') as unknown;
    const authenticationMethod = Reflect.get(principal, 'authenticationMethod') as unknown;
    const permissionEvidence = Reflect.get(principal, 'permissions') as unknown;
    const sessionId = Reflect.get(principal, 'sessionId') as unknown;
    if (!Array.isArray(permissionEvidence)) {
      return invalidAuthentication('authentication_invalid');
    }
    const permissionCount = permissionEvidence.length;
    if (permissionCount > HOSTED_PERMISSIONS.length) {
      return invalidAuthentication('authentication_invalid');
    }
    const permissions: unknown[] = [];
    for (let index = 0; index < permissionCount; index += 1) {
      permissions.push(permissionEvidence[index]);
    }

    return Object.freeze({
      principal: Object.freeze({
        userId,
        authenticationMethod,
        permissions: Object.freeze(permissions),
        sessionId,
      }),
      authenticatedSessionId,
    });
  } catch {
    return invalidAuthentication('authentication_invalid');
  }
}

function readAuthentication(value: unknown): AuthenticationRead {
  const evidence = snapshotAuthentication(value);
  if ('ok' in evidence) return evidence;

  const { authenticationMethod, permissions: permissionEvidence } = evidence.principal;
  if (!isAuthenticationMethod(authenticationMethod)) {
    return invalidAuthentication('authentication_invalid');
  }

  let userId: HostedPrincipal['userId'];
  let principalSessionId: HostedPrincipal['sessionId'];
  let permissions: readonly HostedPermission[];
  try {
    userId = parseUserId(evidence.principal.userId);
    principalSessionId =
      evidence.principal.sessionId === null
        ? null
        : parseHostedSessionId(evidence.principal.sessionId);
    permissions = Object.freeze(
      permissionEvidence.map((permission) => {
        if (!HOSTED_PERMISSION_SET.has(permission as HostedPermission)) {
          throw new TypeError('hosted-query-context-permission-invalid');
        }
        return permission as HostedPermission;
      })
    );
  } catch {
    return invalidAuthentication('authentication_invalid');
  }

  let authenticatedSessionId: AuthenticatedHostedSessionId;
  try {
    authenticatedSessionId =
      authenticationMethod === 'personal'
        ? parseOperatorSessionId(evidence.authenticatedSessionId)
        : parseHostedSessionId(evidence.authenticatedSessionId);
  } catch {
    return invalidAuthentication('authenticated_session_required');
  }

  if (principalSessionId === null && authenticationMethod !== 'personal') {
    return invalidAuthentication('principal_session_required');
  }
  if (principalSessionId !== null && principalSessionId !== authenticatedSessionId) {
    return invalidAuthentication('principal_session_mismatch');
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      principal: Object.freeze({
        userId,
        authenticationMethod,
        permissions,
        sessionId: principalSessionId,
      }),
      authenticatedSessionId,
    }),
  });
}

export class AuthenticatedHostedQueryContextFactory implements AuthenticatedHostedQueryContextFactoryPort {
  private readonly successes = new WeakMap<object, AuthenticatedHostedQueryContextSuccess>();
  private readonly authentication: AuthenticatedHostedQueryContextFactoryDependencies['authentication'];
  private readonly identity: AuthenticatedHostedQueryContextFactoryDependencies['identity'];
  private readonly clock: AuthenticatedHostedQueryContextFactoryDependencies['clock'];
  private readonly authorizedScope: AuthenticatedHostedQueryContextFactoryDependencies['policy']['authorizedScope'];
  private readonly requiredPermission: AuthenticatedHostedQueryContextFactoryDependencies['policy']['requiredPermission'];
  private readonly timeoutMs: number;
  private readonly deploymentId: AuthenticatedHostedQueryContextFactoryDependencies['runtimeInstance']['deploymentId'];
  private readonly bootId: AuthenticatedHostedQueryContextFactoryDependencies['runtimeInstance']['bootId'];

  constructor(dependencies: AuthenticatedHostedQueryContextFactoryDependencies) {
    const policy = dependencies.policy;
    const timeoutMs = policy.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('authenticated-hosted-query-context-policy-invalid');
    }
    const requiredPermission = policy.requiredPermission;
    if (!HOSTED_PERMISSION_SET.has(requiredPermission)) {
      throw new TypeError('authenticated-hosted-query-context-policy-invalid');
    }
    const runtimeInstance = dependencies.runtimeInstance;
    this.authentication = dependencies.authentication;
    this.identity = dependencies.identity;
    this.clock = dependencies.clock;
    this.authorizedScope = policy.authorizedScope;
    this.requiredPermission = requiredPermission;
    this.timeoutMs = timeoutMs;
    this.deploymentId = runtimeInstance.deploymentId;
    this.bootId = runtimeInstance.bootId;
  }

  create(request: object, signal: AbortSignal): AuthenticatedHostedQueryContextResult {
    if (!isRequestKey(request)) return failure('request_invalid');
    if (!isServerSignal(signal)) return failure('signal_invalid');
    if (signal.aborted) return failure('request_cancelled');

    const cached = this.successes.get(request);
    if (cached !== undefined) {
      return cached.context.signal === signal ? cached : failure('signal_rebinding');
    }

    let authentication: ReturnType<
      AuthenticatedHostedQueryContextFactoryDependencies['authentication']['authenticatedPrincipalFor']
    >;
    try {
      authentication = this.authentication.authenticatedPrincipalFor(request);
    } catch {
      return signal.aborted ? failure('request_cancelled') : failure('context_unavailable');
    }
    if (signal.aborted) return failure('request_cancelled');

    let read;
    try {
      read = readAuthentication(authentication);
    } catch {
      return signal.aborted ? failure('request_cancelled') : failure('authentication_invalid');
    }
    if (signal.aborted) return failure('request_cancelled');
    if (!read.ok) return read.failure;

    const { principal, authenticatedSessionId } = read.value;
    let permitted: boolean;
    try {
      permitted = principal.permissions.includes(this.requiredPermission);
    } catch {
      return signal.aborted ? failure('request_cancelled') : failure('authentication_invalid');
    }
    if (signal.aborted) return failure('request_cancelled');
    if (!permitted) {
      return failure('permission_denied');
    }

    try {
      const nowMs = this.clock.nowMs();
      if (signal.aborted) return failure('request_cancelled');
      const deadlineAtMs = nowMs + this.timeoutMs;
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(deadlineAtMs)) {
        return failure('context_unavailable');
      }
      const actorId = this.identity.projectActorId(principal.userId);
      if (signal.aborted) return failure('request_cancelled');
      const sessionId = this.identity.projectSessionId(authenticatedSessionId);
      if (signal.aborted) return failure('request_cancelled');
      const requestId = this.identity.createRequestId();
      if (signal.aborted) return failure('request_cancelled');
      const context = createQueryContext({
        actorId,
        sessionId,
        deploymentId: this.deploymentId,
        bootId: this.bootId,
        requestId,
        authorizedScope: this.authorizedScope,
        deadlineAtMs,
        signal,
      });
      if (signal.aborted) return failure('request_cancelled');
      const success = Object.freeze({ kind: 'success', context } as const);
      this.successes.set(request, success);
      return success;
    } catch {
      return signal.aborted ? failure('request_cancelled') : failure('context_unavailable');
    }
  }
}
