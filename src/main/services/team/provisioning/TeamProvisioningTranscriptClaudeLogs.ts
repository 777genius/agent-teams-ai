import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { boundProgressLogLines } from '../progressPayload';

import type { TeamTranscriptProjectContext } from '../TeamTranscriptProjectResolver';
import type { RetainedClaudeLogsSnapshot } from './TeamProvisioningRetainedLogs';

type TranscriptClaudeLogsContext = Pick<TeamTranscriptProjectContext, 'projectDir' | 'config'>;

export interface TranscriptClaudeLogsContextResolver {
  getContext(teamName: string): Promise<TranscriptClaudeLogsContext | null>;
}

interface PersistedTranscriptClaudeLogsCacheEntry {
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  snapshot: RetainedClaudeLogsSnapshot;
}

export async function readTranscriptClaudeLogLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) {
        continue;
      }
      lines.push(line);
      const bounded = boundProgressLogLines(lines);
      if (
        bounded.length !== lines.length ||
        bounded.some((boundedLine, index) => boundedLine !== lines[index])
      ) {
        lines.splice(0, lines.length, ...bounded);
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return lines;
}

export class TeamProvisioningTranscriptClaudeLogsCache {
  private readonly cache = new Map<string, PersistedTranscriptClaudeLogsCacheEntry>();

  constructor(
    private readonly contextResolver: TranscriptClaudeLogsContextResolver,
    private readonly readLogLines: (filePath: string) => Promise<string[]> =
      readTranscriptClaudeLogLines
  ) {}

  invalidate(teamName: string): void {
    this.cache.delete(teamName);
  }

  async get(teamName: string): Promise<RetainedClaudeLogsSnapshot | null> {
    const context = await this.contextResolver.getContext(teamName);
    const leadSessionId =
      typeof context?.config.leadSessionId === 'string' ? context.config.leadSessionId.trim() : '';
    if (!context || leadSessionId.length === 0) {
      this.cache.delete(teamName);
      return null;
    }

    const transcriptPath = path.join(context.projectDir, `${leadSessionId}.jsonl`);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(transcriptPath);
    } catch {
      this.cache.delete(teamName);
      return null;
    }

    if (!stat.isFile()) {
      this.cache.delete(teamName);
      return null;
    }

    const cached = this.cache.get(teamName);
    if (
      cached?.transcriptPath === transcriptPath &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.snapshot;
    }

    const lines = await this.readLogLines(transcriptPath);
    if (lines.length === 0) {
      this.cache.delete(teamName);
      return null;
    }

    const snapshot = {
      lines,
      updatedAt: stat.mtime.toISOString(),
    };
    this.cache.set(teamName, {
      transcriptPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      snapshot,
    });
    return snapshot;
  }
}
