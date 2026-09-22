export { resolveTaskChangePresenceFromResult } from '@shared/utils/taskChangePresence';

import type { TaskChangeSetV2 } from '@shared/types';

export function shouldBackgroundRevalidateTaskPresence(
  data: TaskChangeSetV2,
  sessionStartedAtMs: number
): boolean {
  if (data.provenance?.sourceKind === 'ledger' && !!data.provenance.sourceFingerprint) {
    return false;
  }

  const computedAtMs = Date.parse(data.computedAt);
  if (!Number.isFinite(computedAtMs)) {
    return true;
  }

  return computedAtMs < sessionStartedAtMs;
}
