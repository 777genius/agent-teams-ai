import {
  type BootId,
  type DeploymentId,
  type MemberId,
  parseBootId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
  type RunId,
  type TeamId,
} from '@shared/contracts/hosted';

import { exactPublicationRecord } from './teamDraftPublicationContracts';

/** Supplied only by trusted Product composition after authenticated Owner readiness. */
export interface HostedLifecycleAuthorityEpoch {
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
}

export interface HostedLifecycleCurrentAuthority extends HostedLifecycleAuthorityEpoch {
  readonly revision: number;
  readonly state: 'active' | 'retired';
}

export interface HostedLifecycleCurrentRun extends HostedLifecycleAuthorityEpoch {
  readonly runId: RunId;
  readonly teamId: TeamId;
  readonly state: 'eligible' | 'cleanup_pending' | 'retired';
}

export type HostedLifecycleCurrentTeamSelector = Readonly<{
  deploymentId: DeploymentId;
  teamId: TeamId;
}>;

export type HostedLifecycleEpochUpdate = {
  readonly binding: HostedLifecycleAuthorityEpoch;
  readonly expectedRevision: number | null;
};
export type HostedLifecycleRunStateChange = {
  readonly binding: HostedLifecycleAuthorityEpoch;
  readonly runId: RunId;
};
export type HostedLifecycleMemberRetirement = HostedLifecycleRunStateChange & {
  readonly memberId: MemberId;
};
export type HostedLifecycleCurrentMutationResult =
  | { readonly kind: 'applied' | 'idempotent_replay'; readonly revision: number }
  | { readonly kind: 'conflict' };

export interface HostedLifecycleCurrentAuthorityGateway {
  lookupAuthority(deploymentId: DeploymentId): Promise<HostedLifecycleCurrentAuthority | null>;
  lookupRun(runId: RunId): Promise<HostedLifecycleCurrentRun | null>;
  lookupTeamRun(
    input: HostedLifecycleCurrentTeamSelector
  ): Promise<HostedLifecycleCurrentRun | null>;
  setCurrentAuthority(
    input: HostedLifecycleEpochUpdate
  ): Promise<HostedLifecycleCurrentMutationResult>;
  retireAuthority(input: HostedLifecycleEpochUpdate): Promise<HostedLifecycleCurrentMutationResult>;
  activateReservedRun(
    input: HostedLifecycleRunStateChange
  ): Promise<'activated' | 'already_current' | 'conflict'>;
  retireRun(
    input: HostedLifecycleRunStateChange
  ): Promise<'cleanup_pending' | 'already_pending' | 'already_retired' | 'conflict'>;
  confirmRunRetired(
    input: HostedLifecycleRunStateChange
  ): Promise<'retired' | 'already_retired' | 'conflict'>;
  retireMember(
    input: HostedLifecycleMemberRetirement
  ): Promise<'retired' | 'already_retired' | 'conflict'>;
}

export function parseHostedLifecycleCurrentRun(value: unknown): HostedLifecycleCurrentRun {
  const row = exactPublicationRecord(value, [
    'runId',
    'deploymentId',
    'bootId',
    'teamId',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'restoreGeneration',
    'mountGeneration',
    'state',
  ]);
  if (row.state !== 'eligible' && row.state !== 'cleanup_pending' && row.state !== 'retired')
    throw new TypeError('hosted-lifecycle-current-run-invalid');
  const { runId, teamId, state, ...epoch } = row;
  return Object.freeze({
    ...parseHostedLifecycleAuthorityEpoch(epoch),
    runId: parseRunId(runId),
    teamId: parseTeamId(teamId),
    state,
  });
}

export function parseHostedLifecycleCurrentTeamSelector(
  value: unknown
): HostedLifecycleCurrentTeamSelector {
  const row = exactPublicationRecord(value, ['deploymentId', 'teamId']);
  return Object.freeze({
    deploymentId: parseDeploymentId(row.deploymentId),
    teamId: parseTeamId(row.teamId),
  });
}

const AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

export function parseHostedLifecycleAuthorityEpoch(value: unknown): HostedLifecycleAuthorityEpoch {
  const row = exactPublicationRecord(value, [
    'deploymentId',
    'bootId',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'restoreGeneration',
    'mountGeneration',
  ]);
  if (
    typeof row.ownerAuthority !== 'string' ||
    !AUTHORITY.test(row.ownerAuthority) ||
    typeof row.ownerSessionId !== 'string' ||
    !SESSION.test(row.ownerSessionId) ||
    !Number.isSafeInteger(row.ownerGeneration) ||
    (row.ownerGeneration as number) < 1 ||
    !Number.isSafeInteger(row.restoreGeneration) ||
    (row.restoreGeneration as number) < 0 ||
    !Number.isSafeInteger(row.mountGeneration) ||
    (row.mountGeneration as number) < 1
  )
    throw new TypeError('hosted-lifecycle-authority-epoch-invalid');
  return Object.freeze({
    deploymentId: parseDeploymentId(row.deploymentId),
    bootId: parseBootId(row.bootId),
    ownerAuthority: row.ownerAuthority,
    ownerGeneration: row.ownerGeneration as number,
    ownerSessionId: row.ownerSessionId,
    restoreGeneration: row.restoreGeneration as number,
    mountGeneration: row.mountGeneration as number,
  });
}

export function parseHostedLifecycleCurrentAuthority(
  value: unknown
): HostedLifecycleCurrentAuthority {
  const row = exactPublicationRecord(value, [
    'deploymentId',
    'bootId',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'restoreGeneration',
    'mountGeneration',
    'revision',
    'state',
  ]);
  if (
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    (row.state !== 'active' && row.state !== 'retired')
  )
    throw new TypeError('hosted-lifecycle-current-authority-invalid');
  const { revision: ignoredRevision, state: ignoredState, ...epoch } = row;
  void ignoredRevision;
  void ignoredState;
  return Object.freeze({
    ...parseHostedLifecycleAuthorityEpoch(epoch),
    revision: row.revision as number,
    state: row.state,
  });
}

export function parseHostedLifecycleEpochUpdate(value: unknown): HostedLifecycleEpochUpdate {
  const row = exactPublicationRecord(value, ['binding', 'expectedRevision']);
  if (
    row.expectedRevision !== null &&
    (!Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 1)
  )
    throw new TypeError('hosted-lifecycle-epoch-update-invalid');
  return Object.freeze({
    binding: parseHostedLifecycleAuthorityEpoch(row.binding),
    expectedRevision: row.expectedRevision as number | null,
  });
}

export function parseHostedLifecycleRunStateChange(value: unknown): HostedLifecycleRunStateChange {
  const row = exactPublicationRecord(value, ['binding', 'runId']);
  return Object.freeze({
    binding: parseHostedLifecycleAuthorityEpoch(row.binding),
    runId: parseRunId(row.runId),
  });
}

export function parseHostedLifecycleMemberRetirement(
  value: unknown
): HostedLifecycleMemberRetirement {
  const row = exactPublicationRecord(value, ['binding', 'runId', 'memberId']);
  return Object.freeze({
    binding: parseHostedLifecycleAuthorityEpoch(row.binding),
    runId: parseRunId(row.runId),
    memberId: parseMemberId(row.memberId),
  });
}

export function parseHostedLifecycleCurrentMutationResult(
  value: unknown
): HostedLifecycleCurrentMutationResult {
  const row = exactPublicationRecord(
    value,
    (value as { kind?: unknown })?.kind === 'conflict' ? ['kind'] : ['kind', 'revision']
  );
  if (row.kind === 'conflict') return { kind: 'conflict' };
  if (
    (row.kind === 'applied' || row.kind === 'idempotent_replay') &&
    Number.isSafeInteger(row.revision) &&
    (row.revision as number) > 0
  )
    return { kind: row.kind, revision: row.revision as number };
  throw new TypeError('hosted-lifecycle-current-mutation-result-invalid');
}
