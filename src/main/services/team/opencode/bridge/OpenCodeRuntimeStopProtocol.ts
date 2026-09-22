import { createHash } from 'crypto';

import {
  type OpenCodeBridgeRuntimeSnapshot,
  type OpenCodeTeamBridgeDiagnostic,
  stableHash,
} from './OpenCodeBridgeCommandContract';

export interface OpenCodeStopTeamCommandBody {
  runId: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath?: string;
  expectedCapabilitySnapshotId?: string | null;
  manifestHighWatermark?: number | null;
  reason: string;
  force?: boolean;
  allowEmptyLaneStop?: boolean;
}
export interface OpenCodeStopTeamCommandData {
  runId: string;
  stopped: boolean;
  members: Record<string, { sessionId?: string; stopped: boolean; diagnostics: string[] }>;
  warnings: string[];
  diagnostics: OpenCodeTeamBridgeDiagnostic[];
  idempotencyKey?: string;
  manifestHighWatermark?: number | null;
  runtimeStoreManifestHighWatermark?: number | null;
}

/** Version 1 wire contract owned by the runtime session store. */
export interface RuntimeStopTarget {
  teamId: string;
  laneId: string;
  runId: string;
  projectPath: string;
  capabilitySnapshotId: string;
  expectedBehaviorFingerprint: string;
  members: { memberName: string; sessionId: string }[];
}
export interface RuntimeStopRequest {
  contractVersion: 1;
  originalRequestId: string;
  idempotencyKey: string;
  target: RuntimeStopTarget;
}
export interface RuntimeStopBinding {
  memberName: string;
  sessionId: string;
  hostKey: string;
  createdAt: string;
}
export interface RuntimeStopObservation {
  status: 'reconciled_stopped';
  target: RuntimeStopTarget;
  binding: RuntimeStopBinding[];
  sessionSetToken: string;
}
export interface RuntimeStopReceipt {
  request: RuntimeStopRequest;
  binding: RuntimeStopBinding[];
  runtime: OpenCodeBridgeRuntimeSnapshot;
  status: 'completed';
  data: OpenCodeStopTeamCommandData;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Stop recovery object; reconciliation required');
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Invalid original Stop identity; reconciliation unknown');
  return value;
}
export function parseRuntimeStopRequest(value: unknown): RuntimeStopRequest {
  const request = object(value);
  const raw = object(request.target);
  if (request.contractVersion !== 1) throw new Error('Unsupported Stop recovery contract version');
  if (!Array.isArray(raw.members) || !raw.members.length)
    throw new Error('Stop reconciliation unknown: original session set missing');
  const members = raw.members
    .map((value) => {
      const member = object(value);
      return { memberName: identity(member.memberName), sessionId: identity(member.sessionId) };
    })
    .sort((a, b) => a.memberName.localeCompare(b.memberName));
  if (
    new Set(members.map((m) => m.memberName)).size !== members.length ||
    new Set(members.map((m) => m.sessionId)).size !== members.length
  )
    throw new Error('Ambiguous original Stop session set');
  const capabilitySnapshotId = identity(raw.capabilitySnapshotId);
  const expectedBehaviorFingerprint = identity(raw.expectedBehaviorFingerprint);
  if (
    !/^opencode:[a-f0-9]{32}$/.test(capabilitySnapshotId) ||
    !/^[a-f0-9]{64}$/.test(expectedBehaviorFingerprint)
  )
    throw new Error('Invalid original Stop capability/behavior identity');
  return {
    contractVersion: 1,
    originalRequestId: identity(request.originalRequestId),
    idempotencyKey: identity(request.idempotencyKey),
    target: {
      teamId: identity(raw.teamId),
      laneId: identity(raw.laneId),
      runId: identity(raw.runId),
      projectPath: identity(raw.projectPath),
      capabilitySnapshotId,
      expectedBehaviorFingerprint,
      members,
    },
  };
}
export function validateRuntimeStopData(
  value: unknown,
  request: RuntimeStopRequest
): OpenCodeStopTeamCommandData {
  const data = object(value);
  const members = object(data.members);
  if (
    data.runId !== request.target.runId ||
    typeof data.stopped !== 'boolean' ||
    !Array.isArray(data.warnings) ||
    !data.warnings.every((v) => typeof v === 'string') ||
    !Array.isArray(data.diagnostics) ||
    !data.diagnostics.every((value) => {
      const d = object(value);
      return (
        typeof d.code === 'string' &&
        typeof d.message === 'string' &&
        typeof d.severity === 'string' &&
        ['info', 'warning', 'error'].includes(d.severity)
      );
    }) ||
    (data.idempotencyKey !== undefined && data.idempotencyKey !== request.idempotencyKey) ||
    ![data.manifestHighWatermark, data.runtimeStoreManifestHighWatermark].every(
      (v) => v === undefined || v === null || (Number.isSafeInteger(v) && Number(v) >= 0)
    ) ||
    Object.keys(members).length !== request.target.members.length ||
    !request.target.members.every((target) => {
      const member = object(members[target.memberName]);
      return (
        member.sessionId === target.sessionId &&
        typeof member.stopped === 'boolean' &&
        Array.isArray(member.diagnostics) &&
        member.diagnostics.every((v) => typeof v === 'string')
      );
    }) ||
    data.stopped !== Object.values(members).every((v) => object(v).stopped === true)
  )
    throw new Error('Invalid durable Stop result; reconciliation required');
  return structuredClone(value) as OpenCodeStopTeamCommandData;
}
function validateBinding(
  value: unknown,
  target: RuntimeStopTarget
): asserts value is RuntimeStopBinding[] {
  if (
    !Array.isArray(value) ||
    value.length !== target.members.length ||
    !target.members.every((m, i) => {
      const bound = object(value[i]);
      return (
        bound.memberName === m.memberName &&
        bound.sessionId === m.sessionId &&
        typeof bound.hostKey === 'string' &&
        !!bound.hostKey &&
        typeof bound.createdAt === 'string' &&
        !!bound.createdAt
      );
    })
  )
    throw new Error('Stop binding mismatch; reconciliation required');
}
export function validateRuntimeStopReceipt(
  value: unknown,
  expected: RuntimeStopRequest
): RuntimeStopReceipt {
  const receipt = object(value);
  const request = parseRuntimeStopRequest(receipt.request);
  const runtime = object(receipt.runtime);
  if (
    stableHash(request) !== stableHash(expected) ||
    receipt.status !== 'completed' ||
    runtime.providerId !== 'opencode' ||
    runtime.capabilitySnapshotId !== request.target.capabilitySnapshotId ||
    ![runtime.binaryPath, runtime.binaryFingerprint, runtime.version].every(
      (v) => v === null || typeof v === 'string'
    )
  )
    throw new Error('Stop receipt target/runtime mismatch; reconciliation required');
  validateBinding(receipt.binding, request.target);
  validateRuntimeStopData(receipt.data, request);
  return structuredClone(value) as RuntimeStopReceipt;
}
export function validateRuntimeStopObservation(
  value: unknown,
  request: RuntimeStopRequest
): RuntimeStopObservation {
  const observation = object(value);
  if (
    observation.status !== 'reconciled_stopped' ||
    stableHash(observation.target) !== stableHash(request.target)
  )
    throw new Error(`Stop reconciliation ${String(observation.status)}; exact target required`);
  validateBinding(observation.binding, request.target);
  const token = createHash('sha256')
    .update(JSON.stringify({ target: request.target, binding: observation.binding }))
    .digest('hex');
  if (observation.sessionSetToken !== token)
    throw new Error('Stop observation session-set token mismatch');
  return structuredClone(value) as RuntimeStopObservation;
}
