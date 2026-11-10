import {
  BOARD_TASK_CHANGE_FRESHNESS_DIRNAME,
  BOARD_TASK_CHANGES_DIRNAME,
  BOARD_TASK_LOG_FRESHNESS_DIRNAME,
  getRelativeLogSourceParts,
  isAgentTranscriptFileName,
  normalizeLogSourceSessionId,
} from './teamLogSourceWatchScope';

export function shouldIgnoreLogSourceWatcherPath(
  projectDir: string,
  watchedPath: string,
  scope?: {
    scopedSessionIds?: ReadonlySet<string>;
    pendingRootSessionIds?: ReadonlySet<string>;
  }
): boolean {
  const parts = getRelativeLogSourceParts(projectDir, watchedPath);
  if (!parts) {
    return false;
  }

  const first = parts[0];
  if (first === BOARD_TASK_CHANGES_DIRNAME) return true;
  if (parts.includes('tool-results')) return true;
  if (parts.includes('memory')) return true;
  if (first === BOARD_TASK_LOG_FRESHNESS_DIRNAME) return false;
  if (first === BOARD_TASK_CHANGE_FRESHNESS_DIRNAME) return false;

  const scopedSessionIds = scope?.scopedSessionIds;
  if (scopedSessionIds) {
    if (parts.length === 1) {
      if (first.endsWith('.jsonl')) {
        const sessionId = normalizeLogSourceSessionId(first.slice(0, -'.jsonl'.length));
        return (
          !sessionId ||
          (!scopedSessionIds.has(sessionId) && !scope?.pendingRootSessionIds?.has(sessionId))
        );
      }
      return !scopedSessionIds.has(first);
    }

    if (!scopedSessionIds.has(first)) {
      return true;
    }

    if (parts[1] === 'subagents') {
      if (parts.length === 2) return false;
      if (parts.length === 3) return !isAgentTranscriptFileName(parts[2]);
    }

    return true;
  }

  if (parts.length >= 2 && parts[1] === 'subagents') {
    if (parts.length === 2) return false;
    if (parts.length === 3) return !isAgentTranscriptFileName(parts[2]);
    return true;
  }

  return false;
}
