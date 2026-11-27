import { createLogger } from '@shared/utils/logger';

import type { SchedulerStopBarrier } from './SchedulerStopBarrier';
import type { Schedule } from '@shared/types';
import type { Cron } from 'croner';

const logger = createLogger('Service:Scheduler');
const WARMUP_RETRY_DELAY_MS = 60_000;
const WARMUP_MAX_RETRIES = 3;

/** Warm-up function injected from main process (wraps prepareForProvisioning). */
export type WarmUpFn = (cwd: string) => Promise<{ ready: boolean; message: string }>;

/** The original scheduler's optional warm-up timers and their stop/epoch fence. */
export class SchedulerWarmUp {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly options: {
      isStopped(): boolean;
      epoch(): number;
      admission: Pick<SchedulerStopBarrier, 'withAdmission'>;
      warmUp: WarmUpFn;
      cronJobs: ReadonlyMap<string, Cron>;
    }
  ) {}

  clearAll(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      logger.debug(`Cleared warm-up timer: ${id}`);
    }
    this.timers.clear();
  }

  schedule(schedule: Schedule): void {
    if (this.options.isStopped()) return;
    this.clear(schedule.id);

    // Smart jobs dispatch through existing runtime services; warming up the
    // one-shot CLI needlessly can alter a live team and is not required.
    if (schedule.executionMode || schedule.hostTarget || schedule.warmUpMinutes <= 0) return;

    const job = this.options.cronJobs.get(schedule.id);
    if (!job) return;

    const msToNext = job.msToNext();
    if (msToNext == null) return;

    const warmUpMs = schedule.warmUpMinutes * 60_000;
    const warmUpDelayMs = Math.max(0, msToNext - warmUpMs);

    const timer = setTimeout(() => {
      this.timers.delete(schedule.id);
      void this.perform(schedule);
    }, warmUpDelayMs);

    // Don't block Electron quit
    timer.unref();
    this.timers.set(schedule.id, timer);

    logger.debug(
      `Warm-up scheduled for ${schedule.id}: in ${Math.round(warmUpDelayMs / 1000)}s ` +
        `(${schedule.warmUpMinutes}min before next run)`
    );
  }

  clear(scheduleId: string): void {
    const timer = this.timers.get(scheduleId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(scheduleId);
    }
  }

  private async perform(schedule: Schedule, retryCount = 0): Promise<void> {
    const generation = this.options.epoch();
    return this.options.admission.withAdmission(schedule.id, async (isCurrent) => {
      if (this.options.isStopped() || generation !== this.options.epoch()) return;
      logger.info(
        `[${schedule.id}] Starting warm-up (attempt ${retryCount + 1}/${WARMUP_MAX_RETRIES})`
      );

      try {
        const result = await this.options.warmUp(schedule.launchConfig.cwd);

        if (result.ready) {
          logger.info(`[${schedule.id}] Warm-up successful: ${result.message}`);
          return;
        }

        logger.warn(`[${schedule.id}] Warm-up not ready: ${result.message}`);
      } catch (err) {
        logger.warn(`[${schedule.id}] Warm-up error: ${err}`);
      }

      // Retry
      if (!isCurrent() || this.options.isStopped() || generation !== this.options.epoch()) return;
      if (retryCount < WARMUP_MAX_RETRIES - 1) {
        const retryTimer = setTimeout(() => {
          this.timers.delete(schedule.id);
          void this.perform(schedule, retryCount + 1);
        }, WARMUP_RETRY_DELAY_MS);
        retryTimer.unref();
        // Store in warmUpTimers so clearWarmUpTimer/stop() can cancel it
        this.timers.set(schedule.id, retryTimer);
      } else {
        logger.warn(`[${schedule.id}] Warm-up failed after ${WARMUP_MAX_RETRIES} attempts`);
      }
    });
  }
}
