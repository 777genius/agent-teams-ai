/**
 * Schedule repository interface — abstracts storage backend.
 *
 * Current implementation: JsonScheduleRepository (JSON files on disk).
 * Future upgrade path: Drizzle + sql.js (WASM, no native modules).
 */

import type { Schedule, ScheduleRun } from '@shared/types';

export interface ScheduleRepository {
  listSchedules(): Promise<Schedule[]>;
  getSchedule(id: string): Promise<Schedule | null>;
  getSchedulesByTeam(teamName: string): Promise<Schedule[]>;
  saveSchedule(schedule: Schedule): Promise<void>;
  deleteSchedule(id: string): Promise<void>;

  listRuns(scheduleId: string, opts?: { limit?: number; offset?: number }): Promise<ScheduleRun[]>;
  getLatestRun(scheduleId: string): Promise<ScheduleRun | null>;
  saveRun(run: ScheduleRun): Promise<void>;
  pruneOldRuns(scheduleId: string, keepCount: number): Promise<number>;

  saveRunLogs(scheduleId: string, runId: string, stdout: string, stderr: string): Promise<void>;
  getRunLogs(scheduleId: string, runId: string): Promise<{ stdout: string; stderr: string }>;
}
