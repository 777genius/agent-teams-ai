import {
  buildReplaceMembersDiff,
  buildReplaceMembersSummaryMessage,
} from '@main/services/team/memberUpdateNotifications';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import {
  assertLiveRosterMutationAllowed,
  didOpenCodeRosterMemberChange,
  isLeadRosterMutationMember,
  isOpenCodeLedRoster,
  isOpenCodeRosterMutationMember,
} from './teamLiveRosterMutationPolicy';

import type { RuntimeRosterMutationMember } from './runtimeRosterMutationMember';
import type { TeamMemberLifecycleApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';
import type { ReplaceMembersRequest } from '@shared/types';

const logger = createLogger('TeamNativeRosterMutation');
type NativeRosterLifecycle = Pick<
  TeamMemberLifecycleApi,
  'attachLiveRosterMember' | 'detachLiveRosterMember'
>;

/** The caller holds the existing team configuration/lifecycle gate. */
export interface NativeRosterMutationPorts {
  data: Pick<TeamDataService, 'getTeamData' | 'replaceMembers'>;
  lifecycle: NativeRosterLifecycle;
  isTeamAlive(teamName: string): boolean;
  invalidate(teamName: string): void;
  notify(teamName: string, message: string): Promise<unknown>;
}

/** Invalidate both main-process reads and the worker snapshot after a roster write. */
export function invalidateTeamRosterSnapshotCaches(
  teamName: string,
  data: Pick<TeamDataService, 'invalidateMessageFeed' | 'invalidateTeamRuntimeAdvisories'>
): void {
  TeamConfigReader.invalidateTeam(teamName);
  data.invalidateMessageFeed(teamName);
  data.invalidateTeamRuntimeAdvisories(teamName);
  const worker = getTeamDataWorkerClient();
  worker.invalidateTeamConfig(teamName);
  worker.invalidateMemberRuntimeAdvisory(teamName);
}

function toRollbackReplaceMembersRequest(
  members: RuntimeRosterMutationMember[]
): Pick<ReplaceMembersRequest, 'members'> {
  return {
    members: members
      .filter((member) => !member.removedAt && !isLeadRosterMutationMember(member))
      .map((member) => ({
        name: member.name.trim(),
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        providerBackendId: migrateProviderBackendId(member.providerId, member.providerBackendId),
        model: member.model?.trim() || undefined,
        effort: member.effort,
        fastMode: member.fastMode,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
      })),
  };
}

async function restorePreviousMembersMetaSnapshot(options: {
  teamName: string;
  teamDataService: Pick<TeamDataService, 'replaceMembers'>;
  previousMembers: RuntimeRosterMutationMember[];
  previousMembersMeta: TeamMembersMetaFile | null;
}): Promise<boolean> {
  const { teamName, teamDataService, previousMembers, previousMembersMeta } = options;

  if (previousMembersMeta) {
    try {
      await new TeamMembersMetaStore().writeMembers(teamName, previousMembersMeta.members, {
        providerBackendId: previousMembersMeta.providerBackendId,
      });
      return true;
    } catch (error) {
      logger.error(
        `Failed to restore exact live roster metadata for ${teamName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  try {
    await teamDataService.replaceMembers(
      teamName,
      toRollbackReplaceMembersRequest(previousMembers)
    );
    return true;
  } catch (error) {
    logger.error(
      `Failed to roll back fallback live roster metadata for ${teamName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

export async function rollbackLiveRosterMutation(options: {
  teamName: string;
  teamDataService: Pick<TeamDataService, 'replaceMembers'>;
  memberLifecycle: NativeRosterLifecycle;
  invalidate(teamName: string): void;
  previousMembers: RuntimeRosterMutationMember[];
  previousMembersMeta: TeamMembersMetaFile | null;
  restoreLiveMemberNames?: string[];
  detachLiveMemberNames?: string[];
}): Promise<void> {
  const {
    teamName,
    teamDataService,
    memberLifecycle,
    invalidate,
    previousMembers,
    previousMembersMeta,
    restoreLiveMemberNames = [],
    detachLiveMemberNames = [],
  } = options;

  const detachNames = Array.from(
    new Set(detachLiveMemberNames.map((memberName) => memberName.trim()).filter(Boolean))
  );
  for (const memberName of detachNames) {
    try {
      await memberLifecycle.detachLiveRosterMember(teamName, memberName);
    } catch (error) {
      logger.warn(
        `Failed to clean up live roster member for ${teamName}/${memberName} during rollback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const metadataRestored = await restorePreviousMembersMetaSnapshot({
    teamName,
    teamDataService,
    previousMembers,
    previousMembersMeta,
  });
  if (metadataRestored) {
    invalidate(teamName);
  }

  if (!metadataRestored) {
    return;
  }

  const restoreNames = Array.from(
    new Set(restoreLiveMemberNames.map((memberName) => memberName.trim()).filter(Boolean))
  );
  for (const memberName of restoreNames) {
    try {
      await memberLifecycle.attachLiveRosterMember(teamName, memberName, {
        reason: 'member_updated',
      });
    } catch (error) {
      logger.warn(
        `Failed to restore live roster member for ${teamName}/${memberName} during rollback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

/** Apply an admitted, validated replacement using the native attach/detach and rollback flow. */
export async function replaceNativeTeamMembers(
  teamName: string,
  request: Pick<ReplaceMembersRequest, 'members'>,
  ports: NativeRosterMutationPorts
): Promise<void> {
  const tn = teamName;
  const members = request.members;
  const teamDataService = ports.data;
  const memberLifecycle = ports.lifecycle;
  const isTeamAlive = ports.isTeamAlive(tn);
  if (!isTeamAlive) {
    await teamDataService.replaceMembers(tn, { members });
    ports.invalidate(tn);
    return;
  }
  const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
  const previousTeamData = await teamDataService.getTeamData(tn);
  const previousMembers = previousTeamData.members as RuntimeRosterMutationMember[];
  const useSecondaryOpenCodeLaneRouting = isTeamAlive && !isOpenCodeLedRoster(previousMembers);
  assertLiveRosterMutationAllowed(previousMembers, members);
  const primaryDiff = buildReplaceMembersDiff(
    previousMembers.filter((member) =>
      useSecondaryOpenCodeLaneRouting ? !isOpenCodeRosterMutationMember(member) : true
    ),
    members.filter((member) =>
      useSecondaryOpenCodeLaneRouting ? !isOpenCodeRosterMutationMember(member) : true
    )
  );
  const previousByName = new Map(
    previousMembers
      .filter((member) => !member.removedAt)
      .map((member) => [member.name.trim().toLowerCase(), member])
  );
  const nextByName = new Map(
    members.map((member) => [
      member.name.trim().toLowerCase(),
      member as RuntimeRosterMutationMember,
    ])
  );
  const removedOpenCodeMembers = useSecondaryOpenCodeLaneRouting
    ? previousMembers.filter((member) => {
        const normalizedName = member.name.trim().toLowerCase();
        return (
          !member.removedAt &&
          isOpenCodeRosterMutationMember(member) &&
          !nextByName.has(normalizedName)
        );
      })
    : [];
  const addedOpenCodeMembers = useSecondaryOpenCodeLaneRouting
    ? members.filter((member) => {
        const normalizedName = member.name.trim().toLowerCase();
        return isOpenCodeRosterMutationMember(member) && !previousByName.has(normalizedName);
      })
    : [];
  const updatedOpenCodeMembers = useSecondaryOpenCodeLaneRouting
    ? members.filter((member) => {
        const normalizedName = member.name.trim().toLowerCase();
        const previousMember = previousByName.get(normalizedName);
        return (
          isOpenCodeRosterMutationMember(member) &&
          isOpenCodeRosterMutationMember(previousMember) &&
          didOpenCodeRosterMemberChange(previousMember, member)
        );
      })
    : [];

  await teamDataService.replaceMembers(tn, { members });
  ports.invalidate(tn);

  if (!isTeamAlive) {
    return;
  }

  try {
    for (const removedMember of removedOpenCodeMembers) {
      await memberLifecycle.detachLiveRosterMember(tn, removedMember.name);
    }

    for (const addedMember of addedOpenCodeMembers) {
      await memberLifecycle.attachLiveRosterMember(tn, addedMember.name, {
        reason: 'member_added',
      });
    }

    for (const updatedMember of updatedOpenCodeMembers) {
      await memberLifecycle.attachLiveRosterMember(tn, updatedMember.name, {
        reason: 'member_updated',
      });
    }

    for (const removedMemberName of primaryDiff.removed) {
      await memberLifecycle.detachLiveRosterMember(tn, removedMemberName);
    }

    for (const addedMember of primaryDiff.added) {
      await memberLifecycle.attachLiveRosterMember(tn, addedMember.name, {
        reason: 'member_added',
      });
    }

    for (const updatedMember of primaryDiff.updated) {
      await memberLifecycle.attachLiveRosterMember(tn, updatedMember.name, {
        reason: 'member_updated',
      });
    }
  } catch (error) {
    await rollbackLiveRosterMutation({
      teamName: tn,
      teamDataService,
      memberLifecycle,
      invalidate: ports.invalidate,
      previousMembers,
      previousMembersMeta,
      restoreLiveMemberNames: [
        ...removedOpenCodeMembers.map((member) => member.name),
        ...primaryDiff.removed,
        ...updatedOpenCodeMembers.map((member) => member.name),
        ...primaryDiff.updated.map((member) => member.name),
      ],
      detachLiveMemberNames: [
        ...addedOpenCodeMembers.map((member) => member.name),
        ...primaryDiff.added.map((member) => member.name),
      ],
    });
    throw error;
  }

  const summaryMessage = buildReplaceMembersSummaryMessage({
    ...primaryDiff,
    updated: [],
  });
  if (!summaryMessage) {
    return;
  }
  try {
    await ports.notify(tn, summaryMessage);
  } catch {
    logger.warn(`Failed to notify lead about member updates in ${tn}`);
  }
}
