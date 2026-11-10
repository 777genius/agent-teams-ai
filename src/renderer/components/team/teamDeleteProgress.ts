import { useSyncExternalStore } from 'react';

const deletingTeamListeners = new Set<() => void>();
let deletingTeamsSnapshot: ReadonlySet<string> = new Set();

function publishDeletingTeams(next: ReadonlySet<string>): void {
  deletingTeamsSnapshot = next;
  deletingTeamListeners.forEach((listener) => listener());
}

function subscribeToDeletingTeams(listener: () => void): () => void {
  deletingTeamListeners.add(listener);
  return () => deletingTeamListeners.delete(listener);
}

/**
 * Move a team to the trash, at most once at a time per team.
 *
 * Trashing stops the team runtime first and can then wait behind the team lock
 * for minutes, for example while a stopped OpenCode lane does not confirm its
 * stop. While that runs the team is marked as deleting, so the team list and
 * the team header show it as busy, and another request for the same team
 * returns false without calling `deleteTeam`. Errors reach the caller
 * unchanged; the mark is removed either way.
 */
export async function runTeamDeleteOnce(
  teamName: string,
  deleteTeam: () => Promise<void>
): Promise<boolean> {
  if (deletingTeamsSnapshot.has(teamName)) return false;
  publishDeletingTeams(new Set(deletingTeamsSnapshot).add(teamName));
  try {
    await deleteTeam();
    return true;
  } finally {
    const next = new Set(deletingTeamsSnapshot);
    next.delete(teamName);
    publishDeletingTeams(next);
  }
}

export function useTeamDeleteInProgress(teamName: string): boolean {
  const isDeleting = (): boolean => deletingTeamsSnapshot.has(teamName);
  return useSyncExternalStore(subscribeToDeletingTeams, isDeleting, isDeleting);
}
