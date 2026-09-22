import { classifyTaskChangeReviewability } from './taskChangeReviewability';

import type { TaskChangePresenceState, TaskChangeSetV2 } from '../types';

export function resolveTaskChangePresenceFromResult(
  data: Pick<TaskChangeSetV2, 'files' | 'totalFiles' | 'confidence' | 'warnings' | 'scope'> &
    Partial<Pick<TaskChangeSetV2, 'diffStatCompleteness' | 'provenance' | 'reviewDiagnostics'>>
): Exclude<TaskChangePresenceState, 'unknown'> | null {
  const status = classifyTaskChangeReviewability(data);
  switch (status.reviewability) {
    case 'reviewable':
      return 'has_changes';
    case 'attention_required':
      return 'needs_attention';
    case 'none':
      return 'no_changes';
    case 'diagnostic_only':
    case 'unknown':
      return null;
  }
}
