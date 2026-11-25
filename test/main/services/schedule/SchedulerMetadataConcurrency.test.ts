import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { SchedulerService } from '@main/services/schedule/SchedulerService';
import { updateScheduleTimestamps } from '@main/services/schedule/updateScheduleTimestamps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Schedule } from '@shared/types';

const paths = vi.hoisted(() => ({ directory: '' }));
vi.mock('@main/utils/pathDecoder', () => ({ getSchedulesBasePath: () => paths.directory }));

interface BackgroundMetadata {
  resetConsecutiveFailures(schedule: Schedule): Promise<void>;
  incrementConsecutiveFailures(schedule: Schedule): Promise<void>;
}

interface MetadataQueue {
  writeMetadata(action: () => Promise<unknown>): Promise<unknown>;
  writeSchedulesFile(schedules: Schedule[]): Promise<void>;
}

interface AtomicScheduleUpdate {
  updateSchedule(id: string, update: (current: Schedule) => Schedule | null): Promise<Schedule | null>;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

/** Hold one writer before queue admission, while other real metadata writes commit. */
async function beforeMetadataAdmission<T>(
  repository: JsonScheduleRepository,
  operation: () => Promise<T>,
  interleave: () => Promise<void>
): Promise<T> {
  const metadata = repository as unknown as MetadataQueue;
  const write = metadata.writeMetadata.bind(repository);
  const entered = signal(), release = signal();
  const held = vi.spyOn(metadata, 'writeMetadata').mockImplementationOnce(async (action) => {
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
      pending.then(() => { throw new Error('Background mutation returned before metadata admission'); }),
    ]);
    await interleave();
    release.resolve();
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

const backgroundCases = [
  { method: 'updateScheduleTimestamps', failures: 2 },
  { method: 'resetConsecutiveFailures', failures: 0 },
  { method: 'incrementConsecutiveFailures', failures: 3 },
] as const;

describe('scheduler metadata concurrency', () => {
  let repository: JsonScheduleRepository;
  let scheduler: SchedulerService;
  const execute = vi.fn(async () => { throw new Error('TEST must not execute a scheduled task'); });

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

  it.each(backgroundCases)('$method preserves durable pause and edits across restart', async ({ method, failures }) => {
    const original = schedule();
    await repository.saveSchedule(original);
    let edited!: Schedule;
    await beforeMetadataAdmission(repository,
      () => method === 'updateScheduleTimestamps'
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
      });

    const durable = await new JsonScheduleRepository().getSchedule(original.id);
    expect(durable).toMatchObject({
      id: original.id, status: 'paused', cronExpression: edited.cronExpression,
      label: edited.label, launchConfig: edited.launchConfig, consecutiveFailures: failures,
      maxConsecutiveFailures: edited.maxConsecutiveFailures, createdAt: original.createdAt,
    });
    if (method === 'updateScheduleTimestamps') {
      expect(durable?.lastRunAt).toEqual(expect.any(String));
      expect(durable?.nextRunAt).toEqual(expect.any(String));
    }

    await scheduler.stop();
    const jobs = vi.spyOn(scheduler as unknown as { createCronJob(row: Schedule): void }, 'createCronJob');
    await scheduler.start();
    expect((await scheduler.getSchedule(original.id))?.status).toBe('paused');
    expect(jobs).not.toHaveBeenCalled();
  });

  it('increments the latest failure count and applies its latest auto-pause threshold', async () => {
    const original = schedule({ consecutiveFailures: 0, maxConsecutiveFailures: 5 });
    await repository.saveSchedule(original);
    const changed = vi.fn();
    scheduler.setChangeEmitter(changed);
    await beforeMetadataAdmission(repository,
      () => (scheduler as unknown as BackgroundMetadata).incrementConsecutiveFailures(original),
      async () => {
        await repository.saveSchedule({ ...original, consecutiveFailures: 2,
          maxConsecutiveFailures: 3, label: 'TEST latest failure policy' }, { mustExist: true });
      });

    expect(await repository.getSchedule(original.id)).toMatchObject({
      consecutiveFailures: 3, maxConsecutiveFailures: 3,
      status: 'paused', label: 'TEST latest failure policy',
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({
      type: 'schedule-paused', scheduleId: original.id, teamName: original.teamName,
      detail: 'auto-paused after 3 consecutive failures',
    });
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['[Service:Scheduler]', `[${original.id}] Auto-pausing after 3 consecutive failures`],
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it.each(backgroundCases)('$method does not resurrect a deletion committed before admission', async ({ method }) => {
    const original = schedule();
    await repository.saveSchedule(original);
    const changed = vi.fn();
    scheduler.setChangeEmitter(changed);
    await beforeMetadataAdmission(repository,
      () => method === 'updateScheduleTimestamps'
        ? updateScheduleTimestamps(repository, original, changed)
        : (scheduler as unknown as BackgroundMetadata)[method](original),
      () => repository.deleteSchedule(original.id));
    expect(await repository.getSchedule(original.id)).toBeNull();
    expect(await repository.listSchedules()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

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
    await expect(updater.updateSchedule(original.id, () => { throw callbackError; })).rejects.toBe(callbackError);
    await expect(updater.updateSchedule(original.id,
      current => ({ ...current, id: 'TEST-wrong-identity' }))).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);

    const writeError = new Error('TEST metadata write refused');
    const write = vi.spyOn(metadata, 'writeSchedulesFile').mockRejectedValueOnce(writeError);
    try {
      await expect(updater.updateSchedule(original.id,
        current => ({ ...current, label: 'TEST failed write' }))).rejects.toBe(writeError);
    } finally {
      write.mockRestore();
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    const saved = await updater.updateSchedule(original.id,
      current => ({ ...current, label: 'TEST queue remains usable' }));
    expect(saved).toEqual({ ...original, label: 'TEST queue remains usable' });
    expect(await repository.getSchedule(original.id)).toEqual(saved);
  });
});
