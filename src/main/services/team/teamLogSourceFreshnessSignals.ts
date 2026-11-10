import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  BOARD_TASK_CHANGE_FRESHNESS_DIRNAME,
  BOARD_TASK_LOG_FRESHNESS_DIRNAME,
  BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX,
  TEAM_TASK_LOG_FRESHNESS_DIRNAME,
} from './teamLogSourceWatchScope';

import type { TeamChangeEvent } from '@shared/types';

export type TaskFreshnessSignalKind = NonNullable<TeamChangeEvent['taskSignalKind']>;

export type DecodedFreshnessTaskId =
  | { kind: 'task-id'; taskId: string }
  | { kind: 'opaque-safe-segment' }
  | { kind: 'invalid' };

/**
 * The two families of directory a team's freshness signals land in: the
 * team-scoped log-signal dir, and the legacy per-project roots that still
 * carry the board's task-log and task-change freshness subdirectories.
 */
export interface TaskFreshnessDirs {
  legacyRootDirs: readonly string[];
  logSignalDirs: readonly string[];
}

/**
 * Where a routed signal goes. The tracker owns the change emitter, so routing
 * takes the two emissions it can produce as ports rather than reaching into
 * the tracker for them.
 */
export interface TaskFreshnessSignalSink {
  /** The signal named one task, so only that task's views need to refresh. */
  emitTaskLogChange(signal: {
    teamName: string;
    taskId: string;
    taskSignalKind: TaskFreshnessSignalKind;
  }): void;
  /** The signal's task could not be read; fall back to a team-level refresh. */
  emitLogSourceChange(teamName: string): void;
}

function isOpaqueSafeTaskIdSegment(segment: string): boolean {
  return /^task-id-[0-9a-f]{32}$/.test(segment);
}

export function pushUniqueNormalizedPath(paths: string[], candidate: string | undefined): void {
  if (!candidate || !path.isAbsolute(candidate)) {
    return;
  }
  const normalized = path.normalize(candidate);
  if (!paths.some((existing) => path.normalize(existing) === normalized)) {
    paths.push(normalized);
  }
}

export function getTeamTaskLogFreshnessDir(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_TASK_LOG_FRESHNESS_DIRNAME);
}

export function decodeTaskLogFreshnessTaskId(fileName: string): DecodedFreshnessTaskId {
  if (!fileName.endsWith(BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX)) {
    return { kind: 'invalid' };
  }

  const encodedTaskId = fileName.slice(0, -BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX.length);
  if (!encodedTaskId) {
    return { kind: 'invalid' };
  }
  if (isOpaqueSafeTaskIdSegment(encodedTaskId)) {
    return { kind: 'opaque-safe-segment' };
  }

  try {
    const taskId = decodeURIComponent(encodedTaskId);
    return taskId.trim().length > 0 ? { kind: 'task-id', taskId } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export function getTaskFreshnessDirsForContext(
  teamName: string,
  projectDir: string,
  taskFreshnessRootDirs: readonly string[]
): { legacyRootDirs: string[]; logSignalDirs: string[] } {
  const legacyRootDirs = [...taskFreshnessRootDirs];
  pushUniqueNormalizedPath(legacyRootDirs, projectDir);
  return {
    legacyRootDirs,
    logSignalDirs: [getTeamTaskLogFreshnessDir(teamName)],
  };
}

async function emitTaskFreshnessSignalFromFile(
  teamName: string,
  filePath: string,
  taskSignalKind: TaskFreshnessSignalKind,
  sink: TaskFreshnessSignalSink
): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const taskId =
      typeof parsed.taskId === 'string' && parsed.taskId.trim().length > 0
        ? parsed.taskId.trim()
        : null;
    if (taskId) {
      sink.emitTaskLogChange({ teamName, taskId, taskSignalKind });
      return;
    }
  } catch {
    // Deletions or partially unavailable files still need a team-level refresh.
  }
  sink.emitLogSourceChange(teamName);
}

function routeTaskFreshnessSignalInDir(
  teamName: string,
  changedPath: string,
  signalDir: string,
  taskSignalKind: TaskFreshnessSignalKind,
  sink: TaskFreshnessSignalSink
): boolean {
  const relativePath = path.relative(signalDir, changedPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return path.normalize(changedPath) === path.normalize(signalDir);
  }

  if (relativePath === '.') {
    return true;
  }

  if (relativePath.includes(path.sep)) {
    return true;
  }

  const decoded = decodeTaskLogFreshnessTaskId(relativePath);
  if (decoded.kind === 'invalid') {
    return true;
  }
  if (decoded.kind === 'opaque-safe-segment') {
    void emitTaskFreshnessSignalFromFile(teamName, changedPath, taskSignalKind, sink);
    return true;
  }

  sink.emitTaskLogChange({ teamName, taskId: decoded.taskId, taskSignalKind });
  return true;
}

function routeTaskFreshnessSignalInRoots(
  teamName: string,
  changedPath: string,
  taskFreshnessRootDirs: readonly string[],
  sink: TaskFreshnessSignalSink
): boolean {
  for (const freshnessRootDir of taskFreshnessRootDirs) {
    if (
      routeTaskFreshnessSignalInDir(
        teamName,
        changedPath,
        path.join(freshnessRootDir, BOARD_TASK_LOG_FRESHNESS_DIRNAME),
        'log',
        sink
      )
    ) {
      return true;
    }
    if (
      routeTaskFreshnessSignalInDir(
        teamName,
        changedPath,
        path.join(freshnessRootDir, BOARD_TASK_CHANGE_FRESHNESS_DIRNAME),
        'change',
        sink
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Route one watcher path change. Returns true when the path belonged to a
 * freshness signal directory and was handled here, so the caller must not fall
 * through to generic log-source classification for it.
 */
export function routeTaskFreshnessSignalChange(
  teamName: string,
  changedPath: string,
  taskFreshnessDirs: TaskFreshnessDirs,
  sink: TaskFreshnessSignalSink
): boolean {
  for (const logSignalDir of taskFreshnessDirs.logSignalDirs) {
    if (routeTaskFreshnessSignalInDir(teamName, changedPath, logSignalDir, 'log', sink)) {
      return true;
    }
  }
  return routeTaskFreshnessSignalInRoots(
    teamName,
    changedPath,
    taskFreshnessDirs.legacyRootDirs,
    sink
  );
}
