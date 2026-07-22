import { buildCombinedLogs } from './TeamProvisioningCliExitPresentation';

const UI_LOGS_TAIL_LIMIT = 128 * 1024;

/**
 * Byte-bounded tail of the combined stdout/stderr buffers for UI display.
 * Returns undefined when there is nothing to show.
 */
export function extractLogsTail(
  stdoutBuffer: string | undefined,
  stderrBuffer: string | undefined,
  maxTailChars: number = UI_LOGS_TAIL_LIMIT
): string | undefined {
  const trimmed = buildCombinedLogs(stdoutBuffer, stderrBuffer).trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(-maxTailChars);
}

/**
 * Paginate a chronological CLI log-line buffer newest-first. `offset` counts
 * back from the newest line; `limit` is clamped to [1, 1000]. Strips the legacy
 * `[stdout] `/`[stderr] ` line prefixes emitted by older builds.
 */
export function sliceClaudeLogs(
  linesChronological: string[],
  updatedAt: string | undefined,
  query?: { offset?: number; limit?: number }
): { lines: string[]; total: number; hasMore: boolean; updatedAt?: string } {
  const offsetRaw = query?.offset ?? 0;
  const limitRaw = query?.limit ?? 100;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 100;

  const total = linesChronological.length;
  if (total === 0) {
    return { lines: [], total: 0, hasMore: false, updatedAt };
  }

  const newestExclusive = Math.max(0, total - offset);
  const oldestInclusive = Math.max(0, newestExclusive - limit);
  const normalizeLine = (line: string): string => {
    // Back-compat: older builds prefixed every line with "[stdout] " / "[stderr] "
    if (line.startsWith('[stdout] ') && line !== '[stdout]') {
      return line.slice('[stdout] '.length);
    }
    if (line.startsWith('[stderr] ') && line !== '[stderr]') {
      return line.slice('[stderr] '.length);
    }
    return line;
  };

  const lines = linesChronological
    .slice(oldestInclusive, newestExclusive)
    .map(normalizeLine)
    .toReversed();

  return {
    lines,
    total,
    hasMore: oldestInclusive > 0,
    updatedAt,
  };
}
