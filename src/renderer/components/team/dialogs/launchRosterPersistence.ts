import { api } from '@renderer/api';

import type { ReplaceMembersRequest } from '@shared/types';

/**
 * Launch mode saves the roster shown in the form before it launches.
 *
 * A per-project team's roster is owned by its definition, which only the team
 * edit flow writes; the form here shows the roster of one project copy and
 * must never write it back (a stale copy would overwrite the definition and
 * spread to every project). Such a dialog is `rosterReadOnly`.
 */
export async function saveLaunchRoster(
  rosterReadOnly: boolean | undefined,
  teamName: string,
  members: ReplaceMembersRequest['members'],
  memberSettingsRelaunch?: ReplaceMembersRequest['memberSettingsRelaunch']
): Promise<void> {
  if (rosterReadOnly) return;
  await api.teams.replaceMembers(teamName, { members, memberSettingsRelaunch });
}
