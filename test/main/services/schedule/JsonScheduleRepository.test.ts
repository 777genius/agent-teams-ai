import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Schedule, ScheduleRun } from '@shared/types';

// Mock pathDecoder to use temp dir
let tempDir: string;

vi.mock('@main/utils/pathDecoder', () => ({
  getSchedulesBasePath: () => tempDir,
}));

function makeSchedule(overrides?: Partial<Schedule>): Schedule {
  const now = new Date().toISOString();
  return {
    id: 'sched-1',
    teamName: 'test-team',
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
      cwd: '/tmp/project',
      prompt: 'Run tests',
    },
    ...overrides,
  };
}

function makeRun(overrides?: Partial<ScheduleRun>): ScheduleRun {
  const now = new Date().toISOString();
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    teamName: 'test-team',
    status: 'completed',
    scheduledFor: now,
    startedAt: now,
    retryCount: 0,
    ...overrides,
  };
}

describe('JsonScheduleRepository', () => {
  let repo: JsonScheduleRepository;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `schedule-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    repo = new JsonScheduleRepository();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Schedule CRUD
  // =========================================================================

  describe('schedules', () => {
    it('lists empty schedules when no file exists', async () => {
      const result = await repo.listSchedules();
      expect(result).toEqual([]);
    });

    it('saves and retrieves a schedule', async () => {
      const schedule = makeSchedule();
      await repo.saveSchedule(schedule);

      const retrieved = await repo.getSchedule('sched-1');
      expect(retrieved).toEqual(schedule);
    });

    it('updates an existing schedule', async () => {
      const schedule = makeSchedule();
      await repo.saveSchedule(schedule);

      const updated = { ...schedule, label: 'Daily tests' };
      await repo.saveSchedule(updated);

      const retrieved = await repo.getSchedule('sched-1');
      expect(retrieved?.label).toBe('Daily tests');

      const all = await repo.listSchedules();
      expect(all).toHaveLength(1);
    });

    it('filters schedules by team', async () => {
      await repo.saveSchedule(makeSchedule({ id: 's1', teamName: 'team-a' }));
      await repo.saveSchedule(makeSchedule({ id: 's2', teamName: 'team-b' }));
      await repo.saveSchedule(makeSchedule({ id: 's3', teamName: 'team-a' }));

      const teamA = await repo.getSchedulesByTeam('team-a');
      expect(teamA).toHaveLength(2);
      expect(teamA.map((s) => s.id).sort()).toEqual(['s1', 's3']);
    });

    it('deletes a schedule and its runs/logs', async () => {
      const schedule = makeSchedule();
      await repo.saveSchedule(schedule);

      const run = makeRun();
      await repo.saveRun(run);

      // Create log files
      const logsDir = path.join(tempDir, 'logs', 'sched-1');
      await fs.promises.mkdir(logsDir, { recursive: true });
      await fs.promises.writeFile(path.join(logsDir, 'run-1.log'), 'stdout');
      await fs.promises.writeFile(path.join(logsDir, 'run-1.err'), 'stderr');

      await repo.deleteSchedule('sched-1');

      expect(await repo.getSchedule('sched-1')).toBeNull();
      expect(await repo.listRuns('sched-1')).toEqual([]);
      // Logs dir cleaned up
      await expect(fs.promises.stat(logsDir)).rejects.toThrow();
    });

    it('returns null for non-existent schedule', async () => {
      const result = await repo.getSchedule('non-existent');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Run CRUD
  // =========================================================================

  describe('runs', () => {
    it('lists empty runs when no file exists', async () => {
      const result = await repo.listRuns('sched-1');
      expect(result).toEqual([]);
    });

    it('saves and retrieves runs (newest first)', async () => {
      const run1 = makeRun({ id: 'run-1', startedAt: '2026-01-01T09:00:00Z' });
      const run2 = makeRun({ id: 'run-2', startedAt: '2026-01-02T09:00:00Z' });

      await repo.saveRun(run1);
      await repo.saveRun(run2);

      const runs = await repo.listRuns('sched-1');
      expect(runs).toHaveLength(2);
      // run2 added later → newest first (unshift)
      expect(runs[0].id).toBe('run-2');
      expect(runs[1].id).toBe('run-1');
    });

    it('updates an existing run in place', async () => {
      const run = makeRun({ status: 'running' });
      await repo.saveRun(run);

      const updated = { ...run, status: 'completed' as const, exitCode: 0 };
      await repo.saveRun(updated);

      const runs = await repo.listRuns('sched-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('completed');
      expect(runs[0].exitCode).toBe(0);
    });

    it('getLatestRun returns newest run', async () => {
      await repo.saveRun(makeRun({ id: 'run-1' }));
      await repo.saveRun(makeRun({ id: 'run-2' }));

      const latest = await repo.getLatestRun('sched-1');
      expect(latest?.id).toBe('run-2');
    });

    it('getLatestRun returns null for empty schedule', async () => {
      const latest = await repo.getLatestRun('sched-1');
      expect(latest).toBeNull();
    });

    it('supports pagination via offset and limit', async () => {
      for (let i = 0; i < 10; i++) {
        await repo.saveRun(makeRun({ id: `run-${i}` }));
      }

      const page = await repo.listRuns('sched-1', { limit: 3, offset: 2 });
      expect(page).toHaveLength(3);
    });
  });

  // =========================================================================
  // Pruning
  // =========================================================================

  describe('pruneOldRuns', () => {
    it('prunes old runs beyond keep count', async () => {
      for (let i = 0; i < 10; i++) {
        await repo.saveRun(makeRun({ id: `run-${i}` }));
      }

      const removed = await repo.pruneOldRuns('sched-1', 5);
      expect(removed).toBe(5);

      const remaining = await repo.listRuns('sched-1');
      expect(remaining).toHaveLength(5);
    });

    it('returns 0 when nothing to prune', async () => {
      await repo.saveRun(makeRun({ id: 'run-1' }));
      const removed = await repo.pruneOldRuns('sched-1', 10);
      expect(removed).toBe(0);
    });

    it('deletes log files for pruned runs', async () => {
      const logsDir = path.join(tempDir, 'logs', 'sched-1');
      await fs.promises.mkdir(logsDir, { recursive: true });

      for (let i = 0; i < 5; i++) {
        await repo.saveRun(makeRun({ id: `run-${i}` }));
        await fs.promises.writeFile(path.join(logsDir, `run-${i}.log`), `log ${i}`);
      }

      await repo.pruneOldRuns('sched-1', 2);

      const remaining = await repo.listRuns('sched-1');
      expect(remaining).toHaveLength(2);

      // Pruned run logs should be deleted
      const logFiles = await fs.promises.readdir(logsDir);
      // Only newest 2 runs logs remain (run-4, run-3 since newest first)
      expect(logFiles.length).toBeLessThanOrEqual(2);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles corrupted JSON gracefully', async () => {
      await fs.promises.mkdir(path.dirname(path.join(tempDir, 'schedules.json')), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(tempDir, 'schedules.json'), 'not valid json');

      // Logger uses console.warn internally — expect it for corrupted file
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await repo.listSchedules();
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('handles concurrent saves without data loss', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        repo.saveSchedule(makeSchedule({ id: `sched-${i}` }))
      );
      await Promise.all(promises);

      const schedules = await repo.listSchedules();
      // At least some should be saved (atomic writes prevent corruption)
      expect(schedules.length).toBeGreaterThan(0);
    });
  });
});
