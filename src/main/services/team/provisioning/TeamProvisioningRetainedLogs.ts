import { boundProgressLogLines } from '../progressPayload';

import { extractLogsTail } from './TeamProvisioningLogSlice';

export interface RetainedClaudeLogsSnapshot {
  lines: string[];
  updatedAt?: string;
}

export interface RetainedLogsRunLike {
  claudeLogLines?: string[];
  stdoutBuffer?: string;
  stderrBuffer?: string;
  claudeLogsUpdatedAt?: string;
  progress?: { updatedAt?: string };
}

/**
 * Best-effort CLI log text for a run: prefer the captured line buffer (bounded),
 * otherwise fall back to the raw stdout/stderr tail.
 */
export function extractCliLogsFromRun(run: RetainedLogsRunLike): string | undefined {
  const claudeLogLines = Array.isArray(run.claudeLogLines) ? run.claudeLogLines : [];
  if (claudeLogLines.length > 0) {
    const joined = boundProgressLogLines(claudeLogLines).join('\n').trim();
    if (joined.length === 0) {
      return undefined;
    }
    return joined;
  }
  return extractLogsTail(run.stdoutBuffer, run.stderrBuffer);
}

/**
 * Snapshot of retained CLI logs for a run, from the bounded line buffer when
 * present, otherwise reconstructed from the raw log tail. Returns null when
 * there is nothing to retain.
 */
export function buildRetainedClaudeLogsSnapshot(
  run: RetainedLogsRunLike
): RetainedClaudeLogsSnapshot | null {
  const claudeLogLines = Array.isArray(run.claudeLogLines) ? run.claudeLogLines : [];
  if (claudeLogLines.length > 0) {
    return {
      lines: boundProgressLogLines(claudeLogLines),
      updatedAt: run.claudeLogsUpdatedAt,
    };
  }

  const fallback = extractCliLogsFromRun(run);
  if (!fallback) {
    return null;
  }

  const lines = fallback
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  return {
    lines: boundProgressLogLines(lines),
    updatedAt: run.claudeLogsUpdatedAt ?? run.progress?.updatedAt,
  };
}
