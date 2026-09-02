import {
  type RuntimeEvidenceKind,
  RuntimeStaleEvidenceError,
} from '../opencode/store/RuntimeRunTombstoneStore';

import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';
import { resolveEffectiveConfiguredMember } from './TeamProvisioningMemberStatusProjection';

import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

export interface OpenCodeRuntimeMemberSessionAcceptancePorts {
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
}

export async function assertOpenCodeRuntimeMemberSessionAccepted(
  input: {
    teamName: string;
    runId: string;
    laneId: string;
    memberName: string;
    runtimeSessionId: string;
    evidenceKind: RuntimeEvidenceKind;
  },
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
  input: {
    teamName: string;
    runId: string;
    laneId: string;
    memberName: string;
    runtimeSessionId: string;
    evidenceKind: RuntimeEvidenceKind;
  },
  snapshot: PersistedTeamLaunchSnapshot | null,
  config: TeamConfig | null,
  metaMembers: readonly TeamMember[]
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

  const persistedMember = Object.entries(snapshot?.members ?? {}).find(([memberName]) =>
    matchesTeamMemberIdentity(memberName, configuredMember.name)
  )?.[1];
  const isBootstrapCheckin = input.evidenceKind === 'bootstrap_checkin';
  if (!persistedMember) {
    if (isBootstrapCheckin) return;
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
