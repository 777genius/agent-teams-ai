export interface DetailCacheFillScope {
  readonly key: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly kind: 'session' | 'subagent';
}

export interface DetailCacheFillPermit {
  readonly scope: DetailCacheFillScope;
  isSourceCurrent(): boolean;
  canCommit(): boolean;
  release(): void;
}

interface ActiveFill {
  sourceCurrent: boolean;
  readonly scope: DetailCacheFillScope;
}

interface WriterRecord {
  latest: symbol;
  readonly active: Map<symbol, ActiveFill>;
}

/** Tracks only outstanding fills; settling a newer writer never revives an older one. */
export class DetailCacheFillFence {
  private readonly writers = new Map<string, WriterRecord>();
  private revision = 0;
  private disposed = false;

  begin(input: DetailCacheFillScope): DetailCacheFillPermit {
    const scope = Object.freeze({ ...input });
    const token = Symbol('detail-cache-fill');
    const revision = this.revision;
    const record: WriterRecord = this.writers.get(scope.key) ?? {
      latest: token,
      active: new Map<symbol, ActiveFill>(),
    };
    const fill: ActiveFill = { scope, sourceCurrent: !this.disposed };
    let released = false;

    if (!this.disposed) {
      record.latest = token;
      record.active.set(token, fill);
      this.writers.set(scope.key, record);
    }

    return {
      scope,
      isSourceCurrent: () => !released && !this.disposed && fill.sourceCurrent,
      canCommit: () =>
        !released &&
        !this.disposed &&
        fill.sourceCurrent &&
        revision === this.revision &&
        record.latest === token &&
        this.writers.get(scope.key) === record,
      release: () => {
        if (released) return;
        released = true;
        record.active.delete(token);
        if (record.active.size === 0 && this.writers.get(scope.key) === record) {
          this.writers.delete(scope.key);
        }
      },
    };
  }

  /** Enable transitions fence commits without making the read itself a failure. */
  advanceRevision(): void {
    this.revision++;
  }

  supersedeCommit(key: string): void {
    const record = this.writers.get(key);
    if (record) record.latest = Symbol('synchronous-cache-write');
  }

  invalidate(matches: (scope: DetailCacheFillScope) => boolean): void {
    this.advanceRevision();
    for (const record of this.writers.values()) {
      for (const fill of record.active.values()) {
        if (matches(fill.scope)) fill.sourceCurrent = false;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate(() => true);
  }
}
