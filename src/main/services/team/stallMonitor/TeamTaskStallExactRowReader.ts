import { yieldToEventLoop } from '@main/utils/asyncYield';
import { parseJsonlLine } from '@main/utils/jsonl';
import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';

import { BoardTaskActivityParseCache } from '../taskLogs/activity/BoardTaskActivityParseCache';

import type { TeamTaskStallExactRow } from './TeamTaskStallTypes';

const logger = createLogger('Service:TeamTaskStallExactRowReader');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function hasStrictTimestamp(record: Record<string, unknown>): boolean {
  return typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp));
}

function parseSystemSubtype(record: Record<string, unknown>): 'turn_duration' | 'init' | undefined {
  return record.subtype === 'turn_duration' || record.subtype === 'init'
    ? record.subtype
    : undefined;
}

export class TeamTaskStallExactRowReader {
  private readonly cache = new BoardTaskActivityParseCache<TeamTaskStallExactRow[]>();

  async parseFiles(filePaths: string[]): Promise<Map<string, TeamTaskStallExactRow[]>> {
    const uniquePaths = [...new Set(filePaths)].sort();
    this.cache.retainOnly(new Set(uniquePaths));

    const rows = await Promise.all(
      uniquePaths.map(async (filePath) => [filePath, await this.parseFile(filePath)] as const)
    );
    return new Map(rows);
  }

  private async parseFile(filePath: string): Promise<TeamTaskStallExactRow[]> {
    try {
      const stat = await fs.stat(filePath);
      const cached = this.cache.getIfFresh(filePath, stat.mtimeMs, stat.size);
      if (cached !== null) {
        return cached;
      }

      const inFlight = this.cache.getInFlight(filePath);
      if (inFlight) {
        return inFlight;
      }

      const promise = this.readFile(filePath);
      this.cache.setInFlight(filePath, promise);
      try {
        const parsed = await promise;
        this.cache.set(filePath, stat.mtimeMs, stat.size, parsed);
        return parsed;
      } finally {
        this.cache.clearInFlight(filePath);
      }
    } catch (error) {
      logger.debug(`Skipping unreadable stall exact-log transcript ${filePath}: ${String(error)}`);
      this.cache.clearForPath(filePath);
      return [];
    }
  }

  private async readFile(filePath: string): Promise<TeamTaskStallExactRow[]> {
    const rows: TeamTaskStallExactRow[] = [];
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineCount = 0;
    let sourceOrder = 0;

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      lineCount += 1;

      try {
        const raw = JSON.parse(line) as unknown;
        const record = asRecord(raw);
        if (!record || !hasStrictTimestamp(record)) {
          continue;
        }

        const parsed = parseJsonlLine(line);
        if (!parsed) {
          continue;
        }

        sourceOrder += 1;
        const systemSubtype = parseSystemSubtype(record);
        rows.push({
          filePath,
          sourceOrder,
          messageUuid: parsed.uuid,
          timestamp: record.timestamp as string,
          parsedMessage: parsed,
          ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
          ...(parsed.sourceToolUseID ? { sourceToolUseId: parsed.sourceToolUseID } : {}),
          ...(parsed.sourceToolAssistantUUID
            ? { sourceToolAssistantUuid: parsed.sourceToolAssistantUUID }
            : {}),
          ...(systemSubtype ? { systemSubtype } : {}),
          toolUseIds: parsed.toolCalls.map((toolCall) => toolCall.id),
          toolResultIds: parsed.toolResults.map((toolResult) => toolResult.toolUseId),
        });
      } catch (error) {
        logger.debug(`Skipping malformed stall exact-log line in ${filePath}: ${String(error)}`);
      }

      if (lineCount % 250 === 0) {
        await yieldToEventLoop();
      }
    }

    return rows;
  }
}
