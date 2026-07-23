function normalizeTeamKey(teamName: string): string {
  const key = teamName.trim().toLowerCase();
  if (!key) {
    throw new Error('Member work sync team name must not be empty');
  }
  return key;
}

export class MemberWorkSyncTeamQuiescedError extends Error {
  constructor(readonly teamName: string) {
    super(`Member work sync team "${teamName}" is quiesced`);
    this.name = 'MemberWorkSyncTeamQuiescedError';
  }
}

/**
 * Closes admission and drains already-admitted member-work-sync operations for
 * one team without delaying unrelated teams.
 */
export class MemberWorkSyncTeamOperationGate {
  private readonly quiescedTeams = new Set<string>();
  private readonly inFlightByTeam = new Map<string, Set<Promise<unknown>>>();

  async run<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const teamKey = normalizeTeamKey(teamName);
    if (this.quiescedTeams.has(teamKey)) {
      throw new MemberWorkSyncTeamQuiescedError(teamName.trim());
    }

    // Defer invocation by one microtask so the operation is tracked before any
    // of its async work can start or synchronously request a lifecycle change.
    const operationPromise = Promise.resolve().then(operation);
    const inFlight = this.inFlightByTeam.get(teamKey) ?? new Set<Promise<unknown>>();
    inFlight.add(operationPromise);
    this.inFlightByTeam.set(teamKey, inFlight);

    try {
      return await operationPromise;
    } finally {
      inFlight.delete(operationPromise);
      if (inFlight.size === 0 && this.inFlightByTeam.get(teamKey) === inFlight) {
        this.inFlightByTeam.delete(teamKey);
      }
    }
  }

  beginTeamQuiesce(teamName: string): void {
    this.quiescedTeams.add(normalizeTeamKey(teamName));
  }

  async awaitTeamIdle(teamName: string): Promise<void> {
    const teamKey = normalizeTeamKey(teamName);
    while (true) {
      const inFlight = this.inFlightByTeam.get(teamKey);
      if (!inFlight || inFlight.size === 0) {
        return;
      }
      await Promise.allSettled([...inFlight]);
    }
  }

  resumeTeam(teamName: string): void {
    this.quiescedTeams.delete(normalizeTeamKey(teamName));
  }
}
