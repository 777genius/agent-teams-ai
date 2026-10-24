interface OwnedReads {
  retireOwner(owner: object): void;
}

/** Tracks only unsettled subscriptions belonging to this IPC adapter instance. */
export class DetailReadAdapterLifetime {
  private readonly reads = new Map<OwnedReads, number>();
  private active = true;

  isCurrent(): boolean {
    return this.active;
  }

  track(reads: OwnedReads): () => void {
    if (!this.active) throw new Error('Detail read adapter is retired');
    this.reads.set(reads, (this.reads.get(reads) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.reads.get(reads);
      if (count === undefined) return;
      if (count === 1) this.reads.delete(reads);
      else this.reads.set(reads, count - 1);
    };
  }

  retire(): void {
    if (!this.active) return;
    this.active = false;
    for (const reads of this.reads.keys()) reads.retireOwner(this);
    this.reads.clear();
  }
}
