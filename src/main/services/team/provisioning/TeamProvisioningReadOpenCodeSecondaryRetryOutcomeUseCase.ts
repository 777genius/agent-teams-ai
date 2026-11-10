import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';

import type { TeamRuntimeLaunchResult, TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type {
  MemberLaunchState,
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

export interface OpenCodeSecondaryRetryOutcome {
  launchState: MemberLaunchState;
  reason?: string;
}

export interface ReadOpenCodeSecondaryRetryOutcomeRun {
  teamName: string;
  mixedSecondaryLanes?: readonly {
    laneId: string;
    member: { name: string };
    result?: Pick<TeamRuntimeLaunchResult, 'members'> | null;
  }[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
}

export type ReadOpenCodeSecondaryRetryOutcomeUseCase = (
  run: ReadOpenCodeSecondaryRetryOutcomeRun,
  memberName: string,
  laneId: string
) => Promise<OpenCodeSecondaryRetryOutcome>;

export interface ReadOpenCodeSecondaryRetryOutcomeUseCasePorts {
  readLaunchStateSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
}

export function createReadOpenCodeSecondaryRetryOutcomeUseCase(
  ports: ReadOpenCodeSecondaryRetryOutcomeUseCasePorts
): ReadOpenCodeSecondaryRetryOutcomeUseCase {
  return async (run, memberName, laneId) => {
    const lane = (run.mixedSecondaryLanes ?? []).find(
      (candidate) =>
        candidate.laneId === laneId || matchesTeamMemberIdentity(candidate.member.name, memberName)
    );
    const memberEvidence =
      lane?.result?.members[memberName] ??
      Object.values(lane?.result?.members ?? {}).find((member) =>
        matchesTeamMemberIdentity(member.memberName, memberName)
      );
    const persistedSnapshot = await ports.readLaunchStateSnapshot(run.teamName).catch(() => null);
    const persistedMember =
      persistedSnapshot?.members[memberName] ??
      Object.values(persistedSnapshot?.members ?? {}).find((member) => member.laneId === laneId);
    const liveEntry = run.memberSpawnStatuses.get(memberName);

    if (
      memberEvidence?.launchState === 'confirmed_alive' ||
      memberEvidence?.bootstrapConfirmed === true ||
      liveEntry?.launchState === 'confirmed_alive' ||
      liveEntry?.bootstrapConfirmed === true ||
      persistedMember?.launchState === 'confirmed_alive' ||
      persistedMember?.bootstrapConfirmed === true
    ) {
      return { launchState: 'confirmed_alive' };
    }

    if (
      liveEntry?.launchState === 'skipped_for_launch' ||
      liveEntry?.skippedForLaunch === true ||
      persistedMember?.launchState === 'skipped_for_launch' ||
      persistedMember?.skippedForLaunch === true
    ) {
      return {
        launchState: 'skipped_for_launch',
        reason: liveEntry?.skipReason ?? persistedMember?.skipReason,
      };
    }

    if (
      memberEvidence?.launchState === 'failed_to_start' ||
      memberEvidence?.hardFailure === true ||
      liveEntry?.launchState === 'failed_to_start' ||
      liveEntry?.status === 'error' ||
      persistedMember?.launchState === 'failed_to_start' ||
      persistedMember?.hardFailure === true
    ) {
      return {
        launchState: 'failed_to_start',
        reason: selectOpenCodeSecondaryRetryFailureReason({
          memberEvidence,
          liveEntry,
          persistedMember,
        }),
      };
    }

    return {
      launchState:
        memberEvidence?.launchState ??
        liveEntry?.launchState ??
        persistedMember?.launchState ??
        'runtime_pending_bootstrap',
    };
  };
}

function selectOpenCodeSecondaryRetryFailureReason(input: {
  memberEvidence?: TeamRuntimeMemberLaunchEvidence;
  liveEntry?: MemberSpawnStatusEntry;
  persistedMember?: PersistedTeamLaunchMemberState;
}): string | undefined {
  const diagnostics = [
    input.memberEvidence?.hardFailureReason,
    input.memberEvidence?.runtimeDiagnostic,
    ...(input.memberEvidence?.diagnostics ?? []),
    input.liveEntry?.hardFailureReason,
    input.liveEntry?.runtimeDiagnostic,
    input.liveEntry?.error,
    input.persistedMember?.hardFailureReason,
    input.persistedMember?.runtimeDiagnostic,
  ];
  return diagnostics
    .find(
      (diagnostic): diagnostic is string =>
        typeof diagnostic === 'string' && diagnostic.trim().length > 0
    )
    ?.trim();
}
