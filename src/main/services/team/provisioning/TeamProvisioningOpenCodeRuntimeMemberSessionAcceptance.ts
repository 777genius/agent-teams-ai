import {
  type RuntimeEvidenceKind,
  RuntimeStaleEvidenceError,
} from '../opencode/store/RuntimeRunTombstoneStore';

import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';
import { resolveEffectiveConfiguredMember } from './TeamProvisioningMemberStatusProjection';
import {
  hasCommittedOpenCodeRuntimeBootstrapSessionEvidence,
  type OpenCodeRuntimeBootstrapEvidencePorts,
} from './TeamProvisioningOpenCodeBootstrapEvidence';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamMember,
} from '@shared/types';

export interface OpenCodeRuntimeMemberSessionIdentityInput {
  teamName: string;
  runId: string;
  laneId: string;
  memberName: string;
  runtimeSessionId: string;
  evidenceKind: RuntimeEvidenceKind;
}

export interface OpenCodeRuntimeMemberSessionAcceptancePorts {
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
}

export async function assertOpenCodeRuntimeMemberSessionAccepted(
  input: OpenCodeRuntimeMemberSessionIdentityInput,
  ports: OpenCodeRuntimeMemberSessionAcceptancePorts
): Promise<void> {
  const [snapshot, config, metaMembers] = await Promise.all([
    ports.readLaunchState(input.teamName),
    ports.readConfigForStrictDecision(input.teamName),
    ports.readMetaMembers(input.teamName),
  ]);
  assertOpenCodeRuntimeMemberSessionAcceptedFromState(input, snapshot, config, metaMembers);
}

export function assertOpenCodeRuntimeMemberSessionAcceptedFromState(
  input: OpenCodeRuntimeMemberSessionIdentityInput,
  snapshot: PersistedTeamLaunchSnapshot | null,
  config: TeamConfig | null,
  metaMembers: readonly TeamMember[],
  options: { allowMissingPersistedMember?: boolean } = {}
): void {
  if (!config || config.deletedAt) {
    throwRuntimeMemberSessionMismatch(input, 'team configuration is unavailable');
  }

  const configuredMember = resolveEffectiveConfiguredMember(
    config.members ?? [],
    metaMembers,
    input.memberName
  );
  if (!configuredMember) {
    throwRuntimeMemberSessionMismatch(input, 'member is not configured');
  }
  if (configuredMember.removedAt != null) {
    throwRuntimeMemberSessionMismatch(input, 'member has been removed');
  }
  if (configuredMember.providerId !== 'opencode')
    throwRuntimeMemberSessionMismatch(input, 'member is not owned by OpenCode');

  const persistedMember = findPersistedLaunchMemberState(snapshot, configuredMember.name);
  const isBootstrapCheckin = input.evidenceKind === 'bootstrap_checkin';
  if (!persistedMember) {
    if (isBootstrapCheckin) return;
    // Heartbeat self-heal: the caller has already verified lane-scoped committed
    // bootstrap session evidence for this exact runId + runtime session, so a
    // missing launch-state entry is a recoverable snapshot gap, not a stale run.
    if (input.evidenceKind === 'heartbeat' && options.allowMissingPersistedMember) return;
    throwRuntimeMemberSessionMismatch(input, 'member runtime identity is unavailable');
  }
  const persistedRunId = persistedMember.runtimeRunId?.trim();
  if (isBootstrapCheckin && persistedRunId !== input.runId) return;
  const persistedOwnerProviderId =
    persistedMember.laneOwnerProviderId ?? persistedMember.providerId;
  if (persistedOwnerProviderId !== 'opencode') {
    throwRuntimeMemberSessionMismatch(input, 'member is not owned by OpenCode');
  }

  const persistedLaneId = persistedMember.laneId?.trim();
  if (persistedLaneId !== input.laneId) {
    throwRuntimeMemberSessionMismatch(input, 'member lane does not match');
  }
  if (persistedRunId !== input.runId) {
    throwRuntimeMemberSessionMismatch(input, 'member runtime run does not match');
  }
  const persistedSessionId = persistedMember.runtimeSessionId?.trim();
  if (
    persistedSessionId !== input.runtimeSessionId &&
    (!isBootstrapCheckin || Boolean(persistedSessionId))
  ) {
    throwRuntimeMemberSessionMismatch(input, 'member runtime session does not match');
  }
}

/**
 * A heartbeat may arrive while the persisted launch snapshot no longer carries the
 * member (snapshot cleared or rewritten). When the lane-scoped committed bootstrap
 * evidence already pins this exact runId + runtime session, the heartbeat may
 * re-materialize the member entry instead of being rejected with
 * "member runtime identity is unavailable".
 */
export async function shouldSelfHealMissingHeartbeatMemberIdentity(
  input: OpenCodeRuntimeMemberSessionIdentityInput,
  snapshot: PersistedTeamLaunchSnapshot | null,
  createEvidencePorts: () => OpenCodeRuntimeBootstrapEvidencePorts
): Promise<boolean> {
  if (input.evidenceKind !== 'heartbeat') {
    return false;
  }
  if (findPersistedLaunchMemberState(snapshot, input.memberName)) {
    return false;
  }
  return hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(
    {
      teamName: input.teamName,
      runId: input.runId,
      laneId: input.laneId,
      memberName: input.memberName,
      runtimeSessionId: input.runtimeSessionId,
    },
    createEvidencePorts()
  );
}

/** Restore lane/provider identity on a member entry re-materialized by a heartbeat. */
export function applyHealedRuntimeMemberLaneIdentity(
  member: PersistedTeamLaunchMemberState | undefined,
  laneId: string
): void {
  if (!member) {
    return;
  }
  member.providerId ??= 'opencode';
  member.laneId ??= laneId;
  member.laneOwnerProviderId ??= 'opencode';
  member.laneKind ??= laneId === 'primary' ? 'primary' : 'secondary';
}

function findPersistedLaunchMemberState(
  snapshot: PersistedTeamLaunchSnapshot | null,
  memberName: string
): PersistedTeamLaunchMemberState | undefined {
  return Object.entries(snapshot?.members ?? {}).find(([persistedName]) =>
    matchesTeamMemberIdentity(persistedName, memberName)
  )?.[1];
}

function throwRuntimeMemberSessionMismatch(
  input: {
    memberName: string;
    runId: string;
    evidenceKind: RuntimeEvidenceKind;
  },
  reason: string
): never {
  throw new RuntimeStaleEvidenceError(
    `Rejected OpenCode ${input.evidenceKind} for ${input.memberName}: ${reason}`,
    'run_mismatch',
    input.evidenceKind,
    input.runId
  );
}
