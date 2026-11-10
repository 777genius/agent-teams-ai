const lastResolvedTeamDataRefreshAtByTeam = new Map<string, number>();

export function getLastResolvedTeamDataRefreshAt(teamName: string): number | undefined {
  return lastResolvedTeamDataRefreshAtByTeam.get(teamName);
}

export function recordLastResolvedTeamDataRefresh(teamName: string, resolvedAt = Date.now()): void {
  lastResolvedTeamDataRefreshAtByTeam.set(teamName, resolvedAt);
}

export function hasLastResolvedTeamDataRefreshAt(teamName: string): boolean {
  return lastResolvedTeamDataRefreshAtByTeam.has(teamName);
}

export function clearLastResolvedTeamDataRefreshAt(teamName: string): void {
  lastResolvedTeamDataRefreshAtByTeam.delete(teamName);
}

export function clearAllLastResolvedTeamDataRefreshes(): void {
  lastResolvedTeamDataRefreshAtByTeam.clear();
}
