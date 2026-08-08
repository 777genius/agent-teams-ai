import type {
  HostedPermission,
  HostedPrincipal,
  HostedSessionId,
  OperatorSessionId,
} from '@features/hosted-access/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type {
  ActorId,
  AuthorizedScope,
  QueryContext,
  RequestId,
  SessionId,
} from '@shared/contracts/hosted';

export type AuthenticatedHostedSessionId = HostedSessionId | OperatorSessionId;

/**
 * Authentication evidence is supplied by the server authentication boundary.
 * The request body, query, params, headers, and cookies are deliberately absent.
 */
export interface AuthenticatedHostedPrincipal {
  readonly principal: HostedPrincipal;
  readonly authenticatedSessionId: AuthenticatedHostedSessionId;
}

export interface AuthenticatedHostedPrincipalSourcePort {
  authenticatedPrincipalFor(request: object): AuthenticatedHostedPrincipal | null;
}

export interface HostedQueryContextIdentityPort {
  projectActorId(userId: HostedPrincipal['userId']): ActorId;
  projectSessionId(authenticatedSessionId: AuthenticatedHostedSessionId): SessionId;
  createRequestId(): RequestId;
}

export interface HostedQueryContextClockPort {
  nowMs(): number;
}

export interface AuthenticatedHostedQueryContextPolicy {
  readonly authorizedScope: AuthorizedScope;
  readonly requiredPermission: HostedPermission;
  readonly timeoutMs: number;
}

export interface AuthenticatedHostedQueryContextFactoryDependencies {
  readonly authentication: AuthenticatedHostedPrincipalSourcePort;
  readonly identity: HostedQueryContextIdentityPort;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly clock: HostedQueryContextClockPort;
  readonly policy: AuthenticatedHostedQueryContextPolicy;
}

export type AuthenticatedHostedQueryContextFailureCode =
  | 'request_invalid'
  | 'request_cancelled'
  | 'signal_invalid'
  | 'signal_rebinding'
  | 'authentication_required'
  | 'authentication_invalid'
  | 'authenticated_session_required'
  | 'principal_session_required'
  | 'principal_session_mismatch'
  | 'permission_denied'
  | 'context_unavailable';

export interface AuthenticatedHostedQueryContextFailure {
  readonly kind: 'failure';
  readonly code: AuthenticatedHostedQueryContextFailureCode;
}

export interface AuthenticatedHostedQueryContextSuccess {
  readonly kind: 'success';
  readonly context: QueryContext;
}

export type AuthenticatedHostedQueryContextResult =
  | AuthenticatedHostedQueryContextSuccess
  | AuthenticatedHostedQueryContextFailure;

export interface AuthenticatedHostedQueryContextFactoryPort {
  create(request: object, signal: AbortSignal): AuthenticatedHostedQueryContextResult;
}
