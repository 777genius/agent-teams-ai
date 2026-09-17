export function nextTeamAliveFromLeadActivity(
  currentIsAlive: boolean | undefined,
  nextActivity: 'active' | 'idle' | 'offline'
): boolean | undefined {
  if (nextActivity === 'offline') {
    return false;
  }
  // Lead 'active' heals a stale isAlive:false for a genuinely running team.
  // Idle must not resurrect leftover lead heartbeats after Stop.
  if (nextActivity === 'active') {
    return true;
  }
  return currentIsAlive;
}
