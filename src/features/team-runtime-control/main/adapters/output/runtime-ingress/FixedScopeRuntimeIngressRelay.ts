import { randomBytes } from 'node:crypto';

import {
  type ResolveRuntimeIngressRelayBindingRequest,
  RevokeRuntimeIngressCredential,
  type RuntimeIngressClockPort,
  type RuntimeIngressCommandOrchestrationPort,
  type RuntimeIngressDurableRecoveryPort,
  type RuntimeIngressRelayAuthority,
  type RuntimeIngressRelayAuthoritySourcePort,
  type RuntimeIngressRelayBinding,
  type RuntimeIngressRelayDispatchRequest,
  type RuntimeIngressRelayDispatchResult,
} from '../../../../core/application/runtime-ingress';
import {
  areRuntimeIngressCredentialsExact,
  isExactRuntimeIngressCredentialScope,
  type PresentedRuntimeIngressCredential,
  type RuntimeIngressCredential,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressPresentedSecret,
  type RuntimeIngressSessionState,
} from '../../../../core/domain/runtime-ingress';

import { isRuntimePlanRefExact } from './runtimeIngressDurableState';

import type {
  CloseRuntimeIngressRelayRequest,
  CloseRuntimeIngressRelayResult,
  LaneRelayHandle,
  OpenRuntimeIngressRelayRequest,
  OpenRuntimeIngressRelayResult,
  RuntimeIngressRelayPort,
  RuntimeIngressRelayRef,
} from '../../../../core/application/ports';
import type { RuntimeIngressRelaySecretSource } from './InheritedFdRuntimeIngressSecretSource';

export interface RuntimeIngressRelayStorePort extends RuntimeIngressDurableRecoveryPort {
  resolveCredentialContext(presented: PresentedRuntimeIngressCredential): Promise<
    | {
        readonly status: 'resolved';
        readonly context: {
          readonly credential: RuntimeIngressCredential;
          readonly session: RuntimeIngressSessionState;
        };
      }
    | { readonly status: 'rejected' | 'unavailable' }
  >;
  findRelayBinding(
    request: ResolveRuntimeIngressRelayBindingRequest
  ): Promise<
    | { readonly status: 'found'; readonly binding: RuntimeIngressRelayBinding }
    | { readonly status: 'missing' | 'ambiguous' | 'unavailable' }
  >;
}

interface OpenRelaySession {
  readonly request: OpenRuntimeIngressRelayRequest;
  readonly authority: RuntimeIngressRelayAuthority;
  readonly binding: RuntimeIngressRelayBinding;
  readonly secret: RuntimeIngressPresentedSecret;
  readonly relayRef: RuntimeIngressRelayRef;
  readonly laneRelayHandle: LaneRelayHandle;
}

export interface FixedScopeRuntimeIngressRelayDeps {
  readonly store: RuntimeIngressRelayStorePort;
  readonly commandOrchestration: RuntimeIngressCommandOrchestrationPort;
  readonly authoritySource: RuntimeIngressRelayAuthoritySourcePort;
  readonly secretSource: RuntimeIngressRelaySecretSource;
  readonly clock: RuntimeIngressClockPort;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/**
 * Controller-owned local relay. Provider input selects only a verb from the
 * immutable allowed set; every scope field and canonical credential header is
 * supplied from the server-owned relay session.
 */
export class FixedScopeRuntimeIngressRelay implements RuntimeIngressRelayPort {
  private readonly byHandle = new Map<LaneRelayHandle, OpenRelaySession>();
  private readonly byLane = new Map<string, OpenRelaySession>();
  private readonly revokeCredential: RevokeRuntimeIngressCredential;
  private readonly random: (size: number) => Uint8Array;

  constructor(private readonly deps: FixedScopeRuntimeIngressRelayDeps) {
    this.revokeCredential = new RevokeRuntimeIngressCredential(deps.store);
    this.random = deps.randomBytes ?? randomBytes;
  }

  async open(request: OpenRuntimeIngressRelayRequest): Promise<OpenRuntimeIngressRelayResult> {
    const authorityResolution = await this.resolveAuthority(request);
    if (authorityResolution.status !== 'resolved') {
      return {
        status: 'rejected',
        reason: authorityResolution.status === 'unavailable' ? 'unavailable' : 'stale_plan',
      };
    }
    const authority = authorityResolution.authority;
    const laneKey = relayLaneKey(request);
    const existing = this.byLane.get(laneKey);
    if (existing) {
      if (
        !isOpenRequestExact(existing.request, request) ||
        !isRelayAuthorityExact(existing.authority, authority)
      ) {
        return { status: 'rejected', reason: 'stale_plan' };
      }
      const active = await this.deps.store.resolveCredentialContext({
        credentialId: existing.binding.credential.credentialId,
        secret: existing.secret,
      });
      if (
        active.status === 'resolved' &&
        areRuntimeIngressCredentialsExact(active.context.credential, existing.binding.credential)
      ) {
        return {
          status: 'already_open',
          relayRef: existing.relayRef,
          laneRelayHandle: existing.laneRelayHandle,
        };
      }
      this.byLane.delete(laneKey);
      this.byHandle.delete(existing.laneRelayHandle);
      return {
        status: 'rejected',
        reason: active.status === 'unavailable' ? 'unavailable' : 'stale_plan',
      };
    }

    const resolved = await this.deps.store.findRelayBinding({ authority });
    if (resolved.status !== 'found') {
      return {
        status: 'rejected',
        reason: resolved.status === 'unavailable' ? 'unavailable' : 'stale_plan',
      };
    }
    if (
      !authority.memberIds.includes(resolved.binding.session.deliveryOwnerId) ||
      !isRuntimePlanRefExact(resolved.binding.planRef, authority.planRef) ||
      !isExactRuntimeIngressCredentialScope(
        resolved.binding.credential.scope,
        authorityCredentialScope(authority)
      )
    ) {
      return { status: 'rejected', reason: 'stale_plan' };
    }
    const bootstrap = await this.deps.secretSource.consume({
      credentialId: resolved.binding.credential.credentialId,
      expectedScope: resolved.binding.credential.scope,
    });
    if (bootstrap.status !== 'consumed') {
      return { status: 'rejected', reason: 'unavailable' };
    }
    const verified = await this.deps.store.resolveCredentialContext({
      credentialId: resolved.binding.credential.credentialId,
      secret: bootstrap.secret,
    });
    if (
      verified.status !== 'resolved' ||
      !areRuntimeIngressCredentialsExact(verified.context.credential, resolved.binding.credential)
    ) {
      return { status: 'rejected', reason: 'unavailable' };
    }

    const relayRef = this.createUniqueRef('runtime-relay') as RuntimeIngressRelayRef;
    const laneRelayHandle = this.createUniqueRef('lane-relay') as LaneRelayHandle;
    const session: OpenRelaySession = Object.freeze({
      request: Object.freeze({
        ...request,
        memberIds: Object.freeze([...request.memberIds]),
        allowedVerbs: Object.freeze([...request.allowedVerbs]),
      }),
      authority: freezeRelayAuthority(authority),
      binding: resolved.binding,
      secret: bootstrap.secret,
      relayRef,
      laneRelayHandle,
    });
    this.byLane.set(laneKey, session);
    this.byHandle.set(laneRelayHandle, session);
    return { status: 'opened', relayRef, laneRelayHandle };
  }

  async close(request: CloseRuntimeIngressRelayRequest): Promise<CloseRuntimeIngressRelayResult> {
    const session = [...this.byHandle.values()].find(
      (candidate) => candidate.relayRef === request.relayRef
    );
    if (!session) return { status: 'already_closed' };
    if (
      session.request.laneId !== request.laneId ||
      !isRuntimePlanRefExact(session.request.planRef, request.planRef)
    ) {
      return { status: 'unclassified_residual' };
    }
    const revoked = await this.revokeCredential.execute({
      credentialId: session.binding.credential.credentialId,
      expectedScope: session.binding.credential.scope,
      revokedAtIso: this.deps.clock.nowIso(),
      reason: 'runtime-relay-closed',
    });
    if (revoked.status === 'rejected') return { status: 'unclassified_residual' };
    this.byHandle.delete(session.laneRelayHandle);
    this.byLane.delete(relayLaneKey(session.request));
    return { status: revoked.status === 'revoked' ? 'closed' : 'already_closed' };
  }

  async dispatch(
    request: RuntimeIngressRelayDispatchRequest
  ): Promise<RuntimeIngressRelayDispatchResult> {
    const session = this.byHandle.get(request.laneRelayHandle);
    if (!session) return { status: 'rejected', reason: 'handle_invalid' };
    if (!session.binding.credential.scope.allowedVerbs.includes(request.verb)) {
      return { status: 'rejected', reason: 'verb_not_allowed' };
    }
    const result = await this.deps.commandOrchestration.executeRelayCommand(
      this.toRelayCommandRequest(session, request)
    );
    return { status: 'delivered', result };
  }

  private async resolveAuthority(
    request: OpenRuntimeIngressRelayRequest
  ): Promise<
    | { readonly status: 'resolved'; readonly authority: RuntimeIngressRelayAuthority }
    | { readonly status: 'stale_plan' | 'unavailable' }
  > {
    try {
      const resolved = await this.deps.authoritySource.resolve({
        planRef: request.planRef,
        laneId: request.laneId,
      });
      if (
        resolved.status !== 'resolved' ||
        !isRuntimePlanRefExact(resolved.authority.planRef, request.planRef) ||
        resolved.authority.laneId !== request.laneId ||
        resolved.authority.credentialGeneration !== request.credentialGeneration ||
        !areStringSetsExact(resolved.authority.memberIds, request.memberIds) ||
        !areStringSetsExact(resolved.authority.allowedVerbs, request.allowedVerbs)
      ) {
        return { status: resolved.status === 'unavailable' ? 'unavailable' : 'stale_plan' };
      }
      return resolved;
    } catch {
      return { status: 'unavailable' };
    }
  }

  private toRelayCommandRequest(
    session: OpenRelaySession,
    request: RuntimeIngressRelayDispatchRequest
  ) {
    return {
      runId: session.binding.credential.scope.runId,
      verb: request.verb,
      credentialId: session.binding.credential.credentialId,
      presentedSecret: session.secret,
      rawBody: request.rawBody,
    };
  }

  private createUniqueRef(prefix: string): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = `${prefix}:${Buffer.from(this.random(24)).toString('base64url')}`;
      const collides = [...this.byHandle.values()].some(
        (session) => session.laneRelayHandle === value || session.relayRef === value
      );
      if (!collides) return value;
    }
    throw new Error('runtime-ingress-relay-random-collision');
  }
}

function relayLaneKey(request: OpenRuntimeIngressRelayRequest): string {
  return JSON.stringify([
    request.planRef.teamId,
    request.planRef.runId,
    request.planRef.generation,
    request.planRef.planHash,
    request.laneId,
  ]);
}

function isOpenRequestExact(
  left: OpenRuntimeIngressRelayRequest,
  right: OpenRuntimeIngressRelayRequest
): boolean {
  return (
    isRuntimePlanRefExact(left.planRef, right.planRef) &&
    left.laneId === right.laneId &&
    left.credentialGeneration === right.credentialGeneration &&
    areStringSetsExact(left.memberIds, right.memberIds) &&
    areStringSetsExact(left.allowedVerbs, right.allowedVerbs)
  );
}

function isRelayAuthorityExact(
  left: RuntimeIngressRelayAuthority,
  right: RuntimeIngressRelayAuthority
): boolean {
  return (
    isRuntimePlanRefExact(left.planRef, right.planRef) &&
    left.deploymentId === right.deploymentId &&
    left.providerId === right.providerId &&
    left.laneId === right.laneId &&
    left.credentialGeneration === right.credentialGeneration &&
    areStringSetsExact(left.memberIds, right.memberIds) &&
    areStringSetsExact(left.allowedVerbs, right.allowedVerbs)
  );
}

function freezeRelayAuthority(
  authority: RuntimeIngressRelayAuthority
): RuntimeIngressRelayAuthority {
  return Object.freeze({
    ...authority,
    planRef: Object.freeze({ ...authority.planRef }),
    memberIds: Object.freeze([...authority.memberIds]),
    allowedVerbs: Object.freeze([...authority.allowedVerbs]),
  });
}

function authorityCredentialScope(
  authority: RuntimeIngressRelayAuthority
): RuntimeIngressCredentialScope {
  return {
    deploymentId: authority.deploymentId,
    teamId: authority.planRef.teamId,
    runId: authority.planRef.runId,
    planGeneration: authority.planRef.generation,
    laneId: authority.laneId,
    providerId: authority.providerId,
    credentialGeneration: authority.credentialGeneration,
    allowedVerbs: authority.allowedVerbs,
  };
}

function areStringSetsExact(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}
