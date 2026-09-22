import type {
  DispatchDueRecoveriesSummary,
  RuntimeRecoveryLoggerPort,
  RuntimeRecoveryRepositoryPort,
} from '../../core/application';

const DEFAULT_FALLBACK_SWEEP_MS = 30_000;
const MIN_WAKE_DELAY_MS = 1_000;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export class TeamRuntimeRecoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly deps: {
      repository: RuntimeRecoveryRepositoryPort;
      listActiveTeamNames(): Promise<string[]>;
      dispatch(teamNames: string[]): Promise<DispatchDueRecoveriesSummary>;
      expireUnknownOutcomes(teamNames: string[]): Promise<number>;
      now?: () => Date;
      fallbackSweepMs?: number;
      logger?: RuntimeRecoveryLoggerPort;
    }
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.schedule(MIN_WAKE_DELAY_MS);
  }

  wake(): void {
    if (this.stopped) return;
    this.schedule(MIN_WAKE_DELAY_MS);
  }

  async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.running) return this.running;
    const run = this.runInternal();
    this.running = run;
    try {
      await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private async runInternal(): Promise<void> {
    try {
      const [activeTeamNames, persistedTeamNames] = await Promise.all([
        this.deps.listActiveTeamNames(),
        this.deps.repository.listTeamNames(),
      ]);
      const active = new Set(activeTeamNames.map((name) => name.trim()).filter(Boolean));
      const teamNames = [...new Set([...active, ...persistedTeamNames])].filter((name) =>
        active.has(name)
      );
      await this.deps.expireUnknownOutcomes(teamNames);
      const summary = await this.deps.dispatch(teamNames);
      if (summary.claimed > 0) {
        this.deps.logger?.debug('team runtime recovery dispatch completed', { ...summary });
      }
      this.schedule(await this.resolveNextWakeDelay(teamNames));
    } catch (error) {
      this.deps.logger?.warn('team runtime recovery scheduler failed', { error: String(error) });
      this.schedule(this.deps.fallbackSweepMs ?? DEFAULT_FALLBACK_SWEEP_MS);
    }
  }

  private async resolveNextWakeDelay(teamNames: string[]): Promise<number> {
    const nowMs = (this.deps.now ?? (() => new Date()))().getTime();
    let nextAtMs = Number.POSITIVE_INFINITY;
    for (const teamName of teamNames) {
      const state = await this.deps.repository.read(teamName);
      for (const job of state.jobs) {
        if (['pending', 'failed_retryable'].includes(job.status)) {
          const dueAt = Date.parse(job.nextAttemptAt);
          if (Number.isFinite(dueAt)) nextAtMs = Math.min(nextAtMs, dueAt);
        }
        if (job.status === 'awaiting_outcome') {
          const deadline = Date.parse(job.outcomeDeadlineAt ?? '');
          if (Number.isFinite(deadline)) nextAtMs = Math.min(nextAtMs, deadline);
        }
      }
    }
    const fallback = this.deps.fallbackSweepMs ?? DEFAULT_FALLBACK_SWEEP_MS;
    return Number.isFinite(nextAtMs)
      ? Math.max(MIN_WAKE_DELAY_MS, Math.min(fallback, nextAtMs - nowMs))
      : fallback;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runOnce();
      },
      Math.max(MIN_WAKE_DELAY_MS, delayMs)
    );
    unrefTimer(this.timer);
  }
}
