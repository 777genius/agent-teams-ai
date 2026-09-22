const memberSpawnStatusesIpcBackoffUntilByTeam = new Map<string, number>();

export function getMemberSpawnStatusesIpcBackoffUntil(teamName: string): number {
  return memberSpawnStatusesIpcBackoffUntilByTeam.get(teamName) ?? 0;
}

export function hasMemberSpawnStatusesIpcBackoff(teamName: string): boolean {
  return memberSpawnStatusesIpcBackoffUntilByTeam.has(teamName);
}

export function isMemberSpawnStatusesIpcBackoffActive(
  teamName: string,
  now = Date.now()
): boolean {
  return getMemberSpawnStatusesIpcBackoffUntil(teamName) > now;
}

export function recordMemberSpawnStatusesIpcBackoffUntil(
  teamName: string,
  backoffUntil: number
): void {
  memberSpawnStatusesIpcBackoffUntilByTeam.set(teamName, backoffUntil);
}

export function recordMemberSpawnStatusesIpcRetryBackoff(
  teamName: string,
  retryBackoffMs: number,
  now = Date.now()
): void {
  recordMemberSpawnStatusesIpcBackoffUntil(teamName, now + retryBackoffMs);
}

export function clearMemberSpawnStatusesIpcBackoff(teamName: string): void {
  memberSpawnStatusesIpcBackoffUntilByTeam.delete(teamName);
}

export function clearAllMemberSpawnStatusesIpcBackoffs(): void {
  memberSpawnStatusesIpcBackoffUntilByTeam.clear();
}
