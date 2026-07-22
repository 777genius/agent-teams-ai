import type {
  MemberWorkSyncLoggerPort,
  MemberWorkSyncNudgeDispatchSummary,
} from '../../core/application';

const DEFAULT_NUDGE_DISPATCH_INTERVAL_MS = 60_000;
const DEFAULT_NUDGE_DISPATCH_TIMEOUT_MS = 2 * 60_000;

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export interface MemberWorkSyncNudgeDispatchSchedulerDeps {
  listLifecycleActiveTeamNames(): Promise<string[]>;
  dispatchDue(
    teamNames: string[],
    signal?: AbortSignal
  ): Promise<MemberWorkSyncNudgeDispatchSummary>;
  intervalMs?: number;
  dispatchTimeoutMs?: number;
  logger?: MemberWorkSyncLoggerPort;
}

export class MemberWorkSyncNudgeDispatchScheduler {
  private readonly intervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private timedOutWork: Promise<unknown> | null = null;
  private stopped = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: MemberWorkSyncNudgeDispatchSchedulerDeps) {
    this.intervalMs = Math.max(10_000, deps.intervalMs ?? DEFAULT_NUDGE_DISPATCH_INTERVAL_MS);
    this.dispatchTimeoutMs = Math.max(
      1,
      deps.dispatchTimeoutMs ?? DEFAULT_NUDGE_DISPATCH_TIMEOUT_MS
    );
  }

  start(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.schedule(this.intervalMs);
  }

  async runOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.timedOutWork) {
      return;
    }
    if (this.running) {
      await this.running;
      return;
    }

    const work = this.dispatchOnce();
    this.running = work;
    try {
      await work;
    } finally {
      if (this.running === work) {
        this.running = null;
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.disposePromise = this.drainForDisposal();
    return this.disposePromise;
  }

  private async drainForDisposal(): Promise<void> {
    await this.running?.catch(() => undefined);
    await this.timedOutWork?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    unrefTimer(this.timer);
  }

  private async dispatchOnce(): Promise<void> {
    try {
      const teamNames = uniqueNonEmpty(await this.listLifecycleActiveTeamNamesWithTimeout());
      if (teamNames.length === 0) {
        return;
      }
      const summary = await this.runDispatchDueWithTimeout(teamNames);
      if (summary.claimed > 0 || summary.delivered > 0 || summary.retryable > 0) {
        this.deps.logger?.debug('member work sync scheduled nudge dispatch completed', {
          teamCount: teamNames.length,
          ...summary,
        });
      }
    } catch (error) {
      this.deps.logger?.warn('member work sync scheduled nudge dispatch failed', {
        error: String(error),
      });
    }
  }

  private async runDispatchDueWithTimeout(
    teamNames: string[]
  ): Promise<MemberWorkSyncNudgeDispatchSummary> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();
    const work = this.deps.dispatchDue(teamNames, abortController.signal);
    void work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abortController.abort();
            this.trackTimedOutWork(work);
            reject(
              new Error(
                `member work sync scheduled nudge dispatch timed out after ${this.dispatchTimeoutMs}ms`
              )
            );
          }, this.dispatchTimeoutMs);
          unrefTimer(timeout);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async listLifecycleActiveTeamNamesWithTimeout(): Promise<string[]> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const work = this.deps.listLifecycleActiveTeamNames();
    void work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            this.trackTimedOutWork(work);
            reject(
              new Error(
                `member work sync scheduled nudge team listing timed out after ${this.dispatchTimeoutMs}ms`
              )
            );
          }, this.dispatchTimeoutMs);
          unrefTimer(timeout);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private trackTimedOutWork(work: Promise<unknown>): void {
    const settling = work
      .catch(() => undefined)
      .finally(() => {
        if (this.timedOutWork === settling) {
          this.timedOutWork = null;
        }
      });
    this.timedOutWork = settling;
  }
}
