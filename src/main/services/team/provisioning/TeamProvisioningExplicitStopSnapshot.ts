import type { MemberSpawnStatusEntry, PersistedTeamLaunchSnapshot } from '@shared/types';

const EXPLICIT_STOP_DIAGNOSTIC = 'Runtime stopped by explicit user action';

export function isExplicitlyStoppedLaunchSnapshot(
  snapshot: PersistedTeamLaunchSnapshot | null
): snapshot is PersistedTeamLaunchSnapshot {
  if (!snapshot?.stoppedAt) return false;
  // A confirmed no-run/adapter-only stop can have no expected roster. Fall
  // back to any recoverable member rows; a fully empty snapshot is itself the
  // standalone durable fence against stale bootstrap evidence after restart.
  const stoppedMemberNames =
    snapshot.expectedMembers.length > 0 ? snapshot.expectedMembers : Object.keys(snapshot.members);
  return stoppedMemberNames.every((memberName) => {
    const member = snapshot.members[memberName];
    return (
      member?.launchState === 'skipped_for_launch' ||
      member?.diagnostics?.includes(EXPLICIT_STOP_DIAGNOSTIC) === true
    );
  });
}

export function selectExplicitlyStoppedLaunchSnapshot(
  primary: PersistedTeamLaunchSnapshot | null,
  fallback: PersistedTeamLaunchSnapshot | null
): PersistedTeamLaunchSnapshot | null {
  if (isExplicitlyStoppedLaunchSnapshot(primary)) return primary;
  return isExplicitlyStoppedLaunchSnapshot(fallback) ? fallback : null;
}

export function projectExplicitlyStoppedStatusesOffline(
  statuses: Record<string, MemberSpawnStatusEntry>
): Record<string, MemberSpawnStatusEntry> {
  return Object.fromEntries(
    Object.entries(statuses).map(([name, status]) => [name, { ...status, status: 'offline' }])
  );
}
