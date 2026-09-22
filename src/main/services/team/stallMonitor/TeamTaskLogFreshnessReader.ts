import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { BoardTaskActivityParseCache } from '../taskLogs/activity/BoardTaskActivityParseCache';

import type { TaskLogFreshnessSignal } from './TeamTaskStallTypes';

const BOARD_TASK_LOG_FRESHNESS_DIRNAME = '.board-task-log-freshness';
const TEAM_TASK_LOG_FRESHNESS_DIRNAME = 'task-log-freshness';
const BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX = '.json';
const MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH = 120;

interface ParsedFreshnessSignal {
  taskId: string;
  updatedAt: string;
  transcriptFileBasename?: string;
}

function isWindowsReservedArtifactSegment(segment: string): boolean {
  const stem = segment.split('.')[0]?.toUpperCase() ?? '';
  return (
    !segment ||
    stem === 'CON' ||
    stem === 'PRN' ||
    stem === 'AUX' ||
    stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  );
}

function encodeTaskId(taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  return isWindowsReservedArtifactSegment(encoded) ||
    encoded.length > MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded;
}

function taskIdArtifactSegments(taskId: string): string[] {
  const safe = encodeTaskId(taskId);
  const legacy = encodeURIComponent(taskId);
  return safe === legacy ? [safe] : [safe, legacy];
}

function taskSignalPathCandidates(projectDir: string, taskId: string, teamName?: string): string[] {
  const dirs = [
    ...(teamName ? [path.join(getTeamsBasePath(), teamName, TEAM_TASK_LOG_FRESHNESS_DIRNAME)] : []),
    path.join(projectDir, BOARD_TASK_LOG_FRESHNESS_DIRNAME),
  ];
  return dirs.flatMap((dir) =>
    taskIdArtifactSegments(taskId).map((segment) =>
      path.join(dir, `${segment}${BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX}`)
    )
  );
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

export class TeamTaskLogFreshnessReader {
  private readonly cache = new BoardTaskActivityParseCache<ParsedFreshnessSignal | false>();

  async readSignals(
    projectDir: string,
    taskIds: string[],
    options?: { teamName?: string }
  ): Promise<Map<string, TaskLogFreshnessSignal>> {
    const uniqueTaskIds = [...new Set(taskIds)].filter((taskId) => taskId.trim().length > 0).sort();
    const signalFilePathCandidates = uniqueTaskIds.map((taskId) =>
      taskSignalPathCandidates(projectDir, taskId, options?.teamName)
    );
    this.cache.retainOnly(new Set(signalFilePathCandidates.flat()));

    const rows = await Promise.all(
      uniqueTaskIds.map(async (taskId, index) => {
        const candidates = signalFilePathCandidates[index] ?? [];
        const result = await this.readFirstSignal(candidates);
        if (result?.parsed.taskId !== taskId) {
          return null;
        }
        const parsed = result.parsed;
        return [
          taskId,
          {
            taskId,
            updatedAt: parsed.updatedAt,
            filePath: result.filePath,
            ...(parsed.transcriptFileBasename
              ? { transcriptFileBasename: parsed.transcriptFileBasename }
              : {}),
          } satisfies TaskLogFreshnessSignal,
        ] as const;
      })
    );

    return new Map(rows.filter((row): row is NonNullable<typeof row> => row !== null));
  }

  private async readFirstSignal(
    filePaths: string[]
  ): Promise<{ filePath: string; parsed: ParsedFreshnessSignal } | null> {
    for (const filePath of filePaths) {
      const parsed = await this.readSignal(filePath);
      if (parsed) {
        return { filePath, parsed };
      }
    }
    return null;
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
