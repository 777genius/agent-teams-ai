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

const WORK_SYNC_MEMBER_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'agent_process_table',
  'opencode_bridge',
]);

const WORK_SYNC_LEAD_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'lead_process',
]);

function isWorkSyncLeadLikeMemberName(memberName: string): boolean {
  const normalized = normalizeMemberName(memberName).replace(/[\s_]+/g, '-');
  return (
    normalized === 'lead' ||
    normalized === 'team-lead' ||
    normalized === 'teamlead' ||
    normalized === 'team-leader'
  );
}

function hasActiveWorkSyncProcessEvidence(
  entry: Pick<TeamAgentRuntimeEntry, 'alive' | 'livenessKind' | 'pidSource'> | null | undefined,
  confirmedBootstrapActivePidSources: ReadonlySet<TeamAgentRuntimePidSource>
): boolean {
  if (entry?.alive !== true) {
    return false;
  }
  if (
    entry.livenessKind === 'confirmed_bootstrap' &&
    (!entry.pidSource ||
      WORK_SYNC_BOOTSTRAP_ONLY_PID_SOURCES.has(entry.pidSource) ||
      !confirmedBootstrapActivePidSources.has(entry.pidSource))
  ) {
    return false;
  }
  if (!entry.livenessKind) {
    return true;
  }
  return !WORK_SYNC_INACTIVE_LIVENESS_KINDS.has(entry.livenessKind);
}

export function isRuntimeEntryActiveForWorkSync(
  entry:
    | Pick<
        TeamAgentRuntimeEntry,
        'alive' | 'backendType' | 'livenessKind' | 'memberName' | 'pidSource'
      >
    | null
    | undefined
): boolean {
  if (!entry) {
    return false;
  }
  if (
    entry.backendType === 'lead' ||
    WORK_SYNC_RESERVED_MEMBER_NAMES.has(entry.memberName.trim().toLowerCase())
  ) {
    return false;
  }
  if (
    entry.pidSource &&
    WORK_SYNC_LEAD_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES.has(entry.pidSource)
  ) {
    return false;
  }
  return hasActiveWorkSyncProcessEvidence(
    entry,
    WORK_SYNC_MEMBER_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES
  );
}

function isRuntimeLeadEntryActiveForWorkSync(
  entry:
    | Pick<
        TeamAgentRuntimeEntry,
        'alive' | 'backendType' | 'livenessKind' | 'memberName' | 'pidSource'
      >
    | null
    | undefined
): boolean {
  if (!entry || !isWorkSyncLeadLikeMemberName(entry.memberName)) {
    return false;
  }
  return (
    entry.backendType === 'lead' &&
    hasActiveWorkSyncProcessEvidence(entry, WORK_SYNC_LEAD_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES)
  );
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

export function hasWorkSyncReachableRuntime(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined
): boolean {
  return Object.values(snapshot?.members ?? {}).some(
    (entry) => isRuntimeEntryActiveForWorkSync(entry) || isRuntimeLeadEntryActiveForWorkSync(entry)
  );
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
      (isRuntimeEntryActiveForWorkSync(entry) ||
        (isWorkSyncLeadLikeMemberName(normalizedMemberName) &&
          isRuntimeLeadEntryActiveForWorkSync(entry)))
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
