const memberSpawnUiEqualLastWarnAtByTeam = new Map<string, number>();

export function getMemberSpawnUiEqualLastWarnAt(teamName: string): number | undefined {
  return memberSpawnUiEqualLastWarnAtByTeam.get(teamName);
}

export function hasMemberSpawnUiEqualLastWarn(teamName: string): boolean {
  return memberSpawnUiEqualLastWarnAtByTeam.has(teamName);
}

export function shouldLogMemberSpawnUiEqualSuppressed(
  teamName: string,
  throttleMs: number,
  now = Date.now()
): boolean {
  const lastWarnAt = memberSpawnUiEqualLastWarnAtByTeam.get(teamName) ?? 0;
  if (now - lastWarnAt < throttleMs) {
    return false;
  }
  memberSpawnUiEqualLastWarnAtByTeam.set(teamName, now);
  return true;
}

export function clearMemberSpawnUiEqualLastWarn(teamName: string): void {
  memberSpawnUiEqualLastWarnAtByTeam.delete(teamName);
}

export function clearAllMemberSpawnUiEqualLastWarns(): void {
  memberSpawnUiEqualLastWarnAtByTeam.clear();
}
