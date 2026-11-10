import { yieldToEventLoop } from '@main/utils/asyncYield';
import { parseJsonlEntry } from '@main/utils/jsonl';
import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';

import { TranscriptSessionActorContextTracker } from '../TranscriptSessionActorContext';

import { BoardTaskExactLogsParseCache } from './BoardTaskExactLogsParseCache';

import type { ParsedMessage } from '@main/types';
import type { ChatHistoryEntry } from '@main/types';

const logger = createLogger('Service:BoardTaskExactLogStrictParser');
const EXACT_LOG_PARSE_CONCURRENCY = process.platform === 'win32' ? 4 : 8;
const EXACT_LOG_PARSE_WARN_MS = 3_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function hasStrictTimestamp(record: Record<string, unknown>): boolean {
  if (typeof record.timestamp !== 'string' || record.timestamp.trim().length === 0) {
    return false;
  }
  return Number.isFinite(Date.parse(record.timestamp));
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

export class BoardTaskExactLogStrictParser {
  constructor(
    private readonly cache: BoardTaskExactLogsParseCache = new BoardTaskExactLogsParseCache()
  ) {}

  async parseFiles(filePaths: string[]): Promise<Map<string, ParsedMessage[]>> {
    const uniquePaths = [...new Set(filePaths)].sort();
    this.cache.retainOnly(new Set(uniquePaths));

    const startedAt = Date.now();
    const results = await mapLimit(
      uniquePaths,
      EXACT_LOG_PARSE_CONCURRENCY,
      async (filePath) => [filePath, await this.parseFile(filePath)] as const
    );
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= EXACT_LOG_PARSE_WARN_MS) {
      logger.warn(
        `Slow exact-log parse: files=${uniquePaths.length} messages=${results.reduce(
          (sum, [, messages]) => sum + messages.length,
          0
        )} elapsedMs=${elapsedMs}`
      );
    }

    return new Map(results);
  }

  private async parseFile(filePath: string): Promise<ParsedMessage[]> {
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

      const promise = this.readStrictFile(filePath);
      this.cache.setInFlight(filePath, promise);
      try {
        const parsed = await promise;
        this.cache.set(filePath, stat.mtimeMs, stat.size, parsed);
        return parsed;
      } finally {
        this.cache.clearInFlight(filePath);
      }
    } catch (error) {
      logger.debug(`Skipping unreadable exact-log transcript ${filePath}: ${String(error)}`);
      this.cache.clearForPath(filePath);
      return [];
    }
  }

  private async readStrictFile(filePath: string): Promise<ParsedMessage[]> {
    const results: ParsedMessage[] = [];
    const actorContextTracker = new TranscriptSessionActorContextTracker();
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineCount = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount += 1;

      try {
        const raw = JSON.parse(line) as unknown;
        const record = asRecord(raw);
        if (!record || !hasStrictTimestamp(record)) {
          continue;
        }

        actorContextTracker.remember(record);
        const contextRecord = actorContextTracker.apply(record);
        const parsed = parseJsonlEntry(contextRecord as unknown as ChatHistoryEntry);
        if (parsed) {
          results.push(parsed);
        }
      } catch (error) {
        logger.debug(`Skipping malformed exact-log line in ${filePath}: ${String(error)}`);
      }

      if (lineCount % 250 === 0) {
        await yieldToEventLoop();
      }
    }

    return results;
  }
}
