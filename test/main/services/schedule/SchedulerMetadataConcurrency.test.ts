import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { SchedulerService } from '@main/services/schedule/SchedulerService';
import { updateScheduleTimestamps } from '@main/services/schedule/updateScheduleTimestamps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleMutationQueue } from '@main/services/schedule/ScheduleMutationQueue';
import type { Schedule, ScheduleRun } from '@shared/types';
import type { Cron } from 'croner';

const paths = vi.hoisted(() => ({ directory: '' }));
vi.mock('@main/utils/pathDecoder', () => ({ getSchedulesBasePath: () => paths.directory }));

interface BackgroundMetadata {
  resetConsecutiveFailures(schedule: Schedule): Promise<void>;
  incrementConsecutiveFailures(schedule: Schedule): Promise<void>;
}

interface MetadataQueue {
  writeMetadata(action: (filePath: string) => Promise<unknown>): Promise<unknown>;
  writeSchedulesFile(filePath: string, schedules: Schedule[]): Promise<void>;
}

interface AtomicScheduleUpdate {
  updateSchedule(
    id: string,
    update: (current: Schedule) => Schedule | null
  ): Promise<Schedule | null>;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

/** Start competing writers before releasing admission; serialized service actions may wait. */
async function beforeMetadataAdmission<T>(
  repository: JsonScheduleRepository,
  operation: () => Promise<T>,
  interleave: () => Promise<void>,
  awaitCompetingBeforeRelease = true,
  scheduleQueue?: ScheduleMutationQueue
): Promise<T> {
  const metadata = repository as unknown as MetadataQueue;
  const write = metadata.writeMetadata.bind(repository);
  const entered = signal(),
    release = signal();
  const run = scheduleQueue?.run.bind(scheduleQueue);
  const held =
    scheduleQueue && run
      ? vi
          .spyOn(scheduleQueue, 'run')
          .mockImplementationOnce(async <U>(id: string, action: () => Promise<U>) => {
            entered.resolve();
            await release.promise;
            return run(id, action);
          })
      : vi.spyOn(metadata, 'writeMetadata').mockImplementationOnce(async (action) => {
          entered.resolve();
          await release.promise;
          return write(action);
        });
  const pending = operation();
  try {
    // A changed path that returns or rejects before admission fails immediately;
    // neither snapshot relies on a timer or a polling deadline to reach the cut.
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Background mutation returned before metadata admission');
      }),
    ]);
    const competing = interleave();
    if (awaitCompetingBeforeRelease) await competing;
    release.resolve();
    await competing;
    return await pending;
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    held.mockRestore();
  }
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'TEST-metadata-race',
    teamName: 'TEST-team',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    status: 'active',
    warmUpMinutes: 0,
    maxConsecutiveFailures: 10,
    consecutiveFailures: 2,
    maxTurns: 50,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    launchConfig: { cwd: paths.directory, prompt: 'TEST original prompt', model: 'TEST-original' },
    ...overrides,
  };
}

type UserChange = 'create' | 'edit' | 'pause' | 'resume' | 'delete';

function changeSchedule(scheduler: SchedulerService, original: Schedule, action: UserChange) {
  if (action === 'create') return scheduler.createSchedule(original);
  if (action === 'edit')
    return scheduler.updateSchedule(original.id, { cronExpression: '0 18 * * 2' });
  if (action === 'pause') return scheduler.pauseSchedule(original.id);
  if (action === 'delete') return scheduler.deleteSchedule(original.id);
  return scheduler.resumeSchedule(original.id);
}

const backgroundCases = [
  { method: 'updateScheduleTimestamps', failures: 2 },
  { method: 'resetConsecutiveFailures', failures: 0 },
  { method: 'incrementConsecutiveFailures', failures: 3 },
] as const;

const backgroundAdmissions = [
  ...backgroundCases.map((testCase) => ({ ...testCase, beforeQueue: false })),
  ...backgroundCases
    .filter(({ method }) => method !== 'updateScheduleTimestamps')
    .map((testCase) => ({ ...testCase, beforeQueue: true })),
];

describe('scheduler metadata concurrency', () => {
  let repository: JsonScheduleRepository;
  let scheduler: SchedulerService;
  const execute = vi.fn(async () => {
    throw new Error('TEST must not execute a scheduled task');
  });

  beforeEach(async () => {
    paths.directory = await mkdtemp(join(tmpdir(), 'scheduler-metadata-concurrency-'));
    repository = new JsonScheduleRepository();
    scheduler = new SchedulerService(repository, { execute, cancel: () => false, cancelAll() {} });
    execute.mockClear();
  });

  afterEach(async () => {
    try {
      await scheduler?.stop();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (paths.directory) await rm(paths.directory, { recursive: true, force: true });
      paths.directory = '';
    }
  });

  it('keeps a pause and the failure increment queued while its original read is pending', async () => {
    const original = schedule({ consecutiveFailures: 0 });
    await repository.saveSchedule(original);
    const read = repository.getSchedule.bind(repository);
    const entered = signal(),
      release = signal();
    vi.spyOn(repository, 'getSchedule').mockImplementationOnce(async (id) => {
      const captured = await read(id);
      entered.resolve();
      await release.promise;
      return captured;
    });
    const pausing = scheduler.pauseSchedule(original.id);
    await entered.promise;
    const finishing = (scheduler as unknown as BackgroundMetadata).incrementConsecutiveFailures(
      original
    );
    release.resolve();
    await Promise.all([pausing, finishing]);
    expect(await new JsonScheduleRepository().getSchedule(original.id)).toMatchObject({
      status: 'paused',
      consecutiveFailures: 1,
    });
  });

  it.each(['create', 'edit', 'resume'] as const)(
    'does not activate a late %s after scheduler stop',
    async (action) => {
      const original = schedule({ status: action === 'resume' ? 'paused' : 'active' });
      await repository.saveSchedule(original);
      const save = repository.saveSchedule.bind(repository);
      const entered = signal(),
        release = signal();
      vi.spyOn(repository, 'saveSchedule').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await save(...args);
      });
      const pending = changeSchedule(scheduler, original, action);
      try {
        await entered.promise;
        await scheduler.stop();
      } finally {
        release.resolve();
        await pending;
      }
      expect((scheduler as unknown as { cronJobs: Map<string, unknown> }).cronJobs.size).toBe(0);
      expect(execute).not.toHaveBeenCalled();
      expect(await repository.listRuns(original.id)).toEqual([]);
    }
  );

  it.each(['create', 'edit', 'pause', 'resume', 'delete'] as const)(
    'keeps the new profile cron when an old %s finishes after restart',
    async (action) => {
      const originalPath = paths.directory;
      const nextPath = await mkdtemp(join(tmpdir(), 'TEST-scheduler-next-profile-'));
      const original = schedule({ status: action === 'resume' ? 'paused' : 'active' });
      const next = schedule({ label: 'TEST next profile', cronExpression: '0 17 * * 3' });
      await repository.saveSchedule(original);
      paths.directory = nextPath;
      await repository.saveSchedule(next);
      paths.directory = originalPath;
      const metadata = repository as unknown as MetadataQueue;
      const write = metadata.writeSchedulesFile.bind(repository);
      const entered = signal(),
        release = signal();
      vi.spyOn(metadata, 'writeSchedulesFile').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await write(...args);
      });
      const pending = changeSchedule(scheduler, original, action);
      try {
        await entered.promise;
        await scheduler.stop();
        paths.directory = nextPath;
        await scheduler.start();
        const jobs = (scheduler as unknown as { cronJobs: Map<string, Cron> }).cronJobs;
        const currentJob = jobs.get(next.id);
        expect(currentJob).toBeDefined();
        release.resolve();
        await pending;
        expect(await repository.getSchedule(next.id)).toEqual(next);
        expect(jobs.get(next.id)).toBe(currentJob);
        expect(jobs.size).toBe(1);
        expect(currentJob?.isRunning()).toBe(true);
      } finally {
        release.resolve();
        await pending;
        await scheduler.stop();
        paths.directory = originalPath;
        await rm(nextPath, { recursive: true, force: true });
      }
    }
  );

  it.each(['edit', 'pause', 'resume'] as const)(
    'rejects a queued %s before reading the new profile after restart',
    async (action) => {
      const originalPath = paths.directory;
      const nextPath = await mkdtemp(join(tmpdir(), 'TEST-scheduler-next-profile-'));
      const original = schedule();
      const next = schedule({ label: 'TEST next profile', cronExpression: '0 17 * * 3' });
      await repository.saveSchedule(original);
      paths.directory = nextPath;
      await repository.saveSchedule(next);
      paths.directory = originalPath;
      const metadata = repository as unknown as MetadataQueue;
      const write = metadata.writeSchedulesFile.bind(repository);
      const entered = signal(),
        release = signal();
      vi.spyOn(metadata, 'writeSchedulesFile').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await write(...args);
      });
      const first = scheduler.updateSchedule(original.id, { label: 'TEST prior edit' });
      await entered.promise;
      const queued = changeSchedule(scheduler, original, action).then(
        () => 'completed',
        (error: unknown) => String(error)
      );
      try {
        await scheduler.stop();
        paths.directory = nextPath;
        await scheduler.start();
        const read = vi.spyOn(repository, 'getSchedule');
        release.resolve();
        await first;
        expect(await queued).toBe('Error: Scheduler context changed');
        expect(read).not.toHaveBeenCalled();
        expect(await repository.getSchedule(next.id)).toEqual(next);
      } finally {
        release.resolve();
        await Promise.allSettled([first, queued]);
        await scheduler.stop();
        paths.directory = originalPath;
        await rm(nextPath, { recursive: true, force: true });
      }
    }
  );

  it.each(['edit', 'pause', 'resume', 'delete'] as const)(
    'rejects a stale %s read before writing into the new profile after restart',
    async (action) => {
      const originalPath = paths.directory;
      const nextPath = await mkdtemp(join(tmpdir(), 'TEST-scheduler-next-profile-'));
      const original = schedule();
      const next = schedule({ label: 'TEST next profile', cronExpression: '0 17 * * 3' });
      await repository.saveSchedule(original);
      paths.directory = nextPath;
      await repository.saveSchedule(next);
      paths.directory = originalPath;
      const read = repository.getSchedule.bind(repository);
      const entered = signal(),
        release = signal();
      vi.spyOn(repository, 'getSchedule').mockImplementationOnce(async (id) => {
        const captured = await read(id);
        entered.resolve();
        await release.promise;
        return captured;
      });
      const pending = changeSchedule(scheduler, original, action).then(
        () => 'completed',
        (error: unknown) => String(error)
      );
      try {
        await entered.promise;
        await scheduler.stop();
        paths.directory = nextPath;
        await scheduler.start();
        release.resolve();
        expect(await pending).toBe('Error: Scheduler context changed');
        expect(await repository.getSchedule(next.id)).toEqual(next);
      } finally {
        release.resolve();
        await pending;
        await scheduler.stop();
        paths.directory = originalPath;
        await rm(nextPath, { recursive: true, force: true });
      }
    }
  );

  it.each(['create', 'edit', 'resume'] as const)(
    'rejects a stale %s admission before writing into the new profile after restart',
    async (action) => {
      const originalPath = paths.directory;
      const nextPath = await mkdtemp(join(tmpdir(), 'TEST-scheduler-next-profile-'));
      const original = schedule();
      const next = schedule({ label: 'TEST next profile', cronExpression: '0 17 * * 3' });
      await repository.saveSchedule(original);
      paths.directory = nextPath;
      await repository.saveSchedule(next);
      paths.directory = originalPath;
      const entered = signal(),
        release = signal();
      scheduler = new SchedulerService(
        repository,
        { execute, cancel: () => false, cancelAll() {} },
        undefined,
        undefined,
        async () => {
          entered.resolve();
          await release.promise;
          return true;
        }
      );
      const pending = changeSchedule(scheduler, original, action).then(
        () => 'completed',
        (error: unknown) => String(error)
      );
      try {
        await entered.promise;
        await scheduler.stop();
        paths.directory = nextPath;
        await scheduler.start();
        release.resolve();
        expect(await pending).toBe('Error: Scheduler context changed');
        expect(await repository.listSchedules()).toEqual([next]);
      } finally {
        release.resolve();
        await pending;
        await scheduler.stop();
        paths.directory = originalPath;
        await rm(nextPath, { recursive: true, force: true });
      }
    }
  );

  it.each([1, 2])('does not finish startup after stop during schedule list %s', async (cut) => {
    await repository.saveSchedule(schedule());
    const list = repository.listSchedules.bind(repository);
    const entered = signal(),
      release = signal();
    let calls = 0;
    vi.spyOn(repository, 'listSchedules').mockImplementation(async () => {
      const rows = await list();
      if (++calls === cut) {
        entered.resolve();
        await release.promise;
      }
      return rows;
    });
    const pending = scheduler.start();
    try {
      await entered.promise;
      await scheduler.stop();
    } finally {
      release.resolve();
      await pending;
    }
    expect((scheduler as unknown as { cronJobs: Map<string, Cron> }).cronJobs.size).toBe(0);
  });

  it.each(['recovery-read', 'run-write'] as const)(
    'keeps startup recovery and cron ownership in the original profile after restart at %s',
    async (cut) => {
      const originalPath = paths.directory;
      const nextPath = await mkdtemp(join(tmpdir(), 'TEST-scheduler-next-profile-'));
      const original = schedule();
      const next = schedule({ label: 'TEST next profile', cronExpression: '0 17 * * 3' });
      const interrupted: ScheduleRun = {
        id: 'TEST-old-run',
        scheduleId: original.id,
        teamName: original.teamName,
        status: 'running',
        scheduledFor: original.createdAt,
        startedAt: original.createdAt,
        retryCount: 0,
      };
      const nextRun: ScheduleRun = { ...interrupted, id: 'TEST-next-run', status: 'completed' };
      await repository.saveSchedule(original);
      await repository.saveRun(interrupted);
      paths.directory = nextPath;
      await repository.saveSchedule(next);
      await repository.saveRun(nextRun);
      paths.directory = originalPath;
      const entered = signal(),
        release = signal();
      if (cut === 'recovery-read') {
        const list = repository.listRuns.bind(repository);
        vi.spyOn(repository, 'listRuns').mockImplementationOnce(async (...args) => {
          const rows = await list(...args);
          entered.resolve();
          await release.promise;
          return rows;
        });
      } else {
        const history = repository as unknown as {
          readRunsFile(id: string): Promise<ScheduleRun[]>;
        };
        const read = history.readRunsFile.bind(repository);
        let calls = 0;
        vi.spyOn(history, 'readRunsFile').mockImplementation(async (id) => {
          const rows = await read(id);
          if (++calls === 2) {
            entered.resolve();
            await release.promise;
          }
          return rows;
        });
      }
      const pending = scheduler.start();
      try {
        await entered.promise;
        await scheduler.stop();
        paths.directory = nextPath;
        await scheduler.start();
        const jobs = (scheduler as unknown as { cronJobs: Map<string, Cron> }).cronJobs;
        const currentJob = jobs.get(next.id);
        release.resolve();
        await pending;
        expect(await repository.listRuns(next.id)).toEqual([nextRun]);
        expect(jobs.get(next.id)).toBe(currentJob);
      } finally {
        release.resolve();
        await pending;
        await scheduler.stop();
        paths.directory = originalPath;
        await rm(nextPath, { recursive: true, force: true });
      }
    }
  );

  it.each(backgroundAdmissions)(
    '$method preserves durable pause and edits across restart (beforeQueue=$beforeQueue)',
    async ({ method, failures, beforeQueue }) => {
      const original = schedule();
      await repository.saveSchedule(original);
      let edited!: Schedule;
      await beforeMetadataAdmission(
        repository,
        () =>
          method === 'updateScheduleTimestamps'
            ? updateScheduleTimestamps(repository, original, () => undefined)
            : (scheduler as unknown as BackgroundMetadata)[method](original),
        async () => {
          await scheduler.pauseSchedule(original.id);
          edited = await scheduler.updateSchedule(original.id, {
            cronExpression: '0 18 * * 2',
            label: 'TEST retained user edit',
            launchConfig: { prompt: 'TEST edited prompt', model: 'TEST-edited' },
          });
          expect((await repository.getSchedule(original.id))?.status).toBe('paused');
        },
        beforeQueue || method === 'updateScheduleTimestamps',
        beforeQueue
          ? (scheduler as unknown as { scheduleMutations: ScheduleMutationQueue }).scheduleMutations
          : undefined
      );

      const durable = await new JsonScheduleRepository().getSchedule(original.id);
      expect(durable).toMatchObject({
        id: original.id,
        status: 'paused',
        cronExpression: edited.cronExpression,
        label: edited.label,
        launchConfig: edited.launchConfig,
        consecutiveFailures: failures,
        maxConsecutiveFailures: edited.maxConsecutiveFailures,
        createdAt: original.createdAt,
      });
      if (method === 'updateScheduleTimestamps') {
        expect(durable?.lastRunAt).toEqual(expect.any(String));
        expect(durable?.nextRunAt).toEqual(expect.any(String));
      }

      await scheduler.stop();
      const jobs = vi.spyOn(
        scheduler as unknown as { createCronJob(row: Schedule): void },
        'createCronJob'
      );
      await scheduler.start();
      expect((await scheduler.getSchedule(original.id))?.status).toBe('paused');
      expect(jobs).not.toHaveBeenCalled();
    }
  );

  it('increments the latest failure count and applies its latest auto-pause threshold', async () => {
    const original = schedule({ consecutiveFailures: 0, maxConsecutiveFailures: 5 });
    await repository.saveSchedule(original);
    const changed = vi.fn();
    scheduler.setChangeEmitter(changed);
    await beforeMetadataAdmission(
      repository,
      () => (scheduler as unknown as BackgroundMetadata).incrementConsecutiveFailures(original),
      async () => {
        await repository.saveSchedule(
          {
            ...original,
            consecutiveFailures: 2,
            maxConsecutiveFailures: 3,
            label: 'TEST latest failure policy',
          },
          { mustExist: true }
        );
      }
    );

    expect(await repository.getSchedule(original.id)).toMatchObject({
      consecutiveFailures: 3,
      maxConsecutiveFailures: 3,
      status: 'paused',
      label: 'TEST latest failure policy',
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({
      type: 'schedule-paused',
      scheduleId: original.id,
      teamName: original.teamName,
      detail: 'auto-paused after 3 consecutive failures',
    });
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['[Service:Scheduler]', `[${original.id}] Auto-pausing after 3 consecutive failures`],
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it.each(backgroundCases)(
    '$method does not resurrect a deletion committed before admission',
    async ({ method }) => {
      const original = schedule();
      await repository.saveSchedule(original);
      const changed = vi.fn();
      scheduler.setChangeEmitter(changed);
      await beforeMetadataAdmission(
        repository,
        () =>
          method === 'updateScheduleTimestamps'
            ? updateScheduleTimestamps(repository, original, changed)
            : (scheduler as unknown as BackgroundMetadata)[method](original),
        () => repository.deleteSchedule(original.id)
      );
      expect(await repository.getSchedule(original.id)).toBeNull();
      expect(await repository.listSchedules()).toEqual([]);
      expect(changed).not.toHaveBeenCalled();
    }
  );

  it('keeps metadata unchanged after absent, declined, invalid, or failed atomic updates and releases the queue', async () => {
    const original = schedule();
    await repository.saveSchedule(original);
    const updater = repository as unknown as AtomicScheduleUpdate;
    const metadata = repository as unknown as MetadataQueue;
    const file = join(paths.directory, 'schedules.json');
    const before = await readFile(file, 'utf8');
    const missing = vi.fn((current: Schedule) => current);
    await expect(updater.updateSchedule('TEST-absent', missing)).resolves.toBeNull();
    expect(missing).not.toHaveBeenCalled();
    await expect(updater.updateSchedule(original.id, () => null)).resolves.toBeNull();

    const callbackError = new Error('TEST callback refused');
    await expect(
      updater.updateSchedule(original.id, () => {
        throw callbackError;
      })
    ).rejects.toBe(callbackError);
    await expect(
      updater.updateSchedule(original.id, (current) => ({ ...current, id: 'TEST-wrong-identity' }))
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);

    const writeError = new Error('TEST metadata write refused');
    const write = vi.spyOn(metadata, 'writeSchedulesFile').mockRejectedValueOnce(writeError);
    try {
      await expect(
        updater.updateSchedule(original.id, (current) => ({
          ...current,
          label: 'TEST failed write',
        }))
      ).rejects.toBe(writeError);
    } finally {
      write.mockRestore();
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    const saved = await updater.updateSchedule(original.id, (current) => ({
      ...current,
      label: 'TEST queue remains usable',
    }));
    expect(saved).toEqual({ ...original, label: 'TEST queue remains usable' });
    expect(await repository.getSchedule(original.id)).toEqual(saved);
  });
});
