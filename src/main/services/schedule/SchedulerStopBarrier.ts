/**
 * Owns scheduler persistence finalization and cancellable retry sleeps.
 * stop() may finish only after already-started finalizers settle.
 */
const STOP_DRAIN_TIMEOUT_MS = 15_000;

export class SchedulerStopBarrier {
  private readonly admissions = new Map<string, Set<{ current: boolean }>>();
  private readonly finalizations = new Set<Promise<void>>();
  private readonly retryDelays = new Set<{
    timer: ReturnType<typeof setTimeout>;
    finish: () => void;
  }>();

  async withAdmission<T>(scheduleId: string, action: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    const marker = { current: true };
    let pending = this.admissions.get(scheduleId);
    if (!pending) this.admissions.set(scheduleId, pending = new Set());
    pending.add(marker);
    try {
      return await action(() => marker.current);
    } finally {
      pending.delete(marker);
      if (pending.size === 0) this.admissions.delete(scheduleId);
    }
  }

  cancelAdmissions(scheduleId: string): void {
    for (const marker of this.admissions.get(scheduleId) ?? []) marker.current = false;
  }

  beginFinalization(): () => void {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    this.finalizations.add(pending);
    return () => {
      this.finalizations.delete(pending);
      resolve();
    };
  }

  waitForRetry(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = {
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        finish: () => resolve(),
      };
      entry.timer = setTimeout(() => {
        this.retryDelays.delete(entry);
        resolve();
      }, delayMs);
      entry.timer.unref();
      this.retryDelays.add(entry);
    });
  }

  cancelRetries(): void {
    for (const { timer, finish } of this.retryDelays) {
      clearTimeout(timer);
      finish();
    }
    this.retryDelays.clear();
  }

  async drainFinalizations(): Promise<void> {
    if (this.finalizations.size === 0) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.finalizations]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Scheduler stop timed out waiting for durable run finalization')),
            STOP_DRAIN_TIMEOUT_MS
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
