import { useMemo } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
  selectTeamIsAliveForName,
} from '@renderer/store/slices/teamSlice';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  getMemberDotClass,
  getPresenceLabel,
  resolveMemberIdentityColor,
  STATUS_DOT_COLORS,
} from '@renderer/utils/memberHelpers';
import { isLeadNameAlias } from '@shared/utils/leadDetection';
import { useShallow } from 'zustand/react/shallow';

export interface ChatMemberIdentity {
  name: string;
  color?: string;
  avatarUrl?: string;
  presenceClass: string;
  presenceLabel: string;
  avatarUrlFor: (participant: string) => string;
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
  const { member, members, isTeamAlive, leadActivity } = useStore(
    useShallow((state) => ({
      member: selectResolvedMemberForTeamName(state, teamName, name),
      members: selectResolvedMembersForTeamName(state, teamName),
      isTeamAlive: selectTeamIsAliveForName(state, teamName),
      leadActivity: state.leadActivityByTeam[teamName],
    }))
  );
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

  return {
    name,
    color: resolveMemberIdentityColor(name, colorMap, member?.color ?? fallbackColor),
    avatarUrl: rosterAvatarUrl(name, avatarMap),
    presenceClass: member
      ? getMemberDotClass(member, isTeamAlive, undefined, leadActivity)
      : STATUS_DOT_COLORS.unknown,
    presenceLabel: member
      ? getPresenceLabel(member, isTeamAlive, undefined, leadActivity)
      : 'offline',
    avatarUrlFor: (participant: string) => rosterAvatarUrl(participant, avatarMap),
  };
}
