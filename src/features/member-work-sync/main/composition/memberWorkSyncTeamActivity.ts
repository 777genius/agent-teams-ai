import { mentionsProcessTableUnavailable } from '@shared/utils/teamLaunchFailureReason';

import { normalizeMemberName } from '../../core/domain';

import type {
  TeamAgentRuntimeEntry,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

type RuntimeLivenessKind = NonNullable<TeamAgentRuntimeEntry['livenessKind']>;

const WORK_SYNC_RESERVED_MEMBER_NAMES = new Set(['team-lead', 'user']);

// registered_only / stale_metadata are NOT listed: an on-demand OpenCode lane
// degrades to those kinds between turns while staying deliverable (alive:true).
// Entries that are genuinely dead still fail the alive check first.
const WORK_SYNC_INACTIVE_LIVENESS_KINDS = new Set<RuntimeLivenessKind>([
  'permission_blocked',
  'runtime_process_candidate',
  'shell_only',
  'not_found',
]);

const WORK_SYNC_BOOTSTRAP_ONLY_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'persisted_metadata',
]);

// runtime_bootstrap counts as active: an on-demand OpenCode lane holds no live
// pid between turns, yet a confirmed bootstrap check-in means deliveries reach
// it (delivery itself spins the runtime up). Rejecting it deadlocks assignment
// nudges: the lane only earns an opencode_bridge pid AFTER a first delivery.
const WORK_SYNC_MEMBER_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'agent_process_table',
  'opencode_bridge',
  'runtime_bootstrap',
]);

const WORK_SYNC_LEAD_CONFIRMED_BOOTSTRAP_ACTIVE_PID_SOURCES = new Set<TeamAgentRuntimePidSource>([
  'lead_process',
]);

/**
 * Member names (normalized) whose launch hard-failed - grace timeout expired,
 * bootstrap evidence rejected, etc. A hard-failed member can still resolve
 * `alive: true` in the runtime snapshot (no pid ever disproves it), which is
 * correct for the "alive between turns" case this snapshot also has to serve,
 * but it must never make an assignment nudge target a member that is not
 * coming back on its own.
 */
export type WorkSyncHardFailedMembers = ReadonlySet<string>;

/** Builds the lookup isRuntimeEntryActiveForWorkSync et al. take from a member-spawn-status snapshot. */
export function buildWorkSyncHardFailedMembers(
  statuses: Record<string, Pick<{ hardFailure?: boolean }, 'hardFailure'>> | null | undefined
): WorkSyncHardFailedMembers {
  const hardFailedMembers = new Set<string>();
  for (const [memberName, entry] of Object.entries(statuses ?? {})) {
    if (entry.hardFailure === true) {
      const normalized = normalizeMemberName(memberName);
      if (normalized) {
        hardFailedMembers.add(normalized);
      }
    }
  }
  return hardFailedMembers;
}

function isWorkSyncHardFailedMember(
  entry: Pick<TeamAgentRuntimeEntry, 'memberName'>,
  hardFailedMembers: WorkSyncHardFailedMembers | undefined
): boolean {
  return hardFailedMembers != null && hardFailedMembers.has(normalizeMemberName(entry.memberName));
}

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
    | undefined,
  hardFailedMembers?: WorkSyncHardFailedMembers
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
  if (isWorkSyncHardFailedMember(entry, hardFailedMembers)) {
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
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined,
  hardFailedMembers?: WorkSyncHardFailedMembers
): boolean {
  return Object.values(snapshot?.members ?? {}).some((entry) =>
    isRuntimeEntryActiveForWorkSync(entry, hardFailedMembers)
  );
}

export function hasWorkSyncReachableRuntime(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined,
  hardFailedMembers?: WorkSyncHardFailedMembers
): boolean {
  return Object.values(snapshot?.members ?? {}).some(
    (entry) =>
      isRuntimeEntryActiveForWorkSync(entry, hardFailedMembers) ||
      isRuntimeLeadEntryActiveForWorkSync(entry)
  );
}

export function isRuntimeMemberActiveForWorkSync(
  snapshot: Pick<TeamAgentRuntimeSnapshot, 'members'> | null | undefined,
  memberName: string,
  hardFailedMembers?: WorkSyncHardFailedMembers
): boolean {
  const normalizedMemberName = normalizeMemberName(memberName);
  if (!normalizedMemberName) {
    return false;
  }
  return Object.values(snapshot?.members ?? {}).some(
    (entry) =>
      normalizeMemberName(entry.memberName) === normalizedMemberName &&
      (isRuntimeEntryActiveForWorkSync(entry, hardFailedMembers) ||
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
