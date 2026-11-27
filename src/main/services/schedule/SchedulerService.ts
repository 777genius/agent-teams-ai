/**
 * SchedulerService — orchestrates scheduled task execution via croner.
 *
 * Manages cron jobs, warm-up timers, execution lifecycle, and concurrency locks.
 */

import { getSchedulesBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { getValidScheduleNextRuns } from '@shared/utils/scheduleTiming';
import { Cron } from 'croner';

import { buildNewSchedule, buildUpdatedSchedule } from './buildScheduleRecord';
import { completeScheduleRun } from './completeScheduleRun';
import { computeScheduleNextRunAt } from './computeScheduleNextRunAt';
import { createScheduleRun, persistScheduleRun } from './createScheduleRun';
import { recordConsecutiveScheduleFailure } from './recordConsecutiveScheduleFailure';
import { recoverInterruptedScheduleRuns } from './recoverInterruptedScheduleRuns';
import {
  assertScheduledTeamTarget,
  hasScheduledTeamTarget,
  HOST_SCHEDULE_UNSUPPORTED,
} from './scheduledTeamTarget';
import { SchedulerStopBarrier } from './SchedulerStopBarrier';
import { SchedulerWarmUp, type WarmUpFn } from './SchedulerWarmUp';
import {
  admissionRefusal,
  assertScheduleAdmission,
  folderChange,
  type ScheduleAdmissionCheck,
} from './scheduleTarget';
import { updateScheduleTimestamps } from './updateScheduleTimestamps';

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

const EXECUTION_MAX_RETRIES = 2;
const EXECUTION_RETRY_DELAY_MS = 90_000; // 90s between retries

// =============================================================================
// Types
// =============================================================================

type ChangeEmitter = (event: ScheduleChangeEvent) => void;

export type { WarmUpFn } from './SchedulerWarmUp';

// =============================================================================
// SchedulerService
// =============================================================================

export class SchedulerService {
  private readonly warmUp: SchedulerWarmUp;
  private smartDispatcher: ScheduleDispatcher | null;
  private changeEmitter: ChangeEmitter | null = null;

  // Croner jobs keyed by schedule ID
  private cronJobs = new Map<string, Cron>();

  // Active runs keyed by schedule ID (only one run per schedule at a time)
  private activeRuns = new Map<string, ScheduleRun>();

  // CWD exclusion lock: cwd → schedule ID (prevents two schedule runs on same dir)
  private cwdLock = new Map<string, string>();

  // Flag to prevent retry timers from firing after stop()
  private stopped = false;
  private lifecycleEpoch = 0;
  private readonly stopBarrier = new SchedulerStopBarrier();

  constructor(
    private readonly repository: ScheduleRepository,
    private readonly executor: Pick<ScheduledTaskExecutor, 'execute' | 'cancel' | 'cancelAll'>,
    warmUpFn?: WarmUpFn,
    smartDispatcher?: ScheduleDispatcher,
    private readonly allowTeamSchedule: ScheduleAdmissionCheck = async () => true
  ) {
    this.smartDispatcher = smartDispatcher ?? null;
    this.warmUp = new SchedulerWarmUp({
      isStopped: () => this.stopped,
      epoch: () => this.lifecycleEpoch,
      admission: this.stopBarrier,
      warmUp: warmUpFn ?? (async () => ({ ready: true, message: 'warm-up skipped' })),
      cronJobs: this.cronJobs,
    });
  }

  setChangeEmitter(emitter: ChangeEmitter): void {
    this.changeEmitter = emitter;
  }

  // Lifecycle

  async start(): Promise<void> {
    await this.stopBarrier.drainFinalizations();
    logger.info(`Scheduler starting, basePath=${getSchedulesBasePath()}`);

    this.stopped = false;

    // Recovery: mark interrupted runs from previous session
    const { recoveredCount, unavailableScheduleIds } = await recoverInterruptedScheduleRuns(
      this.repository
    );
    if (recoveredCount > 0) {
      logger.info(`Recovered ${recoveredCount} interrupted runs as failed_interrupted`);
    }

    // Load all schedules and create cron jobs for active ones
    const schedules = await this.repository.listSchedules();
    let activeCount = 0;

    for (const schedule of schedules.filter(({ id }) => !unavailableScheduleIds.has(id))) {
      if (
        schedule.status === 'active' &&
        hasScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true)
      ) {
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
    this.warmUp.clearAll();

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

  // CRUD
  async listSchedules(): Promise<Schedule[]> {
    return this.repository.listSchedules();
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    return this.repository.getSchedule(id);
  }

  async getSchedulesByTeam(teamName: string): Promise<Schedule[]> {
    return this.repository.getSchedulesByTeam(teamName);
  }

  async createSchedule(
    input: CreateScheduleInput,
    admission?: ScheduleTargetAdmission
  ): Promise<Schedule> {
    await assertScheduleAdmission(this.allowTeamSchedule, input.teamName, {
      cwd: input.launchConfig.cwd,
    });
    const cronExpression = input.cronExpression.trim();
    const timezone = input.timezone.trim();
    getValidScheduleNextRuns(cronExpression, timezone);
    const selected = { ...input, hostTarget: admission?.target };
    assertScheduledTeamTarget(selected, this.smartDispatcher?.supportsHost === true);
    await this.smartDispatcher?.assertCanSchedule(selected);
    if (input.taskFirst && input.executionMode !== 'agent' && input.executionMode !== 'team') {
      throw new Error('Task-first schedule requires agent or team executionMode');
    }
    const schedule = buildNewSchedule(input, admission, selected, cronExpression, timezone);
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

  async updateSchedule(
    id: string,
    patch: UpdateSchedulePatch,
    admission?: ScheduleTargetAdmission
  ): Promise<Schedule> {
    const existing = await this.repository.getSchedule(id);
    if (!existing) throw new Error(`Schedule not found: ${id}`);
    await assertScheduleAdmission(
      this.allowTeamSchedule,
      existing.teamName,
      folderChange(existing, patch)
    );
    const hostTarget = admission?.target ?? existing.hostTarget;
    assertScheduledTeamTarget(
      { teamName: existing.teamName, hostTarget },
      this.smartDispatcher?.supportsHost === true
    );
    if (patch.reviewedSavedPrompt && !existing.taskFirst)
      throw new Error('Review requires task-first schedule');
    const cronChanged = patch.cronExpression !== undefined || patch.timezone !== undefined;
    const cronExpression = (patch.cronExpression ?? existing.cronExpression).trim();
    const timezone = (patch.timezone ?? existing.timezone).trim();
    if (cronChanged) getValidScheduleNextRuns(cronExpression, timezone);
    const updated = buildUpdatedSchedule(
      existing,
      patch,
      hostTarget,
      cronChanged,
      cronExpression,
      timezone
    );
    await this.smartDispatcher?.assertCanSchedule(updated, folderChange(existing, patch));

    // Reschedule cron job if expression or timezone changed
    const reschedule =
      Boolean(admission) ||
      cronChanged ||
      patch.warmUpMinutes !== undefined ||
      patch.executionMode !== undefined;
    if (reschedule && updated.status === 'active')
      updated.nextRunAt = computeScheduleNextRunAt(updated) ?? undefined;
    const nextJob = reschedule && updated.status === 'active' ? this.prepareCronJob(updated) : null;
    try {
      if (admission && !admission.isCurrent()) throw new Error('Scheduled team context changed');
      await this.repository.saveSchedule(updated, { mustExist: true });
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
    await this.repository.deleteSchedule(id, async () => {
      this.stopBarrier.cancelAdmissions(id);
      const activeRun = this.activeRuns.get(id);
      if (activeRun) this.executor.cancel(activeRun.id);
      this.removeCronJob(id);
      this.releaseRunLocks(id);
      if (activeRun) await this.smartDispatcher?.cancel?.(activeRun.id);
    });
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
    await this.repository.saveSchedule(updated, { mustExist: true });
    this.cronJobs.get(id)?.pause();
    this.warmUp.clear(id);
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

    await assertScheduleAdmission(this.allowTeamSchedule, existing.teamName);
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
      await this.repository.saveSchedule(updated, { mustExist: true });
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

  // Run History

  async getRuns(
    scheduleId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<ScheduleRun[]> {
    return this.repository.listRuns(scheduleId, opts);
  }

  async getRunLogs(scheduleId: string, runId: string): Promise<{ stdout: string; stderr: string }> {
    return this.repository.getRunLogs(scheduleId, runId);
  }

  // Trigger Now
  async triggerNow(id: string): Promise<ScheduleRun> {
    if (this.stopped) throw new Error('Scheduler is stopped');
    const generation = this.lifecycleEpoch;
    return this.stopBarrier.withAdmission(id, async (isCurrent) => {
      const schedule = await this.repository.getSchedule(id);
      if (!schedule) throw new Error(`Schedule not found: ${id}`);
      await assertScheduleAdmission(this.allowTeamSchedule, schedule.teamName);
      assertScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true);
      const conflict = this.lockConflict(schedule);
      if (conflict) throw new Error(conflict);
      const run = await this.startOccurrence(schedule, generation, isCurrent);
      if (!run)
        throw new Error(
          isCurrent() ? 'Scheduler stopped before dispatch' : 'Schedule deleted before dispatch'
        );
      return run;
    });
  }

  // claudeRootPath Change

  async reloadForClaudeRootChange(): Promise<void> {
    logger.info('Reloading schedules for claudeRootPath change');
    await this.stop();
    await this.start();
  }

  // Cron Job Management

  /** Prepare the replacement without touching the currently active cron timer. */
  private prepareCronJob(schedule: Schedule): Cron {
    return new Cron(
      schedule.cronExpression,
      { timezone: schedule.timezone, paused: true },
      () => void this.onCronTick(schedule.id)
    );
  }

  private activateCronJob(schedule: Schedule, job: Cron): void {
    this.removeCronJob(schedule.id);
    this.cronJobs.set(schedule.id, job);
    job.resume();
    this.warmUp.schedule(schedule);
    logger.info(
      `Cron job created for schedule ${schedule.id}: "${schedule.cronExpression}" ` +
        `(timezone: ${schedule.timezone}, next: ${job.nextRun()?.toISOString() ?? 'never'})`
    );
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
    this.warmUp.clear(scheduleId);
  }

  // Warm-Up Timer

  // Cron Tick → Execution

  private async onCronTick(scheduleId: string): Promise<void> {
    const generation = this.lifecycleEpoch;
    await this.stopBarrier.withAdmission(scheduleId, async (isCurrent) => {
      const schedule = await this.repository.getSchedule(scheduleId);
      if (
        schedule?.status !== 'active' ||
        !hasScheduledTeamTarget(schedule, this.smartDispatcher?.supportsHost === true)
      ) {
        logger.debug(`Cron tick for ${scheduleId} skipped (not active or unsupported owner)`);
        return;
      }
      const conflict = this.lockConflict(schedule);
      if (conflict) {
        logger.warn(`[${scheduleId}] Cron tick skipped: ${conflict}`);
        return;
      }
      await this.startOccurrence(schedule, generation, isCurrent);
    });
  }

  private lockConflict(schedule: Schedule): string | undefined {
    if (this.activeRuns.has(schedule.id))
      return `Schedule ${schedule.id} already has an active run`;
    const cwd = schedule.launchConfig.cwd;
    const holder = this.cwdLock.get(cwd);
    if (holder && holder !== schedule.id)
      return `Working directory "${cwd}" is locked by another schedule: ${holder}`;
    return undefined;
  }

  // Execution

  /** Publish only in the original lifecycle; delayed reads cannot acquire locks after Stop. */
  private async startOccurrence(
    schedule: Schedule,
    generation: number,
    isCurrent: () => boolean
  ): Promise<ScheduleRun | null> {
    if (!isCurrent() || this.stopped || generation !== this.lifecycleEpoch) return null;
    const run = createScheduleRun(schedule);
    this.activeRuns.set(schedule.id, run);
    this.cwdLock.set(schedule.launchConfig.cwd, schedule.id);
    try {
      await persistScheduleRun(this.repository, this.stopBarrier, run);
      if (
        !isCurrent() ||
        this.stopped ||
        generation !== this.lifecycleEpoch ||
        this.activeRuns.get(schedule.id)?.id !== run.id
      ) {
        if (this.activeRuns.get(schedule.id)?.id === run.id) this.releaseRunLocks(schedule.id);
        return null;
      }
    } catch (error) {
      if (this.activeRuns.get(schedule.id)?.id === run.id) this.releaseRunLocks(schedule.id);
      throw error;
    }
    this.emitChange({ type: 'run-started', scheduleId: schedule.id, teamName: schedule.teamName });
    this.dispatchRun(schedule, run);
    return run;
  }

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
      const refusal = admissionRefusal(await this.allowTeamSchedule(schedule.teamName));
      const outcome = refusal
        ? { kind: 'skipped' as const, summary: refusal }
        : schedule.executionMode || schedule.hostTarget
          ? await this.smartDispatcher?.dispatch(
              schedule,
              run.id,
              () =>
                this.stopped ||
                generation !== this.lifecycleEpoch ||
                this.activeRuns.get(scheduleId)?.id !== run.id
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
      if (
        this.stopped ||
        generation !== this.lifecycleEpoch ||
        this.activeRuns.get(scheduleId)?.id !== run.id
      )
        return;
      finishFinalization = this.stopBarrier.beginFinalization();
      if (!outcome) throw new Error('Smart schedule dispatcher is unavailable');
      if (outcome.kind === 'skipped' || outcome.kind === 'dispatched') {
        const receiptRun =
          outcome.kind === 'skipped' && outcome.pendingTaskCommandId
            ? { ...run, pendingTaskCommandId: outcome.pendingTaskCommandId }
            : run;
        await this.completeRun(receiptRun, outcome.kind, null, outcome.summary, undefined, outcome);
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
            retriedInternally = await this.handleRunFailure(
              schedule,
              run,
              result.exitCode,
              errorMsg
            );
          }
        }
      }
    } catch (err) {
      if (
        (this.stopped ||
          generation !== this.lifecycleEpoch ||
          this.activeRuns.get(scheduleId)?.id !== run.id) &&
        !finishFinalization
      )
        return;
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
        await updateScheduleTimestamps(this.repository, schedule, (event) =>
          this.emitChange(event)
        );
        await this.stopBarrier.withAdmission(scheduleId, async (isCurrent) => {
          const freshSchedule = await this.repository.getSchedule(scheduleId);
          if (
            isCurrent() &&
            !this.stopped &&
            generation === this.lifecycleEpoch &&
            freshSchedule?.status === 'active'
          ) {
            this.warmUp.schedule(freshSchedule);
          }
        });
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
    const generation = this.lifecycleEpoch;
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

      return this.stopBarrier.withAdmission(schedule.id, async (isCurrent) => {
        const freshSchedule = await this.repository.getSchedule(schedule.id);
        if (
          !isCurrent() ||
          this.stopped ||
          generation !== this.lifecycleEpoch ||
          freshSchedule?.status !== 'active' ||
          this.lockConflict(freshSchedule)
        ) {
          await this.completeRun(retryRun, 'failed', exitCode, undefined, error);
          return false;
        }
        // Dispatch retry — caller's finally must not run cleanup.
        this.dispatchRun(freshSchedule, retryRun);
        return true;
      });
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
    link?: { taskId?: string; executionTeamName?: string }
  ): Promise<void> {
    await completeScheduleRun(
      this.repository,
      (event) => this.emitChange(event),
      run,
      status,
      exitCode,
      summary,
      error,
      link
    );
  }

  // Consecutive Failure Tracking

  private async resetConsecutiveFailures(schedule: Schedule): Promise<void> {
    await this.repository.updateSchedule(schedule.id, (fresh) =>
      fresh.consecutiveFailures === 0
        ? null
        : {
            ...fresh,
            consecutiveFailures: 0,
            updatedAt: new Date().toISOString(),
          }
    );
  }

  private async incrementConsecutiveFailures(schedule: Schedule): Promise<void> {
    const { updated, shouldAutoPause } = await recordConsecutiveScheduleFailure(
      this.repository,
      schedule.id
    );

    if (updated && shouldAutoPause) {
      this.cronJobs.get(schedule.id)?.pause();
      this.warmUp.clear(schedule.id);
      this.emitChange({
        type: 'schedule-paused',
        scheduleId: schedule.id,
        teamName: schedule.teamName,
        detail: `auto-paused after ${updated.consecutiveFailures} consecutive failures`,
      });
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
