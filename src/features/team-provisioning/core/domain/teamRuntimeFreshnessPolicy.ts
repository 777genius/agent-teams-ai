import type { TeamAgentRuntimeSnapshot } from '@shared/types';

export type TeamRuntimeSnapshotEquality = (
  visible: TeamAgentRuntimeSnapshot,
  cached: TeamAgentRuntimeSnapshot
) => boolean;

export function parseRuntimeFreshnessTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function doesRuntimeFreshnessTimestampExtendVisible(
  visibleTimestamp: string | undefined,
  cachedTimestamp: string | undefined
): boolean {
  if (!visibleTimestamp) return true;
  if (!cachedTimestamp) return false;

  const visibleMs = parseRuntimeFreshnessTimestampMs(visibleTimestamp);
  const cachedMs = parseRuntimeFreshnessTimestampMs(cachedTimestamp);
  if (visibleMs === null || cachedMs === null) {
    return cachedTimestamp === visibleTimestamp;
  }
  return cachedMs >= visibleMs;
}

export function doesRuntimeFreshnessSnapshotExtendVisible(
  visibleSnapshot: TeamAgentRuntimeSnapshot,
  cachedSnapshot: TeamAgentRuntimeSnapshot,
  areSnapshotsEqual: TeamRuntimeSnapshotEquality
): boolean {
  if (!areSnapshotsEqual(visibleSnapshot, cachedSnapshot)) {
    return false;
  }
  if (
    !doesRuntimeFreshnessTimestampExtendVisible(visibleSnapshot.updatedAt, cachedSnapshot.updatedAt)
  ) {
    return false;
  }

  for (const [memberName, visibleEntry] of Object.entries(visibleSnapshot.members)) {
    const cachedEntry = cachedSnapshot.members[memberName];
    if (
      !cachedEntry ||
      !doesRuntimeFreshnessTimestampExtendVisible(visibleEntry.updatedAt, cachedEntry.updatedAt) ||
      !doesRuntimeFreshnessTimestampExtendVisible(
        visibleEntry.runtimeLastSeenAt,
        cachedEntry.runtimeLastSeenAt
      )
    ) {
      return false;
    }
  }

  return true;
}
