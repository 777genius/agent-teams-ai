import { getTasksBasePath } from '@main/utils/pathDecoder';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { TaskComment, TeamTask, TeamTaskStatus } from '@shared/types';

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
      const cliCompatibleTask: TeamTask = {
        ...task,
        description: task.description ?? '',
        blocks: task.blocks ?? [],
        blockedBy: task.blockedBy ?? [],
        related: task.related ?? [],
        createdAt: task.createdAt ?? new Date().toISOString(),
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
      task.status = status;
      await atomicWriteAsync(taskPath, JSON.stringify(task, null, 2));

      const verifyRaw = await fs.promises.readFile(taskPath, 'utf8');
      const verifyTask = JSON.parse(verifyRaw) as TeamTask;
      if (verifyTask.status !== status) {
        throw new Error(`Task status update verification failed: ${taskId}`);
      }
    });
  }

  async addComment(
    teamName: string,
    taskId: string,
    text: string,
    options?: { id?: string; author?: string; createdAt?: string }
  ): Promise<TaskComment> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);
    const comment: TaskComment = {
      id: options?.id ?? randomUUID(),
      author: options?.author ?? 'user',
      text,
      createdAt: options?.createdAt ?? new Date().toISOString(),
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
