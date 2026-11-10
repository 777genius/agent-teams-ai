const activeTeamPendingReplyWaitSourceIdsByTeam = new Map<string, Set<string>>();

export function hasActiveTeamPendingReplyWait(teamName: string): boolean {
  return (activeTeamPendingReplyWaitSourceIdsByTeam.get(teamName)?.size ?? 0) > 0;
}

export function getActiveTeamPendingReplyWaits(): Set<string> {
  return new Set(
    Array.from(activeTeamPendingReplyWaitSourceIdsByTeam.entries())
      .filter(([, sourceIds]) => sourceIds.size > 0)
      .map(([teamName]) => teamName)
  );
}

export function clearAllPendingReplyRefreshWaits(): void {
  activeTeamPendingReplyWaitSourceIdsByTeam.clear();
}

export function clearPendingReplyRefreshWaits(teamName: string): void {
  activeTeamPendingReplyWaitSourceIdsByTeam.delete(teamName);
}

export function setPendingReplyRefreshEnabled(
  teamName: string,
  sourceId: string,
  enabled: boolean
): boolean {
  if (enabled) {
    const existing = activeTeamPendingReplyWaitSourceIdsByTeam.get(teamName) ?? new Set<string>();
    existing.add(sourceId);
    activeTeamPendingReplyWaitSourceIdsByTeam.set(teamName, existing);
    return true;
  }

  const existing = activeTeamPendingReplyWaitSourceIdsByTeam.get(teamName);
  if (!existing) {
    return false;
  }
  existing.delete(sourceId);
  if (existing.size === 0) {
    activeTeamPendingReplyWaitSourceIdsByTeam.delete(teamName);
    return false;
  }
  return true;
}
