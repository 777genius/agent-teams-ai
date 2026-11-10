/**
 * JSON-based ScheduleRepository implementation.
 *
 * Storage layout:
 *   {getSchedulesBasePath()}/
 *     schedules.json              — Schedule[]
 *     runs/{scheduleId}.json      — ScheduleRun[] (newest first, max 50)
 *     logs/{scheduleId}/{runId}.log  — stdout (max 64KB)
 *     logs/{scheduleId}/{runId}.err  — stderr (max 16KB)
 */

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getSchedulesBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { ScheduleRepository } from './ScheduleRepository';
import type { Schedule, ScheduleRun } from '@shared/types';

const logger = createLogger('Service:JsonScheduleRepo');

const READ_TIMEOUT_MS = 5_000;
const MAX_RUNS_PER_SCHEDULE = 50;

export class JsonScheduleRepository implements ScheduleRepository {
  private get basePath(): string {
    return getSchedulesBasePath();
  }

  private get schedulesFilePath(): string {
    return path.join(this.basePath, 'schedules.json');
  }

  private runsFilePath(scheduleId: string): string {
    return path.join(this.basePath, 'runs', `${scheduleId}.json`);
  }

  private logsDir(scheduleId: string): string {
    return path.join(this.basePath, 'logs', scheduleId);
  }

  // ---------------------------------------------------------------------------
  // Schedule CRUD
  // ---------------------------------------------------------------------------

  async listSchedules(): Promise<Schedule[]> {
    return this.readSchedulesFile();
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    const schedules = await this.readSchedulesFile();
    return schedules.find((s) => s.id === id) ?? null;
  }

  async getSchedulesByTeam(teamName: string): Promise<Schedule[]> {
    const schedules = await this.readSchedulesFile();
    return schedules.filter((s) => s.teamName === teamName);
  }

  async saveSchedule(schedule: Schedule): Promise<void> {
    const schedules = await this.readSchedulesFile();
    const idx = schedules.findIndex((s) => s.id === schedule.id);
    if (idx >= 0) {
      schedules[idx] = schedule;
    } else {
      schedules.push(schedule);
    }
    await this.writeSchedulesFile(schedules);
  }

  async deleteSchedule(id: string): Promise<void> {
    const schedules = await this.readSchedulesFile();
    const filtered = schedules.filter((s) => s.id !== id);
    if (filtered.length !== schedules.length) {
      await this.writeSchedulesFile(filtered);
    }
    // Clean up runs and logs
    const runsFile = this.runsFilePath(id);
    await fs.promises.unlink(runsFile).catch(() => undefined);
    const logsPath = this.logsDir(id);
    await fs.promises.rm(logsPath, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Run CRUD
  // ---------------------------------------------------------------------------

  async listRuns(
    scheduleId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<ScheduleRun[]> {
    const runs = await this.readRunsFile(scheduleId);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? runs.length;
    return runs.slice(offset, offset + limit);
  }

  async getLatestRun(scheduleId: string): Promise<ScheduleRun | null> {
    const runs = await this.readRunsFile(scheduleId);
    return runs[0] ?? null;
  }

  async saveRun(run: ScheduleRun): Promise<void> {
    const runs = await this.readRunsFile(run.scheduleId);
    const idx = runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      runs[idx] = run;
    } else {
      runs.unshift(run); // newest first
    }
    // Enforce max limit
    const trimmed = runs.slice(0, MAX_RUNS_PER_SCHEDULE);
    await this.writeRunsFile(run.scheduleId, trimmed);
  }

  async pruneOldRuns(scheduleId: string, keepCount: number): Promise<number> {
    const runs = await this.readRunsFile(scheduleId);
    if (runs.length <= keepCount) {
      return 0;
    }
    const removed = runs.slice(keepCount);
    const kept = runs.slice(0, keepCount);
    await this.writeRunsFile(scheduleId, kept);

    // Clean up log files for pruned runs
    for (const run of removed) {
      await this.deleteRunLogs(scheduleId, run.id);
    }

    return removed.length;
  }

  // ---------------------------------------------------------------------------
  // Internal I/O
  // ---------------------------------------------------------------------------

  private async readSchedulesFile(): Promise<Schedule[]> {
    return this.readJsonFile<Schedule[]>(this.schedulesFilePath, []);
  }

  private async writeSchedulesFile(schedules: Schedule[]): Promise<void> {
    await atomicWriteAsync(this.schedulesFilePath, JSON.stringify(schedules, null, 2));
  }

  private async readRunsFile(scheduleId: string): Promise<ScheduleRun[]> {
    return this.readJsonFile<ScheduleRun[]>(this.runsFilePath(scheduleId), []);
  }

  private async writeRunsFile(scheduleId: string, runs: ScheduleRun[]): Promise<void> {
    await atomicWriteAsync(this.runsFilePath(scheduleId), JSON.stringify(runs, null, 2));
  }

  private async readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      try {
        const content = await fs.promises.readFile(filePath, {
          encoding: 'utf8',
          signal: controller.signal,
        });
        return JSON.parse(content) as T;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultValue;
      }
      logger.warn(
        `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return defaultValue;
    }
  }

  private async deleteRunLogs(scheduleId: string, runId: string): Promise<void> {
    const dir = this.logsDir(scheduleId);
    await fs.promises.unlink(path.join(dir, `${runId}.log`)).catch(() => undefined);
    await fs.promises.unlink(path.join(dir, `${runId}.err`)).catch(() => undefined);
  }

  async saveRunLogs(
    scheduleId: string,
    runId: string,
    stdout: string,
    stderr: string
  ): Promise<void> {
    const dir = this.logsDir(scheduleId);
    await fs.promises.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.promises.writeFile(path.join(dir, `${runId}.log`), stdout, 'utf8'),
      fs.promises.writeFile(path.join(dir, `${runId}.err`), stderr, 'utf8'),
    ]);
  }

  async getRunLogs(scheduleId: string, runId: string): Promise<{ stdout: string; stderr: string }> {
    const dir = this.logsDir(scheduleId);
    const [stdout, stderr] = await Promise.all([
      fs.promises.readFile(path.join(dir, `${runId}.log`), 'utf8').catch(() => ''),
      fs.promises.readFile(path.join(dir, `${runId}.err`), 'utf8').catch(() => ''),
    ]);
    return { stdout, stderr };
  }
}
