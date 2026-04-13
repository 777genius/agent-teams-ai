import { yieldToEventLoop } from '@main/utils/asyncYield';
import { parseJsonlLine } from '@main/utils/jsonl';
import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';

import { BoardTaskExactLogsParseCache } from './BoardTaskExactLogsParseCache';

import type { ParsedMessage } from '@main/types';

const logger = createLogger('Service:BoardTaskExactLogStrictParser');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function hasStrictTimestamp(record: Record<string, unknown>): boolean {
  if (typeof record.timestamp !== 'string' || record.timestamp.trim().length === 0) {
    return false;
  }
  return Number.isFinite(Date.parse(record.timestamp));
}

export class BoardTaskExactLogStrictParser {
  constructor(
    private readonly cache: BoardTaskExactLogsParseCache = new BoardTaskExactLogsParseCache()
  ) {}

  async parseFiles(filePaths: string[]): Promise<Map<string, ParsedMessage[]>> {
    const uniquePaths = [...new Set(filePaths)].sort();
    this.cache.retainOnly(new Set(uniquePaths));

    const results = await Promise.all(
      uniquePaths.map(async (filePath) => [filePath, await this.parseFile(filePath)] as const)
    );

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

        const parsed = parseJsonlLine(line);
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
