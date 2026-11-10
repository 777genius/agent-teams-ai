import { TeamTaskReader } from '../../TeamTaskReader';
import { TeamTranscriptSourceLocator } from '../discovery/TeamTranscriptSourceLocator';

import { BoardTaskActivityRecordBuilder } from './BoardTaskActivityRecordBuilder';
import { BoardTaskActivityTranscriptReader } from './BoardTaskActivityTranscriptReader';

import type { BoardTaskActivityRecord } from './BoardTaskActivityRecord';
import type { TeamTask } from '@shared/types';

const TASK_ACTIVITY_INDEX_CACHE_TTL_MS = 1_000;

interface TaskActivityIndex {
  expiresAt: number;
  generation: number;
  tasksById: Map<string, TeamTask>;
  recordsByTaskId: Map<string, BoardTaskActivityRecord[]>;
}

export class BoardTaskActivityRecordSource {
  private readonly indexCache = new Map<string, TaskActivityIndex>();
  private readonly indexInFlight = new Map<
    string,
    { generation: number; promise: Promise<TaskActivityIndex> }
  >();

  constructor(
    private readonly transcriptSourceLocator: TeamTranscriptSourceLocator = new TeamTranscriptSourceLocator(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly transcriptReader: BoardTaskActivityTranscriptReader = new BoardTaskActivityTranscriptReader(),
    private readonly recordBuilder: Pick<
      BoardTaskActivityRecordBuilder,
      'buildForTasks'
    > = new BoardTaskActivityRecordBuilder()
  ) {}

  async getTaskRecords(teamName: string, taskId: string): Promise<BoardTaskActivityRecord[]> {
    const index = await this.getTaskActivityIndex(teamName);
    if (!index.tasksById.has(taskId)) {
      return [];
    }
    return [...(index.recordsByTaskId.get(taskId) ?? [])];
  }

  private async getTaskActivityIndex(teamName: string): Promise<TaskActivityIndex> {
    const generation = this.getTranscriptDiscoveryGeneration(teamName);
    const cached = this.indexCache.get(teamName);
    if (cached?.generation === generation && cached.expiresAt > Date.now()) {
      return cached;
    }

    const existingInFlight = this.indexInFlight.get(teamName);
    if (existingInFlight?.generation === generation) {
      return await existingInFlight.promise;
    }

    const promise = this.buildTaskActivityIndex(teamName, generation)
      .then((index) => {
        if (this.getTranscriptDiscoveryGeneration(teamName) === generation) {
          this.indexCache.set(teamName, index);
        }
        return index;
      })
      .finally(() => {
        if (this.indexInFlight.get(teamName)?.promise === promise) {
          this.indexInFlight.delete(teamName);
        }
      });
    this.indexInFlight.set(teamName, { generation, promise });
    return await promise;
  }

  private getTranscriptDiscoveryGeneration(teamName: string): number {
    const locator = this.transcriptSourceLocator as {
      getGeneration?: (teamName: string) => number;
    };
    return locator.getGeneration?.(teamName) ?? 0;
  }

  private async buildTaskActivityIndex(
    teamName: string,
    generation: number
  ): Promise<TaskActivityIndex> {
    const [activeTasks, deletedTasks, transcriptFiles] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.listTranscriptFiles(teamName),
    ]);

    const tasks = [...activeTasks, ...deletedTasks];
    const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
    if (tasks.length === 0 || transcriptFiles.length === 0) {
      return {
        expiresAt: Date.now() + TASK_ACTIVITY_INDEX_CACHE_TTL_MS,
        generation,
        tasksById,
        recordsByTaskId: new Map(),
      };
    }

    const messages = await this.transcriptReader.readFiles(transcriptFiles);
    const recordsByTaskId = this.recordBuilder.buildForTasks({
      teamName,
      tasks,
      messages,
    });
    return {
      expiresAt: Date.now() + TASK_ACTIVITY_INDEX_CACHE_TTL_MS,
      generation,
      tasksById,
      recordsByTaskId,
    };
  }

  private async listTranscriptFiles(teamName: string): Promise<string[]> {
    const locator = this.transcriptSourceLocator as {
      getContext?: (teamName: string) => Promise<{ transcriptFiles: string[] } | null>;
      listTranscriptFiles?: (teamName: string) => Promise<string[]>;
    };
    const context = await locator.getContext?.(teamName);
    if (context) {
      return context.transcriptFiles;
    }
    return (await locator.listTranscriptFiles?.(teamName)) ?? [];
  }
}
