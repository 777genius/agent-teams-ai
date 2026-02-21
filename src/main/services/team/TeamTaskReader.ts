import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { TeamTask } from '@shared/types';

const logger = createLogger('Service:TeamTaskReader');

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
        const raw = await fs.promises.readFile(taskPath, 'utf8');
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
        const task: TeamTask = {
          id: typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
          subject,
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
          activeForm: typeof parsed.activeForm === 'string' ? parsed.activeForm : undefined,
          owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
          status: (['pending', 'in_progress', 'completed', 'deleted'] as const).includes(
            parsed.status as TeamTask['status']
          )
            ? (parsed.status as TeamTask['status'])
            : 'pending',
          blocks: Array.isArray(parsed.blocks) ? (parsed.blocks as string[]) : undefined,
          blockedBy: Array.isArray(parsed.blockedBy) ? (parsed.blockedBy as string[]) : undefined,
        };
        if (task.status === 'deleted') {
          continue;
        }
        tasks.push(task);
      } catch {
        logger.debug(`Skipping invalid task file: ${taskPath}`);
      }
    }

    return tasks;
  }
}
