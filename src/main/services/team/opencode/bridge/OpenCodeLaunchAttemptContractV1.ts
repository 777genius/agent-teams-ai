import { types as nodeUtilTypes } from 'node:util';

import { validateOpenCodeLaunchAttemptCorrelationV1 } from './OpenCodeLaunchAttemptCorrelationV1';

import type { OpenCodeLaunchRequestCorrelationAuthorityV1 } from './OpenCodeLaunchAttemptDigestV1';

export { createOpenCodeLaunchAttemptIdV1 } from './OpenCodeLaunchAttemptDigestV1';

export const OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION = 1 as const;

export type OpenCodeOpaqueIdentity = `sha256:${string}`;
export type OpenCodeLaunchAttemptOutcome =
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'reconciliation_required';
export type OpenCodeLaunchAttemptPhase =
  | 'profile_prepare'
  | 'retained_host_start'
  | 'provider_live_validate'
  | 'retained_host_mcp_proof'
  | 'execution_submit'
  | 'execution_poll'
  | 'member_materialize'
  | 'result_commit'
  | 'cleanup'
  | 'complete';
export type OpenCodeLaunchFailureKind =
  | 'pre_side_effect_transport'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'provider_plan_denied'
  | 'authentication_required'
  | 'external_dependency'
  | 'contract_violation'
  | 'candidate_budget_exhausted'
  | 'attempt_budget_exhausted'
  | 'deadline_before_partial'
  | 'deadline_after_partial'
  | 'unknown_transport_after_side_effect'
  | 'cancelled';
export type OpenCodeLaunchRetryDisposition =
  | 'automatic'
  | 'backoff'
  | 'user_action'
  | 'external_change'
  | 'continuation'
  | 'never';
export type OpenCodeLaunchFailureOrigin =
  | 'profile'
  | 'host'
  | 'catalog'
  | 'mcp'
  | 'provider'
  | 'session'
  | 'store'
  | 'deadline';
export type OpenCodeLaunchExhaustionScope =
  | 'attempt'
  | 'member'
  | 'profile'
  | 'host'
  | 'provider'
  | 'global';

export interface OpenCodeLaunchParentLinkage {
  sessionIdentity: OpenCodeOpaqueIdentity;
  messageIdentity: OpenCodeOpaqueIdentity;
}
export interface OpenCodeLaunchAttemptRequestBody {
  attemptId: string;
  payloadHash: string;
  generation: number;
  proofNonce: string;
  /** Orchestrator core replaces this wire placeholder with a fresh internal nonce. */
  parent: OpenCodeLaunchParentLinkage;
  providerId: string;
  modelId: string;
  requiredMcpTools: string[];
  continuationToken?: string;
  requireFreshRetainedHostProof: true;
  requestCorrelationDigest?: string;
}
export interface OpenCodeRetainedHostIdentity {
  hostKeyIdentity: OpenCodeOpaqueIdentity;
  processId: number;
  processStartedAtMs: number;
  profileScopeIdentity: OpenCodeOpaqueIdentity;
}
export interface OpenCodeLaunchFailureDetails {
  code: OpenCodeLaunchFailureKind;
  origin: OpenCodeLaunchFailureOrigin;
  retryDisposition: OpenCodeLaunchRetryDisposition;
  retryable: boolean;
  retryAfterMs?: number;
  phase: OpenCodeLaunchAttemptPhase;
  sideEffectsStarted: boolean;
  exhaustionScope?: OpenCodeLaunchExhaustionScope;
}
export interface OpenCodeLaunchAttemptDetails {
  contractVersion: 1;
  attemptId: string;
  idempotencyKey: 'attemptId';
  payloadHash: string;
  generation: number;
  inputDigest: string;
  immutableDigest: string;
  requestCorrelationDigest?: string;
  outcome: OpenCodeLaunchAttemptOutcome;
  phase: OpenCodeLaunchAttemptPhase;
  startedAt: number;
  absoluteDeadlineAt: number;
  workDeadlineAt: number;
  cleanupReserveMs: number;
  elapsedMs: number;
  providerId: string;
  modelId: string;
  profilePurpose: string;
  projectIdentity: OpenCodeOpaqueIdentity;
  profileIdentity: OpenCodeOpaqueIdentity;
  configIdentity: OpenCodeOpaqueIdentity;
  authIdentity: OpenCodeOpaqueIdentity;
  pluginPolicyIdentity: OpenCodeOpaqueIdentity;
  cacheIdentity: OpenCodeOpaqueIdentity;
  binaryIdentity: OpenCodeOpaqueIdentity;
  retainedHostIdentity: OpenCodeRetainedHostIdentity;
  processStartedAtMs?: number;
}
export interface OpenCodeRetainedHostProof {
  generation: number;
  attemptId: string;
  parent: OpenCodeLaunchParentLinkage;
  providerId: string;
  modelId: string;
  retainedHostIdentity: OpenCodeRetainedHostIdentity;
  observedMcpTools: string[];
  nonceHash: string;
  sessionIdentity: OpenCodeOpaqueIdentity;
  promptMessageIdentity: OpenCodeOpaqueIdentity;
  assistantMessageIdentity: OpenCodeOpaqueIdentity;
  verifiedAt: number;
  authorizationSource: 'fresh_live_attempt';
  cacheUsed: false;
  requestCorrelationDigest?: string;
}
export interface OpenCodeLaunchMemberLinkage {
  memberIdentity: OpenCodeOpaqueIdentity;
  sessionIdentity: OpenCodeOpaqueIdentity;
  bootstrapMessageIdentity: OpenCodeOpaqueIdentity;
  commitIdentity: OpenCodeOpaqueIdentity;
}
export interface OpenCodeLaunchMemberOutcomes {
  committed: OpenCodeLaunchMemberLinkage[];
  failed: Array<{ memberIdentity: OpenCodeOpaqueIdentity; failure: OpenCodeLaunchFailureDetails }>;
  pending: OpenCodeOpaqueIdentity[];
  cleanupPending: OpenCodeOpaqueIdentity[];
  continuationToken?: string;
}
export interface OpenCodeLaunchAttemptResponse {
  launchAttempt: OpenCodeLaunchAttemptDetails;
  proof?: OpenCodeRetainedHostProof;
  members: OpenCodeLaunchMemberOutcomes;
  failure?: OpenCodeLaunchFailureDetails;
}

export interface OpenCodeLaunchAttemptCorrelationRequest {
  attemptId: string;
  payloadHash: string;
  generation: number;
  proofNonce: string;
  parent: OpenCodeLaunchParentLinkage;
  providerId: string;
  modelId: string;
  requiredMcpTools: readonly string[];
  continuationToken?: string;
  requestCorrelationDigest?: string;
}

export type OpenCodeLaunchAttemptDecodeResult =
  | { ok: true; value: OpenCodeLaunchAttemptResponse }
  | { ok: false; field: string };

const FAILURE_POLICY = {
  pre_side_effect_transport: ['automatic', true, false],
  rate_limited: ['backoff', true, false],
  quota_exhausted: ['backoff', true, false],
  provider_plan_denied: ['external_change', true, false],
  authentication_required: ['user_action', true, false],
  external_dependency: ['external_change', true, false],
  contract_violation: ['never', false, false],
  candidate_budget_exhausted: ['backoff', true, false],
  attempt_budget_exhausted: ['never', false, false],
  deadline_before_partial: ['backoff', true, false],
  deadline_after_partial: ['continuation', true, true],
  unknown_transport_after_side_effect: ['never', false, true],
  cancelled: ['never', false, false],
} as const satisfies Record<
  OpenCodeLaunchFailureKind,
  readonly [OpenCodeLaunchRetryDisposition, boolean, boolean]
>;
const OUTCOMES = 'succeeded|partial|failed|cancelled|reconciliation_required'.split(
  '|'
) as OpenCodeLaunchAttemptOutcome[];
const PHASES =
  'profile_prepare|retained_host_start|provider_live_validate|retained_host_mcp_proof|execution_submit|execution_poll|member_materialize|result_commit|cleanup|complete'.split(
    '|'
  ) as OpenCodeLaunchAttemptPhase[];
const ORIGINS = 'profile|host|catalog|mcp|provider|session|store|deadline'.split(
  '|'
) as OpenCodeLaunchFailureOrigin[];
const EXHAUSTION_SCOPES = 'attempt|member|profile|host|provider|global'.split(
  '|'
) as OpenCodeLaunchExhaustionScope[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_IDENTITY = /^sha256:[0-9a-f]{64}$/;
const PROVIDER = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const MODEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:+@/-]{0,254}[a-zA-Z0-9])?$/;
const PURPOSE = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL = /^[a-z][a-z0-9_.:-]{0,127}$/;
const SENSITIVE_LOCATION = /(?:https?:\/\/|wss?:\/\/|@)/i;
const SENSITIVE_CREDENTIAL =
  /(?:bearer|secret|credential|authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
function record(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor' ||
      !('value' in descriptor)
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function inertArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null;
  return value;
}

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isIdentity(value: unknown): value is OpenCodeOpaqueIdentity {
  return typeof value === 'string' && OPAQUE_IDENTITY.test(value);
}
function isOpaqueToken(value: unknown): value is string {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !hasControlCharacter &&
    !SENSITIVE_LOCATION.test(value) &&
    !SENSITIVE_CREDENTIAL.test(value)
  );
}
function isCanonicalProvider(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER.test(value);
}
function isExactModel(value: unknown, providerId: unknown): value is string {
  if (typeof value !== 'string' || typeof providerId !== 'string' || !MODEL.test(value)) {
    return false;
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false;
  if (value.split('/').some((part) => part === '.' || part === '..')) return false;
  return value.startsWith(`${providerId}/`);
}
function decodeParent(value: unknown, field: string): OpenCodeLaunchParentLinkage | string {
  const source = record(value);
  if (!source || !isIdentity(source.sessionIdentity)) return `${field}.sessionIdentity`;
  if (!isIdentity(source.messageIdentity)) return `${field}.messageIdentity`;
  return { sessionIdentity: source.sessionIdentity, messageIdentity: source.messageIdentity };
}

function decodeHost(value: unknown, field: string): OpenCodeRetainedHostIdentity | string {
  const source = record(value);
  if (!source || !isIdentity(source.hostKeyIdentity)) return `${field}.hostKeyIdentity`;
  if (!isPositiveInteger(source.processId)) return `${field}.processId`;
  if (!isSafeInteger(source.processStartedAtMs)) return `${field}.processStartedAtMs`;
  if (!isIdentity(source.profileScopeIdentity)) return `${field}.profileScopeIdentity`;
  return {
    hostKeyIdentity: source.hostKeyIdentity,
    processId: source.processId,
    processStartedAtMs: source.processStartedAtMs,
    profileScopeIdentity: source.profileScopeIdentity,
  };
}

function decodeFailure(value: unknown, field: string): OpenCodeLaunchFailureDetails | string {
  const source = record(value);
  if (!source || typeof source.code !== 'string' || !(source.code in FAILURE_POLICY)) {
    return `${field}.code`;
  }
  const code = source.code as OpenCodeLaunchFailureKind;
  const [retryDisposition, retryable, sideEffectsStarted] = FAILURE_POLICY[code];
  if (!isMember(ORIGINS, source.origin)) return `${field}.origin`;
  if (source.retryDisposition !== retryDisposition) return `${field}.retryDisposition`;
  if (source.retryable !== retryable) return `${field}.retryable`;
  if (source.sideEffectsStarted !== sideEffectsStarted) return `${field}.sideEffectsStarted`;
  if (!isMember(PHASES, source.phase)) return `${field}.phase`;
  const retryAfterMs = source.retryAfterMs;
  if (
    retryAfterMs !== undefined &&
    (!isSafeInteger(retryAfterMs) ||
      retryAfterMs > MAX_RETRY_AFTER_MS ||
      (code !== 'rate_limited' && code !== 'quota_exhausted'))
  ) {
    return `${field}.retryAfterMs`;
  }
  if (
    source.exhaustionScope !== undefined &&
    !isMember(EXHAUSTION_SCOPES, source.exhaustionScope)
  ) {
    return `${field}.exhaustionScope`;
  }
  return {
    code,
    origin: source.origin,
    retryDisposition,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    phase: source.phase,
    sideEffectsStarted,
    ...(source.exhaustionScope === undefined ? {} : { exhaustionScope: source.exhaustionScope }),
  };
}

function decodeAttempt(value: unknown): OpenCodeLaunchAttemptDetails | string {
  const source = record(value);
  if (!source) return 'launchAttempt';
  if (source.contractVersion !== 1) return 'launchAttempt.contractVersion';
  if (typeof source.attemptId !== 'string' || !UUID.test(source.attemptId)) {
    return 'launchAttempt.attemptId';
  }
  if (source.idempotencyKey !== 'attemptId') return 'launchAttempt.idempotencyKey';
  for (const field of ['payloadHash', 'inputDigest', 'immutableDigest'] as const) {
    if (typeof source[field] !== 'string' || !SHA256.test(source[field])) {
      return `launchAttempt.${field}`;
    }
  }
  if (
    source.requestCorrelationDigest !== undefined &&
    (typeof source.requestCorrelationDigest !== 'string' ||
      !SHA256.test(source.requestCorrelationDigest))
  ) {
    return 'launchAttempt.requestCorrelationDigest';
  }
  if (!isPositiveInteger(source.generation)) return 'launchAttempt.generation';
  if (!isMember(OUTCOMES, source.outcome)) return 'launchAttempt.outcome';
  if (!isMember(PHASES, source.phase)) return 'launchAttempt.phase';
  for (const field of [
    'startedAt',
    'workDeadlineAt',
    'absoluteDeadlineAt',
    'cleanupReserveMs',
    'elapsedMs',
  ] as const) {
    if (!isSafeInteger(source[field])) return `launchAttempt.${field}`;
  }
  const startedAt = source.startedAt as number;
  const workDeadlineAt = source.workDeadlineAt as number;
  const absoluteDeadlineAt = source.absoluteDeadlineAt as number;
  const cleanupReserveMs = source.cleanupReserveMs as number;
  const elapsedMs = source.elapsedMs as number;
  if (cleanupReserveMs === 0) return 'launchAttempt.cleanupReserveMs';
  if (startedAt > workDeadlineAt || workDeadlineAt >= absoluteDeadlineAt) {
    return 'launchAttempt.workDeadlineAt';
  }
  if (absoluteDeadlineAt - workDeadlineAt !== cleanupReserveMs) {
    return 'launchAttempt.cleanupReserveMs';
  }
  if (!isCanonicalProvider(source.providerId)) return 'launchAttempt.providerId';
  if (!isExactModel(source.modelId, source.providerId)) return 'launchAttempt.modelId';
  if (typeof source.profilePurpose !== 'string' || !PURPOSE.test(source.profilePurpose)) {
    return 'launchAttempt.profilePurpose';
  }
  for (const field of [
    'projectIdentity',
    'profileIdentity',
    'configIdentity',
    'authIdentity',
    'pluginPolicyIdentity',
    'cacheIdentity',
    'binaryIdentity',
  ] as const) {
    if (!isIdentity(source[field])) return `launchAttempt.${field}`;
  }
  const retainedHostIdentity = decodeHost(
    source.retainedHostIdentity,
    'launchAttempt.retainedHostIdentity'
  );
  if (typeof retainedHostIdentity === 'string') return retainedHostIdentity;
  if (source.processStartedAtMs !== undefined) {
    if (!isSafeInteger(source.processStartedAtMs)) return 'launchAttempt.processStartedAtMs';
    if (source.processStartedAtMs !== retainedHostIdentity.processStartedAtMs) {
      return 'launchAttempt.processStartedAtMs';
    }
  }
  return {
    contractVersion: 1,
    attemptId: source.attemptId,
    idempotencyKey: 'attemptId',
    payloadHash: source.payloadHash as string,
    generation: source.generation,
    inputDigest: source.inputDigest as string,
    immutableDigest: source.immutableDigest as string,
    ...(source.requestCorrelationDigest === undefined
      ? {}
      : { requestCorrelationDigest: source.requestCorrelationDigest }),
    outcome: source.outcome,
    phase: source.phase,
    startedAt,
    absoluteDeadlineAt,
    workDeadlineAt,
    cleanupReserveMs,
    elapsedMs,
    providerId: source.providerId,
    modelId: source.modelId,
    profilePurpose: source.profilePurpose,
    projectIdentity: source.projectIdentity as OpenCodeOpaqueIdentity,
    profileIdentity: source.profileIdentity as OpenCodeOpaqueIdentity,
    configIdentity: source.configIdentity as OpenCodeOpaqueIdentity,
    authIdentity: source.authIdentity as OpenCodeOpaqueIdentity,
    pluginPolicyIdentity: source.pluginPolicyIdentity as OpenCodeOpaqueIdentity,
    cacheIdentity: source.cacheIdentity as OpenCodeOpaqueIdentity,
    binaryIdentity: source.binaryIdentity as OpenCodeOpaqueIdentity,
    retainedHostIdentity,
    ...(source.processStartedAtMs === undefined
      ? {}
      : { processStartedAtMs: source.processStartedAtMs }),
  };
}

function decodeProof(value: unknown): OpenCodeRetainedHostProof | string {
  const source = record(value);
  if (!source) return 'proof';
  if (!isPositiveInteger(source.generation)) return 'proof.generation';
  if (typeof source.attemptId !== 'string' || !UUID.test(source.attemptId)) {
    return 'proof.attemptId';
  }
  const parent = decodeParent(source.parent, 'proof.parent');
  if (typeof parent === 'string') return parent;
  if (!isCanonicalProvider(source.providerId)) return 'proof.providerId';
  if (!isExactModel(source.modelId, source.providerId)) return 'proof.modelId';
  const retainedHostIdentity = decodeHost(
    source.retainedHostIdentity,
    'proof.retainedHostIdentity'
  );
  if (typeof retainedHostIdentity === 'string') return retainedHostIdentity;
  const tools = inertArray(source.observedMcpTools);
  if (
    !tools ||
    !tools.every((tool): tool is string => typeof tool === 'string' && TOOL.test(tool)) ||
    new Set(tools).size !== tools.length
  ) {
    return 'proof.observedMcpTools';
  }
  if (typeof source.nonceHash !== 'string' || !SHA256.test(source.nonceHash)) {
    return 'proof.nonceHash';
  }
  for (const field of [
    'sessionIdentity',
    'promptMessageIdentity',
    'assistantMessageIdentity',
  ] as const) {
    if (!isIdentity(source[field])) return `proof.${field}`;
  }
  if (!isSafeInteger(source.verifiedAt)) return 'proof.verifiedAt';
  if (source.authorizationSource !== 'fresh_live_attempt') return 'proof.authorizationSource';
  if (source.cacheUsed !== false) return 'proof.cacheUsed';
  if (
    source.requestCorrelationDigest !== undefined &&
    (typeof source.requestCorrelationDigest !== 'string' ||
      !SHA256.test(source.requestCorrelationDigest))
  ) {
    return 'proof.requestCorrelationDigest';
  }
  return {
    generation: source.generation,
    attemptId: source.attemptId,
    parent,
    providerId: source.providerId,
    modelId: source.modelId,
    retainedHostIdentity,
    observedMcpTools: [...tools],
    nonceHash: source.nonceHash,
    sessionIdentity: source.sessionIdentity as OpenCodeOpaqueIdentity,
    promptMessageIdentity: source.promptMessageIdentity as OpenCodeOpaqueIdentity,
    assistantMessageIdentity: source.assistantMessageIdentity as OpenCodeOpaqueIdentity,
    verifiedAt: source.verifiedAt,
    authorizationSource: 'fresh_live_attempt',
    cacheUsed: false,
    ...(source.requestCorrelationDigest === undefined
      ? {}
      : { requestCorrelationDigest: source.requestCorrelationDigest }),
  };
}

function decodeMembers(value: unknown): OpenCodeLaunchMemberOutcomes | string {
  const source = record(value);
  if (!source) return 'members';
  const committedSource = inertArray(source.committed);
  const failedSource = inertArray(source.failed);
  const pendingSource = inertArray(source.pending);
  const cleanupPendingSource = inertArray(source.cleanupPending);
  if (!committedSource) return 'members.committed';
  if (!failedSource) return 'members.failed';
  if (!pendingSource) return 'members.pending';
  if (!cleanupPendingSource) return 'members.cleanupPending';
  if (source.continuationToken !== undefined && !isOpaqueToken(source.continuationToken)) {
    return 'members.continuationToken';
  }
  const committed: OpenCodeLaunchMemberLinkage[] = [];
  const linkageIdentities = new Set<OpenCodeOpaqueIdentity>();
  for (let index = 0; index < committedSource.length; index += 1) {
    const item = record(committedSource[index]);
    if (!item) return `members.committed.${index}`;
    for (const field of [
      'memberIdentity',
      'sessionIdentity',
      'bootstrapMessageIdentity',
      'commitIdentity',
    ] as const) {
      const identity = item[field];
      if (!isIdentity(identity) || linkageIdentities.has(identity)) {
        return `members.committed.${index}.${field}`;
      }
      linkageIdentities.add(identity);
    }
    const memberIdentity = item.memberIdentity as OpenCodeOpaqueIdentity;
    const sessionIdentity = item.sessionIdentity as OpenCodeOpaqueIdentity;
    const bootstrapMessageIdentity = item.bootstrapMessageIdentity as OpenCodeOpaqueIdentity;
    const commitIdentity = item.commitIdentity as OpenCodeOpaqueIdentity;
    committed.push({
      memberIdentity,
      sessionIdentity,
      bootstrapMessageIdentity,
      commitIdentity,
    });
  }
  const failed: OpenCodeLaunchMemberOutcomes['failed'] = [];
  for (let index = 0; index < failedSource.length; index += 1) {
    const item = record(failedSource[index]);
    if (!item || !isIdentity(item.memberIdentity) || linkageIdentities.has(item.memberIdentity)) {
      return `members.failed.${index}.memberIdentity`;
    }
    const failure = decodeFailure(item.failure, `members.failed.${index}.failure`);
    if (typeof failure === 'string') return failure;
    linkageIdentities.add(item.memberIdentity);
    failed.push({ memberIdentity: item.memberIdentity, failure });
  }
  const decodeIdentityArray = (
    sourceArray: readonly unknown[],
    field: string,
    requireDisjoint: boolean
  ): OpenCodeOpaqueIdentity[] | string => {
    const identities: OpenCodeOpaqueIdentity[] = [];
    const local = new Set<OpenCodeOpaqueIdentity>();
    for (const candidate of sourceArray) {
      if (
        !isIdentity(candidate) ||
        local.has(candidate) ||
        (requireDisjoint && linkageIdentities.has(candidate))
      ) {
        return field;
      }
      local.add(candidate);
      identities.push(candidate);
    }
    return identities;
  };
  const pending = decodeIdentityArray(pendingSource, 'members.pending', true);
  if (typeof pending === 'string') return pending;
  const cleanupPending = decodeIdentityArray(cleanupPendingSource, 'members.cleanupPending', false);
  if (typeof cleanupPending === 'string') return cleanupPending;
  return {
    committed,
    failed,
    pending,
    cleanupPending,
    ...(source.continuationToken === undefined
      ? {}
      : { continuationToken: source.continuationToken }),
  };
}

export function decodeOpenCodeLaunchAttemptResponseV1(
  value: unknown
): OpenCodeLaunchAttemptDecodeResult {
  try {
    const source = record(value);
    if (!source) return { ok: false, field: '$' };
    const launchAttempt = decodeAttempt(source.launchAttempt);
    if (typeof launchAttempt === 'string') return { ok: false, field: launchAttempt };
    const members = decodeMembers(source.members);
    if (typeof members === 'string') return { ok: false, field: members };
    let proof: OpenCodeRetainedHostProof | undefined;
    if (source.proof !== undefined) {
      const decoded = decodeProof(source.proof);
      if (typeof decoded === 'string') return { ok: false, field: decoded };
      proof = decoded;
    }
    let failure: OpenCodeLaunchFailureDetails | undefined;
    if (source.failure !== undefined) {
      const decoded = decodeFailure(source.failure, 'failure');
      if (typeof decoded === 'string') return { ok: false, field: decoded };
      failure = decoded;
    }
    const outcome = launchAttempt.outcome;
    if (members.committed.length > 0 && !proof) {
      return { ok: false, field: 'proof' };
    }
    if ((outcome === 'succeeded' || outcome === 'partial') && !proof) {
      return { ok: false, field: 'proof' };
    }
    if (
      outcome === 'succeeded' &&
      (members.failed.length > 0 ||
        members.pending.length > 0 ||
        members.continuationToken !== undefined ||
        failure !== undefined)
    ) {
      return { ok: false, field: 'members' };
    }
    if (outcome === 'partial' && members.committed.length === 0) {
      return { ok: false, field: 'members' };
    }
    if (outcome === 'failed' && (!failure || members.committed.length > 0)) {
      return { ok: false, field: 'failure' };
    }
    if (outcome === 'cancelled' && members.committed.length > 0) {
      return { ok: false, field: 'members.committed' };
    }
    if (
      outcome === 'reconciliation_required' &&
      (!failure ||
        failure.code !== 'unknown_transport_after_side_effect' ||
        members.continuationToken !== undefined)
    ) {
      return { ok: false, field: 'members.continuationToken' };
    }
    if (members.continuationToken !== undefined && outcome !== 'partial') {
      return { ok: false, field: 'members.continuationToken' };
    }
    if (
      members.continuationToken !== undefined &&
      members.failed.length === 0 &&
      members.pending.length === 0
    ) {
      return { ok: false, field: 'members.continuationToken' };
    }
    return {
      ok: true,
      value: {
        launchAttempt,
        ...(proof ? { proof } : {}),
        members,
        ...(failure ? { failure } : {}),
      },
    };
  } catch {
    return { ok: false, field: '$' };
  }
}
export function correlateOpenCodeLaunchAttemptResponseV1(
  input: {
    response: unknown;
  } & (
    | { authority: OpenCodeLaunchRequestCorrelationAuthorityV1 }
    | {
        previouslyVerifiedRequest: OpenCodeLaunchAttemptCorrelationRequest;
        expectedMemberIdentities: readonly OpenCodeOpaqueIdentity[];
      }
  )
): OpenCodeLaunchAttemptDecodeResult {
  const decoded = decodeOpenCodeLaunchAttemptResponseV1(input.response);
  if (!decoded.ok) return decoded;
  const request =
    'authority' in input ? input.authority.command.launchAttempt : input.previouslyVerifiedRequest;
  const expectedMemberIdentities =
    'authority' in input
      ? input.authority.command.members.map((member) => member.memberIdentity)
      : input.expectedMemberIdentities;
  return validateOpenCodeLaunchAttemptCorrelationV1({
    decodedResponse: decoded.value,
    request,
    expectedMemberIdentities,
  });
}
