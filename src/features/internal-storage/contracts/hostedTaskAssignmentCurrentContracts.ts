import {
  type ActorId,
  type DeploymentId,
  type MemberId,
  parseActorId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  parseHostedLifecycleAuthorityEpoch,
  type HostedLifecycleAuthorityEpoch,
} from './hostedLifecycleCurrentAuthorityContracts';
import { parseAuthorityEvidence } from './hostedPromotionStorageContracts';
import { exactPublicationRecord } from './teamDraftPublicationContracts';

/** Captured fresh from the current authenticated request, never from a frozen reservation. */
export interface HostedTaskAssignmentCurrentRequester {
  readonly workspaceId: WorkspaceId;
  readonly actorId: ActorId;
  readonly userId: string;
  readonly sessionId: string;
  readonly grantRevision: string;
  readonly grantGeneration: number;
}

/** Only member-target commands (create_task/update_owner with an ownerId) need Member currency. */
export type HostedTaskAssignmentCurrentTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'member'; readonly memberId: MemberId };

export interface HostedTaskAssignmentCurrentSelector {
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  /** The calling process's own epoch, checked against Writer currency (not superseded). */
  readonly writerEpoch: HostedLifecycleAuthorityEpoch;
  readonly requester: HostedTaskAssignmentCurrentRequester;
  readonly identityChecksum: string;
  readonly target: HostedTaskAssignmentCurrentTarget;
}

/** A current Product decision: the writer epoch plus the eligible run pinned to it, if any. */
export interface HostedTaskAssignmentCurrentPin extends HostedLifecycleAuthorityEpoch {
  readonly runId: string | null;
}

const SHA = /^[0-9a-f]{64}$/u;

function parseHostedTaskAssignmentCurrentRequester(
  value: unknown
): HostedTaskAssignmentCurrentRequester {
  const row = exactPublicationRecord(value, [
    'workspaceId',
    'actorId',
    'userId',
    'sessionId',
    'grantRevision',
    'grantGeneration',
  ]);
  const evidence = parseAuthorityEvidence({
    userId: row.userId,
    sessionId: row.sessionId,
    grantRevision: row.grantRevision,
    grantGeneration: row.grantGeneration,
  });
  return Object.freeze({
    workspaceId: parseWorkspaceId(row.workspaceId),
    actorId: parseActorId(row.actorId),
    ...evidence,
  });
}

function parseHostedTaskAssignmentCurrentTarget(value: unknown): HostedTaskAssignmentCurrentTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('hosted-task-assignment-target-invalid');
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'none') {
    if (Reflect.ownKeys(value).length !== 1)
      throw new TypeError('hosted-task-assignment-target-invalid');
    return Object.freeze({ kind: 'none' });
  }
  if (kind === 'member') {
    const row = exactPublicationRecord(value, ['kind', 'memberId']);
    return Object.freeze({ kind: 'member', memberId: parseMemberId(row.memberId) });
  }
  throw new TypeError('hosted-task-assignment-target-invalid');
}

export function parseHostedTaskAssignmentCurrentSelector(
  value: unknown
): HostedTaskAssignmentCurrentSelector {
  const row = exactPublicationRecord(value, [
    'deploymentId',
    'teamId',
    'writerEpoch',
    'requester',
    'identityChecksum',
    'target',
  ]);
  if (typeof row.identityChecksum !== 'string' || !SHA.test(row.identityChecksum))
    throw new TypeError('hosted-task-assignment-selector-invalid');
  const deploymentId = parseDeploymentId(row.deploymentId);
  const writerEpoch = parseHostedLifecycleAuthorityEpoch(row.writerEpoch);
  // The top-level scope and the writer's own epoch must name the same deployment: otherwise a
  // caller could pass Writer currency for one deployment while resolving Team/Member data
  // under another, which no downstream check would ever separately catch.
  if (deploymentId !== writerEpoch.deploymentId)
    throw new TypeError('hosted-task-assignment-selector-invalid');
  return Object.freeze({
    deploymentId,
    teamId: parseTeamId(row.teamId),
    writerEpoch,
    requester: parseHostedTaskAssignmentCurrentRequester(row.requester),
    identityChecksum: row.identityChecksum,
    target: parseHostedTaskAssignmentCurrentTarget(row.target),
  });
}

export function parseHostedTaskAssignmentCurrentPin(
  value: unknown
): HostedTaskAssignmentCurrentPin {
  const row = exactPublicationRecord(value, [
    'runId',
    'deploymentId',
    'bootId',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'restoreGeneration',
    'mountGeneration',
  ]);
  const epoch = parseHostedLifecycleAuthorityEpoch({
    deploymentId: row.deploymentId,
    bootId: row.bootId,
    ownerAuthority: row.ownerAuthority,
    ownerGeneration: row.ownerGeneration,
    ownerSessionId: row.ownerSessionId,
    restoreGeneration: row.restoreGeneration,
    mountGeneration: row.mountGeneration,
  });
  if (row.runId !== null && typeof row.runId !== 'string')
    throw new TypeError('hosted-task-assignment-pin-invalid');
  return Object.freeze({ runId: row.runId === null ? null : parseRunId(row.runId), ...epoch });
}

/** Host-resolved evidence passed to the Product write authority; never parsed from wire input. */
export interface HostedTaskWriteCommitEvidence {
  readonly deploymentId: DeploymentId;
  readonly workspaceId: WorkspaceId;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly actorId: ActorId;
  readonly userId: string;
  readonly sessionId: string;
  readonly grantRevision: string;
  readonly grantGeneration: number;
}
