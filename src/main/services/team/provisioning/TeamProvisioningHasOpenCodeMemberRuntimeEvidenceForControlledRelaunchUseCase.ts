import { matchesObservedMemberNameForExpected } from './TeamProvisioningMemberIdentity';
import {
  hasOpenCodeRuntimeEntryHandle,
  hasOpenCodeRuntimeHandle,
  hasOpenCodeRuntimeLivenessMarker,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime';
import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

export interface OpenCodeControlledRelaunchRuntimeEvidenceLane {
  result?: Pick<TeamRuntimeLaunchResult, 'members'> | null;
}

export interface HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchInput {
  teamName: string;
  memberName: string;
  laneId: string;
  existingLane: OpenCodeControlledRelaunchRuntimeEvidenceLane | null;
}

export interface HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCasePorts {
  readLaunchStateSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>>;
}

export type HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase = (
  input: HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchInput
) => Promise<boolean>;

export function createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase(
  ports: HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCasePorts
): HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase {
  return async (input) => {
    const laneResultMember =
      input.existingLane?.result?.members[input.memberName] ??
      Object.values(input.existingLane?.result?.members ?? {}).find(
        (member) => member.memberName?.trim() === input.memberName
      );
    if (hasOpenCodeRuntimeHandle(laneResultMember)) {
      return true;
    }

    const persistedSnapshot = await ports.readLaunchStateSnapshot(input.teamName).catch(() => null);
    const persistedMember =
      persistedSnapshot?.members[input.memberName] ??
      Object.values(persistedSnapshot?.members ?? {}).find(
        (member) => member.laneId === input.laneId
      );
    if (
      hasOpenCodeRuntimeHandle(persistedMember) ||
      hasOpenCodeRuntimeLivenessMarker(persistedMember)
    ) {
      return true;
    }

    const liveRuntimeByMember = await ports
      .getLiveTeamAgentRuntimeMetadata(input.teamName)
      .catch(() => new Map<string, LiveTeamAgentRuntimeMetadata>());
    const liveRuntimeMember =
      liveRuntimeByMember.get(input.memberName) ??
      [...liveRuntimeByMember.entries()].find(([candidateName]) =>
        matchesObservedMemberNameForExpected(candidateName, input.memberName)
      )?.[1];
    return hasOpenCodeRuntimeEntryHandle(liveRuntimeMember);
  };
}
