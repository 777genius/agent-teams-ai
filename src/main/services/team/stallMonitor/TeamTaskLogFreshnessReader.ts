import * as fs from 'fs/promises';
import * as path from 'path';

import { BoardTaskActivityParseCache } from '../taskLogs/activity/BoardTaskActivityParseCache';

import type { TaskLogFreshnessSignal } from './TeamTaskStallTypes';

const BOARD_TASK_LOG_FRESHNESS_DIRNAME = '.board-task-log-freshness';
const BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX = '.json';

interface ParsedFreshnessSignal {
  taskId: string;
  updatedAt: string;
  transcriptFileBasename?: string;
}

function encodeTaskId(taskId: string): string {
  return encodeURIComponent(taskId);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

export class TeamTaskLogFreshnessReader {
  private readonly cache = new BoardTaskActivityParseCache<ParsedFreshnessSignal | false>();

  async readSignals(
    projectDir: string,
    taskIds: string[]
  ): Promise<Map<string, TaskLogFreshnessSignal>> {
    const uniqueTaskIds = [...new Set(taskIds)].filter((taskId) => taskId.trim().length > 0).sort();
    const signalFilePaths = uniqueTaskIds.map((taskId) =>
      path.join(
        projectDir,
        BOARD_TASK_LOG_FRESHNESS_DIRNAME,
        `${encodeTaskId(taskId)}${BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX}`
      )
    );
    this.cache.retainOnly(new Set(signalFilePaths));

    const rows = await Promise.all(
      uniqueTaskIds.map(async (taskId, index) => {
        const filePath = signalFilePaths[index];
        const parsed = await this.readSignal(filePath);
        if (!parsed || parsed.taskId !== taskId) {
          return null;
        }
        return [
          taskId,
          {
            taskId,
            updatedAt: parsed.updatedAt,
            filePath,
            ...(parsed.transcriptFileBasename
              ? { transcriptFileBasename: parsed.transcriptFileBasename }
              : {}),
          } satisfies TaskLogFreshnessSignal,
        ] as const;
      })
    );

    return new Map(rows.filter((row): row is NonNullable<typeof row> => row !== null));
  }

  private async readSignal(filePath: string): Promise<ParsedFreshnessSignal | false> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        this.cache.clearForPath(filePath);
        return false;
      }

      const cached = this.cache.getIfFresh(filePath, stat.mtimeMs, stat.size);
      if (cached !== null) {
        return cached;
      }

      const inFlight = this.cache.getInFlight(filePath);
      if (inFlight) {
        return inFlight;
      }

      const promise = this.parseSignal(filePath);
      this.cache.setInFlight(filePath, promise);
      try {
        const parsed = await promise;
        this.cache.set(filePath, stat.mtimeMs, stat.size, parsed);
        return parsed;
      } finally {
        this.cache.clearInFlight(filePath);
      }
    } catch {
      this.cache.clearForPath(filePath);
      return false;
    }
  }

  private async parseSignal(filePath: string): Promise<ParsedFreshnessSignal | false> {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const record = parsed as Record<string, unknown>;
    const taskId =
      typeof record.taskId === 'string' && record.taskId.trim().length > 0
        ? record.taskId.trim()
        : null;
    const updatedAt = isValidTimestamp(record.updatedAt) ? record.updatedAt : null;
    if (!taskId || !updatedAt) {
      return false;
    }

    return {
      taskId,
      updatedAt,
      ...(typeof record.transcriptFile === 'string' && record.transcriptFile.trim().length > 0
        ? { transcriptFileBasename: path.basename(record.transcriptFile.trim()) }
        : {}),
    };
  }
}
