import type {
  MemberWorkSyncLoggerPort,
  RuntimeTurnSettledDrainSummary,
} from '../../core/application';

export interface RuntimeTurnSettledDrainSchedulerDeps {
  drain(): Promise<RuntimeTurnSettledDrainSummary>;
  intervalMs?: number;
  drainTimeoutMs?: number;
  logger?: MemberWorkSyncLoggerPort;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

const DEFAULT_RUNTIME_TURN_SETTLED_DRAIN_TIMEOUT_MS = 2 * 60_000;

export class RuntimeTurnSettledDrainScheduler {
  private readonly intervalMs: number;
  private readonly drainTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;

  constructor(private readonly deps: RuntimeTurnSettledDrainSchedulerDeps) {
    this.intervalMs = Math.max(1_000, deps.intervalMs ?? 15_000);
    this.drainTimeoutMs = Math.max(
      1,
      deps.drainTimeoutMs ?? DEFAULT_RUNTIME_TURN_SETTLED_DRAIN_TIMEOUT_MS
    );
  }

  start(): void {
    if (this.disposed || this.timer) {
      return;
    }
    this.schedule(100);
  }

  async drainNow(): Promise<RuntimeTurnSettledDrainSummary | null> {
    if (this.running || this.disposed) {
      return null;
    }

    this.running = true;
    try {
      return await this.runDrainWithTimeout();
    } catch (error) {
      this.deps.logger?.warn('runtime turn settled scheduled drain failed', {
        error: String(error),
      });
      return null;
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number = this.intervalMs): void {
    if (this.disposed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drainNow().finally(() => this.schedule());
    }, delayMs);
    unrefTimer(this.timer);
  }

  private async runDrainWithTimeout(): Promise<RuntimeTurnSettledDrainSummary> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.deps.drain(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(`runtime turn settled drain timed out after ${this.drainTimeoutMs}ms`)
            );
          }, this.drainTimeoutMs);
          unrefTimer(timeout);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
