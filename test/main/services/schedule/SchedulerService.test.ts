/**
 * SchedulerService tests — covers cron job lifecycle, warm-up, execution flow,
 * concurrency locks, auto-pause on consecutive failures, and recovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';

import type { Schedule, ScheduleChangeEvent, ScheduleRun } from '@shared/types';
import type { ScheduleRepository } from '../../../../src/main/services/schedule/ScheduleRepository';
import type { ExecutionRequest, ScheduledTaskResult } from '../../../../src/main/services/schedule/ScheduledTaskExecutor';
import type { WarmUpFn } from '../../../../src/main/services/schedule/SchedulerService';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('croner', () => {
  const jobs = new Map<string, { callback: () => void; paused: boolean; stopped: boolean }>();

  class MockCron {
    private id: string;
    private callback: () => void;
    private _paused: boolean;
    private _stopped = false;
    private _expression: string;
    private _timezone: string;

    constructor(
      expression: string,
      optsOrCallback: Record<string, unknown> | (() => void),
      maybeCallback?: () => void
    ) {
      this.id = randomUUID();
      this._expression = expression;

      if (typeof optsOrCallback === 'function') {
        this.callback = optsOrCallback;
        this._paused = false;
        this._timezone = 'UTC';
      } else {
        this.callback = maybeCallback!;
        this._paused = !!optsOrCallback.paused;
        this._timezone = (optsOrCallback.timezone as string) ?? 'UTC';
      }

      jobs.set(this.id, { callback: this.callback, paused: this._paused, stopped: this._stopped });
    }

    nextRun(): Date | null {
      if (this._stopped) return null;
      return new Date(Date.now() + 3600_000); // 1 hour from now
    }

    nextRuns(count: number): Date[] {
      if (this._stopped) return [];
      return Array.from({ length: count }, (_, i) =>
        new Date(Date.now() + (i + 1) * 3600_000)
      );
    }

    msToNext(): number | null {
      if (this._stopped || this._paused) return null;
      return 3600_000; // 1 hour
    }

    pause(): void {
      this._paused = true;
    }

    resume(): void {
      this._paused = false;
    }

    stop(): void {
      this._stopped = true;
      jobs.delete(this.id);
    }

    /** Test helper: simulate a cron tick */
    _trigger(): void {
      if (!this._stopped && !this._paused) {
        this.callback();
      }
    }
  }

  return { Cron: MockCron };
});

vi.mock('@main/utils/pathDecoder', () => ({
  getSchedulesBasePath: () => '/tmp/test-schedules',
}));

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockRepository(): ScheduleRepository {
  const schedules = new Map<string, Schedule>();
  const runs = new Map<string, ScheduleRun[]>();

  return {
    listSchedules: vi.fn(async () => [...schedules.values()]),
    getSchedule: vi.fn(async (id: string) => schedules.get(id) ?? null),
    getSchedulesByTeam: vi.fn(async (teamName: string) =>
      [...schedules.values()].filter((s) => s.teamName === teamName)
    ),
    saveSchedule: vi.fn(async (schedule: Schedule) => {
      schedules.set(schedule.id, schedule);
    }),
    deleteSchedule: vi.fn(async (id: string) => {
      schedules.delete(id);
      runs.delete(id);
    }),
    listRuns: vi.fn(async (scheduleId: string) => runs.get(scheduleId) ?? []),
    getLatestRun: vi.fn(async (scheduleId: string) => {
      const r = runs.get(scheduleId);
      return r?.[0] ?? null;
    }),
    saveRun: vi.fn(async (run: ScheduleRun) => {
      const existing = runs.get(run.scheduleId) ?? [];
      const index = existing.findIndex((r) => r.id === run.id);
      if (index >= 0) {
        existing[index] = run;
      } else {
        existing.unshift(run);
      }
      runs.set(run.scheduleId, existing);
    }),
    pruneOldRuns: vi.fn(async () => 0),
    saveRunLogs: vi.fn(async () => undefined),
    getRunLogs: vi.fn(async () => ({ stdout: '', stderr: '' })),
  };
}

function createMockExecutor() {
  const executeFn = vi.fn<(req: ExecutionRequest) => Promise<ScheduledTaskResult>>();
  executeFn.mockResolvedValue({
    exitCode: 0,
    stdout: 'Task completed successfully',
    stderr: '',
    summary: 'Task completed successfully',
    durationMs: 1234,
  });

  return {
    execute: executeFn,
    cancel: vi.fn(() => true),
    cancelAll: vi.fn(),
    get activeCount() {
      return 0;
    },
  };
}

function makeSchedule(overrides?: Partial<Schedule>): Schedule {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    teamName: 'test-team',
    label: 'Test Schedule',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    status: 'active',
    warmUpMinutes: 15,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    maxTurns: 50,
    createdAt: now,
    updatedAt: now,
    launchConfig: {
      cwd: '/tmp/test-project',
      prompt: 'Run tests and report results',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchedulerService', () => {
  let repo: ScheduleRepository;
  let executor: ReturnType<typeof createMockExecutor>;
  let warmUpFn: ReturnType<typeof vi.fn<WarmUpFn>>;
  let events: ScheduleChangeEvent[];

  // Dynamic import to apply mocks
  let SchedulerService: typeof import('../../../../src/main/services/schedule/SchedulerService').SchedulerService;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    repo = createMockRepository();
    executor = createMockExecutor();
    warmUpFn = vi.fn<WarmUpFn>().mockResolvedValue({ ready: true, message: 'ready' });
    events = [];

    const mod = await import('../../../../src/main/services/schedule/SchedulerService');
    SchedulerService = mod.SchedulerService;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createService() {
    const service = new SchedulerService(repo, executor as any, warmUpFn);
    service.setChangeEmitter((event) => events.push(event));
    return service;
  }

  // --- Lifecycle ---

  it('start() loads schedules and creates cron jobs for active ones', async () => {
    const active = makeSchedule({ status: 'active' });
    const paused = makeSchedule({ status: 'paused' });
    (repo.saveSchedule as any)(active);
    (repo.saveSchedule as any)(paused);

    const service = createService();
    await service.start();

    // listSchedules should be called
    expect(repo.listSchedules).toHaveBeenCalled();

    await service.stop();
  });

  it('stop() cancels all active executions and clears state', async () => {
    const service = createService();
    await service.start();
    await service.stop();

    expect(executor.cancelAll).toHaveBeenCalled();
  });

  // --- CRUD ---

  it('createSchedule() saves and emits change event', async () => {
    const service = createService();

    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    expect(schedule.id).toBeTruthy();
    expect(schedule.teamName).toBe('my-team');
    expect(schedule.status).toBe('active');
    expect(schedule.warmUpMinutes).toBe(15);
    expect(schedule.maxTurns).toBe(50);
    expect(schedule.nextRunAt).toBeTruthy();
    expect(repo.saveSchedule).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('schedule-updated');

    await service.stop();
  });

  it('updateSchedule() persists changes and emits event', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    const updated = await service.updateSchedule(schedule.id, {
      label: 'New Label',
      maxTurns: 100,
    });

    expect(updated.label).toBe('New Label');
    expect(updated.maxTurns).toBe(100);
    expect(events.length).toBeGreaterThanOrEqual(2);

    await service.stop();
  });

  it('deleteSchedule() removes schedule and emits event', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.deleteSchedule(schedule.id);

    expect(repo.deleteSchedule).toHaveBeenCalledWith(schedule.id);
    // executor.cancel not called when no active run exists for this schedule
    expect(executor.cancel).not.toHaveBeenCalled();
    const deleteEvent = events.find((e) => e.detail === 'deleted');
    expect(deleteEvent).toBeTruthy();

    await service.stop();
  });

  it('pauseSchedule() sets status to paused', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.pauseSchedule(schedule.id);

    const saved = await service.getSchedule(schedule.id);
    expect(saved?.status).toBe('paused');
    const pauseEvent = events.find((e) => e.type === 'schedule-paused');
    expect(pauseEvent).toBeTruthy();

    await service.stop();
  });

  it('resumeSchedule() resets failures and sets status to active', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.pauseSchedule(schedule.id);
    await service.resumeSchedule(schedule.id);

    const saved = await service.getSchedule(schedule.id);
    expect(saved?.status).toBe('active');
    expect(saved?.consecutiveFailures).toBe(0);

    await service.stop();
  });

  // --- Trigger Now ---

  it('triggerNow() creates a run and starts execution', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    const run = await service.triggerNow(schedule.id);

    expect(run.status).toBe('running');
    expect(run.scheduleId).toBe(schedule.id);
    expect(repo.saveRun).toHaveBeenCalled();

    // Let the background execution complete
    await vi.advanceTimersByTimeAsync(100);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.id,
        config: schedule.launchConfig,
        maxTurns: 50,
      })
    );

    await service.stop();
  });

  it('triggerNow() rejects if run already active for same schedule', async () => {
    executor.execute.mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.triggerNow(schedule.id);
    await vi.advanceTimersByTimeAsync(50);

    await expect(service.triggerNow(schedule.id)).rejects.toThrow('already has an active run');

    await service.stop();
  });

  it('triggerNow() rejects if cwd is locked by another schedule', async () => {
    executor.execute.mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    const service = createService();
    const schedule1 = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/shared-project', prompt: 'job 1' },
    });
    const schedule2 = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 10 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/shared-project', prompt: 'job 2' },
    });

    await service.triggerNow(schedule1.id);
    await vi.advanceTimersByTimeAsync(50);

    await expect(service.triggerNow(schedule2.id)).rejects.toThrow('locked by another schedule');

    await service.stop();
  });

  // --- Execution result ---

  it('successful execution emits run-completed and resets failures', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.triggerNow(schedule.id);
    await vi.advanceTimersByTimeAsync(500);

    const completedEvent = events.find((e) => e.type === 'run-completed');
    expect(completedEvent).toBeTruthy();

    await service.stop();
  });

  it('failed execution increments consecutive failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    executor.execute.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Something went wrong',
      summary: '',
      durationMs: 500,
    });

    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.triggerNow(schedule.id);

    // Advance through retries (each retry has EXECUTION_RETRY_DELAY_MS = 90s)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100_000);
    }

    // Should have retry attempts
    expect(executor.execute).toHaveBeenCalledTimes(3); // initial + 2 retries

    const failEvent = events.find((e) => e.type === 'run-failed');
    expect(failEvent).toBeTruthy();

    warnSpy.mockRestore();
    await service.stop();
  });

  // --- Recovery ---

  it('start() marks interrupted runs as failed_interrupted', async () => {
    // Seed a "running" run before start
    const schedule = makeSchedule();
    await repo.saveSchedule(schedule);
    await repo.saveRun({
      id: randomUUID(),
      scheduleId: schedule.id,
      teamName: schedule.teamName,
      status: 'running',
      scheduledFor: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      retryCount: 0,
    });

    const service = createService();
    await service.start();

    // Check that the run was marked as failed_interrupted
    const runs = await repo.listRuns(schedule.id);
    expect(runs[0].status).toBe('failed_interrupted');
    expect(runs[0].error).toBe('Interrupted by app restart');

    await service.stop();
  });

  // --- reloadForClaudeRootChange ---

  it('reloadForClaudeRootChange() stops and restarts', async () => {
    const service = createService();
    await service.start();
    await service.reloadForClaudeRootChange();

    // cancelAll called at least once during stop
    expect(executor.cancelAll).toHaveBeenCalled();

    await service.stop();
  });

  // --- Warm-Up ---

  it('warm-up is triggered before scheduled run', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      warmUpMinutes: 15,
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    // Mock Cron returns msToNext() = 3600000 (1 hour)
    // warmUpMinutes = 15 → warmUpDelayMs = 3600000 - 900000 = 2700000 (45 min)
    expect(warmUpFn).not.toHaveBeenCalled();

    // Advance to just before warm-up should fire (45 min - 1s)
    await vi.advanceTimersByTimeAsync(2_699_000);
    expect(warmUpFn).not.toHaveBeenCalled();

    // Advance 1 more second — warm-up fires
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warmUpFn).toHaveBeenCalledWith(schedule.launchConfig.cwd);

    await service.stop();
  });

  it('warm-up retries on failure up to 3 times', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warmUpFn
      .mockResolvedValueOnce({ ready: false, message: 'not ready' })
      .mockResolvedValueOnce({ ready: false, message: 'still not ready' })
      .mockResolvedValueOnce({ ready: true, message: 'ready' });

    const service = createService();
    await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      warmUpMinutes: 15,
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    // Fire warm-up timer
    await vi.advanceTimersByTimeAsync(2_700_000);
    expect(warmUpFn).toHaveBeenCalledTimes(1);

    // First retry after 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warmUpFn).toHaveBeenCalledTimes(2);

    // Second retry after another 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warmUpFn).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
    await service.stop();
  });

  it('warm-up is skipped when warmUpMinutes <= 0', async () => {
    const service = createService();
    await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      warmUpMinutes: 0,
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    // Even after a long time, warm-up never fires
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(warmUpFn).not.toHaveBeenCalled();

    await service.stop();
  });

  // --- Auto-Pause on Consecutive Failures ---

  it('auto-pauses schedule after maxConsecutiveFailures via retries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Executor always returns failure (non-zero exit code)
    executor.execute.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'persistent failure',
      summary: '',
      durationMs: 100,
    });

    // Start with consecutiveFailures = 2, threshold = 3
    // After the retry chain exhausts (initial + 2 retries), incrementConsecutiveFailures
    // bumps to 3 → auto-pause.
    const schedule = makeSchedule({
      consecutiveFailures: 2,
      maxConsecutiveFailures: 3,
    });
    await repo.saveSchedule(schedule);

    const service = createService();
    await service.triggerNow(schedule.id);

    // Advance past all retry delays (2 × 90s = 180s)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100_000);
    }

    // Verify all 3 attempts executed
    expect(executor.execute).toHaveBeenCalledTimes(3);

    const saved = await repo.getSchedule(schedule.id);
    expect(saved?.status).toBe('paused');
    expect(saved?.consecutiveFailures).toBeGreaterThanOrEqual(3);

    // Verify auto-pause event was emitted
    const pauseEvent = events.find(
      (e) => e.type === 'schedule-paused' && e.detail?.includes('auto-paused')
    );
    expect(pauseEvent).toBeTruthy();

    warnSpy.mockRestore();
    await service.stop();
  });

  // --- Delete While Running ---

  it('deleteSchedule() cancels active run by runId', async () => {
    executor.execute.mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    const run = await service.triggerNow(schedule.id);
    await vi.advanceTimersByTimeAsync(50);

    // Delete while run is active
    await service.deleteSchedule(schedule.id);

    // executor.cancel called with the run's ID (not schedule ID)
    expect(executor.cancel).toHaveBeenCalledWith(run.id);

    await service.stop();
  });

  // --- Stop During Retry ---

  it('stop() during retry delay prevents retry from executing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    executor.execute.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'fail',
      summary: '',
      durationMs: 100,
    });

    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.triggerNow(schedule.id);

    // Let the first execution complete and enter retry delay
    await vi.advanceTimersByTimeAsync(1_000);
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Stop service while retry timer is pending (90s delay)
    await service.stop();

    // Advance past the retry delay — retry should NOT fire
    await vi.advanceTimersByTimeAsync(100_000);
    expect(executor.execute).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  // --- Lock Ownership Check ---

  it('finally block does not release locks owned by a different run', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let callCount = 0;
    executor.execute.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          exitCode: 1, stdout: '', stderr: 'fail first',
          summary: '', durationMs: 100,
        };
      }
      // Second call (retry) takes a while
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          exitCode: 0, stdout: 'ok', stderr: '',
          summary: 'ok', durationMs: 200,
        }), 500);
      });
    });

    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    await service.triggerNow(schedule.id);

    // Advance through first failure + retry delay + retry execution
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100_000);
    }

    // Service should complete without errors (no lock race crash)
    expect(executor.execute).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
    await service.stop();
  });

  // --- Cron Update Reschedule ---

  it('updateSchedule() recreates cron job when expression changes', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    const updated = await service.updateSchedule(schedule.id, {
      cronExpression: '0 18 * * *',
    });

    // nextRunAt should be recomputed
    expect(updated.nextRunAt).toBeTruthy();
    expect(updated.cronExpression).toBe('0 18 * * *');

    await service.stop();
  });

  it('updateSchedule() recreates cron job when timezone changes', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    const updated = await service.updateSchedule(schedule.id, {
      timezone: 'America/New_York',
    });

    expect(updated.timezone).toBe('America/New_York');
    expect(updated.nextRunAt).toBeTruthy();

    await service.stop();
  });

  // --- Timestamp Updates ---

  it('successful run updates lastRunAt and nextRunAt on schedule', async () => {
    const service = createService();
    const schedule = await service.createSchedule({
      teamName: 'my-team',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      launchConfig: { cwd: '/tmp/project', prompt: 'do stuff' },
    });

    // Before trigger, no lastRunAt
    expect(schedule.lastRunAt).toBeUndefined();

    await service.triggerNow(schedule.id);
    await vi.advanceTimersByTimeAsync(500);

    const saved = await service.getSchedule(schedule.id);
    expect(saved?.lastRunAt).toBeTruthy();
    expect(saved?.nextRunAt).toBeTruthy();

    await service.stop();
  });
});
