/**
 * SchedulerService — orchestrates scheduled task execution via croner.
 *
 * Manages cron jobs, warm-up timers, execution lifecycle, and concurrency locks.
 */

import { getSchedulesBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { initialScheduleLimits, patchScheduleLimits } from '@shared/utils/scheduleLimits';
import { getValidScheduleNextRuns } from '@shared/utils/scheduleTiming';
import { Cron } from 'croner';
import { randomUUID } from 'crypto';

import { completeScheduleRun } from './completeScheduleRun';
import { computeScheduleNextRunAt } from './computeScheduleNextRunAt';
import { createScheduleRun, persistScheduleRun } from './createScheduleRun';
import { recoverInterruptedScheduleRuns } from './recoverInterruptedScheduleRuns';
import { assertScheduledTeamTarget, hasScheduledTeamTarget, HOST_SCHEDULE_UNSUPPORTED } from './scheduledTeamTarget';
import { SchedulerStopBarrier } from './SchedulerStopBarrier';

import type { ScheduledTaskExecutor } from './ScheduledTaskExecutor';
import type { ScheduleTargetAdmission } from './scheduledTeamTarget';
import type { ScheduleRepository } from './ScheduleRepository';
import type { ScheduleDispatcher } from './SelectedScheduleDispatcher';
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleChangeEvent,
  ScheduleRun,
  ScheduleRunStatus,
  UpdateSchedulePatch,
} from '@shared/types';

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
  private executor: Pick<ScheduledTaskExecutor, 'execute' | 'cancel' | 'cancelAll'>;
  private warmUpFn: WarmUpFn;
  private smartDispatcher: ScheduleDispatcher | null;
  private changeEmitter: ChangeEmitter | null = null;

  // Croner jobs keyed by schedule ID
  private cronJobs = new Map<string, Cron>();

  // Warm-up timers keyed by schedule ID (includes warm-up retry timers)
  private warmUpTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Active runs keyed by schedule ID (only one run per schedule at a time)
  private activeRuns = new Map<string, ScheduleRun>();

  // CWD exclusion lock: cwd → schedule ID (prevents two schedule runs on same dir)
  private cwdLock = new Map<string, string>();

  // Flag to prevent retry timers from firing after stop()
  private stopped = false;
  private lifecycleEpoch = 0;
  private readonly stopBarrier = new SchedulerStopBarrier();

  constructor(
    repository: ScheduleRepository,
    executor: Pick<ScheduledTaskExecutor, 'execute' | 'cancel' | 'cancelAll'>,
    warmUpFn?: WarmUpFn,
    smartDispatcher?: ScheduleDispatcher
  ) {
    this.repository = repository;
    this.executor = executor;
    this.smartDispatcher = smartDispatcher ?? null;
    this.warmUpFn = warmUpFn ?? (async () => ({ ready: true, message: 'warm-up skipped' }));
  }

  setChangeEmitter(emitter: ChangeEmitter): void {
    this.changeEmitter = emitter;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    await this.stopBarrier.drainFinalizations();
    logger.info(`Scheduler starting, basePath=${getSchedulesBasePath()}`);

    this.stopped = false;

    // Recovery: mark interrupted runs from previous session
    const recoveredCount = await recoverInterruptedScheduleRuns(this.repository);
    if (recoveredCount > 0) {
      logger.info(`Recovered ${recoveredCount} interrupted runs as failed_interrupted`);
    }

    // Load all schedules and create cron jobs for active ones
    const schedules = await this.repository.listSchedules();
    let activeCount = 0;

    for (const schedule of schedules) {
      if (schedule.status === 'active' && hasScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true)) {
        this.createCronJob(schedule);
        if (this.cronJobs.has(schedule.id)) activeCount++;
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
    this.lifecycleEpoch++;

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

    this.stopBarrier.cancelRetries();
    try {
      await this.smartDispatcher?.cancelAll?.();
      await this.stopBarrier.drainFinalizations();
    } finally {
      this.activeRuns.clear();
      this.cwdLock.clear();
    }

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

  async createSchedule(input: CreateScheduleInput, admission?: ScheduleTargetAdmission): Promise<Schedule> {
    const cronExpression = input.cronExpression.trim();
    const timezone = input.timezone.trim();
    getValidScheduleNextRuns(cronExpression, timezone);
    const selected = { ...input, hostTarget: admission?.target };
    assertScheduledTeamTarget(selected, this.smartDispatcher?.supportsHost === true);
    await this.smartDispatcher?.assertCanSchedule(selected);
    if (input.taskFirst && input.executionMode !== 'agent' && input.executionMode !== 'team') {
      throw new Error('Task-first schedule requires agent or team executionMode');
    }
    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      teamName: input.teamName,
      ...(admission ? { hostTarget: structuredClone(admission.target) } : {}),
      ...(input.executionMode && { executionMode: input.executionMode }),
      ...(input.taskFirst && { taskFirst: true as const, reviewedSavedPrompt: input.reviewedSavedPrompt }),
      ...(input.targetMember !== undefined && { targetMember: input.targetMember }),
      label: input.label,
      cronExpression,
      timezone,
      status: 'active',
      warmUpMinutes: input.warmUpMinutes ?? 15,
      maxConsecutiveFailures: 3,
      consecutiveFailures: 0,
      ...initialScheduleLimits(selected),
      createdAt: now,
      updatedAt: now,
      launchConfig: input.launchConfig,
    };
    schedule.nextRunAt = computeScheduleNextRunAt(schedule) ?? undefined;
    const job = this.prepareCronJob(schedule);
    try {
      if (admission && !admission.isCurrent()) throw new Error('Scheduled team context changed');
      await this.repository.saveSchedule(schedule);
    } catch (error) {
      job.stop();
      throw error;
    }
    this.activateCronJob(schedule, job);
    this.emitChange({
      type: 'schedule-updated',
      scheduleId: schedule.id,
      teamName: schedule.teamName,
      detail: 'created',
    });
    logger.info(`Schedule created: ${schedule.id} for team ${schedule.teamName}`);
    return schedule;
  }

  async updateSchedule(id: string, patch: UpdateSchedulePatch, admission?: ScheduleTargetAdmission): Promise<Schedule> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) throw new Error(`Schedule not found: ${id}`);
    const hostTarget = admission?.target ?? existing.hostTarget;
    assertScheduledTeamTarget({ teamName: existing.teamName, hostTarget }, this.smartDispatcher?.supportsHost === true);
    if (patch.reviewedSavedPrompt && !existing.taskFirst) throw new Error('Review requires task-first schedule');
    const cronChanged = patch.cronExpression !== undefined || patch.timezone !== undefined;
    const cronExpression = (patch.cronExpression ?? existing.cronExpression).trim();
    const timezone = (patch.timezone ?? existing.timezone).trim();
    if (cronChanged) getValidScheduleNextRuns(cronExpression, timezone);
    const updated: Schedule = {
      ...existing,
      ...(hostTarget ? { hostTarget: structuredClone(hostTarget) } : {}),
      ...(patch.executionMode !== undefined && { executionMode: patch.executionMode }),
      ...(patch.targetMember !== undefined && { targetMember: patch.targetMember }),
      ...(patch.reviewedSavedPrompt && { reviewedSavedPrompt: true as const }),
      ...(patch.label !== undefined && { label: patch.label }),
      ...(cronChanged && { cronExpression, timezone }),
      ...(patch.warmUpMinutes !== undefined && { warmUpMinutes: patch.warmUpMinutes }),
      ...patchScheduleLimits({ ...existing, hostTarget }, patch),
      ...(patch.launchConfig && {
        launchConfig: { ...existing.launchConfig, ...patch.launchConfig },
      }),
      updatedAt: new Date().toISOString(),
    };
    await this.smartDispatcher?.assertCanSchedule(updated);

    // Reschedule cron job if expression or timezone changed
    const reschedule = Boolean(admission) || cronChanged || patch.warmUpMinutes !== undefined || patch.executionMode !== undefined;
    if (reschedule && updated.status === 'active') updated.nextRunAt = computeScheduleNextRunAt(updated) ?? undefined;
    const nextJob = reschedule && updated.status === 'active'
      ? this.prepareCronJob(updated)
      : null;
    try {
      if (admission && !admission.isCurrent()) throw new Error('Scheduled team context changed');
      await this.repository.saveSchedule(updated);
    } catch (error) {
      nextJob?.stop();
      throw error;
    }
    if (reschedule) {
      if (nextJob) this.activateCronJob(updated, nextJob);
      else this.removeCronJob(id);
    }
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
    if (!existing) throw new Error(`Schedule not found: ${id}`);
    // Do not stop a live schedule unless the durable deletion succeeds.
    await this.repository.deleteSchedule(id);
    const activeRun = this.activeRuns.get(id);
    if (activeRun) this.executor.cancel(activeRun.id);
    this.removeCronJob(id);
    this.releaseRunLocks(id);
    if (activeRun) await this.smartDispatcher?.cancel?.(activeRun.id);
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
    if (!existing) throw new Error(`Schedule not found: ${id}`);

    const updated: Schedule = {
      ...existing,
      status: 'paused',
      updatedAt: new Date().toISOString(),
    };

    // Persistence errors must not leave an active record without a live job.
    await this.repository.saveSchedule(updated);
    this.cronJobs.get(id)?.pause();
    this.clearWarmUpTimer(id);
    this.emitChange({
      type: 'schedule-paused',
      scheduleId: id,
      teamName: existing.teamName,
    });

    logger.info(`Schedule paused: ${id}`);
  }

  async resumeSchedule(id: string): Promise<void> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) throw new Error(`Schedule not found: ${id}`);

    // A retained Host schedule cannot be armed against the legacy executor.
    assertScheduledTeamTarget(existing, this.smartDispatcher?.supportsHost === true);
    await this.smartDispatcher?.assertCanSchedule(existing);

    // A historic invalid schedule must be repaired before it can be resumed.
    getValidScheduleNextRuns(existing.cronExpression, existing.timezone);
    const updated: Schedule = {
      ...existing,
      status: 'active',
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    };

    updated.nextRunAt = computeScheduleNextRunAt(updated) ?? undefined;
    const job = this.prepareCronJob(updated);
    try {
      await this.repository.saveSchedule(updated);
    } catch (error) {
      job.stop();
      throw error;
    }
    this.activateCronJob(updated, job);
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
    if (this.stopped) throw new Error('Scheduler is stopped');
    const generation = this.lifecycleEpoch;
    const schedule = await this.repository.getSchedule(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }

    // Reject foreign owner keys before allocating an execution record.
    assertScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true);

    // Check locks
    if (this.activeRuns.has(id)) {
      throw new Error(`Schedule ${id} already has an active run`);
    }

    const cwd = schedule.launchConfig.cwd;
    const cwdHolder = this.cwdLock.get(cwd);
    if (cwdHolder && cwdHolder !== id) {
      throw new Error(`Working directory "${cwd}" is locked by another schedule: ${cwdHolder}`);
    }

    const run = createScheduleRun(schedule);
    this.activeRuns.set(id, run);
    this.cwdLock.set(cwd, id);
    try { await persistScheduleRun(this.repository, this.stopBarrier, run); }
    catch (error) { if (this.activeRuns.get(id)?.id === run.id) this.releaseRunLocks(id); throw error; }
    if (this.stopped || generation !== this.lifecycleEpoch) throw new Error('Scheduler stopped before dispatch');
    this.emitChange({ type: 'run-started', scheduleId: id, teamName: schedule.teamName });

    // Execute in background (don't await — triggerNow returns immediately)
    this.dispatchRun(schedule, run);

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

  /** Prepare the replacement without touching the currently active cron timer. */
  private prepareCronJob(schedule: Schedule): Cron {
    return new Cron(schedule.cronExpression, { timezone: schedule.timezone, paused: true },
      () => void this.onCronTick(schedule.id));
  }

  private activateCronJob(schedule: Schedule, job: Cron): void {
    this.removeCronJob(schedule.id);
    this.cronJobs.set(schedule.id, job);
    job.resume();
    this.scheduleWarmUp(schedule);
    logger.info(`Cron job created for schedule ${schedule.id}: "${schedule.cronExpression}" ` +
      `(timezone: ${schedule.timezone}, next: ${job.nextRun()?.toISOString() ?? 'never'})`);
  }

  /** Historic records may be invalid: log and keep the rest of startup running. */
  private createCronJob(schedule: Schedule): void {
    if (!hasScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true)) return;
    try {
      getValidScheduleNextRuns(schedule.cronExpression, schedule.timezone);
      const job = this.prepareCronJob(schedule);
      this.activateCronJob(schedule, job);
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
    if (this.stopped) return;
    this.clearWarmUpTimer(schedule.id);

    // Smart jobs dispatch through existing runtime services; warming up the
    // one-shot CLI needlessly can alter a live team and is not required.
    if (schedule.executionMode || schedule.hostTarget || schedule.warmUpMinutes <= 0) return;

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
    const generation = this.lifecycleEpoch;
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
    if (this.stopped || generation !== this.lifecycleEpoch) return;
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
    const generation = this.lifecycleEpoch;
    const schedule = await this.repository.getSchedule(scheduleId);
    if (schedule?.status !== 'active' || !hasScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true)) {
      logger.debug(`Cron tick for ${scheduleId} skipped (not active or unsupported owner)`);
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

    const run = createScheduleRun(schedule);
    this.activeRuns.set(scheduleId, run);
    this.cwdLock.set(cwd, scheduleId);
    try { await persistScheduleRun(this.repository, this.stopBarrier, run); }
    catch (error) { if (this.activeRuns.get(scheduleId)?.id === run.id) this.releaseRunLocks(scheduleId); throw error; }
    if (this.stopped || generation !== this.lifecycleEpoch) return;
    this.emitChange({ type: 'run-started', scheduleId, teamName: schedule.teamName });

    this.dispatchRun(schedule, run);
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  private dispatchRun(schedule: Schedule, run: ScheduleRun): void {
    void this.executeRunInBackground(schedule, run).catch((error: unknown) => {
      logger.error(`[${schedule.id}] Background run finalization failed: ${error}`);
    });
  }

  private async executeRunInBackground(schedule: Schedule, run: ScheduleRun): Promise<void> {
    // Host work always uses the original persisted target, never a current UI selection.
    schedule = { ...schedule, hostTarget: run.hostTarget };
    if (!hasScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true)) {
      await this.completeRun(run, 'skipped', null, HOST_SCHEDULE_UNSUPPORTED);
      if (this.activeRuns.get(schedule.id)?.id === run.id) this.releaseRunLocks(schedule.id);
      return;
    }
    const generation = this.lifecycleEpoch;
    const { id: scheduleId, launchConfig } = schedule;

    // Acquire locks
    this.activeRuns.set(scheduleId, run);
    this.cwdLock.set(launchConfig.cwd, scheduleId);

    let retriedInternally = false;
    let finishFinalization: (() => void) | undefined;

    try {
      const outcome = schedule.executionMode || schedule.hostTarget
        ? await this.smartDispatcher?.dispatch(schedule, run.id, () =>
            this.stopped || generation !== this.lifecycleEpoch || this.activeRuns.get(scheduleId)?.id !== run.id
          )
        : {
            kind: 'one_shot' as const,
            result: await this.executor.execute({
              runId: run.id,
              config: launchConfig,
              maxTurns: schedule.maxTurns,
              maxBudgetUsd: schedule.maxBudgetUsd,
            }),
          };
      if (this.stopped || generation !== this.lifecycleEpoch || this.activeRuns.get(scheduleId)?.id !== run.id) return;
      finishFinalization = this.stopBarrier.beginFinalization();
      if (!outcome) throw new Error('Smart schedule dispatcher is unavailable');
      if (outcome.kind === 'skipped' || outcome.kind === 'dispatched') {
        const receiptRun = outcome.kind === 'skipped' && outcome.pendingTaskCommandId
          ? { ...run, pendingTaskCommandId: outcome.pendingTaskCommandId } : run;
        await this.completeRun(receiptRun, outcome.kind, null, outcome.summary, undefined, outcome.taskId);
        if (outcome.kind === 'dispatched') await this.resetConsecutiveFailures(schedule);
      } else {
        const result = outcome.result;
        await this.repository.saveRunLogs(scheduleId, run.id, result.stdout, result.stderr);
        if (result.exitCode === 0) {
          await this.completeRun(run, 'completed', result.exitCode, result.summary);
          await this.resetConsecutiveFailures(schedule);
          logger.info(
            `[${scheduleId}] Run ${run.id} completed successfully (${result.durationMs}ms)`
          );
        } else {
          const errorMsg = result.stderr.slice(0, 500) || `Exit code: ${result.exitCode}`;
          if (schedule.executionMode || schedule.hostTarget) {
            await this.completeRun(run, 'failed', result.exitCode, undefined, errorMsg);
            await this.incrementConsecutiveFailures(schedule);
          } else {
            retriedInternally = await this.handleRunFailure(schedule, run, result.exitCode, errorMsg);
          }
        }
      }
    } catch (err) {
      if ((this.stopped || generation !== this.lifecycleEpoch || this.activeRuns.get(scheduleId)?.id !== run.id) && !finishFinalization) return;
      finishFinalization ??= this.stopBarrier.beginFinalization();
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (schedule.executionMode || schedule.hostTarget) {
        // Never blindly retry a task write or a team launch: ACK may have been lost.
        await this.completeRun(run, 'failed', null, undefined, errorMsg);
        await this.incrementConsecutiveFailures(schedule);
      } else {
        retriedInternally = await this.handleRunFailure(schedule, run, null, errorMsg);
      }
    } finally {
      try {
        if (retriedInternally) return;
        // Release only the locks owned by this run.
        if (this.activeRuns.get(scheduleId)?.id === run.id) this.releaseRunLocks(scheduleId);
        // A cancelled external dispatch cannot write after stop/fixture teardown.
        if (!finishFinalization) return;
        await this.updateScheduleTimestamps(schedule);
        const freshSchedule = await this.repository.getSchedule(scheduleId);
        if (!this.stopped && freshSchedule?.status === 'active') this.scheduleWarmUp(freshSchedule);
      } finally {
        finishFinalization?.();
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

      if (!this.stopped) await this.stopBarrier.waitForRetry(EXECUTION_RETRY_DELAY_MS);

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
      if (this.stopped || freshSchedule?.status !== 'active') {
        await this.completeRun(retryRun, 'failed', exitCode, undefined, error);
        return false;
      }

      // Dispatch retry — caller's finally must not run cleanup
      this.dispatchRun(freshSchedule, retryRun);
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
    error?: string,
    linkedTaskId?: string
  ): Promise<void> {
    await completeScheduleRun(
      this.repository, (event) => this.emitChange(event),
      run, status, exitCode, summary, error, linkedTaskId
    );
  }

  // ===========================================================================
  // Consecutive Failure Tracking
  // ===========================================================================

  private async resetConsecutiveFailures(schedule: Schedule): Promise<void> {
    const fresh = await this.repository.getSchedule(schedule.id);
    if (!fresh || fresh.consecutiveFailures === 0) return;

    const updated: Schedule = {
      ...fresh,
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.saveSchedule(updated);
  }

  private async incrementConsecutiveFailures(schedule: Schedule): Promise<void> {
    const fresh = await this.repository.getSchedule(schedule.id);
    if (!fresh) return;
    const newCount = fresh.consecutiveFailures + 1;
    const shouldAutoPause = newCount >= fresh.maxConsecutiveFailures;

    const updated: Schedule = {
      ...fresh,
      consecutiveFailures: newCount,
      status: shouldAutoPause ? 'paused' : fresh.status,
      updatedAt: new Date().toISOString(),
    };

    if (shouldAutoPause) {
      logger.warn(`[${schedule.id}] Auto-pausing after ${newCount} consecutive failures`);
    }

    await this.repository.saveSchedule(updated);

    if (shouldAutoPause) {
      this.cronJobs.get(schedule.id)?.pause();
      this.clearWarmUpTimer(schedule.id);
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
    const nextRunAt = computeScheduleNextRunAt(fresh);

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
