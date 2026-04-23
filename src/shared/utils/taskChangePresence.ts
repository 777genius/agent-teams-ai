import type { TaskChangePresenceState, TaskChangeSetV2 } from '../types';

const EMPTY_INTERVAL_NO_EDITS_WARNING = 'No file edits found within persisted workIntervals.';

function isBenignActiveIntervalWithoutFileEdits(
  data: Pick<TaskChangeSetV2, 'files' | 'warnings' | 'scope'>
): boolean {
  if (data.files.length > 0) {
    return false;
  }

  if (data.warnings.length !== 1 || data.warnings[0] !== EMPTY_INTERVAL_NO_EDITS_WARNING) {
    return false;
  }

  return Boolean(data.scope.startTimestamp) && !data.scope.endTimestamp && data.scope.toolUseIds.length === 0;
}

export function resolveTaskChangePresenceFromResult(
  data: Pick<TaskChangeSetV2, 'files' | 'confidence' | 'warnings' | 'scope'>
): Exclude<TaskChangePresenceState, 'unknown'> | null {
  if (data.files.length > 0) {
    return 'has_changes';
  }

  if (isBenignActiveIntervalWithoutFileEdits(data)) {
    return null;
  }

  if ((data.warnings?.length ?? 0) > 0) {
    return 'needs_attention';
  }

  return data.confidence === 'high' || data.confidence === 'medium' ? 'no_changes' : null;
}
