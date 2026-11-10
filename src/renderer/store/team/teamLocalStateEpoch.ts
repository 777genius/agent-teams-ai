const teamLocalStateEpochByTeam = new Map<string, number>();

export function captureTeamLocalStateEpoch(teamName: string): number {
  return teamLocalStateEpochByTeam.get(teamName) ?? 0;
}

export function isTeamLocalStateEpochCurrent(teamName: string, epoch: number): boolean {
  return captureTeamLocalStateEpoch(teamName) === epoch;
}

export function invalidateTeamLocalStateEpoch(teamName: string): void {
  teamLocalStateEpochByTeam.set(teamName, captureTeamLocalStateEpoch(teamName) + 1);
}

export function hasTeamLocalStateEpoch(teamName: string): boolean {
  return teamLocalStateEpochByTeam.has(teamName);
}

export function clearTeamLocalStateEpoch(teamName: string): void {
  teamLocalStateEpochByTeam.delete(teamName);
}

export function clearAllTeamLocalStateEpochs(): void {
  teamLocalStateEpochByTeam.clear();
}
