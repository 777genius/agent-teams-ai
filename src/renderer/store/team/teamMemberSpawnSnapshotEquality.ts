import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSummary,
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
