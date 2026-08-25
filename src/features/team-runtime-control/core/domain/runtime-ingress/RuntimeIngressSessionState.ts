import {
  type MemberId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { isTeamProviderId } from '@shared/utils/teamProvider';

import { parseLaneId } from '../../../contracts';

import {
  isRuntimeIngressCredentialRecoverable,
  type RuntimeIngressCredential,
} from './RuntimeIngressCredential';
import {
  areRuntimeIngressAuthoritiesExact,
  isCredentialScopeAuthorizedFor,
  isRuntimeIngressIsoInstant,
  isRuntimeIngressSequence,
  isRuntimeIngressVerb,
  parseRuntimeIngressAcknowledgementId,
  parseRuntimeIngressCommandId,
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressEffectRef,
  parseRuntimeIngressRuntimeInstanceId,
  parseRuntimeIngressSessionId,
  type RuntimeIngressCommandId,
  type RuntimeIngressCredentialId,
  type RuntimeIngressEffectAcknowledgement,
  runtimeIngressInstantEpochMs,
  type RuntimeIngressReplayKey,
  type RuntimeIngressRuntimeInstanceId,
  type RuntimeIngressSessionId,
  type RuntimeIngressVerb,
} from './RuntimeIngressProtocol';

export const RUNTIME_INGRESS_MAX_EVENT_AGE_MS = 5 * 60 * 1_000;
export const RUNTIME_INGRESS_MAX_FUTURE_SKEW_MS = 30 * 1_000;

export interface RuntimeIngressAcceptedVerbState {
  readonly verb: RuntimeIngressVerb;
  readonly acceptedCount: number;
  readonly lastSequence: number;
  readonly lastCommandId: RuntimeIngressCommandId;
  readonly lastAcknowledgement: RuntimeIngressEffectAcknowledgement;
}

export interface RuntimeIngressSessionState {
  readonly sessionStateVersion: 1;
  readonly revision: number;
  readonly credentialId: RuntimeIngressCredentialId;
  readonly sessionId: RuntimeIngressSessionId;
  readonly credentialRevision: number;
  readonly authorityScope: RuntimeIngressCredential['scope'];
  readonly deliveryOwnerId: MemberId;
  readonly runtimeInstanceId: RuntimeIngressRuntimeInstanceId | null;
  readonly phase: 'awaiting_bootstrap' | 'active' | 'revoked';
  readonly bootstrapAcceptedAtIso: string | null;
  readonly lastObservedAtIso: string | null;
  readonly lastAcceptedAtIso: string | null;
  readonly lastAcceptedSequence: number;
  readonly acceptedVerbs: readonly RuntimeIngressAcceptedVerbState[];
}

export type PrepareRuntimeIngressAcceptanceResult =
  | { readonly status: 'accepted'; readonly next: RuntimeIngressSessionState }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'session_revoked'
        | 'credential_mismatch'
        | 'authority_mismatch'
        | 'delivery_owner_mismatch'
        | 'bootstrap_required'
        | 'bootstrap_already_accepted'
        | 'runtime_instance_mismatch'
        | 'event_not_fresh'
        | 'event_out_of_order'
        | 'sequence_out_of_order';
    };

export interface PrepareRuntimeIngressAcceptanceInput {
  readonly session: RuntimeIngressSessionState;
  readonly credential: RuntimeIngressCredential;
  readonly replayKey: RuntimeIngressReplayKey;
  readonly acknowledgement: RuntimeIngressEffectAcknowledgement;
}

export function initializeRuntimeIngressSessionState(
  credential: RuntimeIngressCredential,
  deliveryOwnerId: MemberId
): RuntimeIngressSessionState {
  if (!isRuntimeIngressCredentialRecoverable(credential) || credential.phase !== 'active') {
    throw new TypeError('runtime-ingress-session-active-credential-required');
  }
  parseMemberId(deliveryOwnerId);
  if (!credential.scope.allowedVerbs.includes('runtime.bootstrap-checkin')) {
    throw new TypeError('runtime-ingress-session-bootstrap-verb-required');
  }
  return Object.freeze({
    sessionStateVersion: 1,
    revision: 1,
    credentialId: credential.credentialId,
    sessionId: credential.sessionId,
    credentialRevision: credential.revision,
    authorityScope: credential.scope,
    deliveryOwnerId,
    runtimeInstanceId: null,
    phase: 'awaiting_bootstrap',
    bootstrapAcceptedAtIso: null,
    lastObservedAtIso: null,
    lastAcceptedAtIso: null,
    lastAcceptedSequence: 0,
    acceptedVerbs: Object.freeze([]),
  });
}

export function isSessionBoundToCredential(
  session: RuntimeIngressSessionState,
  credential: RuntimeIngressCredential
): boolean {
  const compatiblePhase =
    credential.phase === 'revoked'
      ? session.phase === 'revoked'
      : session.phase === 'awaiting_bootstrap' || session.phase === 'active';
  return (
    session.credentialId === credential.credentialId &&
    session.sessionId === credential.sessionId &&
    session.credentialRevision === credential.revision &&
    compatiblePhase &&
    session.authorityScope.deploymentId === credential.scope.deploymentId &&
    session.authorityScope.teamId === credential.scope.teamId &&
    session.authorityScope.runId === credential.scope.runId &&
    session.authorityScope.planGeneration === credential.scope.planGeneration &&
    session.authorityScope.laneId === credential.scope.laneId &&
    session.authorityScope.providerId === credential.scope.providerId &&
    session.authorityScope.credentialGeneration === credential.scope.credentialGeneration &&
    session.authorityScope.allowedVerbs.length === credential.scope.allowedVerbs.length &&
    credential.scope.allowedVerbs.every((verb) =>
      session.authorityScope.allowedVerbs.includes(verb)
    )
  );
}

export function prepareRuntimeIngressAcceptance(
  input: PrepareRuntimeIngressAcceptanceInput
): PrepareRuntimeIngressAcceptanceResult {
  const { session, credential, replayKey, acknowledgement } = input;
  const { authority } = replayKey;
  if (session.phase === 'revoked') {
    return { status: 'rejected', reason: 'session_revoked' };
  }
  if (!isSessionBoundToCredential(session, credential)) {
    return { status: 'rejected', reason: 'credential_mismatch' };
  }
  if (
    !isCredentialScopeAuthorizedFor(session.authorityScope, authority) ||
    !isAcknowledgementBoundToReplayKey(acknowledgement, replayKey)
  ) {
    return { status: 'rejected', reason: 'authority_mismatch' };
  }
  if (replayKey.deliveryOwnerId !== session.deliveryOwnerId) {
    return { status: 'rejected', reason: 'delivery_owner_mismatch' };
  }
  if (!isRuntimeIngressSequence(replayKey.sequence)) {
    return { status: 'rejected', reason: 'sequence_out_of_order' };
  }
  if (replayKey.sequence !== session.lastAcceptedSequence + 1) {
    return { status: 'rejected', reason: 'sequence_out_of_order' };
  }

  if (session.phase === 'awaiting_bootstrap') {
    if (authority.verb !== 'runtime.bootstrap-checkin') {
      return { status: 'rejected', reason: 'bootstrap_required' };
    }
    if (replayKey.sequence !== 1) {
      return { status: 'rejected', reason: 'sequence_out_of_order' };
    }
  } else {
    if (authority.verb === 'runtime.bootstrap-checkin') {
      return { status: 'rejected', reason: 'bootstrap_already_accepted' };
    }
    if (session.runtimeInstanceId !== replayKey.runtimeInstanceId) {
      return { status: 'rejected', reason: 'runtime_instance_mismatch' };
    }
  }

  const freshness = classifyRuntimeIngressEventFreshness(
    replayKey.observedAtIso,
    acknowledgement.acceptedAtIso,
    credential.issuedAtIso,
    session.lastObservedAtIso,
    session.lastAcceptedAtIso
  );
  if (freshness !== 'fresh') {
    return {
      status: 'rejected',
      reason: freshness === 'out_of_order' ? 'event_out_of_order' : 'event_not_fresh',
    };
  }

  const accepted = session.acceptedVerbs.find((state) => state.verb === authority.verb);
  const nextAccepted: RuntimeIngressAcceptedVerbState = Object.freeze({
    verb: authority.verb,
    acceptedCount: (accepted?.acceptedCount ?? 0) + 1,
    lastSequence: replayKey.sequence,
    lastCommandId: replayKey.commandId,
    lastAcknowledgement: acknowledgement,
  });
  const acceptedVerbs = session.acceptedVerbs
    .filter((state) => state.verb !== authority.verb)
    .concat(nextAccepted)
    .sort((left, right) => compareCodeUnit(left.verb, right.verb));
  const isBootstrap = session.phase === 'awaiting_bootstrap';

  return {
    status: 'accepted',
    next: Object.freeze({
      ...session,
      revision: session.revision + 1,
      runtimeInstanceId: isBootstrap ? replayKey.runtimeInstanceId : session.runtimeInstanceId,
      phase: 'active',
      bootstrapAcceptedAtIso: isBootstrap
        ? acknowledgement.acceptedAtIso
        : session.bootstrapAcceptedAtIso,
      lastObservedAtIso: replayKey.observedAtIso,
      lastAcceptedAtIso: acknowledgement.acceptedAtIso,
      lastAcceptedSequence: replayKey.sequence,
      acceptedVerbs: Object.freeze(acceptedVerbs),
    }),
  };
}

export function revokeRuntimeIngressSessionState(
  session: RuntimeIngressSessionState,
  revokedCredential: RuntimeIngressCredential
): RuntimeIngressSessionState | null {
  if (
    session.credentialId !== revokedCredential.credentialId ||
    session.sessionId !== revokedCredential.sessionId ||
    revokedCredential.phase !== 'revoked'
  ) {
    return null;
  }
  if (session.phase === 'revoked') return session;
  return Object.freeze({
    ...session,
    revision: session.revision + 1,
    credentialRevision: revokedCredential.revision,
    phase: 'revoked',
  });
}

export function isRuntimeIngressSessionStateRecoverable(
  value: unknown
): value is RuntimeIngressSessionState {
  if (!isRecord(value) || !isRecord(value.authorityScope)) return false;
  try {
    parseRuntimeIngressCredentialId(value.credentialId);
    parseRuntimeIngressSessionId(value.sessionId);
    parseMemberId(value.deliveryOwnerId);
    parseDeploymentId(value.authorityScope.deploymentId);
    parseTeamId(value.authorityScope.teamId);
    parseRunId(value.authorityScope.runId);
    parseLaneId(value.authorityScope.laneId);
    if (value.runtimeInstanceId !== null) {
      parseRuntimeIngressRuntimeInstanceId(value.runtimeInstanceId);
    }
  } catch {
    return false;
  }

  const allowedVerbs = value.authorityScope.allowedVerbs;
  if (
    value.sessionStateVersion !== 1 ||
    !isPositiveSafeInteger(value.revision) ||
    !isPositiveSafeInteger(value.credentialRevision) ||
    !isPositiveSafeInteger(value.authorityScope.planGeneration) ||
    !isTeamProviderId(value.authorityScope.providerId) ||
    !isPositiveSafeInteger(value.authorityScope.credentialGeneration) ||
    !Array.isArray(allowedVerbs) ||
    allowedVerbs.length === 0 ||
    new Set(allowedVerbs).size !== allowedVerbs.length ||
    !allowedVerbs.every(isRuntimeIngressVerb) ||
    !allowedVerbs.includes('runtime.bootstrap-checkin') ||
    (value.phase !== 'awaiting_bootstrap' &&
      value.phase !== 'active' &&
      value.phase !== 'revoked') ||
    !Number.isSafeInteger(value.lastAcceptedSequence) ||
    (value.lastAcceptedSequence as number) < 0 ||
    !Array.isArray(value.acceptedVerbs)
  ) {
    return false;
  }

  if (!hasValidSessionPhaseFields(value)) return false;
  const acceptedVerbs = value.acceptedVerbs as unknown[];
  if (!acceptedVerbs.every((state) => isRecoverableAcceptedVerbState(state, value))) {
    return false;
  }
  if (new Set(acceptedVerbs.map((state) => state.verb)).size !== acceptedVerbs.length) {
    return false;
  }
  if (new Set(acceptedVerbs.map((state) => state.lastSequence)).size !== acceptedVerbs.length) {
    return false;
  }
  const maximumSequence = acceptedVerbs.reduce(
    (maximum, state) => Math.max(maximum, state.lastSequence),
    0
  );
  const acceptedCount = acceptedVerbs.reduce((total, state) => total + state.acceptedCount, 0);
  const bootstrap = acceptedVerbs.find((state) => state.verb === 'runtime.bootstrap-checkin');
  const latest = acceptedVerbs.find((state) => state.lastSequence === value.lastAcceptedSequence);
  return (
    Number.isSafeInteger(acceptedCount) &&
    acceptedCount === value.lastAcceptedSequence &&
    maximumSequence === value.lastAcceptedSequence &&
    (value.lastAcceptedSequence === 0 ||
      (bootstrap?.acceptedCount === 1 &&
        bootstrap.lastSequence === 1 &&
        bootstrap.lastAcknowledgement.acceptedAtIso === value.bootstrapAcceptedAtIso &&
        latest !== undefined &&
        latest.lastAcknowledgement.acceptedAtIso === value.lastAcceptedAtIso &&
        latest.lastAcknowledgement.replayKey.observedAtIso === value.lastObservedAtIso))
  );
}

function hasValidSessionPhaseFields(session: Record<string, unknown>): boolean {
  const noAcceptances =
    session.runtimeInstanceId === null &&
    session.bootstrapAcceptedAtIso === null &&
    session.lastObservedAtIso === null &&
    session.lastAcceptedAtIso === null &&
    session.lastAcceptedSequence === 0 &&
    (session.acceptedVerbs as unknown[]).length === 0;
  if (session.phase === 'awaiting_bootstrap') return noAcceptances;
  if (session.phase === 'active') {
    return (
      session.runtimeInstanceId !== null &&
      isRuntimeIngressIsoInstant(session.bootstrapAcceptedAtIso) &&
      isRuntimeIngressIsoInstant(session.lastObservedAtIso) &&
      isRuntimeIngressIsoInstant(session.lastAcceptedAtIso) &&
      isChronologicalSessionWindow(session.bootstrapAcceptedAtIso, session.lastAcceptedAtIso) &&
      isPositiveSafeInteger(session.lastAcceptedSequence) &&
      session.lastAcceptedSequence > 0
    );
  }
  return (
    noAcceptances ||
    (session.runtimeInstanceId !== null &&
      isRuntimeIngressIsoInstant(session.bootstrapAcceptedAtIso) &&
      isRuntimeIngressIsoInstant(session.lastObservedAtIso) &&
      isRuntimeIngressIsoInstant(session.lastAcceptedAtIso) &&
      isChronologicalSessionWindow(session.bootstrapAcceptedAtIso, session.lastAcceptedAtIso) &&
      isPositiveSafeInteger(session.lastAcceptedSequence) &&
      session.lastAcceptedSequence > 0)
  );
}

function isRecoverableAcceptedVerbState(
  value: unknown,
  session: Record<string, unknown>
): value is RuntimeIngressAcceptedVerbState {
  if (
    !isRecord(value) ||
    !isRecord(value.lastAcknowledgement) ||
    !isRecord(value.lastAcknowledgement.replayKey) ||
    !isRecord(value.lastAcknowledgement.replayKey.authority)
  ) {
    return false;
  }
  const acknowledgement = value.lastAcknowledgement;
  const replayKey = acknowledgement.replayKey as Record<string, unknown>;
  const authority = replayKey.authority as Record<string, unknown>;
  try {
    parseRuntimeIngressCommandId(value.lastCommandId);
    parseRuntimeIngressAcknowledgementId(acknowledgement.acknowledgementId);
    parseRuntimeIngressEffectRef(acknowledgement.effectRef);
    parseRuntimeIngressRuntimeInstanceId(replayKey.runtimeInstanceId);
    parseMemberId(replayKey.deliveryOwnerId);
  } catch {
    return false;
  }
  return (
    isRuntimeIngressVerb(value.verb) &&
    (session.authorityScope as { allowedVerbs: unknown[] }).allowedVerbs.includes(value.verb) &&
    isPositiveSafeInteger(value.acceptedCount) &&
    isRuntimeIngressSequence(value.lastSequence) &&
    value.acceptedCount <= value.lastSequence &&
    acknowledgement.acknowledgementVersion === 1 &&
    isRuntimeIngressIsoInstant(acknowledgement.acceptedAtIso) &&
    replayKey.credentialId === session.credentialId &&
    replayKey.sessionId === session.sessionId &&
    replayKey.runtimeInstanceId === session.runtimeInstanceId &&
    replayKey.deliveryOwnerId === session.deliveryOwnerId &&
    replayKey.commandId === value.lastCommandId &&
    replayKey.sequence === value.lastSequence &&
    isRuntimeIngressIsoInstant(replayKey.observedAtIso) &&
    isAcceptedObservationFresh(replayKey.observedAtIso, acknowledgement.acceptedAtIso) &&
    authority.deploymentId === (session.authorityScope as { deploymentId: unknown }).deploymentId &&
    authority.teamId === (session.authorityScope as { teamId: unknown }).teamId &&
    authority.runId === (session.authorityScope as { runId: unknown }).runId &&
    authority.planGeneration ===
      (session.authorityScope as { planGeneration: unknown }).planGeneration &&
    authority.laneId === (session.authorityScope as { laneId: unknown }).laneId &&
    authority.providerId === (session.authorityScope as { providerId: unknown }).providerId &&
    authority.credentialGeneration ===
      (session.authorityScope as { credentialGeneration: unknown }).credentialGeneration &&
    authority.verb === value.verb
  );
}

function isChronologicalSessionWindow(
  bootstrapAcceptedAtIso: string,
  lastAcceptedAtIso: string
): boolean {
  const bootstrapAcceptedAt = runtimeIngressInstantEpochMs(bootstrapAcceptedAtIso);
  const lastAcceptedAt = runtimeIngressInstantEpochMs(lastAcceptedAtIso);
  return (
    bootstrapAcceptedAt !== null && lastAcceptedAt !== null && bootstrapAcceptedAt <= lastAcceptedAt
  );
}

function isAcceptedObservationFresh(observedAtIso: string, acceptedAtIso: string): boolean {
  const observedAt = runtimeIngressInstantEpochMs(observedAtIso);
  const acceptedAt = runtimeIngressInstantEpochMs(acceptedAtIso);
  return (
    observedAt !== null &&
    acceptedAt !== null &&
    observedAt <= acceptedAt + RUNTIME_INGRESS_MAX_FUTURE_SKEW_MS &&
    acceptedAt - observedAt <= RUNTIME_INGRESS_MAX_EVENT_AGE_MS
  );
}

function isAcknowledgementBoundToReplayKey(
  acknowledgement: RuntimeIngressEffectAcknowledgement,
  replayKey: RuntimeIngressReplayKey
): boolean {
  return (
    acknowledgement.acknowledgementVersion === 1 &&
    acknowledgement.replayKey === replayKey &&
    areRuntimeIngressAuthoritiesExact(acknowledgement.replayKey.authority, replayKey.authority)
  );
}

function classifyRuntimeIngressEventFreshness(
  observedAtIso: string,
  acceptedAtIso: string,
  credentialIssuedAtIso: string,
  previousObservedAtIso: string | null,
  previousAcceptedAtIso: string | null
): 'fresh' | 'not_fresh' | 'out_of_order' {
  const observedAt = runtimeIngressInstantEpochMs(observedAtIso);
  const acceptedAt = runtimeIngressInstantEpochMs(acceptedAtIso);
  const credentialIssuedAt = runtimeIngressInstantEpochMs(credentialIssuedAtIso);
  if (observedAt === null || acceptedAt === null || credentialIssuedAt === null) {
    return 'not_fresh';
  }
  if (
    acceptedAt < credentialIssuedAt ||
    observedAt > acceptedAt + RUNTIME_INGRESS_MAX_FUTURE_SKEW_MS ||
    acceptedAt - observedAt > RUNTIME_INGRESS_MAX_EVENT_AGE_MS
  ) {
    return 'not_fresh';
  }
  const previousObservedAt =
    previousObservedAtIso === null ? null : runtimeIngressInstantEpochMs(previousObservedAtIso);
  const previousAcceptedAt =
    previousAcceptedAtIso === null ? null : runtimeIngressInstantEpochMs(previousAcceptedAtIso);
  if (
    (previousObservedAtIso !== null && previousObservedAt === null) ||
    (previousAcceptedAtIso !== null && previousAcceptedAt === null)
  ) {
    return 'not_fresh';
  }
  if (
    (previousObservedAt !== null && observedAt <= previousObservedAt) ||
    (previousAcceptedAt !== null && acceptedAt < previousAcceptedAt)
  ) {
    return 'out_of_order';
  }
  return 'fresh';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
