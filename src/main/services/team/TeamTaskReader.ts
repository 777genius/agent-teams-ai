import { yieldToEventLoop } from '@main/utils/asyncYield';
import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { getTeamFsWorkerClient } from './TeamFsWorkerClient';

import type {
  AttachmentMediaType,
  StatusTransition,
  TaskAttachmentMeta,
  TaskComment,
  TaskWorkInterval,
  TeamTask,
  TeamTaskStatus,
} from '@shared/types';

const logger = createLogger('Service:TeamTaskReader');
const MAX_TASK_FILE_BYTES = 2 * 1024 * 1024;

const VALID_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set<AttachmentMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

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
        // CLI sometimes writes "title" instead of "subject" — normalize
        const subject =
          typeof parsed.subject === 'string'
            ? parsed.subject
            : typeof parsed.title === 'string'
              ? parsed.title
              : '';
        // Resolve createdAt: prefer JSON field, fallback to fs.stat (reuse fileStat from above)
        let createdAt: string | undefined;
        let updatedAt: string | undefined;
        if (typeof parsed.createdAt === 'string') {
          createdAt = parsed.createdAt;
        }
        try {
          if (!createdAt) {
            const bt = fileStat.birthtime.getTime();
            createdAt = (bt > 0 ? fileStat.birthtime : fileStat.mtime).toISOString();
          }
          updatedAt = fileStat.mtime.toISOString();
        } catch {
          /* leave undefined */
        }

        // `satisfies Record<keyof TeamTask, unknown>` ensures compile-time
        // safety: if a field is added to TeamTask but not mapped here,
        // TypeScript will error. This prevents silently dropping new fields.
        const statusHistory: StatusTransition[] | undefined = Array.isArray(parsed.statusHistory)
          ? (parsed.statusHistory as unknown[])
              .filter(
                (e): e is { from: string | null; to: string; timestamp: string; actor?: string } =>
                  Boolean(e) &&
                  typeof e === 'object' &&
                  ((e as Record<string, unknown>).from === null ||
                    typeof (e as Record<string, unknown>).from === 'string') &&
                  typeof (e as Record<string, unknown>).to === 'string' &&
                  typeof (e as Record<string, unknown>).timestamp === 'string' &&
                  ((e as Record<string, unknown>).actor === undefined ||
                    typeof (e as Record<string, unknown>).actor === 'string')
              )
              .map((e) => ({
                from: e.from as TeamTaskStatus | null,
                to: e.to as TeamTaskStatus,
                timestamp: e.timestamp,
                ...(e.actor ? { actor: e.actor } : {}),
              }))
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
          subject,
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
          activeForm: typeof parsed.activeForm === 'string' ? parsed.activeForm : undefined,
          owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
          createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : undefined,
          status: (['pending', 'in_progress', 'completed', 'deleted'] as const).includes(
            parsed.status as TeamTask['status']
          )
            ? (parsed.status as TeamTask['status'])
            : 'pending',
          workIntervals,
          statusHistory,
          blocks: Array.isArray(parsed.blocks) ? (parsed.blocks as string[]) : undefined,
          blockedBy: Array.isArray(parsed.blockedBy) ? (parsed.blockedBy as string[]) : undefined,
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
                  type: (['regular', 'review_request', 'review_approved'] as const).includes(c.type)
                    ? c.type
                    : ('regular' as const),
                  attachments: Array.isArray(c.attachments)
                    ? (c.attachments as unknown[]).filter(
                        (a): a is TaskAttachmentMeta =>
                          Boolean(a) &&
                          typeof a === 'object' &&
                          typeof (a as Record<string, unknown>).id === 'string' &&
                          typeof (a as Record<string, unknown>).filename === 'string' &&
                          typeof (a as Record<string, unknown>).mimeType === 'string' &&
                          VALID_ATTACHMENT_MIME_TYPES.has(
                            (a as Record<string, unknown>).mimeType as string
                          ) &&
                          typeof (a as Record<string, unknown>).size === 'number' &&
                          typeof (a as Record<string, unknown>).addedAt === 'string'
                      )
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
                .filter(
                  (a): a is TaskAttachmentMeta =>
                    Boolean(a) &&
                    typeof a === 'object' &&
                    typeof (a as Record<string, unknown>).id === 'string' &&
                    typeof (a as Record<string, unknown>).filename === 'string' &&
                    typeof (a as Record<string, unknown>).mimeType === 'string' &&
                    VALID_ATTACHMENT_MIME_TYPES.has(
                      (a as Record<string, unknown>).mimeType as string
                    ) &&
                    typeof (a as Record<string, unknown>).size === 'number' &&
                    typeof (a as Record<string, unknown>).addedAt === 'string'
                )
                .map((a) => ({
                  id: a.id,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                  addedAt: a.addedAt,
                }))
            : undefined,
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

        const subject =
          typeof parsed.subject === 'string'
            ? parsed.subject
            : typeof parsed.title === 'string'
              ? parsed.title
              : '';

        const task: TeamTask = {
          id:
            typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
          subject,
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
          owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
          status: 'deleted',
          deletedAt: typeof parsed.deletedAt === 'string' ? parsed.deletedAt : undefined,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
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
