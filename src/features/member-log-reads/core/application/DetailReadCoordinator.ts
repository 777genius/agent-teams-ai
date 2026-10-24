export type DetailReadOutcome<T> =
  | { readonly status: 'success'; readonly value: T | null }
  | { readonly status: 'failure'; readonly error: unknown }
  | { readonly status: 'superseded' | 'disposed' };

export interface DetailReadSubscription<T> {
  readonly result: Promise<DetailReadOutcome<T>>;
  dispose(): void;
}

export interface DetailReadWork<T> {
  isCurrent(): boolean;
  execute(): Promise<T | null>;
  release(): void;
}

export interface DetailReadRequest<T> {
  readonly key: string;
  readonly source: object;
  readonly owner: object;
  readonly fresh: boolean;
  prepare(): DetailReadWork<T>;
}

interface Subscriber<T> {
  readonly owner: object;
  settle(outcome: DetailReadOutcome<T>): void;
}

interface Work<T> {
  readonly source: object;
  readonly operation: DetailReadWork<T>;
  readonly subscribers: Set<Subscriber<T>>;
  released: boolean;
}

interface Container<T> {
  active: Work<T>;
  pending?: Work<T>;
}

/** One physical read and one successor per source address, without retained results. */
export class DetailReadCoordinator<T> {
  private readonly containers = new Map<string, Container<T>>();
  private disposed = false;

  subscribe(request: DetailReadRequest<T>): DetailReadSubscription<T> {
    if (this.disposed) {
      return { result: Promise.resolve({ status: 'disposed' }), dispose() {} };
    }

    let container = this.containers.get(request.key);
    let work: Work<T>;
    let start = false;
    if (!container) {
      work = this.prepare(request);
      container = { active: work };
      this.containers.set(request.key, container);
      start = true;
    } else if (!request.fresh && this.matches(container.active, request.source)) {
      work = container.active;
    } else if (container.pending && this.matches(container.pending, request.source)) {
      work = container.pending;
    } else {
      work = this.prepare(request);
      if (container.pending) this.retire(container.pending, 'superseded');
      container.pending = work;
    }

    let settle!: Subscriber<T>['settle'];
    const result = new Promise<DetailReadOutcome<T>>((resolve) => {
      settle = resolve;
    });
    const subscriber: Subscriber<T> = { owner: request.owner, settle };
    work.subscribers.add(subscriber);
    if (start) this.start(request.key, container, work);
    return {
      result,
      dispose: () => this.removeSubscriber(container, work, subscriber, 'disposed'),
    };
  }

  /** Retire one transport without cancelling subscribers owned by another transport. */
  retireOwner(owner: object): void {
    for (const container of this.containers.values()) {
      for (const work of [container.active, container.pending]) {
        if (!work) continue;
        for (const subscriber of work.subscribers) {
          if (subscriber.owner === owner) {
            this.removeSubscriber(container, work, subscriber, 'superseded');
          }
        }
      }
    }
  }

  /** Keep an abandoned physical read until settlement, even across activation changes. */
  supersede(): void {
    for (const container of this.containers.values()) {
      this.retire(container.active, 'superseded');
      if (container.pending) this.retire(container.pending, 'superseded');
      container.pending = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const container of this.containers.values()) {
      this.retire(container.active, 'disposed');
      if (container.pending) this.retire(container.pending, 'disposed');
      container.pending = undefined;
    }
  }

  private prepare(request: DetailReadRequest<T>): Work<T> {
    return {
      source: request.source,
      operation: request.prepare(),
      subscribers: new Set(),
      released: false,
    };
  }

  private matches(work: Work<T>, source: object): boolean {
    return !work.released && work.source === source && work.operation.isCurrent();
  }

  private start(key: string, container: Container<T>, work: Work<T>): void {
    void Promise.resolve()
      .then(() => (work.released ? null : work.operation.execute()))
      .then(
        (value) => this.finish(key, container, work, { status: 'success', value }),
        (error: unknown) => this.finish(key, container, work, { status: 'failure', error })
      );
  }

  private finish(
    key: string,
    container: Container<T>,
    work: Work<T>,
    outcome: DetailReadOutcome<T>
  ): void {
    const current = !work.released && work.operation.isCurrent();
    for (const subscriber of work.subscribers) {
      subscriber.settle(current ? outcome : { status: this.disposed ? 'disposed' : 'superseded' });
    }
    work.subscribers.clear();
    this.release(work);
    const pending = container.pending;
    container.pending = undefined;
    if (pending && !pending.released && pending.operation.isCurrent() && !this.disposed) {
      container.active = pending;
      this.start(key, container, pending);
    } else {
      if (pending) this.retire(pending, this.disposed ? 'disposed' : 'superseded');
      if (this.containers.get(key) === container) this.containers.delete(key);
    }
  }

  private removeSubscriber(
    container: Container<T>,
    work: Work<T>,
    subscriber: Subscriber<T>,
    status: 'disposed' | 'superseded'
  ): void {
    if (!work.subscribers.delete(subscriber)) return;
    subscriber.settle({ status });
    if (work.subscribers.size === 0) {
      this.release(work);
      if (container.pending === work) container.pending = undefined;
    }
  }

  private retire(work: Work<T>, status: 'disposed' | 'superseded'): void {
    for (const subscriber of work.subscribers) subscriber.settle({ status });
    work.subscribers.clear();
    this.release(work);
  }

  private release(work: Work<T>): void {
    if (work.released) return;
    work.released = true;
    work.operation.release();
  }
}
