import { getTasksBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { TeamTask, TeamTaskStatus } from '@shared/types';

export class TeamTaskWriter {
  async createTask(teamName: string, task: TeamTask): Promise<void> {
    const tasksDir = path.join(getTasksBasePath(), teamName);
    await fs.promises.mkdir(tasksDir, { recursive: true });

    const taskPath = path.join(tasksDir, `${task.id}.json`);
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
    };

    await atomicWriteAsync(taskPath, JSON.stringify(cliCompatibleTask, null, 2));

    const verifyRaw = await fs.promises.readFile(taskPath, 'utf8');
    const verifyTask = JSON.parse(verifyRaw) as TeamTask;
    if (verifyTask.id !== task.id) {
      throw new Error(`Task create verification failed: ${task.id}`);
    }
  }

  async addBlocksEntry(
    teamName: string,
    targetTaskId: string,
    blockedTaskId: string
  ): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${targetTaskId}.json`);

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
  }

  async updateStatus(teamName: string, taskId: string, status: TeamTaskStatus): Promise<void> {
    const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);

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
  }
}
