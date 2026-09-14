export function normalizeMemberWorkSyncTeamOperationKey(teamName: string): string {
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

export interface MemberWorkSyncTeamOperationAdmission {
  /**
   * Keeps work which may outlive the operation's result inside the same team
   * drain. This is intended for timeout/cancellation wrappers which return to
   * their caller before the underlying side effect has settled.
   */
  trackSettling<T>(work: Promise<T>): Promise<T>;
}

/**
 * Closes admission and drains already-admitted member-work-sync operations for
 * one team without delaying unrelated teams.
 */
export class MemberWorkSyncTeamOperationGate {
  private closed = false;
  private readonly quiescedTeams = new Set<string>();
  private readonly ownedQuiesces = new Map<string, Set<symbol>>();
  private readonly inFlightByTeam = new Map<string, Set<Promise<unknown>>>();

  async run<T>(
    teamName: string,
    operation: (admission: MemberWorkSyncTeamOperationAdmission) => Promise<T>
  ): Promise<T> {
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    if (this.closed || this.quiescedTeams.has(teamKey) || this.ownedQuiesces.has(teamKey)) {
      throw new MemberWorkSyncTeamQuiescedError(teamName.trim());
    }

    // Defer invocation by one microtask so the operation is tracked before any
    // of its async work can start or synchronously request a lifecycle change.
    const operationPromise = Promise.resolve().then(() =>
      operation({
        trackSettling: <U>(work: Promise<U>) => {
          this.track(teamKey, work);
          return work;
        },
      })
    );
    this.track(teamKey, operationPromise);

    return operationPromise;
  }

  private track(teamKey: string, operationPromise: Promise<unknown>): void {
    const inFlight = this.inFlightByTeam.get(teamKey) ?? new Set<Promise<unknown>>();
    inFlight.add(operationPromise);
    this.inFlightByTeam.set(teamKey, inFlight);

    void operationPromise.then(
      () => this.release(teamKey, inFlight, operationPromise),
      () => this.release(teamKey, inFlight, operationPromise)
    );
  }

  private release(
    teamKey: string,
    inFlight: Set<Promise<unknown>>,
    operationPromise: Promise<unknown>
  ): void {
    inFlight.delete(operationPromise);
    if (inFlight.size === 0 && this.inFlightByTeam.get(teamKey) === inFlight) {
      this.inFlightByTeam.delete(teamKey);
    }
  }

  beginTeamQuiesce(teamName: string): void {
    this.quiescedTeams.add(normalizeMemberWorkSyncTeamOperationKey(teamName));
  }

  /**
   * Restore owns one closure independently of deletion and other restores. Release only
   * after durable recovery completes; a timeout/failed drain does not grant permission.
   * The caller must awaitTeamIdle outside lifecycle/backend locks before writing.
   */
  beginOwnedTeamQuiesce(teamName: string): { release(): void } {
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const owner = Symbol('member-work-sync-quiesce');
    const owners = this.ownedQuiesces.get(teamKey) ?? new Set<symbol>();
    owners.add(owner);
    this.ownedQuiesces.set(teamKey, owners);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        owners.delete(owner);
        if (owners.size === 0 && this.ownedQuiesces.get(teamKey) === owners)
          this.ownedQuiesces.delete(teamKey);
      },
    };
  }

  async awaitTeamIdle(teamName: string): Promise<void> {
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    while (true) {
      const inFlight = this.inFlightByTeam.get(teamKey);
      if (!inFlight || inFlight.size === 0) {
        return;
      }
      await Promise.allSettled([...inFlight]);
    }
  }

  resumeTeam(teamName: string): void {
    this.quiescedTeams.delete(normalizeMemberWorkSyncTeamOperationKey(teamName));
  }

  close(): void {
    this.closed = true;
  }

  async awaitIdle(): Promise<void> {
    while (true) {
      const inFlight = [...this.inFlightByTeam.values()].flatMap((set) => [...set]);
      if (inFlight.length === 0) {
        return;
      }
      await Promise.allSettled(inFlight);
    }
  }
}
