import type { TeamManagementCommittedChange } from '@features/team-prompt-management/contracts';
import type { TeamSummary } from '@shared/types';

type Notices = Record<string, TeamManagementCommittedChange>;

/** Latest committed facts only; trashed entries serve as bounded late-event tombstones. */
export function retainTeamManagementNotice(
  current: Notices,
  teamName: string,
  change: TeamManagementCommittedChange
): Notices {
  if (Object.values(current).some((notice) => notice.operationId === change.operationId))
    return current;
  const previous = current[teamName];
  if (previous && Date.parse(previous.committedAt) > Date.parse(change.committedAt)) return current;
  return Object.fromEntries(
    Object.entries({ ...current, [teamName]: change })
      .sort(
        ([a, left], [b, right]) =>
          Date.parse(right.committedAt) - Date.parse(left.committedAt) || a.localeCompare(b)
      )
      .slice(0, 20)
  );
}

/** A read started before an event cannot remove its pending canonical row notice. */
export function reconcileTeamManagementNotices(
  current: Notices,
  atReadStart: Notices,
  teams: readonly TeamSummary[]
): Notices {
  const names = new Set(teams.map((team) => team.teamName));
  const stale = Object.keys(current).filter(
    (name) =>
      current[name] === atReadStart[name] && !names.has(name) && current[name].kind !== 'trashed'
  );
  if (!stale.length) return current;
  const next = { ...current };
  for (const name of stale) delete next[name];
  return next;
}

/** Recent changes use only canonical cards that already pass the current view filters. */
export function selectRecentManagedTeams(
  filteredTeams: readonly TeamSummary[],
  canonicalTeams: readonly TeamSummary[],
  notices: Notices
): TeamSummary[] {
  return filteredTeams
    .filter(
      (team) =>
        !team.deletedAt &&
        canonicalTeams.includes(team) &&
        notices[team.teamName]?.kind !== 'trashed' &&
        notices[team.teamName]
    )
    .sort(
      (a, b) =>
        Date.parse(notices[b.teamName].committedAt) - Date.parse(notices[a.teamName].committedAt) ||
        a.teamName.localeCompare(b.teamName)
    );
}
