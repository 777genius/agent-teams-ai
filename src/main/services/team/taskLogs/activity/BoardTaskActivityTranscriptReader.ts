import { yieldToEventLoop } from '@main/utils/asyncYield';
import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';

import {
  parseBoardTaskLinks,
  parseBoardTaskToolActions,
  type ParsedBoardTaskLink,
  type ParsedBoardTaskToolAction,
} from '../contract/BoardTaskTranscriptContract';

import { BoardTaskActivityParseCache } from './BoardTaskActivityParseCache';

const logger = createLogger('Service:BoardTaskActivityTranscriptReader');

export interface RawTaskActivityMessage {
  filePath: string;
  uuid: string;
  timestamp: string;
  sessionId: string;
  agentId?: string;
  agentName?: string;
  isSidechain: boolean;
  boardTaskLinks: ParsedBoardTaskLink[];
  boardTaskToolActions: ParsedBoardTaskToolAction[];
  sourceOrder: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export class BoardTaskActivityTranscriptReader {
  private readonly cache = new BoardTaskActivityParseCache<RawTaskActivityMessage[]>();

  async readFiles(filePaths: string[]): Promise<RawTaskActivityMessage[]> {
    const uniqueFilePaths = [...new Set(filePaths)].sort();
    this.cache.retainOnly(new Set(uniqueFilePaths));

    const parsedFiles = await Promise.all(
      uniqueFilePaths.map((filePath) => this.readFile(filePath))
    );
    return parsedFiles.flat();
  }

  private async readFile(filePath: string): Promise<RawTaskActivityMessage[]> {
    try {
      const stat = await fs.stat(filePath);
      const cached = this.cache.getIfFresh(filePath, stat.mtimeMs, stat.size);
      if (cached) {
        return cached;
      }

      const inFlight = this.cache.getInFlight(filePath);
      if (inFlight) {
        return inFlight;
      }

      const promise = this.parseFile(filePath);
      this.cache.setInFlight(filePath, promise);
      try {
        const parsed = await promise;
        this.cache.set(filePath, stat.mtimeMs, stat.size, parsed);
        return parsed;
      } finally {
        this.cache.clearInFlight(filePath);
      }
    } catch (error) {
      logger.debug(`Skipping unreadable task-activity transcript ${filePath}: ${String(error)}`);
      this.cache.clearForPath(filePath);
      return [];
    }
  }

  private async parseFile(filePath: string): Promise<RawTaskActivityMessage[]> {
    const results: RawTaskActivityMessage[] = [];
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let sourceOrder = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line) as unknown;
        const record = asRecord(parsed);
        if (!record) continue;

        const uuid = typeof record.uuid === 'string' ? record.uuid : '';
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
        const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
        if (!uuid || !sessionId || !timestamp) continue;

        const boardTaskLinks = parseBoardTaskLinks(record.boardTaskLinks);
        if (boardTaskLinks.length === 0) continue;

        sourceOrder += 1;
        results.push({
          filePath,
          uuid,
          timestamp,
          sessionId,
          agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
          agentName: typeof record.agentName === 'string' ? record.agentName : undefined,
          isSidechain: record.isSidechain === true,
          boardTaskLinks,
          boardTaskToolActions: parseBoardTaskToolActions(record.boardTaskToolActions),
          sourceOrder,
        });
      } catch (error) {
        logger.debug(`Skipping malformed task-activity line in ${filePath}: ${String(error)}`);
      }

      if (sourceOrder > 0 && sourceOrder % 250 === 0) {
        await yieldToEventLoop();
      }
    }
    return results;
  }
}
