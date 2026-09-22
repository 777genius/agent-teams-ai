import { BoardTaskActivityRecordSource } from '../activity/BoardTaskActivityRecordSource';

import { BoardTaskExactLogChunkBuilder } from './BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogDetailSelector } from './BoardTaskExactLogDetailSelector';
import { BoardTaskExactLogStrictParser } from './BoardTaskExactLogStrictParser';
import { BoardTaskExactLogSummarySelector } from './BoardTaskExactLogSummarySelector';
import { isBoardTaskExactLogsReadEnabled } from './featureGates';
import { getBoardTaskExactLogFileVersions } from './fileVersions';

import type { BoardTaskExactLogDetailResult } from '@shared/types';

export class BoardTaskExactLogDetailService {
  constructor(
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly summarySelector: BoardTaskExactLogSummarySelector = new BoardTaskExactLogSummarySelector(),
    private readonly strictParser: BoardTaskExactLogStrictParser = new BoardTaskExactLogStrictParser(),
    private readonly detailSelector: BoardTaskExactLogDetailSelector = new BoardTaskExactLogDetailSelector(),
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder = new BoardTaskExactLogChunkBuilder()
  ) {}

  async getTaskExactLogDetail(
    teamName: string,
    taskId: string,
    exactLogId: string,
    expectedSourceGeneration: string
  ): Promise<BoardTaskExactLogDetailResult> {
    if (!isBoardTaskExactLogsReadEnabled()) {
      return { status: 'missing' };
    }

    const records = await this.recordSource.getTaskRecords(teamName, taskId);
    if (records.length === 0) {
      return { status: 'missing' };
    }

    const fileVersionsByPath = await getBoardTaskExactLogFileVersions(
      records.map((record) => record.source.filePath)
    );

    const candidate = this.summarySelector
      .selectSummaries({
        records,
        fileVersionsByPath,
      })
      .find((item) => item.id === exactLogId);

    if (!candidate) {
      return { status: 'missing' };
    }
    if (!candidate.canLoadDetail) {
      return { status: 'missing' };
    }
    if (candidate.sourceGeneration !== expectedSourceGeneration) {
      return { status: 'stale' };
    }

    const parsedMessagesByFile = await this.strictParser.parseFiles([candidate.source.filePath]);
    const detailCandidate = this.detailSelector.selectDetail({
      candidate,
      records,
      parsedMessagesByFile,
    });

    if (!detailCandidate) {
      return { status: 'missing' };
    }

    const chunks = this.chunkBuilder.buildBundleChunks(detailCandidate.filteredMessages);
    return {
      status: 'ok',
      detail: {
        id: detailCandidate.id,
        chunks,
      },
    };
  }
}
