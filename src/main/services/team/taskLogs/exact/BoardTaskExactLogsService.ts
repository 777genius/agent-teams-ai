import { BoardTaskActivityRecordSource } from '../activity/BoardTaskActivityRecordSource';

import { BoardTaskExactLogSummarySelector } from './BoardTaskExactLogSummarySelector';
import { mapCandidateToSummary } from './BoardTaskExactLogTypes';
import { isBoardTaskExactLogsReadEnabled } from './featureGates';
import { getBoardTaskExactLogFileVersions } from './fileVersions';

import type { BoardTaskExactLogSummariesResponse } from '@shared/types';

function compareSummaries(
  left: BoardTaskExactLogSummariesResponse['items'][number],
  right: BoardTaskExactLogSummariesResponse['items'][number]
): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  if (left.source.filePath !== right.source.filePath) {
    return left.source.filePath.localeCompare(right.source.filePath);
  }
  if (left.source.sourceOrder !== right.source.sourceOrder) {
    return left.source.sourceOrder - right.source.sourceOrder;
  }
  if ((left.source.toolUseId ?? '') !== (right.source.toolUseId ?? '')) {
    return (left.source.toolUseId ?? '').localeCompare(right.source.toolUseId ?? '');
  }
  return left.id.localeCompare(right.id);
}

export class BoardTaskExactLogsService {
  constructor(
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly summarySelector: BoardTaskExactLogSummarySelector = new BoardTaskExactLogSummarySelector()
  ) {}

  async getTaskExactLogSummaries(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskExactLogSummariesResponse> {
    if (!isBoardTaskExactLogsReadEnabled()) {
      return { items: [] };
    }

    const records = await this.recordSource.getTaskRecords(teamName, taskId);
    if (records.length === 0) {
      return { items: [] };
    }

    const fileVersionsByPath = await getBoardTaskExactLogFileVersions(
      records.map((record) => record.source.filePath)
    );

    const items = this.summarySelector
      .selectSummaries({
        records,
        fileVersionsByPath,
      })
      .map(mapCandidateToSummary)
      .sort(compareSummaries);

    return { items };
  }
}
