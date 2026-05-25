import type { MemberSpawnStatusEntry, PersistedTeamLaunchSummary } from '@shared/types';

export const TASK_ACTIVITY_RUNTIME_PAUSE_GRACE_MS = 5_000;
export const MEMBER_SPAWN_AUDIT_WARNING_THROTTLE_MS = 10_000;
export const MEMBER_LAUNCH_GRACE_MS = 120_000;

export function shouldWarnOnUnreadableMemberAuditConfig(params: {
  nowMs: number;
  lastWarnAt: number;
  expectedMembers: readonly string[];
  memberSpawnStatuses: ReadonlyMap<
    string,
    Pick<MemberSpawnStatusEntry, 'agentToolAccepted' | 'firstSpawnAcceptedAt'> | undefined
  >;
}): boolean {
  const { nowMs, lastWarnAt, expectedMembers, memberSpawnStatuses } = params;
  if (nowMs - lastWarnAt < MEMBER_SPAWN_AUDIT_WARNING_THROTTLE_MS) {
    return false;
  }
  return expectedMembers.some((memberName) => {
    const current = memberSpawnStatuses.get(memberName);
    if (!current?.agentToolAccepted || typeof current.firstSpawnAcceptedAt !== 'string') {
      return false;
    }
    const acceptedAtMs = Date.parse(current.firstSpawnAcceptedAt);
    return Number.isFinite(acceptedAtMs) && nowMs - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;
  });
}

export function shouldWarnOnMissingRegisteredMember(params: {
  nowMs: number;
  lastWarnAt: number;
  graceExpired: boolean;
}): boolean {
  const { nowMs, lastWarnAt, graceExpired } = params;
  return graceExpired && nowMs - lastWarnAt >= MEMBER_SPAWN_AUDIT_WARNING_THROTTLE_MS;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function parseOptionalIsoMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deriveTaskActivityPauseAt(
  previous: MemberSpawnStatusEntry,
  fallbackAt: string
): string {
  const fallbackMs = parseOptionalIsoMs(fallbackAt);
  const explicitEvidenceMs = Math.max(
    parseOptionalIsoMs(previous.lastHeartbeatAt),
    parseOptionalIsoMs(previous.livenessLastCheckedAt)
  );
  const evidenceMs =
    explicitEvidenceMs > 0 ? explicitEvidenceMs : parseOptionalIsoMs(previous.updatedAt);
  if (evidenceMs <= 0 || fallbackMs <= 0) {
    return fallbackAt;
  }
  const boundedEvidenceMs = Math.min(evidenceMs, fallbackMs);
  const closeMs = Math.max(
    boundedEvidenceMs,
    Math.min(fallbackMs, boundedEvidenceMs + TASK_ACTIVITY_RUNTIME_PAUSE_GRACE_MS)
  );
  return new Date(closeMs).toISOString();
}

export function deriveTaskActivityResumeAt(
  previous: MemberSpawnStatusEntry,
  evidenceAt: string,
  fallbackAt: string
): string {
  const fallbackMs = parseOptionalIsoMs(fallbackAt);
  const evidenceMs = parseOptionalIsoMs(evidenceAt);
  const previousUpdatedMs = parseOptionalIsoMs(previous.updatedAt);
  if (evidenceMs <= 0 || fallbackMs <= 0) {
    return fallbackAt;
  }
  if (previousUpdatedMs > 0 && evidenceMs < previousUpdatedMs) {
    return fallbackAt;
  }
  return new Date(Math.min(evidenceMs, fallbackMs)).toISOString();
}

export function createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry {
  const updatedAt = nowIso();
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt,
  };
}

export function summarizeMemberSpawnStatusRecord(
  expectedMembers: readonly string[],
  statuses: Record<string, MemberSpawnStatusEntry>
): PersistedTeamLaunchSummary {
  let confirmedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let runtimeAlivePendingCount = 0;
  let shellOnlyPendingCount = 0;
  let runtimeProcessPendingCount = 0;
  let runtimeCandidatePendingCount = 0;
  let noRuntimePendingCount = 0;
  let permissionPendingCount = 0;
  const memberNames = Array.from(new Set([...expectedMembers, ...Object.keys(statuses)]));

  for (const memberName of memberNames) {
    const entry = statuses[memberName];
    if (!entry) {
      pendingCount += 1;
      continue;
    }
    if (entry.launchState === 'confirmed_alive') {
      confirmedCount += 1;
      continue;
    }
    if (entry.launchState === 'skipped_for_launch' || entry.skippedForLaunch === true) {
      skippedCount += 1;
      continue;
    }
    if (entry.launchState === 'failed_to_start') {
      failedCount += 1;
      continue;
    }
    pendingCount += 1;
    if (entry.runtimeAlive) {
      runtimeAlivePendingCount += 1;
    }
    if (entry.launchState === 'runtime_pending_permission') {
      permissionPendingCount += 1;
    }
    if (entry.livenessKind === 'shell_only') {
      shellOnlyPendingCount += 1;
    } else if (entry.livenessKind === 'runtime_process') {
      runtimeProcessPendingCount += 1;
    } else if (entry.livenessKind === 'runtime_process_candidate') {
      runtimeCandidatePendingCount += 1;
    } else if (
      entry.livenessKind === 'not_found' ||
      entry.livenessKind === 'stale_metadata' ||
      entry.livenessKind === 'registered_only'
    ) {
      noRuntimePendingCount += 1;
    }
  }

  return {
    confirmedCount,
    pendingCount,
    failedCount,
    skippedCount,
    runtimeAlivePendingCount,
    shellOnlyPendingCount,
    runtimeProcessPendingCount,
    runtimeCandidatePendingCount,
    noRuntimePendingCount,
    permissionPendingCount,
  };
}

export function buildRestartStillRunningReason(memberName: string): string {
  return (
    `Restart for teammate "${memberName}" was skipped because the previous runtime still appears ` +
    `to be active. The requested settings may not have been applied.`
  );
}

export function buildRestartDuplicateUnconfirmedReason(
  memberName: string,
  rawReason?: string
): string {
  const suffix = rawReason?.trim()
    ? ` Agent returned duplicate_skipped with unrecognized reason "${rawReason.trim()}".`
    : ' Agent returned duplicate_skipped without a reason.';
  return (
    `Restart for teammate "${memberName}" could not be confirmed and may not have applied.` + suffix
  );
}

export function buildRestartGraceTimeoutReason(memberName: string): string {
  return `Teammate "${memberName}" did not rejoin within the restart grace window.`;
}
