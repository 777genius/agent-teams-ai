export function nextTeamAliveFromLeadActivity(
  currentIsAlive: boolean | undefined,
  nextActivity: 'active' | 'idle' | 'offline'
): boolean | undefined {
  return nextActivity === 'offline' ? false : currentIsAlive;
}
