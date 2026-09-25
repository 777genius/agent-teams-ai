import {
  type BootId,
  type DeploymentId,
  type MemberId,
  parseBootId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  type RunId,
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
  setCurrentAuthority(
    input: HostedLifecycleEpochUpdate
  ): Promise<HostedLifecycleCurrentMutationResult>;
  retireAuthority(input: HostedLifecycleEpochUpdate): Promise<HostedLifecycleCurrentMutationResult>;
  activateReservedRun(
    input: HostedLifecycleRunStateChange
  ): Promise<'activated' | 'already_current' | 'conflict'>;
  retireRun(
    input: HostedLifecycleRunStateChange
  ): Promise<'retired' | 'already_retired' | 'conflict'>;
  retireMember(
    input: HostedLifecycleMemberRetirement
  ): Promise<'retired' | 'already_retired' | 'conflict'>;
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
