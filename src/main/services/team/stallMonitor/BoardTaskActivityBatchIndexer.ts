import { BoardTaskActivityRecordBuilder } from '../taskLogs/activity/BoardTaskActivityRecordBuilder';

import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { RawTaskActivityMessage } from '../taskLogs/activity/BoardTaskActivityTranscriptReader';
import type { TeamTask } from '@shared/types';

export class BoardTaskActivityBatchIndexer {
  constructor(
    private readonly recordBuilder: Pick<
      BoardTaskActivityRecordBuilder,
      'buildForTasks'
    > = new BoardTaskActivityRecordBuilder()
  ) {}

  buildIndex(args: {
    teamName: string;
    tasks: TeamTask[];
    messages: RawTaskActivityMessage[];
  }): Map<string, BoardTaskActivityRecord[]> {
    if (args.tasks.length === 0 || args.messages.length === 0) {
      return new Map();
    }

    return this.recordBuilder.buildForTasks({
      teamName: args.teamName,
      tasks: args.tasks,
      messages: args.messages,
    });
  }
}
