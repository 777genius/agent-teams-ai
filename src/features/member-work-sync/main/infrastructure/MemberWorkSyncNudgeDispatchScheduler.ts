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
  dispatchDue(teamNames: string[]): Promise<MemberWorkSyncNudgeDispatchSummary>;
  intervalMs?: number;
  dispatchTimeoutMs?: number;
  logger?: MemberWorkSyncLoggerPort;
}

export class MemberWorkSyncNudgeDispatchScheduler {
  private readonly intervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

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

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running.catch(() => undefined);
    }
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
    const work = this.deps.dispatchDue(teamNames);
    void work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
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
}
