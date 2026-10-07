export interface TeamReadScope {
  readonly contextId: string;
  readonly contextEpoch: number;
  readonly teamStateEpoch: number;
}

export type ReadOutcome<T> =
  | { kind: 'success'; value: T }
  | { kind: 'failure'; error: unknown }
  | { kind: 'superseded' | 'disposed' };

interface ActiveRead<T> {
  readonly scope: TeamReadScope;
  readonly result: Promise<T>;
}
interface PendingRead<T> extends ActiveRead<T> {
  readonly predecessor: Promise<T>;
  settle(outcome: ReadOutcome<T>): void;
}

function sameScope(left: TeamReadScope, right: TeamReadScope): boolean {
  return (
    left.contextId === right.contextId &&
    left.contextEpoch === right.contextEpoch &&
    left.teamStateEpoch === right.teamStateEpoch
  );
}

/** Holds live work only. A fresh caller observes one successor, never the predecessor. */
export class ScopedReadRequests<T> {
  private readonly active = new Map<string, ActiveRead<T>>();
  private readonly pending = new Map<string, PendingRead<T>>();

  constructor(private readonly retiredValue: () => T) {}

  get(team: string, scope: TeamReadScope): Promise<T> | undefined {
    const pending = this.pending.get(team);
    if (pending && !sameScope(pending.scope, scope)) {
      this.pending.delete(team);
      pending.settle({ kind: 'superseded' });
    }
    const active = this.active.get(team);
    if (active && !sameScope(active.scope, scope)) {
      this.retire(team, 'superseded');
      return undefined;
    }
    return active?.result;
  }

  set(team: string, result: Promise<T>, scope: TeamReadScope): void {
    this.active.set(team, { result, scope });
  }

  release(team: string, result: Promise<T> | null): void {
    if (result && this.active.get(team)?.result === result) this.active.delete(team);
  }

  hasPending(team: string): boolean {
    return this.pending.has(team);
  }

  queueFresh(
    team: string,
    scope: TeamReadScope,
    read: () => Promise<T>,
    isCurrent: () => boolean
  ): Promise<T> {
    const predecessor = this.get(team, scope);
    if (!predecessor) return read();
    const existing = this.pending.get(team);
    if (existing && sameScope(existing.scope, scope)) {
      if (existing.predecessor === predecessor) return existing.result;
      // A replacement already satisfies the earlier demand, but cannot satisfy a new one.
      this.pending.delete(team);
      this.observe(existing, predecessor);
    }
    let settle!: (outcome: ReadOutcome<T>) => void;
    const outcome = new Promise<ReadOutcome<T>>((resolve) => {
      settle = resolve;
    });
    const result = outcome.then((value) => {
      if (value.kind === 'success') return value.value;
      if (value.kind === 'failure') throw value.error;
      return this.retiredValue();
    });
    const pending: PendingRead<T> = { scope, result, settle, predecessor };
    this.pending.set(team, pending);
    const start = (): void => {
      if (this.pending.get(team) !== pending) return;
      this.pending.delete(team);
      if (!isCurrent()) {
        settle({ kind: 'superseded' });
        return;
      }
      let successor: Promise<T>;
      try {
        successor = this.get(team, scope) ?? read();
      } catch (error) {
        settle({ kind: 'failure', error });
        return;
      }
      this.observe(pending, successor);
    };
    // Both predecessor outcomes release the barrier. Its failure is not the fresh result.
    void predecessor.then(start, start);
    return result;
  }

  delete(team: string): void {
    this.retire(team, 'disposed');
  }

  clear(): void {
    for (const team of new Set([...this.active.keys(), ...this.pending.keys()])) this.delete(team);
  }

  private observe(pending: PendingRead<T>, successor: Promise<T>): void {
    void successor.then(
      (value) => pending.settle({ kind: 'success', value }),
      (error: unknown) => pending.settle({ kind: 'failure', error })
    );
  }

  private retire(team: string, kind: 'superseded' | 'disposed'): void {
    this.active.delete(team);
    const pending = this.pending.get(team);
    this.pending.delete(team);
    pending?.settle({ kind });
  }
}
