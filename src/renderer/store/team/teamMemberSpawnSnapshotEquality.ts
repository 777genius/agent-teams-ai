import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSummary,
  TeamLaunchDiagnosticItem,
  TeamProvisioningProgress,
} from '@shared/types';

export function areLaunchSummaryCountsEqual(
  left: PersistedTeamLaunchSummary | undefined,
  right: PersistedTeamLaunchSummary | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.confirmedCount === right.confirmedCount &&
    left.pendingCount === right.pendingCount &&
    left.failedCount === right.failedCount &&
    left.skippedCount === right.skippedCount &&
    left.runtimeAlivePendingCount === right.runtimeAlivePendingCount &&
    left.shellOnlyPendingCount === right.shellOnlyPendingCount &&
    left.runtimeProcessPendingCount === right.runtimeProcessPendingCount &&
    left.runtimeCandidatePendingCount === right.runtimeCandidatePendingCount &&
    left.noRuntimePendingCount === right.noRuntimePendingCount &&
    left.permissionPendingCount === right.permissionPendingCount
  );
}

export function areExpectedMembersEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function areMemberSpawnStatusEntriesEqual(
  left: MemberSpawnStatusEntry | undefined,
  right: MemberSpawnStatusEntry | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  const leftPendingPermissionIds = [...(left.pendingPermissionRequestIds ?? [])].sort();
  const rightPendingPermissionIds = [...(right.pendingPermissionRequestIds ?? [])].sort();
  // Renderer equality intentionally ignores raw timing fields that do not change
  // visible member status. This suppresses heartbeat-only churn in TeamDetailView.
  return (
    left.status === right.status &&
    left.launchState === right.launchState &&
    left.hostFailedMemberRetry?.runId === right.hostFailedMemberRetry?.runId &&
    left.hostFailedMemberRetry?.memberId === right.hostFailedMemberRetry?.memberId &&
    left.hostFailedMemberRetry?.generation === right.hostFailedMemberRetry?.generation &&
    left.hostFailedMemberRetry?.attemptId === right.hostFailedMemberRetry?.attemptId &&
    left.hostFailedMemberRetry?.noAllocation === right.hostFailedMemberRetry?.noAllocation &&
    left.error === right.error &&
    left.hardFailureReason === right.hardFailureReason &&
    left.skippedForLaunch === right.skippedForLaunch &&
    left.skipReason === right.skipReason &&
    left.skippedAt === right.skippedAt &&
    left.livenessSource === right.livenessSource &&
    left.runtimeAlive === right.runtimeAlive &&
    left.runtimeModel === right.runtimeModel &&
    left.livenessKind === right.livenessKind &&
    left.runtimeDiagnostic === right.runtimeDiagnostic &&
    left.runtimeDiagnosticSeverity === right.runtimeDiagnosticSeverity &&
    left.bootstrapConfirmed === right.bootstrapConfirmed &&
    left.hardFailure === right.hardFailure &&
    leftPendingPermissionIds.length === rightPendingPermissionIds.length &&
    leftPendingPermissionIds.every((value, index) => value === rightPendingPermissionIds[index])
  );
}

export function areMemberSpawnStatusesEqual(
  left: Record<string, MemberSpawnStatusEntry>,
  right: Record<string, MemberSpawnStatusEntry>
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in right)) {
      return false;
    }
    if (!areMemberSpawnStatusEntriesEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

export function areMemberSpawnSnapshotsSemanticallyEqual(
  left: MemberSpawnStatusesSnapshot | undefined,
  right: MemberSpawnStatusesSnapshot
): boolean {
  if (!left) return false;
  return (
    left.runId === right.runId &&
    left.teamLaunchState === right.teamLaunchState &&
    left.launchPhase === right.launchPhase &&
    left.source === right.source &&
    areExpectedMembersEqual(left.expectedMembers, right.expectedMembers) &&
    areLaunchSummaryCountsEqual(left.summary, right.summary) &&
    areMemberSpawnStatusesEqual(left.statuses, right.statuses)
  );
}

function launchDiagnosticsEqual(
  a: readonly TeamLaunchDiagnosticItem[] | undefined,
  b: readonly TeamLaunchDiagnosticItem[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      !left ||
      !right ||
      left.id !== right.id ||
      left.memberName !== right.memberName ||
      left.severity !== right.severity ||
      left.code !== right.code ||
      left.label !== right.label ||
      left.detail !== right.detail ||
      left.observedAt !== right.observedAt
    ) {
      return false;
    }
  }
  return true;
}

export function provisioningProgressPayloadEqual(
  a: TeamProvisioningProgress,
  b: TeamProvisioningProgress
): boolean {
  return (
    a.runId === b.runId &&
    a.teamName === b.teamName &&
    a.state === b.state &&
    a.message === b.message &&
    a.messageSeverity === b.messageSeverity &&
    a.startedAt === b.startedAt &&
    a.pid === b.pid &&
    a.error === b.error &&
    a.cliLogsTail === b.cliLogsTail &&
    a.assistantOutput === b.assistantOutput &&
    a.configReady === b.configReady &&
    a.retainedSecondaryRuntime === b.retainedSecondaryRuntime &&
    areExpectedMembersEqual(a.warnings, b.warnings) &&
    launchDiagnosticsEqual(a.launchDiagnostics, b.launchDiagnostics)
  );
}
