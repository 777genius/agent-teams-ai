import { normalizePhysicalFault } from './physicalFault';

export type PhysicalOutcome = { kind: 'closed' } | { kind: 'unknown'; fault: string };

export interface RawReadTask<T> {
  result: Promise<T>;
  physical: Promise<PhysicalOutcome>;
}

export interface ReadContinuation {
  start<T>(factory: (continuation: ReadContinuation) => RawReadTask<T>): Promise<T>;
}

/** Logical results never seal the physical producer. */
export class PhysicalReadScope implements ReadContinuation {
  readonly drained: Promise<PhysicalOutcome>;
  private finishDrain!: (outcome: PhysicalOutcome) => void;
  private pending = 0;
  private topFinished = false;
  private sealed = false;
  private fault: string | undefined;
  private unknown = false;

  constructor() {
    this.drained = new Promise((resolve) => {
      this.finishDrain = resolve;
    });
  }

  start<T>(factory: (continuation: ReadContinuation) => RawReadTask<T>): Promise<T> {
    if (this.topFinished) throw new Error('Read scope top is finished');
    return this.register(factory);
  }

  finishTop(): void {
    this.topFinished = true;
    this.trySeal();
  }

  private register<T>(factory: (continuation: ReadContinuation) => RawReadTask<T>): Promise<T> {
    if (this.sealed) throw new Error('Physical read scope is sealed');
    this.pending++;
    let active = true;
    const continuation: ReadContinuation = {
      start: (child) => {
        if (!active) throw new Error('Physical parent has settled');
        return this.register(child);
      },
    };
    let task: RawReadTask<T>;
    try {
      task = factory(continuation);
    } catch (error) {
      // A throwing factory may already have dispatched effects without returning their port.
      this.unknown = true;
      this.fault ??= normalizePhysicalFault(error);
      active = false;
      this.pending--;
      this.trySeal();
      const rejected = Promise.reject<T>(error);
      void rejected.catch(() => undefined);
      return rejected;
    }
    // Observe both ports immediately, including callers that abandon their result.
    void task.result.catch(() => undefined);
    const finishPhysical = (observe: () => void): void => {
      // Revoke in the first physical reaction, before any later continuation can dispatch.
      active = false;
      try {
        observe();
      } catch (error) {
        this.unknown = true;
        this.fault ??= normalizePhysicalFault(error);
      } finally {
        this.pending--;
        this.trySeal();
      }
    };
    void task.physical
      .then(
        (outcome) =>
          finishPhysical(() => {
            if (outcome.kind === 'unknown') {
              this.unknown = true;
              this.fault ??= normalizePhysicalFault(outcome.fault);
            }
          }),
        (error: unknown) =>
          finishPhysical(() => {
            this.unknown = true;
            this.fault ??= normalizePhysicalFault(error);
          })
      )
      .catch((error: unknown) => {
        // Observe the complete chain, including physical outcome access and finalization.
        this.unknown = true;
        this.fault ??= normalizePhysicalFault(error);
        this.trySeal();
      });
    return task.result;
  }

  private trySeal(): void {
    if (this.sealed || !this.topFinished || this.pending !== 0) return;
    this.sealed = true;
    this.finishDrain(
      !this.unknown
        ? { kind: 'closed' }
        : { kind: 'unknown', fault: this.fault || 'Physical completion is unconfirmed' }
    );
  }
}
