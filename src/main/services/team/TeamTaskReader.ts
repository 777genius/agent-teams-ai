import { yieldToEventLoop } from '@main/utils/asyncYield';
import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import * as fs from 'fs';
import * as path from 'path';

import { getTeamFsWorkerClient } from './TeamFsWorkerClient';

import type {
  TaskAttachmentMeta,
  TaskComment,
  TaskHistoryEvent,
  TaskRef,
  TaskWorkInterval,
  TeamTask,
} from '@shared/types';

const logger = createLogger('Service:TeamTaskReader');
const MAX_TASK_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Normalise escaped newline sequences (`\\n`) that some MCP/CLI sources
 * write as literal two-character strings instead of real line-breaks.
 * Also handles `\\t` for consistency.  Only operates on isolated escape
 * sequences — already-real newlines are left untouched.
 */
function unescapeLiteralNewlines(text: string): string {
  // Replace literal two-char sequences \n and \t with real control chars.
  // The regex matches a single backslash followed by 'n' or 't'.
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function isValidMimeTypeString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  // Keep it reasonably bounded and avoid control characters.
  if (v.length > 200) return false;
  if (v.includes('\0') || /[\r\n]/.test(v)) return false;
  // Minimal MIME shape: type/subtype
  const slash = v.indexOf('/');
  if (slash <= 0 || slash === v.length - 1) return false;
  return true;
}

function normalizeTaskRefs(value: unknown): TaskRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const taskRefs = (value as unknown[])
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
    )
    .map((entry) => ({
      taskId: typeof entry.taskId === 'string' ? entry.taskId : '',
      displayId: typeof entry.displayId === 'string' ? entry.displayId : '',
      teamName: typeof entry.teamName === 'string' ? entry.teamName : '',
    }))
    .filter((entry) => entry.taskId && entry.displayId && entry.teamName);
  return taskRefs.length > 0 ? taskRefs : undefined;
}

export class TeamTaskReader {
  /**
   * Returns the next available numeric task ID by scanning ALL task files
   * (including _internal ones) to avoid ID collisions.
   */
  async getNextTaskId(teamName: string): Promise<string> {
    const tasksDir = path.join(getTasksBasePath(), teamName);

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '1';
      }
      throw error;
    }

    let maxId = 0;
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const num = Number(file.replace('.json', ''));
      if (Number.isFinite(num) && num > maxId) {
        maxId = num;
      }
    }

    return String(maxId + 1);
  }

  async getTasks(teamName: string): Promise<TeamTask[]> {
    const tasksDir = path.join(getTasksBasePath(), teamName);

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const tasks: TeamTask[] = [];
    let processed = 0;
    for (const file of entries) {
      if (
        !file.endsWith('.json') ||
        file.startsWith('.') ||
        file === '.lock' ||
        file === '.highwatermark'
      ) {
        continue;
      }

      const taskPath = path.join(tasksDir, file);
      try {
        const fileStat = await fs.promises.stat(taskPath);
        if (!fileStat.isFile() || fileStat.size > MAX_TASK_FILE_BYTES) {
          logger.debug(`Skipping suspicious task file: ${taskPath}`);
          continue;
        }
        const raw = await readFileUtf8WithTimeout(taskPath, 5_000);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Skip internal CLI tracking entries (spawned subagent bookkeeping)
        const metadata = parsed.metadata as Record<string, unknown> | undefined;
        if (metadata?._internal === true) {
          continue;
        }
        const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
        const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
        let updatedAt: string | undefined;
        try {
          updatedAt = fileStat.mtime.toISOString();
        } catch {
          /* leave undefined */
        }

        // `satisfies Record<keyof TeamTask, unknown>` ensures compile-time
        // safety: if a field is added to TeamTask but not mapped here,
        // TypeScript will error. This prevents silently dropping new fields.
        const historyEvents: TaskHistoryEvent[] | undefined = Array.isArray(parsed.historyEvents)
          ? (parsed.historyEvents as unknown[])
              .filter(
                (e): e is Record<string, unknown> =>
                  Boolean(e) &&
                  typeof e === 'object' &&
                  typeof (e as Record<string, unknown>).id === 'string' &&
                  typeof (e as Record<string, unknown>).timestamp === 'string' &&
                  typeof (e as Record<string, unknown>).type === 'string'
              )
              .map((e) => e as unknown as TaskHistoryEvent)
          : undefined;
        const workIntervals: TaskWorkInterval[] | undefined = Array.isArray(parsed.workIntervals)
          ? (parsed.workIntervals as unknown[])
              .filter(
                (i): i is { startedAt: string; completedAt?: string } =>
                  Boolean(i) &&
                  typeof i === 'object' &&
                  typeof (i as Record<string, unknown>).startedAt === 'string' &&
                  ((i as Record<string, unknown>).completedAt === undefined ||
                    typeof (i as Record<string, unknown>).completedAt === 'string')
              )
              .map((i) => ({
                startedAt: i.startedAt,
                completedAt: i.completedAt,
              }))
          : undefined;
        const task: TeamTask = {
          id:
            typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
          displayId:
            typeof parsed.displayId === 'string' && parsed.displayId.trim().length > 0
              ? parsed.displayId.trim()
              : deriveTaskDisplayId(
                  typeof parsed.id === 'string' || typeof parsed.id === 'number'
                    ? String(parsed.id)
                    : ''
                ),
          subject,
          description:
            typeof parsed.description === 'string'
              ? unescapeLiteralNewlines(parsed.description)
              : undefined,
          descriptionTaskRefs: normalizeTaskRefs(parsed.descriptionTaskRefs),
          activeForm: typeof parsed.activeForm === 'string' ? parsed.activeForm : undefined,
          prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
          promptTaskRefs: normalizeTaskRefs(parsed.promptTaskRefs),
          owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
          createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : undefined,
          status: (['pending', 'in_progress', 'completed', 'deleted'] as const).includes(
            parsed.status as TeamTask['status']
          )
            ? (parsed.status as TeamTask['status'])
            : 'pending',
          workIntervals,
          historyEvents,
          blocks: Array.isArray(parsed.blocks)
            ? (parsed.blocks as unknown[]).filter((id): id is string => typeof id === 'string')
            : undefined,
          blockedBy: Array.isArray(parsed.blockedBy)
            ? (parsed.blockedBy as unknown[]).filter((id): id is string => typeof id === 'string')
            : undefined,
          related: Array.isArray(parsed.related)
            ? (parsed.related as unknown[]).filter((id): id is string => typeof id === 'string')
            : undefined,
          createdAt,
          updatedAt,
          projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : undefined,
          comments: Array.isArray(parsed.comments)
            ? (parsed.comments as TaskComment[])
                .filter(
                  (c) =>
                    c &&
                    typeof c === 'object' &&
                    typeof c.id === 'string' &&
                    typeof c.author === 'string' &&
                    typeof c.text === 'string' &&
                    typeof c.createdAt === 'string'
                )
                .map((c) => ({
                  ...c,
                  text: unescapeLiteralNewlines(c.text),
                  type: (['regular', 'review_request', 'review_approved'] as const).includes(c.type)
                    ? c.type
                    : ('regular' as const),
                  taskRefs: normalizeTaskRefs((c as unknown as Record<string, unknown>).taskRefs),
                  attachments: Array.isArray(c.attachments)
                    ? (() => {
                        const filtered = (c.attachments as unknown[])
                          .filter((a): a is TaskAttachmentMeta => {
                            if (!a || typeof a !== 'object') return false;
                            const row = a as Record<string, unknown>;
                            const size = row.size;
                            return (
                              typeof row.id === 'string' &&
                              typeof row.filename === 'string' &&
                              typeof row.mimeType === 'string' &&
                              isValidMimeTypeString(row.mimeType) &&
                              typeof size === 'number' &&
                              Number.isFinite(size) &&
                              size >= 0 &&
                              typeof row.addedAt === 'string'
                            );
                          })
                          .map((a) => ({
                            id: a.id,
                            filename: a.filename,
                            mimeType: String(a.mimeType).trim(),
                            size: a.size,
                            addedAt: a.addedAt,
                          }));
                        return filtered.length > 0 ? filtered : undefined;
                      })()
                    : undefined,
                }))
            : undefined,
          needsClarification: (['lead', 'user'] as const).includes(
            parsed.needsClarification as 'lead' | 'user'
          )
            ? (parsed.needsClarification as 'lead' | 'user')
            : undefined,
          deletedAt: undefined, // deleted tasks are filtered out below
          attachments: Array.isArray(parsed.attachments)
            ? (parsed.attachments as unknown[])
                .filter((a): a is TaskAttachmentMeta => {
                  if (!a || typeof a !== 'object') return false;
                  const row = a as Record<string, unknown>;
                  const size = row.size;
                  return (
                    typeof row.id === 'string' &&
                    typeof row.filename === 'string' &&
                    typeof row.mimeType === 'string' &&
                    isValidMimeTypeString(row.mimeType) &&
                    typeof size === 'number' &&
                    Number.isFinite(size) &&
                    size >= 0 &&
                    typeof row.addedAt === 'string'
                  );
                })
                .map((a) => ({
                  id: a.id,
                  filename: a.filename,
                  mimeType: String(a.mimeType).trim(),
                  size: a.size,
                  addedAt: a.addedAt,
                }))
            : undefined,
          reviewState: getReviewStateFromTask({
            historyEvents,
            reviewState: parsed.reviewState as TeamTask['reviewState'],
          }),
        } satisfies Record<keyof TeamTask, unknown>;
        if (task.status === 'deleted') {
          continue;
        }
        tasks.push(task);
      } catch {
        logger.debug(`Skipping invalid task file: ${taskPath}`);
      }
      processed++;
      if (processed % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    // Sort by display ID first for stable human-facing ordering, then canonical id.
    tasks.sort((a, b) => {
      const aLabel = a.displayId ?? a.id;
      const bLabel = b.displayId ?? b.id;
      const aIsNumeric = /^\d+$/.test(aLabel);
      const bIsNumeric = /^\d+$/.test(bLabel);
      if (aIsNumeric && bIsNumeric) return Number(aLabel) - Number(bLabel);
      if (aIsNumeric) return -1;
      if (bIsNumeric) return 1;
      const byDisplay = aLabel.localeCompare(bLabel, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (byDisplay !== 0) return byDisplay;
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
    });

    return tasks;
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    const tasksDir = path.join(getTasksBasePath(), teamName);

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const tasks: TeamTask[] = [];
    let processed = 0;
    for (const file of entries) {
      if (
        !file.endsWith('.json') ||
        file.startsWith('.') ||
        file === '.lock' ||
        file === '.highwatermark'
      ) {
        continue;
      }

      const taskPath = path.join(tasksDir, file);
      try {
        const fileStat = await fs.promises.stat(taskPath);
        if (!fileStat.isFile() || fileStat.size > MAX_TASK_FILE_BYTES) {
          logger.debug(`Skipping suspicious task file: ${taskPath}`);
          continue;
        }
        const raw = await readFileUtf8WithTimeout(taskPath, 5_000);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Skip internal CLI tracking entries
        const metadata = parsed.metadata as Record<string, unknown> | undefined;
        if (metadata?._internal === true) {
          continue;
        }
        if (parsed.status !== 'deleted') {
          continue;
        }

        const subject = typeof parsed.subject === 'string' ? parsed.subject : '';

        const task: TeamTask = {
          id:
            typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
          displayId:
            typeof parsed.displayId === 'string' && parsed.displayId.trim().length > 0
              ? parsed.displayId.trim()
              : deriveTaskDisplayId(
                  typeof parsed.id === 'string' || typeof parsed.id === 'number'
                    ? String(parsed.id)
                    : ''
                ),
          subject,
          description:
            typeof parsed.description === 'string'
              ? unescapeLiteralNewlines(parsed.description)
              : undefined,
          owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
          status: 'deleted',
          deletedAt: typeof parsed.deletedAt === 'string' ? parsed.deletedAt : undefined,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
          reviewState: getReviewStateFromTask({
            reviewState: parsed.reviewState as TeamTask['reviewState'],
          }),
        };

        tasks.push(task);
      } catch {
        logger.debug(`Skipping invalid task file: ${taskPath}`);
      }
      processed++;
      if (processed % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    return tasks;
  }

  async getAllTasks(): Promise<(TeamTask & { teamName: string })[]> {
    const worker = getTeamFsWorkerClient();
    if (worker.isAvailable()) {
      const startedAt = Date.now();
      try {
        const { tasks, diag } = await worker.getAllTasks({
          maxTaskBytes: MAX_TASK_FILE_BYTES,
        });
        const ms = Date.now() - startedAt;
        const skipReasons =
          diag && typeof diag === 'object' ? (diag as Record<string, unknown>).skipReasons : null;
        if (skipReasons && typeof skipReasons === 'object') {
          const bad =
            Number((skipReasons as Record<string, unknown>).task_parse_failed ?? 0) +
            Number((skipReasons as Record<string, unknown>).task_read_timeout ?? 0);
          if (bad > 0) {
            logger.warn(`[getAllTasks] worker skipped broken task files count=${bad}`);
          }
        }
        if (ms >= 2000) {
          logger.warn(`[getAllTasks] worker slow ms=${ms} diag=${JSON.stringify(diag)}`);
        }
        return tasks;
      } catch (error) {
        logger.warn(
          `[getAllTasks] worker failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // fall back
      }
    }

    const tasksBase = getTasksBasePath();

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(tasksBase, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const result: (TeamTask & { teamName: string })[] = [];
    let dirCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const tasks = await this.getTasks(entry.name);
        for (const task of tasks) {
          result.push({ ...task, teamName: entry.name });
        }
      } catch {
        logger.debug(`Skipping tasks dir: ${entry.name}`);
      }
      dirCount++;
      if (dirCount % 2 === 0) {
        // Yield periodically to keep the main process responsive in worst-case directories.
        await yieldToEventLoop();
      }
    }

    return result;
  }
}
