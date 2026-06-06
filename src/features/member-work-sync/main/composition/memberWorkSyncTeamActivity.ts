import { mentionsProcessTableUnavailable } from '@shared/utils/teamLaunchFailureReason';

import { normalizeMemberName } from '../../core/domain';

import type {
  TeamAgentRuntimeEntry,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

type RuntimeLivenessKind = NonNullable<TeamAgentRuntimeEntry['livenessKind']>;

const WORK_SYNC_RESERVED_MEMBER_NAMES = new Set(['team-lead', 'user']);

const WORK_SYNC_INACTIVE_LIVENESS_KINDS = new Set<RuntimeLivenessKind>([
  'permission_blocked',
  'runtime_process_candidate',
  'shell_only',
  'registered_only',
  'stale_metadata',
  'not_found',
]);

const WORK_SYNC_BOOTSTRAP_ONLY_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'runtime_bootstrap',
  'persisted_metadata',
]);

const WORK_SYNC_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'agent_process_table',
  'opencode_bridge',
]);

export function isRuntimeEntryActiveForWorkSync(
  entry:
    | Pick<
        TeamAgentRuntimeEntry,
        'alive' | 'backendType' | 'livenessKind' | 'memberName' | 'pidSource'
      >
    | null
    | undefined
): boolean {
  if (entry?.alive !== true) {
    return false;
  }
  if (
    entry.backendType === 'lead' ||
    WORK_SYNC_RESERVED_MEMBER_NAMES.has(entry.memberName.trim().toLowerCase())
  ) {
    return false;
  }
  if (
    entry.livenessKind === 'confirmed_bootstrap' &&
    (!entry.pidSource ||
      WORK_SYNC_BOOTSTRAP_ONLY_PID_SOURCES.has(entry.pidSource) ||
      !WORK_SYNC_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES.has(entry.pidSource))
  ) {
    return false;
  }
  if (!entry.livenessKind) {
    return true;
  }
  return !WORK_SYNC_INACTIVE_LIVENESS_KINDS.has(entry.livenessKind);
}

function isRuntimeEntryRelevantForWorkSync(
  entry: Pick<TeamAgentRuntimeEntry, 'backendType' | 'memberName'>
): boolean {
  return (
    entry.backendType !== 'lead' &&
    !WORK_SYNC_RESERVED_MEMBER_NAMES.has(entry.memberName.trim().toLowerCase())
  );
}

function runtimeEntryMentionsProcessTableUnavailable(
  entry: Pick<TeamAgentRuntimeEntry, 'diagnostics' | 'runtimeDiagnostic'>
): boolean {
  return [entry.runtimeDiagnostic, ...(entry.diagnostics ?? [])].some((message) =>
    mentionsProcessTableUnavailable(message)
  );
}

export function hasUncertainWorkSyncRuntimeActivity(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined
): boolean {
  return Object.values(snapshot?.members ?? {}).some(
    (entry) =>
      isRuntimeEntryRelevantForWorkSync(entry) && runtimeEntryMentionsProcessTableUnavailable(entry)
  );
}

export function hasWorkSyncActiveRuntime(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined
): boolean {
  return Object.values(snapshot?.members ?? {}).some(isRuntimeEntryActiveForWorkSync);
}

export function isRuntimeMemberActiveForWorkSync(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined,
  memberName: string
): boolean {
  const normalizedMemberName = normalizeMemberName(memberName);
  if (!normalizedMemberName) {
    return false;
  }
  return Object.values(snapshot?.members ?? {}).some(
    (entry) =>
      normalizeMemberName(entry.memberName) === normalizedMemberName &&
      isRuntimeEntryActiveForWorkSync(entry)
  );
}

export function isRuntimeMemberActivityUncertainForWorkSync(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined,
  memberName: string
): boolean {
  const normalizedMemberName = normalizeMemberName(memberName);
  if (!normalizedMemberName) {
    return false;
  }
  return Object.values(snapshot?.members ?? {}).some(
    (entry) =>
      normalizeMemberName(entry.memberName) === normalizedMemberName &&
      isRuntimeEntryRelevantForWorkSync(entry) &&
      runtimeEntryMentionsProcessTableUnavailable(entry)
  );
}
