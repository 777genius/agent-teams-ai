import { TeamTaskReader } from '../../TeamTaskReader';
import { TeamTranscriptSourceLocator } from '../discovery/TeamTranscriptSourceLocator';

import { BoardTaskActivityRecordBuilder } from './BoardTaskActivityRecordBuilder';
import { BoardTaskActivityTranscriptReader } from './BoardTaskActivityTranscriptReader';

import type { BoardTaskActivityRecord } from './BoardTaskActivityRecord';

export class BoardTaskActivityRecordSource {
  constructor(
    private readonly transcriptSourceLocator: TeamTranscriptSourceLocator = new TeamTranscriptSourceLocator(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly transcriptReader: BoardTaskActivityTranscriptReader = new BoardTaskActivityTranscriptReader(),
    private readonly recordBuilder: BoardTaskActivityRecordBuilder = new BoardTaskActivityRecordBuilder()
  ) {}

  async getTaskRecords(teamName: string, taskId: string): Promise<BoardTaskActivityRecord[]> {
    const [activeTasks, deletedTasks, transcriptFiles] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.transcriptSourceLocator.listTranscriptFiles(teamName),
    ]);

    const tasks = [...activeTasks, ...deletedTasks];
    const targetTask = tasks.find((task) => task.id === taskId);
    if (!targetTask || transcriptFiles.length === 0) {
      return [];
    }

    const messages = await this.transcriptReader.readFiles(transcriptFiles);
    return this.recordBuilder.buildForTask({
      teamName,
      targetTask,
      tasks,
      messages,
    });
  }
}
