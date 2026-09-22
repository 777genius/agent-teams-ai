const MAX_TRACKED_TEAMS = 64;

/**
 * Per-team launch floor for derived member runtime advisories.
 *
 * Advisories are re-derived on every snapshot from lane delivery ledgers and
 * member log tails, both of which outlive a force-stop. A new run therefore has
 * to raise a floor: evidence observed before this launch belongs to a dead run
 * and must never reach a fresh member card.
 */
export class MemberRuntimeAdvisoryRunScope {
  private readonly floorMsByTeamKey = new Map<string, number>();

  startRun(teamKey: string, startedAtMs: number): void {
    if (!teamKey || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
      return;
    }
    // Re-insert so the eviction order below stays least-recently-launched first.
    this.floorMsByTeamKey.delete(teamKey);
    this.floorMsByTeamKey.set(teamKey, Math.floor(startedAtMs));
    while (this.floorMsByTeamKey.size > MAX_TRACKED_TEAMS) {
      const oldestKey = this.floorMsByTeamKey.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.floorMsByTeamKey.delete(oldestKey);
    }
  }

  /** Normalizes a caller-supplied floor, then raises it to this run's start. */
  resolveObservedAfterMs(teamKey: string, value: number | null | undefined): number | null {
    const normalized =
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    return this.applyFloor(teamKey, normalized);
  }

  /** Raises a caller-supplied floor to the current run's start; never lowers it. */
  applyFloor(teamKey: string, observedAfterMs: number | null): number | null {
    const floorMs = this.floorMsByTeamKey.get(teamKey);
    if (floorMs === undefined) {
      return observedAfterMs;
    }
    return observedAfterMs == null ? floorMs : Math.max(observedAfterMs, floorMs);
  }

  /** Cache-key fragment: a changed floor must never reuse a previous run's batch. */
  buildScopeKey(observedAfterMs: number | null | undefined): string {
    return observedAfterMs == null ? 'recent' : `after:${observedAfterMs}`;
  }
}
