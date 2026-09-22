import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-approvals/contracts';

import type { RuntimePermissionApprovalIngressAuthority } from '@features/team-approvals/contracts';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
const MEMBER_ID = /^member_[0-9a-f]{32}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u;
const ADMISSION_GENERATION = /^approval-admission-generation_([1-9][0-9]*)_owner_([1-9][0-9]*)$/u;

export interface ParsedHostedApprovalRuntimeAdmissionDocument {
  readonly approvalGeneration: number;
  readonly publishedOwnerGeneration: number;
  readonly authorities: readonly RuntimePermissionApprovalIngressAuthority[];
}

/** Strict schema and canonical-encoding parser for the publisher's persisted admission document. */
export function parseHostedApprovalRuntimeAdmissionDocument(
  body: string
): ParsedHostedApprovalRuntimeAdmissionDocument {
  if (!body.endsWith('\n') || body.includes('\r')) publicationInvalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    publicationInvalid();
  }
  const document = orderedPublicationRecord(parsed, [
    'schemaVersion',
    'admissionGeneration',
    'outerAuthority',
    'routes',
    'actorMembers',
  ]);
  if (
    document.schemaVersion !== 1 ||
    `${JSON.stringify(document)}\n` !== body ||
    typeof document.admissionGeneration !== 'string' ||
    !Array.isArray(document.routes) ||
    document.routes.length === 0 ||
    document.routes.length > 256
  ) {
    publicationInvalid();
  }
  const generation = ADMISSION_GENERATION.exec(document.admissionGeneration);
  if (!generation) publicationInvalid();
  const approvalGeneration = Number(generation[1]);
  const publishedOwnerGeneration = Number(generation[2]);
  if (!positive(approvalGeneration) || !positive(publishedOwnerGeneration)) publicationInvalid();

  const outer = orderedPublicationRecord(document.outerAuthority, [
    'deploymentId',
    'bootId',
    'workspaceId',
    'teamId',
    'restoreGeneration',
    'mountBinding',
  ]);
  const mount = orderedPublicationRecord(outer.mountBinding, [
    'mountGeneration',
    'declaredRootHash',
  ]);
  if (
    typeof outer.deploymentId !== 'string' ||
    !IDENTIFIER.test(outer.deploymentId) ||
    typeof outer.bootId !== 'string' ||
    !IDENTIFIER.test(outer.bootId) ||
    typeof outer.workspaceId !== 'string' ||
    !IDENTIFIER.test(outer.workspaceId) ||
    typeof outer.teamId !== 'string' ||
    !TEAM_ID.test(outer.teamId) ||
    !nonNegative(outer.restoreGeneration) ||
    !positive(mount.mountGeneration) ||
    typeof mount.declaredRootHash !== 'string' ||
    !HEX_SHA256.test(mount.declaredRootHash)
  ) {
    publicationInvalid();
  }

  const actorMembers = orderedPublicationMap(document.actorMembers);
  const actorEntries = Object.entries(actorMembers);
  if (
    actorEntries.length === 0 ||
    actorEntries.length > 256 ||
    actorEntries.some(
      ([actorId, memberId]) =>
        !ACTOR_ID.test(actorId) || typeof memberId !== 'string' || !MEMBER_ID.test(memberId)
    )
  ) {
    publicationInvalid();
  }

  const routeIds = new Set<string>();
  const routeIdentities = new Set<string>();
  const authorities = document.routes.map((candidate) => {
    const route = orderedPublicationRecord(candidate, [
      'routeId',
      'authority',
      'scope',
      'memberName',
      'openCodeBinding',
    ]);
    let authority: RuntimePermissionApprovalIngressAuthority;
    try {
      authority = parseRuntimePermissionApprovalIngressAuthority(route.authority);
    } catch {
      return publicationInvalid();
    }
    const scope = orderedPublicationRecord(route.scope, [
      'principalId',
      'workspaceId',
      'teamId',
      'authorityGeneration',
      'restoreGeneration',
    ]);
    const openCode = orderedPublicationRecord(route.openCodeBinding, [
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
    const identity = `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`;
    if (
      JSON.stringify(authority) !== JSON.stringify(route.authority) ||
      typeof route.routeId !== 'string' ||
      !IDENTIFIER.test(route.routeId) ||
      routeIds.has(route.routeId) ||
      typeof route.memberName !== 'string' ||
      !IDENTIFIER.test(route.memberName) ||
      routeIdentities.has(identity) ||
      authority.deploymentId !== outer.deploymentId ||
      authority.providerId !== 'opencode' ||
      scope.workspaceId !== outer.workspaceId ||
      scope.teamId !== authority.teamId ||
      scope.restoreGeneration !== outer.restoreGeneration ||
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
      !HEX_SHA256.test(openCode.sessionRecordFingerprint) ||
      typeof openCode.liveEffectFingerprint !== 'string' ||
      !HEX_SHA256.test(openCode.liveEffectFingerprint)
    ) {
      publicationInvalid();
    }
    routeIds.add(route.routeId);
    routeIdentities.add(identity);
    return authority;
  });
  const orderedRouteIds = [...routeIds];
  if (
    orderedRouteIds.some((routeId, index) => index > 0 && orderedRouteIds[index - 1] > routeId) ||
    !authorities.some((authority) => authority.teamId === outer.teamId) ||
    authorities.some(
      (authority) => !actorEntries.some(([, memberId]) => memberId === authority.deliveryOwnerId)
    )
  ) {
    publicationInvalid();
  }
  return Object.freeze({ approvalGeneration, publishedOwnerGeneration, authorities });
}

function orderedPublicationRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) publicationInvalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    publicationInvalid();
  }
  return record;
}

function orderedPublicationMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) publicationInvalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key, index) => index > 0 && keys[index - 1] > key)) publicationInvalid();
  return record;
}

function publicationInvalid(): never {
  throw new TypeError('hosted-approval-runtime-publication-invalid');
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
