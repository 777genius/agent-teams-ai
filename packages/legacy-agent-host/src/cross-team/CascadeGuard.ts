const MAX_PER_MINUTE = 10;
const PAIR_COOLDOWN_MS = 3_000;
const MAX_CHAIN_DEPTH = 5;
const WINDOW_MS = 60_000;

export class CascadeGuard {
  private teamCounters = new Map<string, number[]>();
  private pairTimestamps = new Map<string, number>();

  check(fromTeam: string, toTeam: string, chainDepth: number): void {
    if (chainDepth >= MAX_CHAIN_DEPTH) {
      throw new Error(`Cross-team chain depth limit exceeded (max ${MAX_CHAIN_DEPTH})`);
    }

    const now = Date.now();
    this.cleanup(now);

    const counts = this.teamCounters.get(fromTeam) ?? [];
    const recentCount = counts.filter((ts) => ts > now - WINDOW_MS).length;
    if (recentCount >= MAX_PER_MINUTE) {
      throw new Error(`Cross-team rate limit exceeded for ${fromTeam} (max ${MAX_PER_MINUTE}/min)`);
    }

    const pairKey = `${fromTeam}→${toTeam}`;
    const lastPairTs = this.pairTimestamps.get(pairKey);
    if (lastPairTs !== undefined && now - lastPairTs < PAIR_COOLDOWN_MS) {
      throw new Error(`Cross-team pair cooldown active: ${fromTeam} → ${toTeam}`);
    }
  }

  record(fromTeam: string, toTeam: string): void {
    const now = Date.now();
    const counts = this.teamCounters.get(fromTeam) ?? [];
    counts.push(now);
    this.teamCounters.set(fromTeam, counts);
    this.pairTimestamps.set(`${fromTeam}→${toTeam}`, now);
  }

  reset(): void {
    this.teamCounters.clear();
    this.pairTimestamps.clear();
  }

  private cleanup(now: number): void {
    for (const [team, timestamps] of this.teamCounters) {
      const fresh = timestamps.filter((ts) => ts > now - WINDOW_MS);
      if (fresh.length === 0) {
        this.teamCounters.delete(team);
      } else {
        this.teamCounters.set(team, fresh);
      }
    }
    for (const [key, ts] of this.pairTimestamps) {
      if (now - ts > WINDOW_MS) {
        this.pairTimestamps.delete(key);
      }
    }
  }
}
