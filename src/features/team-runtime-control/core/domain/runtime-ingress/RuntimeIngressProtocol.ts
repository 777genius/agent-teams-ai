import type { LaneId } from '../../../contracts';
import type { DeploymentId, MemberId, RunId, TeamId } from '@shared/contracts/hosted';
import type { TeamProviderId } from '@shared/types';

declare const runtimeIngressProtocolBrand: unique symbol;

type RuntimeIngressProtocolId<Name extends string> = string & {
  readonly [runtimeIngressProtocolBrand]: Name;
};

export type RuntimeIngressCredentialId = RuntimeIngressProtocolId<'RuntimeIngressCredentialId'>;
export type RuntimeIngressSessionId = RuntimeIngressProtocolId<'RuntimeIngressSessionId'>;
export type RuntimeIngressCommandId = RuntimeIngressProtocolId<'RuntimeIngressCommandId'>;
export type RuntimeIngressAcknowledgementId =
  RuntimeIngressProtocolId<'RuntimeIngressAcknowledgementId'>;
export type RuntimeIngressEffectRef = RuntimeIngressProtocolId<'RuntimeIngressEffectRef'>;
export type RuntimeIngressPresentedSecret =
  RuntimeIngressProtocolId<'RuntimeIngressPresentedSecret'>;
export type RuntimeIngressRuntimeInstanceId =
  RuntimeIngressProtocolId<'RuntimeIngressRuntimeInstanceId'>;

export const RUNTIME_INGRESS_VERBS = Object.freeze([
  'runtime.bootstrap-checkin',
  'runtime.deliver-message',
  'runtime.task-event',
  'runtime.heartbeat',
  'runtime.permission-request',
] as const);

type KnownRuntimeIngressVerb = (typeof RUNTIME_INGRESS_VERBS)[number];

/**
 * The opaque branch preserves source compatibility for already-branded relay
 * fixtures; production values are admitted only by isRuntimeIngressVerb.
 */
export type RuntimeIngressVerb =
  | KnownRuntimeIngressVerb
  | RuntimeIngressProtocolId<'RuntimeIngressVerb'>;

export interface RuntimeIngressCredentialScope {
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly planGeneration: number;
  readonly laneId: LaneId;
  readonly providerId: TeamProviderId;
  readonly credentialGeneration: number;
  readonly allowedVerbs: readonly RuntimeIngressVerb[];
}

/** Authority selected by the relay/route, never by the provider body. */
export interface RuntimeIngressAuthority {
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly planGeneration: number;
  readonly laneId: LaneId;
  readonly providerId: TeamProviderId;
  readonly credentialGeneration: number;
  readonly verb: RuntimeIngressVerb;
}

/**
 * Repeated body identifiers are assertions only. They are checked against the
 * persisted credential scope and are never used to select an authority.
 */
export interface RuntimeIngressBodyIdentityAssertions {
  readonly teamId?: TeamId;
  readonly runId?: RunId;
  readonly laneId?: LaneId;
  readonly providerId?: TeamProviderId;
}

export interface RuntimeIngressReplayKey {
  readonly authority: RuntimeIngressAuthority;
  readonly credentialId: RuntimeIngressCredentialId;
  readonly sessionId: RuntimeIngressSessionId;
  readonly runtimeInstanceId: RuntimeIngressRuntimeInstanceId;
  readonly deliveryOwnerId: MemberId;
  readonly commandId: RuntimeIngressCommandId;
  readonly sequence: number;
  readonly observedAtIso: string;
}

/**
 * Payload JSON must already be canonicalized by a trusted input adapter. Core
 * authority never comes from fields inside payloadJson.
 */
export interface RuntimeIngressCanonicalEffect {
  readonly payloadJson: string;
}

export interface RuntimeIngressEffectAcknowledgement {
  readonly acknowledgementVersion: 1;
  readonly acknowledgementId: RuntimeIngressAcknowledgementId;
  readonly effectRef: RuntimeIngressEffectRef;
  readonly replayKey: RuntimeIngressReplayKey;
  readonly acceptedAtIso: string;
}

export interface PresentedRuntimeIngressCredential {
  readonly credentialId: RuntimeIngressCredentialId;
  readonly secret: RuntimeIngressPresentedSecret;
}

const RUNTIME_INGRESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseRuntimeIngressProtocolId<Name extends string>(
  value: unknown,
  diagnostic: string
): RuntimeIngressProtocolId<Name> {
  if (typeof value !== 'string' || !RUNTIME_INGRESS_ID_PATTERN.test(value)) {
    throw new TypeError(diagnostic);
  }
  return value as RuntimeIngressProtocolId<Name>;
}

export const parseRuntimeIngressCredentialId = (value: unknown): RuntimeIngressCredentialId =>
  parseRuntimeIngressProtocolId<'RuntimeIngressCredentialId'>(
    value,
    'runtime-ingress-credential-id-invalid'
  );

export const parseRuntimeIngressSessionId = (value: unknown): RuntimeIngressSessionId =>
  parseRuntimeIngressProtocolId<'RuntimeIngressSessionId'>(
    value,
    'runtime-ingress-session-id-invalid'
  );

export const parseRuntimeIngressCommandId = (value: unknown): RuntimeIngressCommandId =>
  parseRuntimeIngressProtocolId<'RuntimeIngressCommandId'>(
    value,
    'runtime-ingress-command-id-invalid'
  );

export const parseRuntimeIngressAcknowledgementId = (
  value: unknown
): RuntimeIngressAcknowledgementId =>
  parseRuntimeIngressProtocolId<'RuntimeIngressAcknowledgementId'>(
    value,
    'runtime-ingress-acknowledgement-id-invalid'
  );

export const parseRuntimeIngressEffectRef = (value: unknown): RuntimeIngressEffectRef =>
  parseRuntimeIngressProtocolId<'RuntimeIngressEffectRef'>(
    value,
    'runtime-ingress-effect-ref-invalid'
  );

export const parseRuntimeIngressPresentedSecret = (value: unknown): RuntimeIngressPresentedSecret =>
  parseRuntimeIngressProtocolId<'RuntimeIngressPresentedSecret'>(
    value,
    'runtime-ingress-presented-secret-invalid'
  );

export const parseRuntimeIngressRuntimeInstanceId = (
  value: unknown
): RuntimeIngressRuntimeInstanceId =>
  parseRuntimeIngressProtocolId<'RuntimeIngressRuntimeInstanceId'>(
    value,
    'runtime-ingress-runtime-instance-id-invalid'
  );

export function isRuntimeIngressVerb(value: unknown): value is RuntimeIngressVerb {
  return (RUNTIME_INGRESS_VERBS as readonly unknown[]).includes(value);
}

export function isRuntimeIngressSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isRuntimeIngressIsoInstant(value: unknown): value is string {
  return runtimeIngressInstantEpochMs(value) !== null;
}

/**
 * Parses only canonical UTC millisecond instants. The round-trip rejects
 * normalized invalid calendar values such as February 30 and keeps ordering
 * numeric instead of relying on string comparison.
 */
export function runtimeIngressInstantEpochMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) return null;
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) return null;
  try {
    return new Date(epochMs).toISOString() === value ? epochMs : null;
  } catch {
    return null;
  }
}

export function compareRuntimeIngressIsoInstants(left: unknown, right: unknown): -1 | 0 | 1 | null {
  const leftEpochMs = runtimeIngressInstantEpochMs(left);
  const rightEpochMs = runtimeIngressInstantEpochMs(right);
  if (leftEpochMs === null || rightEpochMs === null) return null;
  return leftEpochMs < rightEpochMs ? -1 : leftEpochMs > rightEpochMs ? 1 : 0;
}

export function isExactRuntimeIngressCredentialScope(
  left: RuntimeIngressCredentialScope,
  right: RuntimeIngressCredentialScope
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.planGeneration === right.planGeneration &&
    left.laneId === right.laneId &&
    left.providerId === right.providerId &&
    left.credentialGeneration === right.credentialGeneration &&
    areRuntimeIngressVerbSetsEqual(left.allowedVerbs, right.allowedVerbs)
  );
}

export function isCredentialScopeAuthorizedFor(
  scope: RuntimeIngressCredentialScope,
  authority: RuntimeIngressAuthority
): boolean {
  return (
    scope.deploymentId === authority.deploymentId &&
    scope.teamId === authority.teamId &&
    scope.runId === authority.runId &&
    scope.planGeneration === authority.planGeneration &&
    scope.laneId === authority.laneId &&
    scope.providerId === authority.providerId &&
    scope.credentialGeneration === authority.credentialGeneration &&
    scope.allowedVerbs.includes(authority.verb)
  );
}

export function doBodyIdentityAssertionsMatchAuthority(
  assertions: RuntimeIngressBodyIdentityAssertions | undefined,
  authority: RuntimeIngressAuthority
): boolean {
  if (!assertions) return true;
  return (
    (assertions.teamId === undefined || assertions.teamId === authority.teamId) &&
    (assertions.runId === undefined || assertions.runId === authority.runId) &&
    (assertions.laneId === undefined || assertions.laneId === authority.laneId) &&
    (assertions.providerId === undefined || assertions.providerId === authority.providerId)
  );
}

export function areRuntimeIngressAuthoritiesExact(
  left: RuntimeIngressAuthority,
  right: RuntimeIngressAuthority
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.planGeneration === right.planGeneration &&
    left.laneId === right.laneId &&
    left.providerId === right.providerId &&
    left.credentialGeneration === right.credentialGeneration &&
    left.verb === right.verb
  );
}

function areRuntimeIngressVerbSetsEqual(
  left: readonly RuntimeIngressVerb[],
  right: readonly RuntimeIngressVerb[]
): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return (
    leftSet.size === left.length &&
    new Set(right).size === right.length &&
    right.every((verb) => leftSet.has(verb))
  );
}
