import { BoardTaskActivityEntryBuilder } from './BoardTaskActivityEntryBuilder';
import { BoardTaskActivityRecordSource } from './BoardTaskActivityRecordSource';
import { isBoardTaskActivityReadEnabled } from './featureGates';

import type { BoardTaskActivityEntry } from '@shared/types';

export class BoardTaskActivityService {
  constructor(
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly entryBuilder: BoardTaskActivityEntryBuilder = new BoardTaskActivityEntryBuilder()
  ) {}

  async getTaskActivity(teamName: string, taskId: string): Promise<BoardTaskActivityEntry[]> {
    if (!isBoardTaskActivityReadEnabled()) {
      return [];
    }

    const records = await this.recordSource.getTaskRecords(teamName, taskId);
    return this.entryBuilder.buildFromRecords(records);
  }
}
