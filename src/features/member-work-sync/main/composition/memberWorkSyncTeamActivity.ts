import type { TeamAgentRuntimeEntry, TeamAgentRuntimeSnapshot } from '@shared/types';

type RuntimeLivenessKind = NonNullable<TeamAgentRuntimeEntry['livenessKind']>;

const WORK_SYNC_INACTIVE_LIVENESS_KINDS = new Set<RuntimeLivenessKind>([
  'permission_blocked',
  'runtime_process_candidate',
  'shell_only',
  'registered_only',
  'stale_metadata',
  'not_found',
]);

export function isRuntimeEntryActiveForWorkSync(
  entry: Pick<TeamAgentRuntimeEntry, 'alive' | 'livenessKind'> | null | undefined
): boolean {
  if (entry?.alive !== true) {
    return false;
  }
  if (!entry.livenessKind) {
    return true;
  }
  return !WORK_SYNC_INACTIVE_LIVENESS_KINDS.has(entry.livenessKind);
}

export function hasWorkSyncActiveRuntime(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined
): boolean {
  return Object.values(snapshot?.members ?? {}).some(isRuntimeEntryActiveForWorkSync);
}
