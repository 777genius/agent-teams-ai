import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import type {
  AuthoritativeHostedApprovalRuntimeBinding,
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimeOuterAuthority,
  HostedApprovalRuntimeOwnerIdentity,
} from '@main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';

export const HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256 =
  'c4304b8eb1ed77145141390294575f403c9f041c6ff6ad5b6f9f21f8b1b9d39e' as const;
export const HOSTED_APPROVAL_TRANSITION_MAXIMUM_FRAME_BYTES = 8_388_608;
export const HOSTED_APPROVAL_TRANSITION_PROOF_DOMAIN =
  'agent-teams.hosted-approval-transition.owner-proof/v1';

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const HEX = /^[0-9a-f]{64}$/u;
const PREFIXED_HEX = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const PLAN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DEPLOYMENT_ID = /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const RUN_ID = /^run_[0-9a-f]{32}$/u;
const MEMBER_ID = /^member_[0-9a-f]{32}$/u;
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
const AUTHORITY_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u;
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const RUNTIME_INSTANCE = /^runtime_instance_[0-9a-f]{32}$/u;
const CONFIG_GENERATION = /^config_generation_[0-9a-f]{32}$/u;
const TRANSITION_ID = /^approval-transition_[0-9a-f]{32}$/u;
const LEASE_ID = /^approval-transition-lease_[0-9a-f]{32}$/u;
const PROCESS_START = /^start_[0-9a-f]{64}$/u;
const DECIMAL_IDENTITY = /^(?:0|[1-9]\d{0,31})$/u;

export type HostedApprovalTransitionOperation = 'acquire' | 'consume' | 'assert' | 'release';
export type HostedApprovalTransitionRetryScope = 'same_operation' | 'new_transition' | 'never';
export type HostedApprovalTransitionAssertReason =
  | 'expired'
  | 'released'
  | 'fenced'
  | 'owner_restarted'
  | 'binding_changed'
  | 'socket_changed'
  | 'process_changed'
  | 'client_changed';

export interface HostedApprovalTransitionProductProjection {
  readonly teamName: string;
  readonly lifecycle: HostedApprovalRuntimeLifecycle;
  readonly expectedInstalledArtifactDigest: `sha256:${string}`;
  readonly stableAuthority: HostedApprovalRuntimeOuterAuthority;
  readonly expectedOwner: HostedApprovalRuntimeOwnerIdentity;
  readonly clientProcessIdentity: Readonly<{ pid: number; startIdentity: string }>;
}

export interface HostedApprovalTransitionError {
  readonly code: HostedApprovalTransitionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryScope: HostedApprovalTransitionRetryScope;
  readonly retryAfterMs: number | null;
}

export function immutableHostedApprovalTransitionValue<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object') return value as Readonly<T>;
  for (const key of Reflect.ownKeys(value)) {
    immutableHostedApprovalTransitionValue((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

export type HostedApprovalTransitionErrorCode = keyof typeof ERROR_CATALOG;

export interface HostedApprovalTransitionRequest<T extends HostedApprovalTransitionOperation> {
  readonly schemaVersion: 1;
  readonly transitionId: string;
  readonly operation: T;
  readonly sequence: number;
  readonly deadlineAtMs: number;
  readonly payload: HostedApprovalTransitionRequestPayload<T>;
}

export type HostedApprovalTransitionRequestPayload<T extends HostedApprovalTransitionOperation> =
  T extends 'acquire'
    ? Readonly<{
        productProjection: HostedApprovalTransitionProductProjection;
        projectionDigest: string;
      }>
    : T extends 'consume'
      ? Readonly<{
          leaseId: string;
          generation: number;
          projectionDigest: string;
          bindingDigest: string;
        }>
      : Readonly<{ leaseId: string; generation: number; bindingDigest: string }>;

export type HostedApprovalTransitionSuccessPayload<T extends HostedApprovalTransitionOperation> =
  T extends 'acquire'
    ? Readonly<{
        status: 'acquired';
        leaseId: string;
        generation: number;
        expiresAtMs: number;
        projectionDigest: string;
        bindingDigest: string;
        binding: AuthoritativeHostedApprovalRuntimeBinding;
      }>
    : T extends 'consume'
      ? Readonly<{
          status: 'consumed';
          leaseId: string;
          generation: number;
          pinnedExpiresAtMs: number;
          bindingDigest: string;
          binding: AuthoritativeHostedApprovalRuntimeBinding;
        }>
      : T extends 'assert'
        ? Readonly<{
            status: 'asserted';
            leaseId: string;
            generation: number;
            current: boolean;
            reason: HostedApprovalTransitionAssertReason | null;
          }>
        : Readonly<{
            status: 'released';
            leaseId: string;
            generation: number;
            releasedAtMs: number;
          }>;

export type HostedApprovalTransitionResponse<T extends HostedApprovalTransitionOperation> =
  | Readonly<{ payload: HostedApprovalTransitionSuccessPayload<T>; frame: Uint8Array }>
  | Readonly<{ error: HostedApprovalTransitionError; frame: Uint8Array }>;

const ERROR_CATALOG = Object.freeze({
  DEADLINE_EXCEEDED: ['request deadline has elapsed', true, 'same_operation', 0],
  INVALID_SCHEMA: ['request schema is invalid', false, 'never', null],
  LIMIT_EXCEEDED: ['request limit is exceeded', false, 'never', null],
  SEQUENCE_OUT_OF_ORDER: ['sequence is not the next transition sequence', false, 'never', null],
  OPERATION_OUT_OF_ORDER: ['operation is not legal in the lease state', false, 'never', null],
  TRANSITION_CONFLICT: ['transition replay bytes do not match', false, 'never', null],
  PROJECTION_MISMATCH: ['product projection does not match owner authority', false, 'never', null],
  BINDING_INVALID: ['authoritative binding is invalid', false, 'never', null],
  SOCKET_IDENTITY_MISMATCH: ['owner socket identity does not match', true, 'new_transition', null],
  PROCESS_IDENTITY_MISMATCH: [
    'owner process identity does not match',
    true,
    'new_transition',
    null,
  ],
  CLIENT_IDENTITY_MISMATCH: [
    'product process identity does not match',
    true,
    'new_transition',
    null,
  ],
  OWNER_NOT_CURRENT: ['orchestrator owner authority is not current', true, 'new_transition', null],
  PIN_BUSY: ['another transition holds the team pin', true, 'same_operation', 25],
  LEASE_NOT_FOUND: ['lease is not retained', false, 'never', null],
  LEASE_EXPIRED: ['lease has expired', true, 'new_transition', null],
  LEASE_ALREADY_CONSUMED: ['lease was already consumed by another sequence', false, 'never', null],
  LEASE_NOT_CONSUMED: ['lease has not been consumed', false, 'never', null],
  LEASE_RELEASED: ['lease is already terminal', false, 'never', null],
  GENERATION_MISMATCH: ['lease generation does not match', false, 'never', null],
  BINDING_DRIFT: ['authoritative binding changed', true, 'new_transition', null],
  OWNER_RESTARTED: ['orchestrator owner restarted', true, 'new_transition', null],
  TOMBSTONE_CAPACITY: ['transition tombstone capacity is exhausted', true, 'same_operation', 1000],
  UNAVAILABLE: ['transition authority is unavailable', true, 'same_operation', 50],
  INTERNAL: ['transition operation did not settle', true, 'same_operation', 50],
} as const satisfies Record<
  string,
  readonly [string, boolean, HostedApprovalTransitionRetryScope, number | null]
>);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => typeof key === 'string' && key === expected[index])
  );
}

function integer(value: unknown, minimum = 0, maximum = SAFE_MAX): value is number {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    else index += 1;
  }
  return false;
}

function scalarString(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value) && !hasUnpairedSurrogate(value);
}

function canonicalDictionary(
  value: unknown,
  keyPattern: RegExp,
  valuePattern: RegExp
): value is Record<string, string> {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort(compareUtf16);
  if (keys.length < 1 || keys.length > 256 || keys.some((key) => !scalarString(key, keyPattern)))
    return false;
  const values = keys.map((key) => value[key]);
  return (
    values.every((item) => scalarString(item, valuePattern)) &&
    new Set(values).size === values.length
  );
}

function canonicalJson(value: unknown, dictionary = false): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (!record(value)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    )
      throw new TypeError('hosted-approval-transition-value-not-json');
    return JSON.stringify(value);
  }
  const keys = Object.keys(value);
  if (dictionary) keys.sort(compareUtf16);
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          value[key],
          key === 'memberIdsByName' || key === 'actorMembers'
        )}`
    )
    .join(',')}}`;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validSocketPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !value.includes('\0') &&
    !hasUnpairedSurrogate(value) &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 103
  );
}

function validProcessIdentity(
  value: unknown
): value is Readonly<{ pid: number; startIdentity: string }> {
  return (
    record(value) &&
    exactKeys(value, ['pid', 'startIdentity']) &&
    integer(value.pid, 1) &&
    scalarString(value.startIdentity, PROCESS_START)
  );
}

function validSocketIdentity(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ['device', 'inode', 'uid', 'gid', 'mode']) &&
    scalarString(value.device, DECIMAL_IDENTITY) &&
    scalarString(value.inode, DECIMAL_IDENTITY) &&
    integer(value.uid) &&
    integer(value.gid) &&
    value.mode === 384
  );
}

function validOuterAuthority(value: unknown): value is HostedApprovalRuntimeOuterAuthority {
  return (
    record(value) &&
    exactKeys(value, [
      'deploymentId',
      'bootId',
      'workspaceId',
      'teamId',
      'restoreGeneration',
      'mountBinding',
    ]) &&
    scalarString(value.deploymentId, DEPLOYMENT_ID) &&
    scalarString(value.bootId, IDENTIFIER) &&
    scalarString(value.workspaceId, IDENTIFIER) &&
    scalarString(value.teamId, TEAM_ID) &&
    integer(value.restoreGeneration) &&
    record(value.mountBinding) &&
    exactKeys(value.mountBinding, ['mountGeneration', 'declaredRootHash']) &&
    integer(value.mountBinding.mountGeneration, 1) &&
    scalarString(value.mountBinding.declaredRootHash, HEX)
  );
}

function validOwner(value: unknown): value is HostedApprovalRuntimeOwnerIdentity {
  return (
    record(value) &&
    exactKeys(value, [
      'teamId',
      'ownerAuthority',
      'ownerGeneration',
      'ownerSessionId',
      'socketPath',
      'socketIdentity',
      'processIdentity',
    ]) &&
    scalarString(value.teamId, TEAM_ID) &&
    scalarString(value.ownerAuthority, OWNER_AUTHORITY) &&
    integer(value.ownerGeneration, 1) &&
    scalarString(value.ownerSessionId, OWNER_SESSION) &&
    validSocketPath(value.socketPath) &&
    validSocketIdentity(value.socketIdentity) &&
    validProcessIdentity(value.processIdentity)
  );
}

function validLifecycle(value: unknown): value is HostedApprovalRuntimeLifecycle {
  if (!record(value) || !scalarString(value.state, /^(?:provisioning|restart_required|active)$/u))
    return false;
  if (value.state === 'provisioning')
    return exactKeys(value, ['state', 'ownerGeneration']) && integer(value.ownerGeneration, 1);
  if (value.state === 'restart_required') {
    return (
      exactKeys(value, ['state', 'ownerGeneration', 'approvalGeneration']) &&
      integer(value.ownerGeneration, 1) &&
      integer(value.approvalGeneration, 1)
    );
  }
  return (
    exactKeys(value, ['state', 'ownerGeneration', 'approvalGeneration', 'approvalDigest']) &&
    integer(value.ownerGeneration, 1) &&
    integer(value.approvalGeneration, 1) &&
    scalarString(value.approvalDigest, PREFIXED_HEX)
  );
}

export function validateHostedApprovalTransitionProductProjection(
  value: unknown
): asserts value is HostedApprovalTransitionProductProjection {
  if (
    !record(value) ||
    !exactKeys(value, [
      'teamName',
      'lifecycle',
      'expectedInstalledArtifactDigest',
      'stableAuthority',
      'expectedOwner',
      'clientProcessIdentity',
    ]) ||
    !scalarString(value.teamName, TEAM_NAME) ||
    !validLifecycle(value.lifecycle) ||
    !scalarString(value.expectedInstalledArtifactDigest, PREFIXED_HEX) ||
    !validOuterAuthority(value.stableAuthority) ||
    !validOwner(value.expectedOwner) ||
    !validProcessIdentity(value.clientProcessIdentity) ||
    value.lifecycle.ownerGeneration !== value.expectedOwner.ownerGeneration ||
    value.stableAuthority.teamId !== value.expectedOwner.teamId
  ) {
    throw new TypeError('hosted-approval-transition-product-projection-invalid');
  }
}

function validRoute(value: unknown): boolean {
  if (
    !record(value) ||
    !exactKeys(value, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'])
  )
    return false;
  const authority = value.authority;
  const scope = value.scope;
  const open = value.openCodeBinding;
  return (
    scalarString(value.routeId, IDENTIFIER) &&
    scalarString(value.memberName, IDENTIFIER) &&
    record(authority) &&
    exactKeys(authority, [
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
    ]) &&
    scalarString(authority.deploymentId, DEPLOYMENT_ID) &&
    scalarString(authority.teamId, TEAM_ID) &&
    scalarString(authority.runId, RUN_ID) &&
    integer(authority.planGeneration, 1) &&
    scalarString(authority.laneId, PLAN_IDENTIFIER) &&
    authority.providerId === 'opencode' &&
    integer(authority.credentialGeneration, 1) &&
    scalarString(authority.credentialId, IDENTIFIER) &&
    scalarString(authority.sessionId, IDENTIFIER) &&
    scalarString(authority.runtimeInstanceId, RUNTIME_INSTANCE) &&
    scalarString(authority.deliveryOwnerId, MEMBER_ID) &&
    record(scope) &&
    exactKeys(scope, [
      'principalId',
      'workspaceId',
      'teamId',
      'authorityGeneration',
      'restoreGeneration',
    ]) &&
    scalarString(scope.principalId, ACTOR_ID) &&
    scalarString(scope.workspaceId, IDENTIFIER) &&
    scalarString(scope.teamId, TEAM_ID) &&
    scalarString(scope.authorityGeneration, AUTHORITY_GENERATION) &&
    integer(scope.restoreGeneration) &&
    record(open) &&
    exactKeys(open, [
      'toolApprovalMode',
      'planGeneration',
      'credentialGeneration',
      'credentialId',
      'runtimeInstanceId',
      'deliveryOwnerId',
      'openCodeArtifactDigest',
      'sessionRecordFingerprint',
      'liveEffectFingerprint',
    ]) &&
    open.toolApprovalMode === 'manual' &&
    integer(open.planGeneration, 1) &&
    integer(open.credentialGeneration, 1) &&
    scalarString(open.credentialId, IDENTIFIER) &&
    scalarString(open.runtimeInstanceId, RUNTIME_INSTANCE) &&
    scalarString(open.deliveryOwnerId, MEMBER_ID) &&
    scalarString(open.openCodeArtifactDigest, PREFIXED_HEX) &&
    scalarString(open.sessionRecordFingerprint, HEX) &&
    scalarString(open.liveEffectFingerprint, HEX)
  );
}

export function validateHostedApprovalTransitionBinding(
  value: unknown,
  projection: HostedApprovalTransitionProductProjection
): asserts value is AuthoritativeHostedApprovalRuntimeBinding {
  if (
    !record(value) ||
    !exactKeys(value, [
      'outerAuthority',
      'routes',
      'memberIdsByName',
      'actorMembers',
      'owner',
      'capability',
    ]) ||
    !validOuterAuthority(value.outerAuthority) ||
    !validOwner(value.owner) ||
    !Array.isArray(value.routes) ||
    value.routes.length < 1 ||
    value.routes.length > 256 ||
    !value.routes.every(validRoute) ||
    value.routes.some(
      (route, index) =>
        index > 0 &&
        compareUtf16(
          ((value.routes as unknown[])[index - 1] as { routeId: string }).routeId,
          (route as { routeId: string }).routeId
        ) >= 0
    ) ||
    !canonicalDictionary(value.memberIdsByName, IDENTIFIER, MEMBER_ID) ||
    !canonicalDictionary(value.actorMembers, ACTOR_ID, MEMBER_ID) ||
    !record(value.capability) ||
    !exactKeys(value.capability, [
      'schemaVersion',
      'protocol',
      'authentication',
      'runtimeInstanceId',
      'configGeneration',
    ]) ||
    value.capability.schemaVersion !== 2 ||
    value.capability.protocol !== 'agent-teams-hosted-approval-v2' ||
    value.capability.authentication !== 'opencode-basic' ||
    !scalarString(value.capability.runtimeInstanceId, RUNTIME_INSTANCE) ||
    !scalarString(value.capability.configGeneration, CONFIG_GENERATION) ||
    JSON.stringify(value.outerAuthority) !== JSON.stringify(projection.stableAuthority) ||
    JSON.stringify(value.owner) !== JSON.stringify(projection.expectedOwner)
  )
    throw new TypeError('hosted-approval-transition-binding-invalid');

  const binding = value as unknown as AuthoritativeHostedApprovalRuntimeBinding;
  const memberValues = Object.values(binding.memberIdsByName);
  const actorValues = Object.values(binding.actorMembers);
  if (
    memberValues.length !== actorValues.length ||
    memberValues.some((item) => !actorValues.includes(item))
  ) {
    throw new TypeError('hosted-approval-transition-binding-invalid');
  }
  const routeIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const route of binding.routes) {
    if (routeIds.has(route.routeId) || sessionIds.has(route.authority.sessionId))
      throw new TypeError('hosted-approval-transition-binding-invalid');
    routeIds.add(route.routeId);
    sessionIds.add(route.authority.sessionId);
    if (
      route.authority.deploymentId !== binding.outerAuthority.deploymentId ||
      route.authority.teamId !== binding.outerAuthority.teamId ||
      route.scope.workspaceId !== binding.outerAuthority.workspaceId ||
      route.scope.teamId !== binding.outerAuthority.teamId ||
      route.scope.restoreGeneration !== binding.outerAuthority.restoreGeneration ||
      binding.actorMembers[route.scope.principalId] !== route.authority.deliveryOwnerId ||
      binding.memberIdsByName[route.memberName] !== route.authority.deliveryOwnerId ||
      route.openCodeBinding.planGeneration !== route.authority.planGeneration ||
      route.openCodeBinding.credentialGeneration !== route.authority.credentialGeneration ||
      route.openCodeBinding.credentialId !== route.authority.credentialId ||
      route.openCodeBinding.runtimeInstanceId !== route.authority.runtimeInstanceId ||
      route.openCodeBinding.deliveryOwnerId !== route.authority.deliveryOwnerId ||
      route.openCodeBinding.runtimeInstanceId !== binding.capability.runtimeInstanceId ||
      route.openCodeBinding.openCodeArtifactDigest !== projection.expectedInstalledArtifactDigest
    )
      throw new TypeError('hosted-approval-transition-binding-invalid');
  }
}

export function canonicalHostedApprovalTransitionProjection(
  projection: HostedApprovalTransitionProductProjection
): string {
  validateHostedApprovalTransitionProductProjection(projection);
  return JSON.stringify(projection);
}

export function digestHostedApprovalTransitionValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function createHostedApprovalTransitionProof(
  secret: Uint8Array,
  direction: 'request' | 'response',
  canonicalUnsigned: string
): string {
  if (secret.byteLength !== 32) throw new TypeError('hosted-approval-transition-secret-invalid');
  return createHmac('sha256', secret)
    .update(HOSTED_APPROVAL_TRANSITION_PROOF_DOMAIN, 'utf8')
    .update('\0')
    .update(direction, 'utf8')
    .update('\0')
    .update(canonicalUnsigned, 'utf8')
    .digest('hex');
}

export function encodeHostedApprovalTransitionRequest<T extends HostedApprovalTransitionOperation>(
  request: HostedApprovalTransitionRequest<T>,
  secret: Uint8Array
): Readonly<{ frame: Uint8Array; requestDigest: string; canonicalUnsigned: string }> {
  validateRequest(request);
  const canonicalUnsigned = JSON.stringify(request);
  const requestDigest = createHash('sha256').update(canonicalUnsigned, 'utf8').digest('hex');
  const proof = createHostedApprovalTransitionProof(secret, 'request', canonicalUnsigned);
  const frame = Buffer.from(`${canonicalUnsigned.slice(0, -1)},"ownerProof":"${proof}"}\n`, 'utf8');
  if (frame.byteLength > HOSTED_APPROVAL_TRANSITION_MAXIMUM_FRAME_BYTES)
    throw new RangeError('hosted-approval-transition-frame-too-large');
  return Object.freeze({ frame, requestDigest, canonicalUnsigned });
}

function validateRequest(
  request: HostedApprovalTransitionRequest<HostedApprovalTransitionOperation>
): void {
  if (
    !record(request) ||
    !exactKeys(request, [
      'schemaVersion',
      'transitionId',
      'operation',
      'sequence',
      'deadlineAtMs',
      'payload',
    ]) ||
    request.schemaVersion !== 1 ||
    !scalarString(request.transitionId, TRANSITION_ID) ||
    !scalarString(request.operation, /^(?:acquire|consume|assert|release)$/u) ||
    !integer(request.sequence, 1, 2_147_483_647) ||
    !integer(request.deadlineAtMs)
  ) {
    throw new TypeError('hosted-approval-transition-request-invalid');
  }
  const payload: unknown = request.payload;
  if (!record(payload)) throw new TypeError('hosted-approval-transition-request-invalid');
  if (request.operation === 'acquire') {
    if (
      !exactKeys(payload, ['productProjection', 'projectionDigest']) ||
      !scalarString(payload.projectionDigest, HEX)
    )
      throw new TypeError('hosted-approval-transition-request-invalid');
    validateHostedApprovalTransitionProductProjection(payload.productProjection);
    if (digestHostedApprovalTransitionValue(payload.productProjection) !== payload.projectionDigest)
      throw new TypeError('hosted-approval-transition-projection-digest-invalid');
  } else {
    const keys =
      request.operation === 'consume'
        ? ['leaseId', 'generation', 'projectionDigest', 'bindingDigest']
        : ['leaseId', 'generation', 'bindingDigest'];
    if (
      !exactKeys(payload, keys) ||
      !scalarString(payload.leaseId, LEASE_ID) ||
      !integer(payload.generation, 1) ||
      !scalarString(payload.bindingDigest, HEX) ||
      (request.operation === 'consume' && !scalarString(payload.projectionDigest, HEX))
    )
      throw new TypeError('hosted-approval-transition-request-invalid');
  }
}

export function decodeHostedApprovalTransitionResponse<T extends HostedApprovalTransitionOperation>(
  frame: Uint8Array,
  request: HostedApprovalTransitionRequest<T>,
  requestDigest: string,
  secret: Uint8Array,
  projection: HostedApprovalTransitionProductProjection
): HostedApprovalTransitionResponse<T> {
  if (
    frame.byteLength > HOSTED_APPROVAL_TRANSITION_MAXIMUM_FRAME_BYTES ||
    frame.byteLength < 2 ||
    frame[frame.byteLength - 1] !== 0x0a ||
    frame.slice(0, -1).includes(0x0a) ||
    frame.slice(0, -1).includes(0x0d)
  ) {
    throw new TypeError('hosted-approval-transition-response-framing-invalid');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const text = decoder.decode(frame);
  if (text.charCodeAt(0) === 0xfeff || !text.endsWith('\n'))
    throw new TypeError('hosted-approval-transition-response-framing-invalid');
  const body = text.slice(0, -1);
  const proofMatch = /,"ownerProof":"([0-9a-f]{64})"\}$/u.exec(body);
  if (!proofMatch)
    throw new TypeError('hosted-approval-transition-response-proof-structure-invalid');
  const canonicalUnsigned = `${body.slice(0, proofMatch.index)}}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TypeError('hosted-approval-transition-response-json-invalid');
  }
  if (!record(parsed)) throw new TypeError('hosted-approval-transition-response-schema-invalid');
  const proof = proofMatch[1];
  const expected = createHostedApprovalTransitionProof(secret, 'response', canonicalUnsigned);
  if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex')))
    throw new TypeError('hosted-approval-transition-response-proof-invalid');
  const unsigned = { ...parsed };
  delete unsigned.ownerProof;
  if (canonicalJson(unsigned) !== canonicalUnsigned)
    throw new TypeError('hosted-approval-transition-response-noncanonical');
  const common = [
    parsed.schemaVersion,
    parsed.transitionId,
    parsed.operation,
    parsed.sequence,
    parsed.requestDigest,
  ];
  if (
    common[0] !== 1 ||
    common[1] !== request.transitionId ||
    common[2] !== request.operation ||
    common[3] !== request.sequence ||
    common[4] !== requestDigest
  ) {
    throw new TypeError('hosted-approval-transition-response-substitution');
  }
  if (Object.hasOwn(parsed, 'error')) {
    if (
      !exactKeys(parsed, [
        'schemaVersion',
        'transitionId',
        'operation',
        'sequence',
        'requestDigest',
        'error',
        'ownerProof',
      ])
    )
      throw new TypeError('hosted-approval-transition-response-schema-invalid');
    const error = parseError(parsed.error);
    return Object.freeze({ error, frame: Uint8Array.from(frame) });
  }
  if (
    !exactKeys(parsed, [
      'schemaVersion',
      'transitionId',
      'operation',
      'sequence',
      'requestDigest',
      'payload',
      'ownerProof',
    ])
  )
    throw new TypeError('hosted-approval-transition-response-schema-invalid');
  const payload = parseSuccessPayload(request, parsed.payload, projection);
  return Object.freeze({ payload, frame: Uint8Array.from(frame) });
}

function parseError(value: unknown): HostedApprovalTransitionError {
  if (
    !record(value) ||
    !exactKeys(value, ['code', 'message', 'retryable', 'retryScope', 'retryAfterMs']) ||
    typeof value.code !== 'string' ||
    !Object.hasOwn(ERROR_CATALOG, value.code)
  ) {
    throw new TypeError('hosted-approval-transition-error-invalid');
  }
  const expected = ERROR_CATALOG[value.code as HostedApprovalTransitionErrorCode];
  if (
    value.message !== expected[0] ||
    value.retryable !== expected[1] ||
    value.retryScope !== expected[2] ||
    value.retryAfterMs !== expected[3]
  )
    throw new TypeError('hosted-approval-transition-error-invalid');
  return Object.freeze(value as unknown as HostedApprovalTransitionError);
}

function parseSuccessPayload<T extends HostedApprovalTransitionOperation>(
  request: HostedApprovalTransitionRequest<T>,
  value: unknown,
  projection: HostedApprovalTransitionProductProjection
): HostedApprovalTransitionSuccessPayload<T> {
  if (!record(value)) throw new TypeError('hosted-approval-transition-success-invalid');
  const requestPayload = request.payload as Record<string, unknown>;
  if (request.operation === 'acquire') {
    if (
      !exactKeys(value, [
        'status',
        'leaseId',
        'generation',
        'expiresAtMs',
        'projectionDigest',
        'bindingDigest',
        'binding',
      ]) ||
      value.status !== 'acquired' ||
      !scalarString(value.leaseId, LEASE_ID) ||
      !integer(value.generation, 1) ||
      !integer(value.expiresAtMs) ||
      value.projectionDigest !== requestPayload.projectionDigest ||
      !scalarString(value.bindingDigest, HEX)
    )
      throw new TypeError('hosted-approval-transition-success-invalid');
    validateHostedApprovalTransitionBinding(value.binding, projection);
    if (digestHostedApprovalTransitionValue(value.binding) !== value.bindingDigest)
      throw new TypeError('hosted-approval-transition-binding-digest-invalid');
  } else if (request.operation === 'consume') {
    if (
      !exactKeys(value, [
        'status',
        'leaseId',
        'generation',
        'pinnedExpiresAtMs',
        'bindingDigest',
        'binding',
      ]) ||
      value.status !== 'consumed' ||
      value.leaseId !== requestPayload.leaseId ||
      value.generation !== requestPayload.generation ||
      !integer(value.pinnedExpiresAtMs) ||
      value.bindingDigest !== requestPayload.bindingDigest
    )
      throw new TypeError('hosted-approval-transition-success-invalid');
    validateHostedApprovalTransitionBinding(value.binding, projection);
    if (digestHostedApprovalTransitionValue(value.binding) !== value.bindingDigest)
      throw new TypeError('hosted-approval-transition-binding-digest-invalid');
  } else if (request.operation === 'assert') {
    if (
      !exactKeys(value, ['status', 'leaseId', 'generation', 'current', 'reason']) ||
      value.status !== 'asserted' ||
      value.leaseId !== requestPayload.leaseId ||
      value.generation !== requestPayload.generation ||
      typeof value.current !== 'boolean' ||
      (value.current
        ? value.reason !== null
        : !scalarString(
            value.reason,
            /^(?:expired|released|fenced|owner_restarted|binding_changed|socket_changed|process_changed|client_changed)$/u
          ))
    )
      throw new TypeError('hosted-approval-transition-success-invalid');
  } else if (
    !exactKeys(value, ['status', 'leaseId', 'generation', 'releasedAtMs']) ||
    value.status !== 'released' ||
    value.leaseId !== requestPayload.leaseId ||
    value.generation !== requestPayload.generation ||
    !integer(value.releasedAtMs)
  ) {
    throw new TypeError('hosted-approval-transition-success-invalid');
  }
  return immutableHostedApprovalTransitionValue(
    value as unknown as HostedApprovalTransitionSuccessPayload<T>
  ) as HostedApprovalTransitionSuccessPayload<T>;
}
