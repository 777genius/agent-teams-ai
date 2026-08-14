import {
  type DeploymentId,
  type MemberId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
  type RunId,
  type TeamId,
} from '@shared/contracts/hosted';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { sha256Hex } from '@shared/utils/sha256';

import { type LaneId, parseLaneId } from './runtimePlan';

import type { TeamProviderId } from '@shared/types';

/**
 * Browser-safe descriptions of the runtime-permission bridge. They contain
 * only opaque identifiers and redacted approval content; bearer material,
 * filesystem locations, process handles, and provider clients stay outside
 * this contract.
 */

export const RUNTIME_PERMISSION_APPROVAL_SCHEMA_VERSION = 1 as const;

export const RUNTIME_PERMISSION_APPROVAL_CATEGORIES = Object.freeze([
  'file_change',
  'command',
  'network',
  'other',
] as const);

export type RuntimePermissionApprovalCategory =
  (typeof RUNTIME_PERMISSION_APPROVAL_CATEGORIES)[number];

export interface RuntimePermissionApprovalPreview {
  readonly previewRef: string;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly isBinary: boolean;
}

/**
 * Provider-supplied descriptive data only. It deliberately has no team, run,
 * lane, provider, operator, scope, generation, decision, or authority field.
 * The delivery ref is an opaque provider target and is re-bound to persisted
 * ingress authority by the lifecycle delivery port before it can be answered.
 */
export interface RuntimePermissionApprovalPayload {
  readonly schemaVersion: typeof RUNTIME_PERMISSION_APPROVAL_SCHEMA_VERSION;
  readonly deliveryRef: string;
  readonly category: RuntimePermissionApprovalCategory;
  readonly summary: string;
  readonly expiresAtMs: number | null;
  readonly preview: RuntimePermissionApprovalPreview | null;
}

/**
 * Copied from the committed runtime-ingress credential/session scope. No
 * provider body field is allowed to populate this structure.
 */
export interface RuntimePermissionApprovalIngressAuthority {
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly planGeneration: number;
  readonly laneId: LaneId;
  readonly providerId: TeamProviderId;
  readonly credentialGeneration: number;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly deliveryOwnerId: MemberId;
}

export interface RuntimePermissionApprovalIdentity {
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly requestId: string;
  readonly approvalId: string;
  readonly approvalGeneration: string;
}

const RUNTIME_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DELIVERY_REF = /^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const PREVIEW_REF = /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const EFFECT_REF = /^effect:([a-f0-9]{64})$/;
const HOST_PATH =
  /(?:^|[\s"'`(])(?:~[\\/]|[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|etc|private|mnt|Volumes|opt)\/)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseRuntimeIdentifier(value: unknown, diagnostic: string): string {
  if (typeof value !== 'string' || !RUNTIME_IDENTIFIER.test(value)) {
    throw new TypeError(diagnostic);
  }
  return value;
}

function parseText(
  value: unknown,
  diagnostic: string,
  maximum: number,
  allowEmpty = false,
  allowNewlines = false
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    HOST_PATH.test(value)
  ) {
    throw new TypeError(diagnostic);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed = code === 9 || (allowNewlines && (code === 10 || code === 13));
    if ((code <= 31 && !allowed) || code === 127) throw new TypeError(diagnostic);
  }
  return value;
}

function parsePreview(value: unknown): RuntimePermissionApprovalPreview {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['previewRef', 'content', 'byteLength', 'truncated', 'isBinary']) ||
    typeof value.previewRef !== 'string' ||
    !PREVIEW_REF.test(value.previewRef) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    (value.byteLength as number) > 64 * 1024 ||
    typeof value.truncated !== 'boolean' ||
    typeof value.isBinary !== 'boolean'
  ) {
    throw new TypeError('runtime-permission-approval-preview-invalid');
  }
  const content = parseText(
    value.content,
    'runtime-permission-approval-preview-invalid',
    64 * 1024,
    true,
    true
  );
  const byteLength = value.byteLength as number;
  if (
    new TextEncoder().encode(content).byteLength > byteLength ||
    (value.isBinary && content !== '')
  ) {
    throw new TypeError('runtime-permission-approval-preview-invalid');
  }
  return Object.freeze({
    previewRef: value.previewRef,
    content,
    byteLength,
    truncated: value.truncated,
    isBinary: value.isBinary,
  });
}

export function parseRuntimePermissionApprovalPayload(
  value: unknown
): RuntimePermissionApprovalPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'deliveryRef',
      'category',
      'summary',
      'expiresAtMs',
      'preview',
    ]) ||
    value.schemaVersion !== RUNTIME_PERMISSION_APPROVAL_SCHEMA_VERSION ||
    typeof value.deliveryRef !== 'string' ||
    !DELIVERY_REF.test(value.deliveryRef) ||
    !RUNTIME_PERMISSION_APPROVAL_CATEGORIES.includes(
      value.category as RuntimePermissionApprovalCategory
    ) ||
    (value.expiresAtMs !== null &&
      (!Number.isSafeInteger(value.expiresAtMs) || (value.expiresAtMs as number) < 0))
  ) {
    throw new TypeError('runtime-permission-approval-payload-invalid');
  }
  return Object.freeze({
    schemaVersion: RUNTIME_PERMISSION_APPROVAL_SCHEMA_VERSION,
    deliveryRef: value.deliveryRef,
    category: value.category as RuntimePermissionApprovalCategory,
    summary: parseText(value.summary, 'runtime-permission-approval-summary-invalid', 512),
    expiresAtMs: value.expiresAtMs as number | null,
    preview: value.preview === null ? null : parsePreview(value.preview),
  });
}

export function parseRuntimePermissionApprovalIngressAuthority(
  value: unknown
): RuntimePermissionApprovalIngressAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'deploymentId',
      'teamId',
      'runId',
      'planGeneration',
      'laneId',
      'providerId',
      'credentialGeneration',
      'credentialId',
      'sessionId',
      'runtimeInstanceId',
      'deliveryOwnerId',
    ]) ||
    !Number.isSafeInteger(value.planGeneration) ||
    (value.planGeneration as number) < 1 ||
    !isTeamProviderId(value.providerId) ||
    !Number.isSafeInteger(value.credentialGeneration) ||
    (value.credentialGeneration as number) < 1
  ) {
    throw new TypeError('runtime-permission-approval-ingress-authority-invalid');
  }
  const planGeneration = value.planGeneration as number;
  const credentialGeneration = value.credentialGeneration as number;
  return Object.freeze({
    deploymentId: parseDeploymentId(value.deploymentId),
    teamId: parseTeamId(value.teamId),
    runId: parseRunId(value.runId),
    planGeneration,
    laneId: parseLaneId(value.laneId),
    providerId: value.providerId,
    credentialGeneration,
    credentialId: parseRuntimeIdentifier(
      value.credentialId,
      'runtime-permission-approval-credential-id-invalid'
    ),
    sessionId: parseRuntimeIdentifier(
      value.sessionId,
      'runtime-permission-approval-session-id-invalid'
    ),
    runtimeInstanceId: parseRuntimeIdentifier(
      value.runtimeInstanceId,
      'runtime-permission-approval-runtime-instance-id-invalid'
    ),
    deliveryOwnerId: parseMemberId(value.deliveryOwnerId),
  });
}

export function isExactRuntimePermissionApprovalIngressAuthority(
  left: RuntimePermissionApprovalIngressAuthority,
  right: RuntimePermissionApprovalIngressAuthority
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.planGeneration === right.planGeneration &&
    left.laneId === right.laneId &&
    left.providerId === right.providerId &&
    left.credentialGeneration === right.credentialGeneration &&
    left.credentialId === right.credentialId &&
    left.sessionId === right.sessionId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.deliveryOwnerId === right.deliveryOwnerId
  );
}

/** Canonical identity is the authenticated team/run plus the runtime request id. */
export function deriveRuntimePermissionApprovalIdentity(
  input: Readonly<{
    teamId: unknown;
    runId: unknown;
    requestId: unknown;
    effectRef: unknown;
  }>
): RuntimePermissionApprovalIdentity {
  if (typeof input.effectRef !== 'string') {
    throw new TypeError('runtime-permission-approval-effect-ref-invalid');
  }
  const match = EFFECT_REF.exec(input.effectRef);
  if (!match) throw new TypeError('runtime-permission-approval-effect-ref-invalid');
  const teamId = parseTeamId(input.teamId);
  const runId = parseRunId(input.runId);
  const requestId = parseRuntimeIdentifier(
    input.requestId,
    'runtime-permission-approval-request-id-invalid'
  );
  const digest = match[1];
  const identityDigest = sha256Hex(
    JSON.stringify({ schemaVersion: 1, teamId, runId, requestId })
  );
  return Object.freeze({
    teamId,
    runId,
    requestId,
    approvalId: `approval_${identityDigest.slice(0, 32)}`,
    approvalGeneration: `generation_runtime-permission-${digest}`,
  });
}
