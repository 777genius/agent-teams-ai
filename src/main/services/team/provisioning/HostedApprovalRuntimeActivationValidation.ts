import { createHash } from 'node:crypto';

import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';

import type { HostedApprovalRuntimeActivationBinding } from './HostedApprovalRuntimeActivationTypes';

const MAXIMUM_ADMISSION_BYTES = 256 * 1024;
const HEX_32 = /^[0-9a-f]{64}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
const MEMBER_ID = /^member_[0-9a-f]{32}$/u;
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u;
const ADMISSION_GENERATION = /^approval-admission-generation_([1-9][0-9]*)_owner_([1-9][0-9]*)$/u;
const ACTIVATION_CAPABILITY = 'agent-teams.hosted-approval-activation-v2' as const;
const MANIFEST_FORMAT = 'agent-teams.hosted-lifecycle-owner-admission/v4' as const;

export function validateActivationBinding(
  value: HostedApprovalRuntimeActivationBinding
): HostedApprovalRuntimeActivationBinding {
  const canonicalKeys = [
    'deploymentId',
    'bootId',
    'workspaceId',
    'teamId',
    'restoreGeneration',
    'mountBinding',
    'ownerBinding',
    'socketPath',
    'approvalGeneration',
    'admissionOwnerGeneration',
    'approvalDigest',
    'admissionDocumentDigest',
    'ownerArtifactDigest',
    'activationCapability',
    'wireCapabilityDigest',
    'signedManifest',
  ] as const;
  const legacyManifestMappingKeys = canonicalKeys.map((key) =>
    key === 'ownerArtifactDigest' ? 'artifactDigest' : key
  );
  const ownerArtifactDigest = value.ownerArtifactDigest ?? value.artifactDigest;
  if (
    (!exactKeys(value, canonicalKeys) && !exactKeys(value, legacyManifestMappingKeys)) ||
    !IDENTIFIER.test(value.deploymentId) ||
    !IDENTIFIER.test(value.bootId) ||
    !IDENTIFIER.test(value.workspaceId) ||
    !TEAM_ID.test(value.teamId) ||
    !nonNegative(value.restoreGeneration) ||
    !exactKeys(value.mountBinding, ['mountGeneration', 'declaredRootHash']) ||
    !positive(value.mountBinding.mountGeneration) ||
    !HEX_32.test(value.mountBinding.declaredRootHash) ||
    !exactKeys(value.ownerBinding, [
      'ownerAuthority',
      'ownerGeneration',
      'ownerSessionId',
      'socketIdentity',
    ]) ||
    !OWNER_AUTHORITY.test(value.ownerBinding.ownerAuthority) ||
    !positive(value.ownerBinding.ownerGeneration) ||
    !OWNER_SESSION.test(value.ownerBinding.ownerSessionId) ||
    !exactKeys(value.ownerBinding.socketIdentity, ['device', 'inode', 'uid', 'gid', 'mode']) ||
    !/^\d{1,32}$/u.test(value.ownerBinding.socketIdentity.device) ||
    !/^\d{1,32}$/u.test(value.ownerBinding.socketIdentity.inode) ||
    !nonNegative(value.ownerBinding.socketIdentity.uid) ||
    !nonNegative(value.ownerBinding.socketIdentity.gid) ||
    !nonNegative(value.ownerBinding.socketIdentity.mode) ||
    value.ownerBinding.socketIdentity.mode > 0o777 ||
    value.socketPath.length === 0 ||
    !value.socketPath.startsWith('/') ||
    value.socketPath.includes('\0') ||
    !positive(value.approvalGeneration) ||
    !positive(value.admissionOwnerGeneration) ||
    !SHA256.test(value.approvalDigest) ||
    !SHA256.test(value.admissionDocumentDigest) ||
    typeof ownerArtifactDigest !== 'string' ||
    !SHA256.test(ownerArtifactDigest) ||
    value.activationCapability !== ACTIVATION_CAPABILITY ||
    !SHA256.test(value.wireCapabilityDigest) ||
    !exactKeys(value.signedManifest, [
      'format',
      'manifestDigest',
      'releasePinDigest',
      'launcherKeyId',
    ]) ||
    value.signedManifest.format !== MANIFEST_FORMAT ||
    !SHA256.test(value.signedManifest.manifestDigest) ||
    !SHA256.test(value.signedManifest.releasePinDigest) ||
    !HEX_32.test(value.signedManifest.launcherKeyId)
  ) {
    throw new TypeError('hosted-approval-activation-binding-invalid');
  }
  return Object.freeze({
    deploymentId: value.deploymentId,
    bootId: value.bootId,
    workspaceId: value.workspaceId,
    teamId: value.teamId,
    restoreGeneration: value.restoreGeneration,
    mountBinding: Object.freeze({ ...value.mountBinding }),
    ownerBinding: Object.freeze({
      ...value.ownerBinding,
      socketIdentity: Object.freeze({ ...value.ownerBinding.socketIdentity }),
    }),
    socketPath: value.socketPath,
    approvalGeneration: value.approvalGeneration,
    admissionOwnerGeneration: value.admissionOwnerGeneration,
    approvalDigest: value.approvalDigest,
    admissionDocumentDigest: value.admissionDocumentDigest,
    ownerArtifactDigest,
    activationCapability: value.activationCapability,
    wireCapabilityDigest: value.wireCapabilityDigest,
    signedManifest: Object.freeze({ ...value.signedManifest }),
  });
}
export function validateActivationAdmission(
  value: unknown,
  binding: HostedApprovalRuntimeActivationBinding
): unknown {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > MAXIMUM_ADMISSION_BYTES ||
    !value.endsWith('\n') ||
    value.includes('\r')
  ) {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  const record = orderedRecord(parsed, [
    'schemaVersion',
    'admissionGeneration',
    'outerAuthority',
    'routes',
    'actorMembers',
  ]);
  if (
    record.schemaVersion !== 1 ||
    `${JSON.stringify(record)}\n` !== value ||
    typeof record.admissionGeneration !== 'string' ||
    !Array.isArray(record.routes) ||
    record.routes.length === 0 ||
    record.routes.length > 256
  ) {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  const generation = ADMISSION_GENERATION.exec(record.admissionGeneration);
  if (
    !generation ||
    Number(generation[1]) !== binding.approvalGeneration ||
    Number(generation[2]) !== binding.admissionOwnerGeneration
  ) {
    throw new TypeError('hosted-approval-activation-admission-generation-mismatch');
  }
  const outer = orderedRecord(record.outerAuthority, [
    'deploymentId',
    'bootId',
    'workspaceId',
    'teamId',
    'restoreGeneration',
    'mountBinding',
  ]);
  const mount = orderedRecord(outer.mountBinding, ['mountGeneration', 'declaredRootHash']);
  if (
    outer.deploymentId !== binding.deploymentId ||
    outer.bootId !== binding.bootId ||
    outer.workspaceId !== binding.workspaceId ||
    typeof outer.teamId !== 'string' ||
    !TEAM_ID.test(outer.teamId) ||
    outer.restoreGeneration !== binding.restoreGeneration ||
    mount.mountGeneration !== binding.mountBinding.mountGeneration ||
    mount.declaredRootHash !== binding.mountBinding.declaredRootHash
  ) {
    throw new TypeError('hosted-approval-activation-admission-binding-mismatch');
  }
  const actorMembers = orderedRecordMap(record.actorMembers);
  const actorEntries = Object.entries(actorMembers);
  if (
    actorEntries.length === 0 ||
    actorEntries.some(
      ([actorId, memberId]) => !ACTOR_ID.test(actorId) || !MEMBER_ID.test(memberId)
    ) ||
    actorEntries.length > 256
  ) {
    throw new TypeError('hosted-approval-activation-actor-mapping-invalid');
  }
  const routeIds = new Set<string>();
  const routeIdentities = new Set<string>();
  const admittedTeamIds = new Set<string>();
  const authorities = record.routes.map((candidate) => {
    const route = orderedRecord(candidate, [
      'routeId',
      'authority',
      'scope',
      'memberName',
      'openCodeBinding',
    ]);
    const authorityRecord = orderedRecord(route.authority, [
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
    ]);
    const authority = parseRuntimePermissionApprovalIngressAuthority(authorityRecord);
    const scope = orderedRecord(route.scope, [
      'principalId',
      'workspaceId',
      'teamId',
      'authorityGeneration',
      'restoreGeneration',
    ]);
    const openCode = orderedRecord(route.openCodeBinding, [
      'toolApprovalMode',
      'planGeneration',
      'credentialGeneration',
      'credentialId',
      'runtimeInstanceId',
      'deliveryOwnerId',
      'openCodeArtifactDigest',
      'sessionRecordFingerprint',
      'liveEffectFingerprint',
    ]);
    if (
      typeof route.routeId !== 'string' ||
      !IDENTIFIER.test(route.routeId) ||
      routeIds.has(route.routeId) ||
      typeof route.memberName !== 'string' ||
      !IDENTIFIER.test(route.memberName) ||
      authority.deploymentId !== binding.deploymentId ||
      authority.providerId !== 'opencode' ||
      routeIdentities.has(
        `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`
      ) ||
      scope.workspaceId !== binding.workspaceId ||
      scope.teamId !== authority.teamId ||
      scope.restoreGeneration !== binding.restoreGeneration ||
      typeof scope.principalId !== 'string' ||
      !ACTOR_ID.test(scope.principalId) ||
      typeof scope.authorityGeneration !== 'string' ||
      !GENERATION.test(scope.authorityGeneration) ||
      actorMembers[scope.principalId] !== authority.deliveryOwnerId ||
      openCode.toolApprovalMode !== 'manual' ||
      openCode.planGeneration !== authority.planGeneration ||
      openCode.credentialGeneration !== authority.credentialGeneration ||
      openCode.credentialId !== authority.credentialId ||
      openCode.runtimeInstanceId !== authority.runtimeInstanceId ||
      openCode.deliveryOwnerId !== authority.deliveryOwnerId ||
      typeof openCode.openCodeArtifactDigest !== 'string' ||
      !SHA256.test(openCode.openCodeArtifactDigest) ||
      typeof openCode.sessionRecordFingerprint !== 'string' ||
      !HEX_32.test(openCode.sessionRecordFingerprint) ||
      typeof openCode.liveEffectFingerprint !== 'string' ||
      !HEX_32.test(openCode.liveEffectFingerprint)
    ) {
      throw new TypeError('hosted-approval-activation-route-invalid');
    }
    routeIds.add(route.routeId);
    routeIdentities.add(
      `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`
    );
    admittedTeamIds.add(authority.teamId);
    return authority;
  });
  const routeOrder = [...routeIds];
  if (routeOrder.some((routeId, index) => index > 0 && routeOrder[index - 1] > routeId)) {
    throw new TypeError('hosted-approval-activation-route-order-invalid');
  }
  if (
    !admittedTeamIds.has(binding.teamId) ||
    [...admittedTeamIds].some((teamId) => !TEAM_ID.test(teamId)) ||
    authorities.some(
      (authority) =>
        !actorEntries.some(([, actorMemberId]) => actorMemberId === authority.deliveryOwnerId)
    )
  ) {
    throw new TypeError('hosted-approval-activation-actor-mapping-invalid');
  }
  const approvalSnapshot = {
    schemaVersion: 1,
    approvalGeneration: binding.approvalGeneration,
    authorities,
  };
  const approvalDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(approvalSnapshot))
    .digest('hex')}`;
  const documentDigest = `sha256:${createHash('sha256').update(value).digest('hex')}`;
  if (
    approvalDigest !== binding.approvalDigest ||
    documentDigest !== binding.admissionDocumentDigest
  ) {
    throw new TypeError('hosted-approval-activation-admission-digest-mismatch');
  }
  return record;
}
function orderedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-approval-activation-object-invalid');
  }
  const record = value as Record<string, unknown>;
  if (!exactOrderedKeys(record, keys)) {
    throw new TypeError('hosted-approval-activation-order-invalid');
  }
  return record;
}
function orderedRecordMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-approval-activation-object-invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key, index) => index > 0 && keys[index - 1] > key) ||
    Object.values(record).some((memberId) => typeof memberId !== 'string')
  ) {
    throw new TypeError('hosted-approval-activation-order-invalid');
  }
  return record as Record<string, string>;
}
function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => typeof key === 'string' && expected.includes(key))
  );
}
function exactOrderedKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError('hosted-approval-activation-timeout-invalid');
  }
  return value;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
