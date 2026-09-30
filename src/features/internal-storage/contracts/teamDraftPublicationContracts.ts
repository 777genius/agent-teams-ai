import { parseActorId, parseDeploymentId, parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import { parseDirectoryFingerprint, parseIdentityTimestamp, parseLegacyTeamKey, parseTeamAdoptionIntentId } from './teamIdentityStorageContracts';

import type { DirectoryFingerprint, LegacyTeamKey, TeamAdoptionIntentId } from './teamIdentityStorageContracts';
import type { ActorId, DeploymentId, Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

/** Host-derived create attribution, never accepted from the browser DTO. */
export interface TeamDraftPublicationBinding {
  readonly actorId: ActorId;
  readonly deploymentId: DeploymentId;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly bindingGeneration: number;
}

export interface TeamDraftPublicationScope {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly actorId: ActorId;
  readonly deploymentId: DeploymentId;
}

export interface TeamDraftPublication extends TeamDraftPublicationBinding, TeamDraftPublicationScope {
  readonly operationId: TeamAdoptionIntentId;
  readonly legacyKey: LegacyTeamKey;
  readonly createdAt: string;
  readonly initialRevision: Revision;
  readonly directoryFingerprint: DirectoryFingerprint | null;
  readonly state: 'pending' | 'published' | 'recovery_required' | 'tombstoned';
}

export interface TeamDraftPublicationStorageGateway {
  lookupTeamDraftPublication(input: Omit<TeamDraftPublicationScope, 'teamId'> & {
    readonly reference: { readonly operationId: string } | { readonly idempotencyKey: string };
  }): Promise<TeamDraftPublication | null>;
  readTeamDraftPublication(scope: TeamDraftPublicationScope): Promise<TeamDraftPublication | null>;
  settleTeamDraftPublication(input: TeamDraftPublicationScope & {
    readonly operationId: TeamAdoptionIntentId;
    readonly directoryFingerprint: DirectoryFingerprint | null;
    readonly state: TeamDraftPublication['state'];
    readonly deadlineAtMs: number;
  }): Promise<TeamDraftPublication>;
}

export function parseTeamDraftPublicationBinding(value: unknown): TeamDraftPublicationBinding {
  const input = exactPublicationRecord(value, ['actorId', 'deploymentId', 'runtimeWorkspaceId', 'bindingGeneration']);
  if (!Number.isSafeInteger(input.bindingGeneration) || (input.bindingGeneration as number) < 1) {
    throw new TypeError('draft-publication-binding-invalid');
  }
  return Object.freeze({
    actorId: parseActorId(input.actorId), deploymentId: parseDeploymentId(input.deploymentId),
    runtimeWorkspaceId: parseWorkspaceId(input.runtimeWorkspaceId),
    bindingGeneration: input.bindingGeneration as number,
  });
}

export function parseTeamDraftPublicationScope(value: unknown): TeamDraftPublicationScope {
  const input = exactPublicationRecord(value, ['workspaceId', 'teamId', 'actorId', 'deploymentId']);
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId), teamId: parseTeamId(input.teamId),
    actorId: parseActorId(input.actorId), deploymentId: parseDeploymentId(input.deploymentId),
  });
}

export function parseTeamDraftPublication(value: unknown): TeamDraftPublication {
  const input = exactPublicationRecord(value, ['workspaceId', 'teamId', 'actorId', 'deploymentId',
    'runtimeWorkspaceId', 'bindingGeneration', 'operationId', 'legacyKey', 'createdAt',
    'initialRevision', 'directoryFingerprint', 'state']);
  const { workspaceId, teamId, actorId, deploymentId, runtimeWorkspaceId, bindingGeneration } = input;
  const operationId = parseTeamAdoptionIntentId(input.operationId);
  if (input.legacyKey !== `draft-${operationId.slice(9)}` ||
      typeof input.state !== 'string' || !['pending', 'published', 'recovery_required', 'tombstoned'].includes(input.state) ||
      (input.state === 'published' && input.directoryFingerprint === null)) {
    throw new TypeError('draft-publication-record-invalid');
  }
  return Object.freeze({
    ...parseTeamDraftPublicationScope({ workspaceId, teamId, actorId, deploymentId }),
    ...parseTeamDraftPublicationBinding({ actorId, deploymentId, runtimeWorkspaceId, bindingGeneration }),
    operationId, legacyKey: parseLegacyTeamKey(input.legacyKey),
    createdAt: parseIdentityTimestamp(input.createdAt), initialRevision: parseRevision(input.initialRevision),
    directoryFingerprint: input.directoryFingerprint === null ? null : parseDirectoryFingerprint(input.directoryFingerprint),
    state: input.state as TeamDraftPublication['state'],
  });
}

export function exactPublicationRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError('draft-publication-shape-invalid');
  }
  return value as Record<string, unknown>;
}
