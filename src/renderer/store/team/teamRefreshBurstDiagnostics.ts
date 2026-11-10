interface TeamRefreshBurstDiagnostic {
  windowStartedAt: number;
  count: number;
  lastWarnAt: number;
}

const teamRefreshBurstDiagnostics = new Map<string, TeamRefreshBurstDiagnostic>();

export function hasTeamRefreshBurstDiagnostics(teamName: string): boolean {
  return teamRefreshBurstDiagnostics.has(teamName);
}

export function getTeamRefreshBurstDiagnosticForTests(
  teamName: string
): TeamRefreshBurstDiagnostic | undefined {
  const diagnostic = teamRefreshBurstDiagnostics.get(teamName);
  return diagnostic ? { ...diagnostic } : undefined;
}

export function noteTeamRefreshBurst(
  teamName: string,
  windowMs: number,
  now = Date.now()
): number {
  const diagnostic = teamRefreshBurstDiagnostics.get(teamName) ?? {
    windowStartedAt: now,
    count: 0,
    lastWarnAt: 0,
  };

  if (now - diagnostic.windowStartedAt > windowMs) {
    diagnostic.windowStartedAt = now;
    diagnostic.count = 0;
  }

  diagnostic.count += 1;

  teamRefreshBurstDiagnostics.set(teamName, diagnostic);
  return diagnostic.count;
}

export function clearTeamRefreshBurstDiagnostics(teamName: string): void {
  teamRefreshBurstDiagnostics.delete(teamName);
}

export function clearAllTeamRefreshBurstDiagnostics(): void {
  teamRefreshBurstDiagnostics.clear();
}
