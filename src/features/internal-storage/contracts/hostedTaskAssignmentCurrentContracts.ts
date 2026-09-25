import {
  type DeploymentId,
  type MemberId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted';

import { parseHostedLifecycleAuthorityEpoch } from './hostedLifecycleCurrentAuthorityContracts';

export interface HostedTaskAssignmentCurrentSelector {
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  readonly ownerId: MemberId;
  readonly grantRevision: string;
  readonly identityChecksum: string;
}

export interface HostedTaskAssignmentCurrentPin {
  readonly runId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
}

const SHA = /^[0-9a-f]{64}$/u;

export function parseHostedTaskAssignmentCurrentSelector(
  value: unknown
): HostedTaskAssignmentCurrentSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('hosted-task-assignment-selector-invalid');
  const row = value as Record<string, unknown>;
  const fields = ['deploymentId', 'teamId', 'ownerId', 'grantRevision', 'identityChecksum'];
  if (
    Reflect.ownKeys(row).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(row, field)) ||
    typeof row.grantRevision !== 'string' ||
    !SHA.test(row.grantRevision) ||
    typeof row.identityChecksum !== 'string' ||
    !SHA.test(row.identityChecksum)
  )
    throw new TypeError('hosted-task-assignment-selector-invalid');
  return Object.freeze({
    deploymentId: parseDeploymentId(row.deploymentId),
    teamId: parseTeamId(row.teamId),
    ownerId: parseMemberId(row.ownerId),
    grantRevision: row.grantRevision,
    identityChecksum: row.identityChecksum,
  });
}

export function parseHostedTaskAssignmentCurrentPin(
  value: unknown
): HostedTaskAssignmentCurrentPin {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('hosted-task-assignment-pin-invalid');
  const row = value as Record<string, unknown>;
  const fields = [
    'runId',
    'deploymentId',
    'bootId',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'restoreGeneration',
    'mountGeneration',
  ];
  if (
    Reflect.ownKeys(row).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(row, field))
  )
    throw new TypeError('hosted-task-assignment-pin-invalid');
  const epoch = parseHostedLifecycleAuthorityEpoch({
    deploymentId: row.deploymentId,
    bootId: row.bootId,
    ownerAuthority: row.ownerAuthority,
    ownerGeneration: row.ownerGeneration,
    ownerSessionId: row.ownerSessionId,
    restoreGeneration: row.restoreGeneration,
    mountGeneration: row.mountGeneration,
  });
  return Object.freeze({ runId: parseRunId(row.runId), ...epoch });
}
