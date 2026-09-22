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
import { TranscriptSessionActorContextTracker } from '../TranscriptSessionActorContext';

import { BoardTaskActivityParseCache } from './BoardTaskActivityParseCache';

const logger = createLogger('Service:BoardTaskActivityTranscriptReader');
const TASK_ACTIVITY_TRANSCRIPT_READ_CONCURRENCY = process.platform === 'win32' ? 4 : 8;
const TASK_ACTIVITY_TRANSCRIPT_READ_WARN_MS = 3_000;

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

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function lineMayContainTaskActivityOrActorContext(line: string): boolean {
  return (
    line.includes('"boardTaskLinks"') || line.includes('"agentName"') || line.includes('"agentId"')
  );
}

export class BoardTaskActivityTranscriptReader {
  private readonly cache = new BoardTaskActivityParseCache<RawTaskActivityMessage[]>();

  async readFiles(filePaths: string[]): Promise<RawTaskActivityMessage[]> {
    const uniqueFilePaths = [...new Set(filePaths)].sort();
    this.cache.retainOnly(new Set(uniqueFilePaths));

    const startedAt = Date.now();
    const parsedFiles = await mapLimit(
      uniqueFilePaths,
      TASK_ACTIVITY_TRANSCRIPT_READ_CONCURRENCY,
      (filePath) => this.readFile(filePath)
    );
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= TASK_ACTIVITY_TRANSCRIPT_READ_WARN_MS) {
      logger.warn(
        `Slow task-activity transcript read: files=${uniqueFilePaths.length} records=${parsedFiles.reduce(
          (sum, rows) => sum + rows.length,
          0
        )} elapsedMs=${elapsedMs}`
      );
    }
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
    const actorContextTracker = new TranscriptSessionActorContextTracker();
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let sourceOrder = 0;
    let lineCount = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount += 1;
      if (!lineMayContainTaskActivityOrActorContext(line)) {
        if (lineCount % 500 === 0) {
          await yieldToEventLoop();
        }
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        const record = asRecord(parsed);
        if (!record) continue;
        actorContextTracker.remember(record);

        if (!line.includes('"boardTaskLinks"')) {
          continue;
        }

        const uuid = typeof record.uuid === 'string' ? record.uuid : '';
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
        const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
        if (!uuid || !sessionId || !timestamp) continue;

        const boardTaskLinks = parseBoardTaskLinks(record.boardTaskLinks);
        if (boardTaskLinks.length === 0) continue;
        const contextRecord = actorContextTracker.apply(record);

        sourceOrder += 1;
        results.push({
          filePath,
          uuid,
          timestamp,
          sessionId,
          agentId: typeof contextRecord.agentId === 'string' ? contextRecord.agentId : undefined,
          agentName:
            typeof contextRecord.agentName === 'string' ? contextRecord.agentName : undefined,
          isSidechain: contextRecord.isSidechain === true,
          boardTaskLinks,
          boardTaskToolActions: parseBoardTaskToolActions(record.boardTaskToolActions),
          sourceOrder,
        });
      } catch (error) {
        logger.debug(`Skipping malformed task-activity line in ${filePath}: ${String(error)}`);
      }

      if (lineCount % 500 === 0) {
        await yieldToEventLoop();
      }
    }
    return results;
  }
}
