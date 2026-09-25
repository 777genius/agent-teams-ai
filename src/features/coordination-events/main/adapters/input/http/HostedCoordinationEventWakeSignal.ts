import type { HostedCoordinationEventStreamScheduler } from '../../../application/HostedCoordinationEventStreamPort';

type WakeResult = 'wakeup' | 'heartbeat' | 'closed';

export class WakeSignal {
  private versionValue = 0;
  private heartbeatDue = false;
  private cancelHeartbeat = (): void => undefined;
  private readonly listeners = new Set<() => void>();

  get version(): number {
    return this.versionValue;
  }
  notify = (): void => {
    this.versionValue += 1;
    for (const listener of [...this.listeners]) listener();
  };

  /** Restarts the heartbeat deadline. Wake-ups deliberately leave it running:
   * process-wide commits for other scopes must not starve a quiet stream. */
  armHeartbeat(input: {
    readonly delayMs: number;
    readonly scheduler: HostedCoordinationEventStreamScheduler;
  }): void {
    this.disarmHeartbeat();
    this.cancelHeartbeat = input.scheduler.schedule(input.delayMs, () => {
      this.heartbeatDue = true;
      for (const listener of [...this.listeners]) listener();
    });
  }

  disarmHeartbeat(): void {
    const cancel = this.cancelHeartbeat;
    this.cancelHeartbeat = () => undefined;
    this.heartbeatDue = false;
    cancel();
  }

  wait(input: {
    readonly afterVersion: number;
    readonly signal: AbortSignal;
  }): Promise<WakeResult> {
    if (input.signal.aborted) return Promise.resolve('closed');
    if (this.heartbeatDue) return Promise.resolve('heartbeat');
    if (this.versionValue !== input.afterVersion) return Promise.resolve('wakeup');
    return new Promise<WakeResult>((resolve) => {
      let settled = false;
      const finish = (result: WakeResult): void => {
        if (settled) return;
        settled = true;
        this.listeners.delete(onChange);
        input.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onChange = (): void => finish(this.heartbeatDue ? 'heartbeat' : 'wakeup');
      const onAbort = (): void => finish('closed');
      this.listeners.add(onChange);
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (this.heartbeatDue || this.versionValue !== input.afterVersion) onChange();
    });
  }
}
