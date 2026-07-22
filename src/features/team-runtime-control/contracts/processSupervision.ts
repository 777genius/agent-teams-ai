import {
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
  type RunId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import { parseExecutionUnitId } from './runtimePlan';

import type {
  CompositeRuntimePlanHash,
  ExecutionUnitId,
  ResolvedRuntimeBinaryPolicy,
  Sha256Hash,
} from './runtimePlan';

declare const processSupervisionIdBrand: unique symbol;

type ProcessSupervisionId<Name extends string> = string & {
  readonly [processSupervisionIdBrand]: Name;
};

/** Random lookup key. It is never a PID, PGID, or encoded native handle. */
export type OwnedProcessRef = ProcessSupervisionId<'OwnedProcessRef'>;
export type SpawnNonce = ProcessSupervisionId<'SpawnNonce'>;
export type AnchorChannelRef = ProcessSupervisionId<'AnchorChannelRef'>;
export type AnchorIdentityRef = ProcessSupervisionId<'AnchorIdentityRef'>;
export type OwningProcessIdentityRef = ProcessSupervisionId<'OwningProcessIdentityRef'>;
export type MainProcessIdentityRef = ProcessSupervisionId<'MainProcessIdentityRef'>;
export type ProcessControllerInstanceId = ProcessSupervisionId<'ProcessControllerInstanceId'>;

export const PROCESS_SUPERVISION_PROTOCOL_VERSION = 1 as const;
export type ProcessSupervisionProtocolVersion = typeof PROCESS_SUPERVISION_PROTOCOL_VERSION;

export const PROCESS_SUPERVISION_MAX_FRAME_BYTES = 4_096;
export const PROCESS_SUPERVISION_MAX_STATUS_STREAM_BYTES = 64 * 1_024;
export const PROCESS_SUPERVISION_MAX_STATUS_FRAMES = 256;

export interface ProcessOwnershipPlanRef {
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly generation: number;
  readonly planHash: CompositeRuntimePlanHash;
}

export interface ProcessOwnershipScope {
  readonly planRef: ProcessOwnershipPlanRef;
  readonly executionUnitId: ExecutionUnitId;
}

export interface ProcessWorkspaceBinding {
  readonly workspaceId: WorkspaceId;
  readonly registrationRevision: number;
  readonly bindingGeneration: number;
  readonly mountGeneration: number;
}

export const PROCESS_OWNER_ATTESTATION_VERSION = 1 as const;

/**
 * Boot-local evidence returned by the trusted spawn owner. It is independent of argv and status
 * bytes, so a child-controlled ready frame cannot invent the anchor that owns its lifecycle.
 */
export interface ProcessOwnerAttestation {
  readonly attestationVersion: typeof PROCESS_OWNER_ATTESTATION_VERSION;
  readonly processRef: OwnedProcessRef;
  readonly scope: ProcessOwnershipScope;
  readonly workspaceBinding: ProcessWorkspaceBinding;
  readonly spawnNonceDigest: Sha256Hash;
  readonly channelRef: AnchorChannelRef;
  readonly owningProcessIdentityRef: OwningProcessIdentityRef;
  readonly anchorIdentityRef: AnchorIdentityRef;
}

export type ProcessBinaryBinding = ResolvedRuntimeBinaryPolicy;

export interface ProcessStopFence extends ProcessOwnershipScope {
  readonly processRef: OwnedProcessRef;
}

export type ProcessSupervisionFailureReason =
  | 'cancelled'
  | 'timed_out'
  | 'invalid_request'
  | 'argv_digest_mismatch'
  | 'ownership_conflict'
  | 'concurrency_conflict'
  | 'store_unavailable'
  | 'channel_unavailable'
  | 'protocol_error'
  | 'not_owned'
  | 'unclassified_residual';

export class ProcessSupervisionTimeoutError extends Error {
  readonly code = 'process-supervision-timeout' as const;

  constructor(readonly operation: string) {
    super(`process-supervision-timeout:${operation}`);
    this.name = 'ProcessSupervisionTimeoutError';
  }
}

export class ProcessSupervisionCancellationError extends Error {
  readonly code = 'process-supervision-cancelled' as const;

  constructor(readonly operation: string) {
    super(`process-supervision-cancelled:${operation}`);
    this.name = 'ProcessSupervisionCancellationError';
  }
}

export class ProcessSupervisionProtocolError extends Error {
  readonly code = 'process-supervision-protocol-error' as const;

  constructor(readonly reason: string) {
    super(`process-supervision-protocol-error:${reason}`);
    this.name = 'ProcessSupervisionProtocolError';
  }
}

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const SHA_256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function parseOpaqueRef<Name extends string>(
  value: unknown,
  diagnostic: string
): ProcessSupervisionId<Name> {
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value)) {
    throw new TypeError(diagnostic);
  }
  return value as ProcessSupervisionId<Name>;
}

export const parseOwnedProcessRef = (value: unknown): OwnedProcessRef =>
  parseOpaqueRef<'OwnedProcessRef'>(value, 'owned-process-ref-invalid');
export const parseSpawnNonce = (value: unknown): SpawnNonce =>
  parseOpaqueRef<'SpawnNonce'>(value, 'spawn-nonce-invalid');
export const parseAnchorChannelRef = (value: unknown): AnchorChannelRef =>
  parseOpaqueRef<'AnchorChannelRef'>(value, 'anchor-channel-ref-invalid');
export const parseAnchorIdentityRef = (value: unknown): AnchorIdentityRef =>
  parseOpaqueRef<'AnchorIdentityRef'>(value, 'anchor-identity-ref-invalid');
export const parseOwningProcessIdentityRef = (value: unknown): OwningProcessIdentityRef =>
  parseOpaqueRef<'OwningProcessIdentityRef'>(value, 'owning-process-identity-ref-invalid');
export const parseMainProcessIdentityRef = (value: unknown): MainProcessIdentityRef =>
  parseOpaqueRef<'MainProcessIdentityRef'>(value, 'main-process-identity-ref-invalid');
export const parseProcessControllerInstanceId = (value: unknown): ProcessControllerInstanceId =>
  parseOpaqueRef<'ProcessControllerInstanceId'>(value, 'process-controller-instance-id-invalid');

export function parseProcessSupervisionSha256(value: unknown): Sha256Hash {
  if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
    throw new TypeError('process-supervision-sha256-invalid');
  }
  return value as Sha256Hash;
}

export function isExactProcessOwnershipPlanRef(
  left: ProcessOwnershipPlanRef,
  right: ProcessOwnershipPlanRef
): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.planHash === right.planHash
  );
}

export function isExactProcessOwnershipScope(
  left: ProcessOwnershipScope,
  right: ProcessOwnershipScope
): boolean {
  return (
    isExactProcessOwnershipPlanRef(left.planRef, right.planRef) &&
    left.executionUnitId === right.executionUnitId
  );
}

export function isExactProcessWorkspaceBinding(
  left: ProcessWorkspaceBinding,
  right: ProcessWorkspaceBinding
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.registrationRevision === right.registrationRevision &&
    left.bindingGeneration === right.bindingGeneration &&
    left.mountGeneration === right.mountGeneration
  );
}

export function parseProcessOwnerAttestation(value: unknown): ProcessOwnerAttestation {
  const record = requireExactPlainRecord(value, [
    'attestationVersion',
    'processRef',
    'scope',
    'workspaceBinding',
    'spawnNonceDigest',
    'channelRef',
    'owningProcessIdentityRef',
    'anchorIdentityRef',
  ]);
  if (record.attestationVersion !== PROCESS_OWNER_ATTESTATION_VERSION) {
    throw new TypeError('process-owner-attestation-version-invalid');
  }
  const scope = requireExactPlainRecord(record.scope, ['planRef', 'executionUnitId']);
  const planRef = requireExactPlainRecord(scope.planRef, [
    'teamId',
    'runId',
    'generation',
    'planHash',
  ]);
  const workspace = requireExactPlainRecord(record.workspaceBinding, [
    'workspaceId',
    'registrationRevision',
    'bindingGeneration',
    'mountGeneration',
  ]);
  if (
    !isPositiveSafeInteger(planRef.generation) ||
    !isPositiveSafeInteger(workspace.registrationRevision) ||
    !isPositiveSafeInteger(workspace.bindingGeneration) ||
    !isPositiveSafeInteger(workspace.mountGeneration)
  ) {
    throw new TypeError('process-owner-attestation-binding-invalid');
  }

  return Object.freeze({
    attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
    processRef: parseOwnedProcessRef(record.processRef),
    scope: Object.freeze({
      planRef: Object.freeze({
        teamId: parseTeamId(planRef.teamId),
        runId: parseRunId(planRef.runId),
        generation: planRef.generation,
        planHash: parseProcessSupervisionSha256(
          planRef.planHash
        ) as ProcessOwnershipPlanRef['planHash'],
      }),
      executionUnitId: parseExecutionUnitId(scope.executionUnitId),
    }),
    workspaceBinding: Object.freeze({
      workspaceId: parseWorkspaceId(workspace.workspaceId),
      registrationRevision: workspace.registrationRevision,
      bindingGeneration: workspace.bindingGeneration,
      mountGeneration: workspace.mountGeneration,
    }),
    spawnNonceDigest: parseProcessSupervisionSha256(record.spawnNonceDigest),
    channelRef: parseAnchorChannelRef(record.channelRef),
    owningProcessIdentityRef: parseOwningProcessIdentityRef(record.owningProcessIdentityRef),
    anchorIdentityRef: parseAnchorIdentityRef(record.anchorIdentityRef),
  });
}

export function isExactProcessOwnerAttestation(
  left: ProcessOwnerAttestation,
  right: ProcessOwnerAttestation
): boolean {
  return (
    left.attestationVersion === right.attestationVersion &&
    left.processRef === right.processRef &&
    isExactProcessOwnershipScope(left.scope, right.scope) &&
    isExactProcessWorkspaceBinding(left.workspaceBinding, right.workspaceBinding) &&
    left.spawnNonceDigest === right.spawnNonceDigest &&
    left.channelRef === right.channelRef &&
    left.owningProcessIdentityRef === right.owningProcessIdentityRef &&
    left.anchorIdentityRef === right.anchorIdentityRef
  );
}

function requireExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('process-owner-attestation-object-invalid');
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('process-owner-attestation-fields-invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.get === 'function' ||
        typeof descriptor.set === 'function'
    )
  ) {
    throw new TypeError('process-owner-attestation-descriptor-invalid');
  }
  const actualKeys = (ownKeys as string[]).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new TypeError('process-owner-attestation-fields-invalid');
  }
  return record;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
