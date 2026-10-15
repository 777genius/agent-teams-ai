import type { LeadActivityState } from '@shared/types';

/** Pure projection shared by the legacy task sidebar and task-folder tree. */
export function selectLeadOfflineTeamNames(
  leadActivityByTeam: Partial<Record<string, LeadActivityState>>
): string[] {
  const offlineTeamNames: string[] = [];
  for (const [teamName, activity] of Object.entries(leadActivityByTeam)) {
    if (activity === 'offline') offlineTeamNames.push(teamName);
  }
  return offlineTeamNames.sort();
}
