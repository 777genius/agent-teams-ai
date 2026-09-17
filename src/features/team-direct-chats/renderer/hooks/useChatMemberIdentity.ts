import { useMemo } from 'react';

import {
  getLaunchJoinMilestonesFromMembers,
  getLaunchJoinState,
} from '@renderer/components/team/provisioningSteps';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  selectResolvedMembersForTeamName,
  selectTeamIsAliveForName,
} from '@renderer/store/slices/teamSlice';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  buildMemberLaunchPresentation,
  resolveMemberIdentityColor,
  STATUS_DOT_COLORS,
} from '@renderer/utils/memberHelpers';
import { isLeadMember, isLeadNameAlias } from '@shared/utils/leadDetection';
import { useShallow } from 'zustand/react/shallow';

export interface ChatMemberIdentity {
  name: string;
  color?: string;
  avatarUrl?: string;
  presenceClass: string;
  presenceLabel: string;
  avatarUrlFor: (participant: string) => string;
}

export function resolveChatRosterMember<
  T extends { name: string; agentType?: unknown; role?: unknown },
>(members: readonly T[], name: string): T | undefined {
  const normalized = name.trim().toLowerCase();
  const exact = members.find((member) => member.name === name);
  if (exact) {
    return exact;
  }
  const caseInsensitive = members.find((member) => member.name.trim().toLowerCase() === normalized);
  if (caseInsensitive) {
    return caseInsensitive;
  }
  if (isLeadNameAlias(name)) {
    return members.find((member) => isLeadMember(member));
  }
  return undefined;
}

export function rosterAvatarUrl(
  memberName: string,
  avatarMap: ReadonlyMap<string, string>
): string {
  const exact = avatarMap.get(memberName);
  if (exact) return exact;

  const normalizedName = memberName.trim().toLowerCase();
  const queryIsLead = isLeadNameAlias(memberName);
  for (const [candidateName, url] of avatarMap) {
    const normalizedCandidate = candidateName.trim().toLowerCase();
    if (normalizedCandidate === normalizedName) {
      return url;
    }
    if (queryIsLead && isLeadNameAlias(candidateName)) {
      return url;
    }
  }

  return agentAvatarUrl(memberName);
}

export function useChatMemberIdentity(
  teamName: string,
  name: string,
  fallbackColor?: string
): ChatMemberIdentity {
  const {
    members,
    isTeamAlive,
    leadActivity,
    progress,
    memberSpawnSnapshot,
    memberSpawnStatuses,
    runtimeEntries,
  } = useStore(
    useShallow((state) => ({
      members: selectResolvedMembersForTeamName(state, teamName),
      isTeamAlive: selectTeamIsAliveForName(state, teamName),
      leadActivity: state.leadActivityByTeam[teamName],
      progress: getCurrentProvisioningProgressForTeam(state, teamName),
      memberSpawnSnapshot: state.memberSpawnSnapshotsByTeam[teamName],
      memberSpawnStatuses: state.memberSpawnStatusesByTeam[teamName],
      runtimeEntries: state.teamAgentRuntimeByTeam?.[teamName]?.members,
    }))
  );
  const member = resolveChatRosterMember(members, name);
  const rosterName = member?.name ?? name;
  const spawnEntry = memberSpawnStatuses?.[rosterName];
  const runtimeEntry = runtimeEntries?.[rosterName];
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const isLaunchSettling = useMemo(() => {
    if (progress?.state !== 'ready') {
      return false;
    }
    return getLaunchJoinState(
      getLaunchJoinMilestonesFromMembers({
        members,
        memberSpawnStatuses,
        memberSpawnSnapshot,
        memberRuntimeEntries: runtimeEntries,
      })
    ).hasMembersStillJoining;
  }, [members, memberSpawnSnapshot, memberSpawnStatuses, progress?.state, runtimeEntries]);
  const presentation = member
    ? buildMemberLaunchPresentation({
        member,
        spawnStatus: spawnEntry?.status,
        spawnLaunchState: spawnEntry?.launchState,
        spawnLivenessSource: spawnEntry?.livenessSource,
        spawnRuntimeAlive: spawnEntry?.runtimeAlive,
        spawnBootstrapConfirmed: spawnEntry?.bootstrapConfirmed,
        spawnBootstrapStalled: spawnEntry?.bootstrapStalled,
        spawnAgentToolAccepted: spawnEntry?.agentToolAccepted,
        spawnHardFailure: spawnEntry?.hardFailure,
        spawnHardFailureReason: spawnEntry?.hardFailureReason,
        spawnError: spawnEntry?.error,
        spawnRuntimeDiagnostic: spawnEntry?.runtimeDiagnostic,
        spawnLivenessKind: spawnEntry?.livenessKind,
        spawnRuntimeDiagnosticSeverity: spawnEntry?.runtimeDiagnosticSeverity,
        spawnFirstSpawnAcceptedAt: spawnEntry?.firstSpawnAcceptedAt,
        spawnUpdatedAt: spawnEntry?.updatedAt,
        runtimeEntry,
        runtimeAdvisory: member.runtimeAdvisory,
        isLaunchSettling,
        isTeamAlive,
        isTeamProvisioning: false,
        leadActivity: isLeadMember(member) ? leadActivity : undefined,
      })
    : null;

  return {
    name,
    color: resolveMemberIdentityColor(name, colorMap, member?.color ?? fallbackColor),
    avatarUrl: rosterAvatarUrl(name, avatarMap),
    presenceClass: presentation?.dotClass ?? STATUS_DOT_COLORS.unknown,
    presenceLabel: presentation?.presenceLabel ?? 'offline',
    avatarUrlFor: (participant: string) => rosterAvatarUrl(participant, avatarMap),
  };
}
