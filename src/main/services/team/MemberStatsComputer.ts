import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import * as readline from 'readline';

import { type TeamMemberLogsFinder } from './TeamMemberLogsFinder';

import type { FileLineStats, MemberFullStats } from '@shared/types';

const logger = createLogger('Service:MemberStatsComputer');

function isValidFilePath(value: string): boolean {
  return value.length > 0 && value !== 'null' && value !== 'undefined' && value !== 'None';
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  stats: MemberFullStats;
  timestamp: number;
}

export class MemberStatsComputer {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly logsFinder: TeamMemberLogsFinder) {}

  async getStats(teamName: string, memberName: string): Promise<MemberFullStats> {
    const cacheKey = `${teamName}:${memberName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.stats;
    }

    const paths = await this.logsFinder.findMemberLogPaths(teamName, memberName);

    let linesAdded = 0;
    let linesRemoved = 0;
    const filesTouchedSet = new Set<string>();
    const perFileStats: Record<string, FileLineStats> = {};
    const toolUsage: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let messageCount = 0;
    let totalDurationMs = 0;

    for (const filePath of paths) {
      const parsed = await this.parseFile(filePath);
      linesAdded += parsed.linesAdded;
      linesRemoved += parsed.linesRemoved;
      for (const f of parsed.filesTouched) filesTouchedSet.add(f);
      for (const [fp, fls] of Object.entries(parsed.perFileStats)) {
        const existing = perFileStats[fp];
        if (existing) {
          existing.added += fls.added;
          existing.removed += fls.removed;
        } else {
          perFileStats[fp] = { added: fls.added, removed: fls.removed };
        }
      }
      for (const [tool, count] of Object.entries(parsed.toolUsage)) {
        toolUsage[tool] = (toolUsage[tool] ?? 0) + count;
      }
      inputTokens += parsed.inputTokens;
      outputTokens += parsed.outputTokens;
      cacheReadTokens += parsed.cacheReadTokens;
      messageCount += parsed.messageCount;
      totalDurationMs += parsed.durationMs;
    }

    const validFiles = [...filesTouchedSet]
      .filter(isValidFilePath)
      .sort((a, b) => a.localeCompare(b));

    const stats: MemberFullStats = {
      linesAdded,
      linesRemoved,
      filesTouched: validFiles,
      fileStats: perFileStats,
      toolUsage,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUsd: 0,
      tasksCompleted: 0,
      messageCount,
      totalDurationMs,
      sessionCount: paths.length,
      computedAt: new Date().toISOString(),
    };

    this.cache.set(cacheKey, { stats, timestamp: Date.now() });
    return stats;
  }

  private async parseFile(filePath: string): Promise<{
    linesAdded: number;
    linesRemoved: number;
    filesTouched: string[];
    perFileStats: Record<string, FileLineStats>;
    toolUsage: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    messageCount: number;
    durationMs: number;
  }> {
    let linesAdded = 0;
    let linesRemoved = 0;
    const filesTouchedSet = new Set<string>();
    const perFileStats: Record<string, FileLineStats> = {};
    const toolUsage: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let messageCount = 0;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;

    const trackFile = (fp: string): void => {
      if (typeof fp === 'string' && isValidFilePath(fp)) filesTouchedSet.add(fp);
    };

    const addFileLines = (fp: string, added: number, removed: number): void => {
      if (!isValidFilePath(fp)) return;
      const existing = perFileStats[fp];
      if (existing) {
        existing.added += added;
        existing.removed += removed;
      } else {
        perFileStats[fp] = { added, removed };
      }
    };

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;

          if (typeof msg.timestamp === 'string') {
            if (!firstTimestamp) firstTimestamp = msg.timestamp;
            lastTimestamp = msg.timestamp;
          }

          // Count messages
          const role = this.extractRole(msg);
          if (role) messageCount++;

          // Extract token usage
          const usage = this.extractUsage(msg);
          if (usage) {
            inputTokens += usage.inputTokens;
            outputTokens += usage.outputTokens;
            cacheReadTokens += usage.cacheReadTokens;
          }

          // Extract tool_use blocks from assistant messages
          if (role === 'assistant') {
            const content = this.extractContent(msg);
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === 'object' &&
                  (block as Record<string, unknown>).type === 'tool_use'
                ) {
                  const toolBlock = block as Record<string, unknown>;
                  const rawName = typeof toolBlock.name === 'string' ? toolBlock.name : 'unknown';
                  const toolName = rawName.startsWith('proxy_') ? rawName.slice(6) : rawName;
                  toolUsage[toolName] = (toolUsage[toolName] ?? 0) + 1;

                  const input = toolBlock.input as Record<string, unknown> | undefined;
                  if (!input) continue;

                  // Track files
                  if (typeof input.file_path === 'string') {
                    trackFile(input.file_path);
                  }
                  if (typeof input.path === 'string' && toolName === 'Read') {
                    trackFile(input.path);
                  }

                  // Count lines for Edit
                  if (toolName === 'Edit') {
                    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
                    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
                    const oldLines = oldStr ? oldStr.split('\n').length : 0;
                    const newLines = newStr ? newStr.split('\n').length : 0;
                    const fileAdded = newLines > oldLines ? newLines - oldLines : 0;
                    const fileRemoved = oldLines > newLines ? oldLines - newLines : 0;
                    linesAdded += fileAdded;
                    linesRemoved += fileRemoved;
                    if (typeof input.file_path === 'string') {
                      addFileLines(input.file_path, fileAdded, fileRemoved);
                    }
                  }

                  // Count lines for Write
                  if (toolName === 'Write') {
                    const writeContent = typeof input.content === 'string' ? input.content : '';
                    if (writeContent) {
                      const fileAdded = writeContent.split('\n').length;
                      linesAdded += fileAdded;
                      if (typeof input.file_path === 'string') {
                        addFileLines(input.file_path, fileAdded, 0);
                      }
                    }
                  }

                  // Count lines for NotebookEdit
                  if (toolName === 'NotebookEdit') {
                    const src = typeof input.new_source === 'string' ? input.new_source : '';
                    if (src) {
                      const fileAdded = src.split('\n').length;
                      linesAdded += fileAdded;
                      if (typeof input.notebook_path === 'string') {
                        addFileLines(input.notebook_path, fileAdded, 0);
                      }
                    }
                    if (typeof input.notebook_path === 'string') {
                      trackFile(input.notebook_path);
                    }
                  }

                  // Count lines for Bash commands that write to files
                  if (toolName === 'Bash') {
                    const cmd = typeof input.command === 'string' ? input.command : '';
                    if (cmd) {
                      const bashLines = estimateBashLinesChanged(cmd);
                      linesAdded += bashLines.added;
                      linesRemoved += bashLines.removed;
                      for (const f of bashLines.files) {
                        trackFile(f);
                        addFileLines(f, bashLines.added, bashLines.removed);
                      }
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      rl.close();
      stream.destroy();
    } catch (err) {
      logger.debug(`Failed to parse file ${filePath}: ${String(err)}`);
    }

    let durationMs = 0;
    if (firstTimestamp && lastTimestamp) {
      durationMs = Math.max(
        0,
        new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
      );
    }

    return {
      linesAdded,
      linesRemoved,
      filesTouched: [...filesTouchedSet],
      perFileStats,
      toolUsage,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      messageCount,
      durationMs,
    };
  }

  private extractRole(msg: Record<string, unknown>): string | null {
    if (typeof msg.role === 'string') return msg.role;
    if (msg.message && typeof msg.message === 'object') {
      const inner = msg.message as Record<string, unknown>;
      if (typeof inner.role === 'string') return inner.role;
    }
    return null;
  }

  private extractContent(msg: Record<string, unknown>): unknown[] | null {
    const content = msg.content ?? (msg.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) return content as unknown[];
    return null;
  }

  private extractUsage(
    msg: Record<string, unknown>
  ): { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null {
    const usage = (msg.usage ?? (msg.message as Record<string, unknown> | undefined)?.usage) as
      | Record<string, unknown>
      | undefined;
    if (!usage || typeof usage !== 'object') return null;

    return {
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      cacheReadTokens:
        typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Bash line-change heuristics
// ---------------------------------------------------------------------------

interface BashLinesResult {
  added: number;
  removed: number;
  files: string[];
}

/**
 * Best-effort estimation of lines changed by a Bash command.
 * Handles common patterns: heredoc writes, echo/printf redirects,
 * sed in-place edits, and tee writes.
 *
 * Future improvements for Bash line counting accuracy:
 * - Currently only covers ~30-40% of real Bash file-write patterns.
 * - Misses: variable expansions (`echo "$var" > file`), piped output
 *   (`grep ... | sort > file`), `python -c`, `git apply`, `patch`,
 *   `mv`/`cp`, complex heredocs with `<<-` (tab-stripped).
 * - The fundamental limitation is that Bash command output is not stored
 *   in the JSONL tool_use input — only the command string is available.
 *   The actual content written to files lives inside the shell runtime
 *   and is not captured.
 * - Potential improvements: parse tool_result blocks for git diff --stat
 *   patterns (requires two-pass parser), or run a post-hoc `git log --stat`
 *   against the project repo filtered by session timestamps.
 */
export function estimateBashLinesChanged(command: string): BashLinesResult {
  let added = 0;
  let removed = 0;
  const files: string[] = [];

  // 1. Heredoc: cat <<'EOF' > file  OR  cat <<EOF > file
  //    Count lines between delimiter markers.
  const heredocPattern = /<<-?\s*'?(\w+)'?/g;
  let heredocMatch: RegExpExecArray | null;
  while ((heredocMatch = heredocPattern.exec(command)) !== null) {
    const delimiter = heredocMatch[1];
    const afterHeredoc = command.slice(heredocMatch.index + heredocMatch[0].length);
    const endIdx = afterHeredoc.indexOf(`\n${delimiter}`);
    if (endIdx > 0) {
      const startIdx = afterHeredoc.indexOf('\n');
      if (startIdx >= 0 && startIdx < endIdx) {
        const content = afterHeredoc.slice(startIdx + 1, endIdx);
        added += content.split('\n').length;
      }
    }
  }

  // 2. Echo / printf with redirect: echo "..." > /path  OR  printf "..." > /path

  const echoPattern =
    /(?:echo|printf)\s+(?:-[a-zA-Z]+\s+)?(?:"([^"]*)"|'([^']*)')\s*>{1,2}\s*(\S+)/g; // eslint-disable-line security/detect-unsafe-regex -- Fixed alternation, short command strings only
  let echoMatch: RegExpExecArray | null;
  while ((echoMatch = echoPattern.exec(command)) !== null) {
    const content = echoMatch[1] ?? echoMatch[2] ?? '';
    if (content) {
      added += content.split('\\n').length;
    }
    const filePath = echoMatch[3];
    if (filePath?.trim()) {
      files.push(filePath);
    }
  }

  // 3. sed -i: each invocation ~ 1 line changed
  // eslint-disable-next-line sonarjs/slow-regex -- Simple alternation on short command strings, no backtracking risk
  const sedPattern = /sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|-i)\s/g;
  let sedMatch: RegExpExecArray | null;
  while ((sedMatch = sedPattern.exec(command)) !== null) {
    added += 1;
    removed += 1;
    const afterSed = command.slice(sedMatch.index);
    const sedFileMatch = /\s(\/\S+)\s*(?:[;&|]|$)/.exec(afterSed);
    if (sedFileMatch) {
      files.push(sedFileMatch[1]);
    }
  }

  // 4. Redirect to file (catch-all for remaining redirects not caught above)
  if (added === 0 && removed === 0) {
    const redirectPattern = />{1,2}\s*(\/\S+)/g;
    let redirectMatch: RegExpExecArray | null;
    while ((redirectMatch = redirectPattern.exec(command)) !== null) {
      const filePath = redirectMatch[1];
      if (filePath) {
        files.push(filePath);
      }
    }
  }

  // 5. tee: ... | tee /path/to/file
  const teePattern = /\btee\s+(?:-a\s+)?(\/\S+)/g; // eslint-disable-line security/detect-unsafe-regex -- Simple pattern on short command strings
  let teeMatch: RegExpExecArray | null;
  while ((teeMatch = teePattern.exec(command)) !== null) {
    const filePath = teeMatch[1];
    if (filePath) {
      files.push(filePath);
    }
  }

  return { added, removed, files };
}
