import { getBaseName } from '@renderer/utils/pathUtils';

import type { ResolvedTeamMember, TeamMemberSnapshot } from '@shared/types';

/** Pure list-view presentation values kept outside the stateful page component. */
export function formatTeamProjectPathName(fullPath: string): string {
  return getBaseName(fullPath) || fullPath;
}

/** Normalizes persisted member snapshots for the launch dialog's live-member shape. */
export function resolveLaunchDialogMembers(
  members: readonly TeamMemberSnapshot[]
): ResolvedTeamMember[] {
  return members.map((member) => ({
    ...member,
    status: member.currentTaskId ? 'active' : 'idle',
    messageCount: 0,
    lastActiveAt: null,
  }));
}
