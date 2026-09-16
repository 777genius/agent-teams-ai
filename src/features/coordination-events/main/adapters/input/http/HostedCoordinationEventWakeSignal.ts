type WakeResult = 'wakeup' | 'heartbeat' | 'closed';

export interface HostedCoordinationEventStreamScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export class WakeSignal {
  private versionValue = 0;
  private readonly listeners = new Set<() => void>();

  get version(): number {
    return this.versionValue;
  }
  notify = (): void => {
    this.versionValue += 1;
    for (const listener of [...this.listeners]) listener();
  };

  wait(input: {
    readonly afterVersion: number;
    readonly delayMs: number;
    readonly signal: AbortSignal;
    readonly scheduler: HostedCoordinationEventStreamScheduler;
  }): Promise<WakeResult> {
    if (input.signal.aborted) return Promise.resolve('closed');
    if (this.versionValue !== input.afterVersion) return Promise.resolve('wakeup');
    return new Promise<WakeResult>((resolve) => {
      let settled = false;
      let cancelSchedule = (): void => undefined;
      const finish = (result: WakeResult): void => {
        if (settled) return;
        settled = true;
        cancelSchedule();
        this.listeners.delete(onWakeup);
        input.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onWakeup = (): void => finish('wakeup');
      const onAbort = (): void => finish('closed');
      cancelSchedule = input.scheduler.schedule(input.delayMs, () => finish('heartbeat'));
      this.listeners.add(onWakeup);
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (this.versionValue !== input.afterVersion) finish('wakeup');
    });
  }
}
