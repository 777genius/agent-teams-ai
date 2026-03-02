import { getTasksBasePath } from '@main/utils/pathDecoder';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { TaskComment, TaskCommentType, TeamTask, TeamTaskStatus } from '@shared/types';

const taskWriteLocks = new Map<string, Promise<void>>();

async function withTaskLock<T>(taskPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskWriteLocks.get(taskPath) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  taskWriteLocks.set(taskPath, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (taskWriteLocks.get(taskPath) === mine) {
      taskWriteLocks.delete(taskPath);
    }
  }
}

export class TeamTaskWriter {
  async createTask(teamName: string, task: TeamTask): Promise<void> {
    const tasksDir = path.join(getTasksBasePath(), teamName);
    await fs.promises.mkdir(tasksDir, { recursive: true });

    const taskPath = path.join(tasksDir, `${task.id}.json`);

    await withTaskLock(taskPath, async () => {
      try {
        await fs.promises.access(taskPath, fs.constants.F_OK);
        throw new Error(`Task already exists: ${task.id}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      // Ensure CLI-compatible format: description, blocks, blockedBy are required
      // by Claude Code CLI's Zod schema validation (safeParse fails without them)
      const createdAt = task.createdAt ?? new Date().toISOString();
      const cliCompatibleTask: TeamTask = {
        ...task,
        description: task.description ?? '',
        blocks: task.blocks ?? [],
        blockedBy: task.blockedBy ?? [],
        related: task.related ?? [],
        createdAt,
        workIntervals:
          task.status === 'in_progress'
            ? // Start the first work interval on creation when task starts immediately.
              [
                ...(Array.isArray(task.workIntervals) && task.workIntervals.length > 0
                  ? task.workIntervals
                  : [{ startedAt: createdAt }]),
              ]
            : task.workIntervals,
      };

      await atomicWriteAsync(taskPath, JSON.stringify(cliCompatibleTask, null, 2));

      const verifyRaw = await fs.promises.readFile(taskPath, 'utf8');
      const verifyTask = JSON.parse(verifyRaw) as TeamTask;
      if (verifyTask.id !== task.id) {
        throw new Error(`Task create verification failed: ${task.id}`);
      }
    });
  }

  async addBlocksEntry(
    teamName: string,
    targetTaskId: string,
    blockedTaskId: string
  ): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${targetTaskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return; // Target task doesn't exist — skip silently
        }
        throw error;
      }

      const task = JSON.parse(raw) as TeamTask;
      const blocks = task.blocks ?? [];
      if (!blocks.includes(blockedTaskId)) {
        task.blocks = [...blocks, blockedTaskId];
        await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
      }
    });
  }

  async addRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    if (taskId === targetId) {
      throw new Error('Cannot link a task to itself');
    }

    // For 'blocks', delegate as reverse blockedBy (swap task/target intentionally)
    if (type === 'blocks') {
      const swappedTask = targetId;
      const swappedTarget = taskId;
      return this.addRelationship(teamName, swappedTask, swappedTarget, 'blockedBy');
    }

    const tasksDir = path.join(getTasksBasePath(), teamName);
    const taskPath = path.join(tasksDir, `${taskId}.json`);
    const targetPath = path.join(tasksDir, `${targetId}.json`);

    // Lock both paths in sorted order to avoid deadlocks
    const [firstPath, secondPath] =
      taskPath < targetPath ? [taskPath, targetPath] : [targetPath, taskPath];

    await withTaskLock(firstPath, () =>
      withTaskLock(secondPath, async () => {
        // Read both tasks
        const taskRaw = await this.readTaskFile(taskPath, taskId);
        const targetRaw = await this.readTaskFile(targetPath, targetId);
        const task = JSON.parse(taskRaw) as TeamTask;
        const target = JSON.parse(targetRaw) as TeamTask;

        if (type === 'blockedBy') {
          // Cycle detection: walk target's blockedBy chain to check if taskId is reachable
          await this.checkBlockCycle(tasksDir, taskId, targetId);

          // task.blockedBy += targetId
          const blockedBy = task.blockedBy ?? [];
          if (!blockedBy.includes(targetId)) {
            task.blockedBy = [...blockedBy, targetId];
            await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
          }
          // target.blocks += taskId (reverse)
          const blocks = target.blocks ?? [];
          if (!blocks.includes(taskId)) {
            target.blocks = [...blocks, taskId];
            await atomicWriteAsync(targetPath, JSON.stringify(target, null, 2));
          }
        } else {
          // related — bidirectional
          const relA = task.related ?? [];
          if (!relA.includes(targetId)) {
            task.related = [...relA, targetId];
            await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
          }
          const relB = target.related ?? [];
          if (!relB.includes(taskId)) {
            target.related = [...relB, taskId];
            await atomicWriteAsync(targetPath, JSON.stringify(target, null, 2));
          }
        }
      })
    );
  }

  async removeRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    // For 'blocks', delegate as reverse blockedBy (swap task/target intentionally)
    if (type === 'blocks') {
      const swappedTask = targetId;
      const swappedTarget = taskId;
      return this.removeRelationship(teamName, swappedTask, swappedTarget, 'blockedBy');
    }

    const tasksDir = path.join(getTasksBasePath(), teamName);
    const taskPath = path.join(tasksDir, `${taskId}.json`);
    const targetPath = path.join(tasksDir, `${targetId}.json`);

    const [firstPath, secondPath] =
      taskPath < targetPath ? [taskPath, targetPath] : [targetPath, taskPath];

    await withTaskLock(firstPath, () =>
      withTaskLock(secondPath, async () => {
        // Read task (must exist)
        const taskRaw = await this.readTaskFile(taskPath, taskId);
        const task = JSON.parse(taskRaw) as TeamTask;

        if (type === 'blockedBy') {
          task.blockedBy = (task.blockedBy ?? []).filter((id) => id !== targetId);
          await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));

          // Remove reverse from target if it exists
          try {
            const targetRaw = await fs.promises.readFile(targetPath, 'utf8');
            const target = JSON.parse(targetRaw) as TeamTask;
            target.blocks = (target.blocks ?? []).filter((id) => id !== taskId);
            await atomicWriteAsync(targetPath, JSON.stringify(target, null, 2));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // Target doesn't exist — skip silently
          }
        } else {
          // related — remove bidirectional
          task.related = (task.related ?? []).filter((id) => id !== targetId);
          await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));

          try {
            const targetRaw = await fs.promises.readFile(targetPath, 'utf8');
            const target = JSON.parse(targetRaw) as TeamTask;
            target.related = (target.related ?? []).filter((id) => id !== taskId);
            await atomicWriteAsync(targetPath, JSON.stringify(target, null, 2));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      })
    );
  }

  private async readTaskFile(taskPath: string, taskId: string): Promise<string> {
    try {
      return await fs.promises.readFile(taskPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Task not found: ${taskId}`);
      }
      throw error;
    }
  }

  /**
   * Walks targetId's blockedBy chain to detect if sourceId is reachable.
   * Reads are outside locks (deliberate TOCTOU trade-off — the calling method
   * holds locks on both source and target, and only other tasks are read here).
   */
  private async checkBlockCycle(
    tasksDir: string,
    sourceId: string,
    targetId: string
  ): Promise<void> {
    const visited = new Set<string>();
    const stack = [targetId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === sourceId) {
        throw new Error(`Circular dependency: #${targetId} already depends on #${sourceId}`);
      }
      if (visited.has(current)) continue;
      visited.add(current);

      try {
        const raw = await fs.promises.readFile(path.join(tasksDir, `${current}.json`), 'utf8');
        const task = JSON.parse(raw) as TeamTask;
        if (Array.isArray(task.blockedBy)) {
          for (const dep of task.blockedBy) {
            stack.push(dep);
          }
        }
      } catch {
        // Skip unreadable tasks
      }
    }
  }

  async updateStatus(teamName: string, taskId: string, status: TeamTaskStatus): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Task not found: ${taskId}`);
        }
        throw error;
      }

      const task = JSON.parse(raw) as TeamTask;
      const prevStatus = task.status;
      const nowIso = new Date().toISOString();

      // Maintain workIntervals as periods of time where status === 'in_progress'.
      const intervals = Array.isArray(task.workIntervals) ? [...task.workIntervals] : [];
      const last = intervals.length > 0 ? intervals[intervals.length - 1] : undefined;

      const wasInProgress = prevStatus === 'in_progress';
      const isInProgress = status === 'in_progress';

      if (!wasInProgress && isInProgress) {
        // Entering in_progress: open a new interval if none is open.
        if (!last || typeof last.completedAt === 'string') {
          intervals.push({ startedAt: nowIso });
        }
      } else if (wasInProgress && !isInProgress) {
        // Leaving in_progress: close open interval if present.
        if (last && last.completedAt === undefined) {
          last.completedAt = nowIso;
        }
      }

      task.workIntervals = intervals.length > 0 ? intervals : undefined;
      task.status = status;
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));

      const verifyRaw = await fs.promises.readFile(taskPath, 'utf8');
      const verifyTask = JSON.parse(verifyRaw) as TeamTask;
      if (verifyTask.status !== status) {
        throw new Error(`Task status update verification failed: ${taskId}`);
      }
    });
  }

  async updateOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Task not found: ${taskId}`);
        }
        throw error;
      }

      const task = JSON.parse(raw) as TeamTask;
      if (owner) {
        task.owner = owner;
      } else {
        delete task.owner;
      }
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
    });
  }

  async softDelete(teamName: string, taskId: string): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Task not found: ${taskId}`);
        }
        throw error;
      }

      const task = JSON.parse(raw) as TeamTask;
      const nowIso = new Date().toISOString();

      // Ensure any open in_progress interval is closed on delete.
      if (task.status === 'in_progress') {
        const intervals = Array.isArray(task.workIntervals) ? [...task.workIntervals] : [];
        const last = intervals.length > 0 ? intervals[intervals.length - 1] : undefined;
        if (last && last.completedAt === undefined) {
          last.completedAt = nowIso;
        }
        task.workIntervals = intervals.length > 0 ? intervals : task.workIntervals;
      }

      task.status = 'deleted';
      task.deletedAt = nowIso;
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));

      const verifyRaw = await fs.promises.readFile(taskPath, 'utf8');
      const verifyTask = JSON.parse(verifyRaw) as TeamTask;
      if (verifyTask.status !== 'deleted') {
        throw new Error(`Task soft-delete verification failed: ${taskId}`);
      }
    });
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Task not found: ${taskId}`);
        }
        throw error;
      }

      const task = JSON.parse(raw) as TeamTask;
      task.status = 'pending';
      delete task.deletedAt;
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
    });
  }

  async updateFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Task not found: ${taskId}`);
        }
        throw error;
      }

      const task = JSON.parse(raw) as TeamTask;
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
      }
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
    });
  }

  async setNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

    await withTaskLock(taskPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(taskPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Task not found: ${taskId}`);
        }
        throw error;
      }

      const task = JSON.parse(raw) as Record<string, unknown>;
      if (value) {
        task.needsClarification = value;
      } else {
        delete task.needsClarification;
      }
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));
    });
  }

  async addComment(
    teamName: string,
    taskId: string,
    text: string,
    options?: { id?: string; author?: string; createdAt?: string; type?: TaskCommentType }
  ): Promise<TaskComment> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);
    const comment: TaskComment = {
      id: options?.id ?? randomUUID(),
      author: options?.author ?? 'user',
      text,
      createdAt: options?.createdAt ?? new Date().toISOString(),
      type: options?.type ?? 'regular',
    };

    await withTaskLock(taskPath, async () => {
      const raw = await fs.promises.readFile(taskPath, 'utf8');
      const task = JSON.parse(raw) as Record<string, unknown>;
      const existing = Array.isArray(task.comments) ? (task.comments as TaskComment[]) : [];
      // Dedup by ID — skip if comment with same ID already exists
      if (existing.some((c) => c.id === comment.id)) {
        return;
      }
      task.comments = [...existing, comment];
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));

      const verifyRaw = await fs.promises.readFile(taskPath, 'utf8');
      const verified = JSON.parse(verifyRaw) as Record<string, unknown>;
      const verifiedComments = Array.isArray(verified.comments)
        ? (verified.comments as TaskComment[])
        : [];
      if (!verifiedComments.some((c) => c.id === comment.id)) {
        throw new Error(`Comment write verification failed for task: ${taskId}`);
      }
    });

    return comment;
  }
}
