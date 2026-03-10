/**
 * SchedulerService — orchestrates scheduled task execution via croner.
 *
 * Manages cron jobs, warm-up timers, execution lifecycle, and concurrency locks.
 * Uses one-shot `claude -p` executor (NOT launchTeam stream-json).
 */

import { getSchedulesBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { Cron } from 'croner';
import { randomUUID } from 'crypto';

import type {
  CreateScheduleInput,
  Schedule,
  ScheduleChangeEvent,
  ScheduleRun,
  ScheduleRunStatus,
  UpdateSchedulePatch,
} from '@shared/types';
import type { ScheduleRepository } from './ScheduleRepository';
import type { ScheduledTaskExecutor } from './ScheduledTaskExecutor';

const logger = createLogger('Service:Scheduler');

// =============================================================================
// Constants
// =============================================================================

const WARMUP_RETRY_DELAY_MS = 60_000;
const WARMUP_MAX_RETRIES = 3;
const EXECUTION_MAX_RETRIES = 2;
const EXECUTION_RETRY_DELAY_MS = 90_000; // 90s between retries

// =============================================================================
// Types
// =============================================================================

type ChangeEmitter = (event: ScheduleChangeEvent) => void;

/** Warm-up function injected from main process (wraps prepareForProvisioning) */
export type WarmUpFn = (cwd: string) => Promise<{ ready: boolean; message: string }>;

// =============================================================================
// SchedulerService
// =============================================================================

export class SchedulerService {
  private repository: ScheduleRepository;
  private executor: ScheduledTaskExecutor;
  private warmUpFn: WarmUpFn;
  private changeEmitter: ChangeEmitter | null = null;

  // Croner jobs keyed by schedule ID
  private cronJobs = new Map<string, Cron>();

  // Warm-up timers keyed by schedule ID (includes warm-up retry timers)
  private warmUpTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Execution retry delay timers keyed by schedule ID
  private retryDelayTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Active runs keyed by schedule ID (only one run per schedule at a time)
  private activeRuns = new Map<string, ScheduleRun>();

  // CWD exclusion lock: cwd → schedule ID (prevents two schedule runs on same dir)
  private cwdLock = new Map<string, string>();

  // Flag to prevent retry timers from firing after stop()
  private stopped = false;

  constructor(
    repository: ScheduleRepository,
    executor: ScheduledTaskExecutor,
    warmUpFn?: WarmUpFn
  ) {
    this.repository = repository;
    this.executor = executor;
    this.warmUpFn = warmUpFn ?? (async () => ({ ready: true, message: 'warm-up skipped' }));
  }

  setChangeEmitter(emitter: ChangeEmitter): void {
    this.changeEmitter = emitter;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    logger.info(`Scheduler starting, basePath=${getSchedulesBasePath()}`);

    this.stopped = false;

    // Recovery: mark interrupted runs from previous session
    await this.recoverInterruptedRuns();

    // Load all schedules and create cron jobs for active ones
    const schedules = await this.repository.listSchedules();
    let activeCount = 0;

    for (const schedule of schedules) {
      if (schedule.status === 'active') {
        this.createCronJob(schedule);
        activeCount++;
      }
    }

    logger.info(
      `Scheduler started: ${activeCount} active jobs out of ${schedules.length} schedules`
    );
  }

  async stop(): Promise<void> {
    logger.info('Scheduler stopping');

    // Prevent retry timers from dispatching new work after stop
    this.stopped = true;

    // Cancel all active executions
    this.executor.cancelAll();

    // Stop all cron jobs
    for (const [id, job] of this.cronJobs) {
      job.stop();
      logger.debug(`Stopped cron job: ${id}`);
    }
    this.cronJobs.clear();

    // Clear all warm-up timers
    for (const [id, timer] of this.warmUpTimers) {
      clearTimeout(timer);
      logger.debug(`Cleared warm-up timer: ${id}`);
    }
    this.warmUpTimers.clear();

    // Clear execution retry delay timers
    for (const [id, timer] of this.retryDelayTimers) {
      clearTimeout(timer);
      logger.debug(`Cleared retry delay timer: ${id}`);
    }
    this.retryDelayTimers.clear();

    // Clear locks
    this.activeRuns.clear();
    this.cwdLock.clear();

    logger.info('Scheduler stopped');
  }

  // ===========================================================================
  // CRUD
  // ===========================================================================

  async listSchedules(): Promise<Schedule[]> {
    return this.repository.listSchedules();
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    return this.repository.getSchedule(id);
  }

  async getSchedulesByTeam(teamName: string): Promise<Schedule[]> {
    return this.repository.getSchedulesByTeam(teamName);
  }

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      teamName: input.teamName,
      label: input.label,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      status: 'active',
      warmUpMinutes: input.warmUpMinutes ?? 15,
      maxConsecutiveFailures: 3,
      consecutiveFailures: 0,
      maxTurns: input.maxTurns ?? 50,
      maxBudgetUsd: input.maxBudgetUsd,
      createdAt: now,
      updatedAt: now,
      launchConfig: input.launchConfig,
    };

    // Compute nextRunAt before saving
    schedule.nextRunAt = this.computeNextRunAt(schedule) ?? undefined;

    await this.repository.saveSchedule(schedule);
    this.createCronJob(schedule);

    this.emitChange({
      type: 'schedule-updated',
      scheduleId: schedule.id,
      teamName: schedule.teamName,
      detail: 'created',
    });

    logger.info(`Schedule created: ${schedule.id} for team ${schedule.teamName}`);
    return schedule;
  }

  async updateSchedule(id: string, patch: UpdateSchedulePatch): Promise<Schedule> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) {
      throw new Error(`Schedule not found: ${id}`);
    }

    const updated: Schedule = {
      ...existing,
      ...(patch.label !== undefined && { label: patch.label }),
      ...(patch.cronExpression !== undefined && { cronExpression: patch.cronExpression }),
      ...(patch.timezone !== undefined && { timezone: patch.timezone }),
      ...(patch.warmUpMinutes !== undefined && { warmUpMinutes: patch.warmUpMinutes }),
      ...(patch.maxTurns !== undefined && { maxTurns: patch.maxTurns }),
      ...(patch.maxBudgetUsd !== undefined && { maxBudgetUsd: patch.maxBudgetUsd }),
      ...(patch.launchConfig && {
        launchConfig: { ...existing.launchConfig, ...patch.launchConfig },
      }),
      updatedAt: new Date().toISOString(),
    };

    // Reschedule cron job if expression or timezone changed
    const cronChanged = patch.cronExpression !== undefined || patch.timezone !== undefined;

    if (cronChanged || patch.warmUpMinutes !== undefined) {
      this.removeCronJob(id);
      if (updated.status === 'active') {
        updated.nextRunAt = this.computeNextRunAt(updated) ?? undefined;
        this.createCronJob(updated);
      }
    }

    await this.repository.saveSchedule(updated);
    this.emitChange({
      type: 'schedule-updated',
      scheduleId: updated.id,
      teamName: updated.teamName,
      detail: 'updated',
    });

    return updated;
  }

  async deleteSchedule(id: string): Promise<void> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) {
      throw new Error(`Schedule not found: ${id}`);
    }

    // Cancel active run if any
    const activeRun = this.activeRuns.get(id);
    if (activeRun) {
      this.executor.cancel(activeRun.id);
    }
    this.removeCronJob(id);
    this.releaseRunLocks(id);

    await this.repository.deleteSchedule(id);
    this.emitChange({
      type: 'schedule-updated',
      scheduleId: id,
      teamName: existing.teamName,
      detail: 'deleted',
    });

    logger.info(`Schedule deleted: ${id}`);
  }

  async pauseSchedule(id: string): Promise<void> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) {
      throw new Error(`Schedule not found: ${id}`);
    }

    // Pause cron job
    const job = this.cronJobs.get(id);
    if (job) {
      job.pause();
    }

    // Clear warm-up timer
    this.clearWarmUpTimer(id);

    const updated: Schedule = {
      ...existing,
      status: 'paused',
      updatedAt: new Date().toISOString(),
    };

    await this.repository.saveSchedule(updated);
    this.emitChange({
      type: 'schedule-paused',
      scheduleId: id,
      teamName: existing.teamName,
    });

    logger.info(`Schedule paused: ${id}`);
  }

  async resumeSchedule(id: string): Promise<void> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) {
      throw new Error(`Schedule not found: ${id}`);
    }

    // Remove old job and recreate to get fresh next-run timing
    this.removeCronJob(id);

    const updated: Schedule = {
      ...existing,
      status: 'active',
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    };

    updated.nextRunAt = this.computeNextRunAt(updated) ?? undefined;
    this.createCronJob(updated);

    await this.repository.saveSchedule(updated);
    this.emitChange({
      type: 'schedule-updated',
      scheduleId: id,
      teamName: existing.teamName,
      detail: 'resumed',
    });

    logger.info(`Schedule resumed: ${id}`);
  }

  // ===========================================================================
  // Run History
  // ===========================================================================

  async getRuns(
    scheduleId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<ScheduleRun[]> {
    return this.repository.listRuns(scheduleId, opts);
  }

  async getRunLogs(scheduleId: string, runId: string): Promise<{ stdout: string; stderr: string }> {
    return this.repository.getRunLogs(scheduleId, runId);
  }

  // ===========================================================================
  // Trigger Now
  // ===========================================================================

  async triggerNow(id: string): Promise<ScheduleRun> {
    const schedule = await this.repository.getSchedule(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }

    // Check locks
    if (this.activeRuns.has(id)) {
      throw new Error(`Schedule ${id} already has an active run`);
    }

    const cwd = schedule.launchConfig.cwd;
    const cwdHolder = this.cwdLock.get(cwd);
    if (cwdHolder && cwdHolder !== id) {
      throw new Error(`Working directory "${cwd}" is locked by another schedule: ${cwdHolder}`);
    }

    const now = new Date().toISOString();
    const run: ScheduleRun = {
      id: randomUUID(),
      scheduleId: id,
      teamName: schedule.teamName,
      status: 'running',
      scheduledFor: now,
      startedAt: now,
      executionStartedAt: now,
      retryCount: 0,
    };

    await this.repository.saveRun(run);
    this.emitChange({ type: 'run-started', scheduleId: id, teamName: schedule.teamName });

    // Execute in background (don't await — triggerNow returns immediately)
    void this.executeRunInBackground(schedule, run);

    return run;
  }

  // ===========================================================================
  // claudeRootPath Change
  // ===========================================================================

  async reloadForClaudeRootChange(): Promise<void> {
    logger.info('Reloading schedules for claudeRootPath change');
    await this.stop();
    await this.start();
  }

  // ===========================================================================
  // Cron Job Management
  // ===========================================================================

  private createCronJob(schedule: Schedule): void {
    if (this.cronJobs.has(schedule.id)) {
      this.removeCronJob(schedule.id);
    }

    try {
      const job = new Cron(schedule.cronExpression, { timezone: schedule.timezone }, () => {
        void this.onCronTick(schedule.id);
      });

      this.cronJobs.set(schedule.id, job);

      // Set warm-up timer for the next run
      this.scheduleWarmUp(schedule);

      logger.info(
        `Cron job created for schedule ${schedule.id}: "${schedule.cronExpression}" ` +
          `(timezone: ${schedule.timezone}, next: ${job.nextRun()?.toISOString() ?? 'never'})`
      );
    } catch (err) {
      logger.error(`Failed to create cron job for ${schedule.id}: ${err}`);
    }
  }

  private removeCronJob(scheduleId: string): void {
    const job = this.cronJobs.get(scheduleId);
    if (job) {
      job.stop();
      this.cronJobs.delete(scheduleId);
    }
    this.clearWarmUpTimer(scheduleId);
  }

  // ===========================================================================
  // Warm-Up Timer
  // ===========================================================================

  private scheduleWarmUp(schedule: Schedule): void {
    this.clearWarmUpTimer(schedule.id);

    if (schedule.warmUpMinutes <= 0) return;

    const job = this.cronJobs.get(schedule.id);
    if (!job) return;

    const msToNext = job.msToNext();
    if (msToNext == null) return;

    const warmUpMs = schedule.warmUpMinutes * 60_000;
    const warmUpDelayMs = Math.max(0, msToNext - warmUpMs);

    const timer = setTimeout(() => {
      this.warmUpTimers.delete(schedule.id);
      void this.performWarmUp(schedule);
    }, warmUpDelayMs);

    // Don't block Electron quit
    timer.unref();
    this.warmUpTimers.set(schedule.id, timer);

    logger.debug(
      `Warm-up scheduled for ${schedule.id}: in ${Math.round(warmUpDelayMs / 1000)}s ` +
        `(${schedule.warmUpMinutes}min before next run)`
    );
  }

  private clearWarmUpTimer(scheduleId: string): void {
    const timer = this.warmUpTimers.get(scheduleId);
    if (timer) {
      clearTimeout(timer);
      this.warmUpTimers.delete(scheduleId);
    }
  }

  private async performWarmUp(schedule: Schedule, retryCount = 0): Promise<void> {
    logger.info(
      `[${schedule.id}] Starting warm-up (attempt ${retryCount + 1}/${WARMUP_MAX_RETRIES})`
    );

    try {
      const result = await this.warmUpFn(schedule.launchConfig.cwd);

      if (result.ready) {
        logger.info(`[${schedule.id}] Warm-up successful: ${result.message}`);
        return;
      }

      logger.warn(`[${schedule.id}] Warm-up not ready: ${result.message}`);
    } catch (err) {
      logger.warn(`[${schedule.id}] Warm-up error: ${err}`);
    }

    // Retry
    if (retryCount < WARMUP_MAX_RETRIES - 1) {
      const retryTimer = setTimeout(() => {
        this.warmUpTimers.delete(schedule.id);
        void this.performWarmUp(schedule, retryCount + 1);
      }, WARMUP_RETRY_DELAY_MS);
      retryTimer.unref();
      // Store in warmUpTimers so clearWarmUpTimer/stop() can cancel it
      this.warmUpTimers.set(schedule.id, retryTimer);
    } else {
      logger.warn(`[${schedule.id}] Warm-up failed after ${WARMUP_MAX_RETRIES} attempts`);
    }
  }

  // ===========================================================================
  // Cron Tick → Execution
  // ===========================================================================

  private async onCronTick(scheduleId: string): Promise<void> {
    const schedule = await this.repository.getSchedule(scheduleId);
    if (!schedule || schedule.status !== 'active') {
      logger.debug(`Cron tick for ${scheduleId} skipped (not active)`);
      return;
    }

    // Check schedule-level lock
    if (this.activeRuns.has(scheduleId)) {
      logger.warn(`[${scheduleId}] Cron tick skipped: previous run still active`);
      return;
    }

    // Check cwd lock
    const cwd = schedule.launchConfig.cwd;
    const cwdHolder = this.cwdLock.get(cwd);
    if (cwdHolder && cwdHolder !== scheduleId) {
      logger.warn(
        `[${scheduleId}] Cron tick skipped: cwd "${cwd}" locked by schedule ${cwdHolder}`
      );
      return;
    }

    const now = new Date().toISOString();
    const run: ScheduleRun = {
      id: randomUUID(),
      scheduleId,
      teamName: schedule.teamName,
      status: 'running',
      scheduledFor: now,
      startedAt: now,
      executionStartedAt: now,
      retryCount: 0,
    };

    await this.repository.saveRun(run);
    this.emitChange({ type: 'run-started', scheduleId, teamName: schedule.teamName });

    void this.executeRunInBackground(schedule, run);
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  private async executeRunInBackground(schedule: Schedule, run: ScheduleRun): Promise<void> {
    const { id: scheduleId, launchConfig } = schedule;

    // Acquire locks
    this.activeRuns.set(scheduleId, run);
    this.cwdLock.set(launchConfig.cwd, scheduleId);

    let retriedInternally = false;

    try {
      const result = await this.executor.execute({
        runId: run.id,
        config: launchConfig,
        maxTurns: schedule.maxTurns,
        maxBudgetUsd: schedule.maxBudgetUsd,
      });

      if (result.exitCode === 0) {
        // Success — save logs, complete run
        await this.repository.saveRunLogs(scheduleId, run.id, result.stdout, result.stderr);
        await this.completeRun(run, 'completed', result.exitCode, result.summary);
        await this.resetConsecutiveFailures(schedule);
        logger.info(
          `[${scheduleId}] Run ${run.id} completed successfully (${result.durationMs}ms)`
        );
      } else {
        // Failure — save logs before handling
        await this.repository.saveRunLogs(scheduleId, run.id, result.stdout, result.stderr);
        const errorMsg = result.stderr.slice(0, 500) || `Exit code: ${result.exitCode}`;
        retriedInternally = await this.handleRunFailure(schedule, run, result.exitCode, errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      retriedInternally = await this.handleRunFailure(schedule, run, null, errorMsg);
    } finally {
      // Skip cleanup if retry took over — retry's own finally will handle it
      if (retriedInternally) return;

      // Release locks only if this run still owns them (prevents double-release race)
      const currentActive = this.activeRuns.get(scheduleId);
      if (currentActive?.id === run.id) {
        this.releaseRunLocks(scheduleId);
      }

      // Update schedule's lastRunAt and nextRunAt
      await this.updateScheduleTimestamps(schedule);

      // Schedule next warm-up
      const freshSchedule = await this.repository.getSchedule(scheduleId);
      if (freshSchedule?.status === 'active') {
        this.scheduleWarmUp(freshSchedule);
      }
    }
  }

  /**
   * Handle a failed run. Returns `true` if a retry was dispatched
   * (meaning the caller's finally block should skip cleanup).
   */
  private async handleRunFailure(
    schedule: Schedule,
    run: ScheduleRun,
    exitCode: number | null,
    error: string
  ): Promise<boolean> {
    logger.warn(`[${schedule.id}] Run ${run.id} failed: ${error}`);

    // Retry logic
    if (run.retryCount < EXECUTION_MAX_RETRIES) {
      logger.info(
        `[${schedule.id}] Scheduling retry ${run.retryCount + 1}/${EXECUTION_MAX_RETRIES}`
      );

      const retryRun: ScheduleRun = {
        ...run,
        status: 'pending',
        retryCount: run.retryCount + 1,
        error,
      };
      await this.repository.saveRun(retryRun);

      // Release locks before retry delay
      this.releaseRunLocks(schedule.id);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXECUTION_RETRY_DELAY_MS);
        timer.unref();
        this.retryDelayTimers.set(schedule.id, timer);
      });
      this.retryDelayTimers.delete(schedule.id);

      // Bail if service was stopped during delay
      if (this.stopped) {
        await this.completeRun(retryRun, 'failed', exitCode, undefined, error);
        return false;
      }

      // Re-acquire locks and retry
      if (this.activeRuns.has(schedule.id)) {
        // Something else started — skip retry
        await this.completeRun(retryRun, 'failed', exitCode, undefined, error);
        return false;
      }

      const freshSchedule = await this.repository.getSchedule(schedule.id);
      if (!freshSchedule || freshSchedule.status !== 'active') {
        await this.completeRun(retryRun, 'failed', exitCode, undefined, error);
        return false;
      }

      // Dispatch retry — caller's finally must not run cleanup
      void this.executeRunInBackground(freshSchedule, retryRun);
      return true;
    }

    // Max retries exhausted
    await this.completeRun(run, 'failed', exitCode, undefined, error);
    await this.incrementConsecutiveFailures(schedule);
    return false;
  }

  private async completeRun(
    run: ScheduleRun,
    status: ScheduleRunStatus,
    exitCode: number | null,
    summary?: string,
    error?: string
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const startedAt = new Date(run.startedAt).getTime();
    const durationMs = Date.now() - startedAt;

    const updatedRun: ScheduleRun = {
      ...run,
      status,
      completedAt,
      durationMs,
      exitCode,
      summary: summary ?? run.summary,
      error: error ?? run.error,
    };

    await this.repository.saveRun(updatedRun);

    const eventType = status === 'completed' ? 'run-completed' : 'run-failed';
    this.emitChange({
      type: eventType,
      scheduleId: run.scheduleId,
      teamName: run.teamName,
      detail: error,
    });
  }

  // ===========================================================================
  // Consecutive Failure Tracking
  // ===========================================================================

  private async resetConsecutiveFailures(schedule: Schedule): Promise<void> {
    if (schedule.consecutiveFailures === 0) return;

    const updated: Schedule = {
      ...schedule,
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.saveSchedule(updated);
  }

  private async incrementConsecutiveFailures(schedule: Schedule): Promise<void> {
    const newCount = schedule.consecutiveFailures + 1;
    const shouldAutoPause = newCount >= schedule.maxConsecutiveFailures;

    const updated: Schedule = {
      ...schedule,
      consecutiveFailures: newCount,
      status: shouldAutoPause ? 'paused' : schedule.status,
      updatedAt: new Date().toISOString(),
    };

    if (shouldAutoPause) {
      logger.warn(`[${schedule.id}] Auto-pausing after ${newCount} consecutive failures`);
      const job = this.cronJobs.get(schedule.id);
      if (job) job.pause();
      this.clearWarmUpTimer(schedule.id);
    }

    await this.repository.saveSchedule(updated);

    if (shouldAutoPause) {
      this.emitChange({
        type: 'schedule-paused',
        scheduleId: schedule.id,
        teamName: schedule.teamName,
        detail: `auto-paused after ${newCount} consecutive failures`,
      });
    }
  }

  // ===========================================================================
  // Schedule Timestamp Updates
  // ===========================================================================

  private async updateScheduleTimestamps(schedule: Schedule): Promise<void> {
    // Reload fresh from repo to avoid overwriting changes from incrementConsecutiveFailures
    const fresh = await this.repository.getSchedule(schedule.id);
    if (!fresh) return;

    const now = new Date().toISOString();
    const nextRunAt = this.computeNextRunAt(fresh);

    const updated: Schedule = {
      ...fresh,
      lastRunAt: now,
      nextRunAt: nextRunAt ?? undefined,
      updatedAt: now,
    };

    await this.repository.saveSchedule(updated);
    this.emitChange({
      type: 'schedule-updated',
      scheduleId: fresh.id,
      teamName: fresh.teamName,
    });
  }

  // ===========================================================================
  // Recovery
  // ===========================================================================

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.repository.listSchedules();
    let recoveredCount = 0;

    for (const schedule of schedules) {
      const runs = await this.repository.listRuns(schedule.id, { limit: 5 });

      for (const run of runs) {
        if (
          run.status === 'warming_up' ||
          run.status === 'warm' ||
          run.status === 'running' ||
          run.status === 'pending'
        ) {
          const updated: ScheduleRun = {
            ...run,
            status: 'failed_interrupted',
            completedAt: new Date().toISOString(),
            error: 'Interrupted by app restart',
          };
          await this.repository.saveRun(updated);
          recoveredCount++;
        }
      }
    }

    if (recoveredCount > 0) {
      logger.info(`Recovered ${recoveredCount} interrupted runs as failed_interrupted`);
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private computeNextRunAt(schedule: Schedule): string | null {
    try {
      const job = new Cron(schedule.cronExpression, {
        timezone: schedule.timezone,
        paused: true,
      });
      const next = job.nextRun();
      job.stop();
      return next?.toISOString() ?? null;
    } catch {
      return null;
    }
  }

  private releaseRunLocks(scheduleId: string): void {
    this.activeRuns.delete(scheduleId);

    // Release cwd lock for this schedule
    for (const [cwd, holder] of this.cwdLock) {
      if (holder === scheduleId) {
        this.cwdLock.delete(cwd);
        break;
      }
    }
  }

  private emitChange(event: ScheduleChangeEvent): void {
    this.changeEmitter?.(event);
  }
}
