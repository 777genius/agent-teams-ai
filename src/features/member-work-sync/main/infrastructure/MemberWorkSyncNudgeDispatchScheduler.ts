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

export interface MemberWorkSyncScheduledDispatch {
  result: Promise<MemberWorkSyncNudgeDispatchSummary>;
  settled: Promise<void>;
}

export interface MemberWorkSyncNudgeDispatchSchedulerDeps {
  listLifecycleActiveTeamNames(): Promise<string[]>;
  dispatchDue(
    teamNames: string[],
    signal?: AbortSignal
  ): Promise<MemberWorkSyncNudgeDispatchSummary> | MemberWorkSyncScheduledDispatch;
  intervalMs?: number;
  dispatchTimeoutMs?: number;
  logger?: MemberWorkSyncLoggerPort;
}

export class MemberWorkSyncNudgeDispatchScheduler {
  private readonly intervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private readonly listings = new Set<Promise<void>>();
  private lastDiscovery: { teams: string[]; observedAt: number } | null = null;
  private readonly dispatches = new Map<string, Promise<void>>();
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
    await Promise.all([...this.listings]);
    await Promise.all([...this.dispatches.values()]);
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
      let cursor = 0;
      const consume = async (): Promise<void> => {
        while (!this.stopped && cursor < teamNames.length) {
          const teamName = teamNames[cursor++];
          if (this.dispatches.has(teamName)) continue;
          if (this.dispatches.size >= 128) {
            this.deps.logger?.warn('member work sync scheduler retained operation limit reached', {
              retained: this.dispatches.size,
            });
            return;
          }
          try {
            const summary = await this.runDispatchDueWithTimeout(teamName);
            if (summary.claimed > 0 || summary.delivered > 0 || summary.retryable > 0) {
              this.deps.logger?.debug('member work sync scheduled nudge dispatch completed', {
                teamCount: 1,
                teamName,
                ...summary,
              });
            }
          } catch (error) {
            this.deps.logger?.warn('member work sync scheduled nudge dispatch failed', {
              teamName,
              error: String(error),
            });
          }
        }
      };
      await Promise.all([consume(), consume()]);
    } catch (error) {
      this.deps.logger?.warn('member work sync scheduled nudge dispatch failed', {
        error: String(error),
      });
    }
  }

  private async runDispatchDueWithTimeout(
    teamName: string
  ): Promise<MemberWorkSyncNudgeDispatchSummary> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();
    // Reserve synchronously before the deferred dispatch can perform any effect.
    let physical: Promise<void> = Promise.resolve();
    const work = Promise.resolve().then(() => {
      const call = this.deps.dispatchDue([teamName], abortController.signal);
      if ('result' in call) {
        physical = call.settled.then(
          () => undefined,
          () => undefined
        );
        return call.result;
      }
      return call;
    });
    const settled = work
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => physical);
    this.dispatches.set(teamName, settled);
    void settled.then(() => {
      if (this.dispatches.get(teamName) === settled) this.dispatches.delete(teamName);
    });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abortController.abort();
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
    // At most one replacement for an unresolved read. No replacement ever starts a side effect.
    if (this.listings.size >= 2) {
      throw new Error('member work sync scheduled team discovery capacity exhausted');
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const work = Promise.resolve().then(() => this.deps.listLifecycleActiveTeamNames());
    const settled = work.then(
      () => undefined,
      () => undefined
    );
    this.listings.add(settled);
    void settled.then(() => this.listings.delete(settled));
    try {
      const teams = await Promise.race([
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
      // Only this logical pass can publish. A timed-out read has no cache-writing callback.
      if (!this.stopped)
        this.lastDiscovery = { teams: uniqueNonEmpty(teams), observedAt: Date.now() };
      return teams;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  getHealth(): {
    pendingDiscovery: number;
    retainedDispatches: number;
    lastDiscoveryAt: number | null;
    discoveryCapacityExhausted: boolean;
  } {
    return {
      pendingDiscovery: this.listings.size,
      retainedDispatches: this.dispatches.size,
      lastDiscoveryAt: this.lastDiscovery?.observedAt ?? null,
      discoveryCapacityExhausted: this.listings.size >= 2,
    };
  }
}
