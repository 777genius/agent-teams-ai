import type { ReviewPersistedStateSnapshot } from '@shared/types';

const fingerprint = (snapshot: Partial<ReviewPersistedStateSnapshot> | null): string =>
  JSON.stringify([
    snapshot?.hunkDecisions ?? {},
    snapshot?.fileDecisions ?? {},
    snapshot?.hunkContextHashesByFile ?? {},
    snapshot?.reviewActionHistory ?? [],
    snapshot?.reviewRedoHistory ?? [],
  ]);

// Only successful reads/writes establish durability. Failed or unacknowledged
// writes invalidate it, so retries can never silently skip a possibly lost write.
export class ConfirmedReviewDecisions {
  private readonly snapshots = new Map<string, { revision: number; fingerprint: string }>();

  remember(
    scope: string,
    revision: number,
    snapshot: Partial<ReviewPersistedStateSnapshot> | null
  ): void {
    this.snapshots.delete(scope);
    this.snapshots.set(scope, { revision, fingerprint: fingerprint(snapshot) });
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  matches(
    scope: string,
    revision: number,
    snapshot: Partial<ReviewPersistedStateSnapshot> | null
  ): boolean {
    const saved = this.snapshots.get(scope);
    return saved?.revision === revision && saved.fingerprint === fingerprint(snapshot);
  }

  forget(scope: string): void {
    this.snapshots.delete(scope);
  }
}

export function reviewPersistedSnapshotsEqual(
  left: ReviewPersistedStateSnapshot,
  right: ReviewPersistedStateSnapshot
): boolean {
  return fingerprint(left) === fingerprint(right);
}

export function buildPersistDecisionScopeKey(
  teamName: string,
  scopeKey: string,
  scopeToken?: string
): string {
  return scopeToken ? `${teamName}:${scopeKey}:${scopeToken}` : `${teamName}:${scopeKey}`;
}
