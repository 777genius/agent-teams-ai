import type { TaskChangePresenceState, TaskChangeSetV2 } from '../types';

export function resolveTaskChangePresenceFromResult(
  data: Pick<TaskChangeSetV2, 'files' | 'confidence' | 'warnings'>
): Exclude<TaskChangePresenceState, 'unknown'> | null {
  if (data.files.length > 0) {
    return 'has_changes';
  }

  if ((data.warnings?.length ?? 0) > 0) {
    return 'needs_attention';
  }

  return data.confidence === 'high' || data.confidence === 'medium' ? 'no_changes' : null;
}
