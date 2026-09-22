import type {
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

const TRANSIENT_RUNTIME_OFFLINE_GRACE_MS = 15_000;

const TRANSIENT_RUNTIME_OFFLINE_KINDS = new Set<TeamAgentRuntimeLivenessKind>([
  'registered_only',
  'stale_metadata',
  'not_found',
]);

const STRONG_LIVE_RUNTIME_KINDS = new Set<TeamAgentRuntimeLivenessKind>([
  'runtime_process',
  'confirmed_bootstrap',
]);

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEntryObservedAtMs(
  snapshot: TeamAgentRuntimeSnapshot,
  entry: TeamAgentRuntimeEntry
): number | null {
  return (
    parseTimestampMs(entry.updatedAt) ??
    parseTimestampMs(entry.runtimeLastSeenAt) ??
    parseTimestampMs(snapshot.updatedAt)
  );
}

function hasStrongLiveRuntimeEvidence(entry: TeamAgentRuntimeEntry | undefined): boolean {
  return Boolean(
    entry?.alive === true &&
    (entry.livenessKind == null || STRONG_LIVE_RUNTIME_KINDS.has(entry.livenessKind))
  );
}

function isTransientRuntimeOfflineEntry(entry: TeamAgentRuntimeEntry | undefined): boolean {
  return Boolean(
    entry?.alive === false &&
    entry.runtimeDiagnosticSeverity !== 'error' &&
    entry.livenessKind != null &&
    TRANSIENT_RUNTIME_OFFLINE_KINDS.has(entry.livenessKind)
  );
}

function shouldKeepPreviousLiveRuntimeEntry({
  previousSnapshot,
  previousEntry,
  nextEntry,
  nowMs,
}: {
  previousSnapshot: TeamAgentRuntimeSnapshot;
  previousEntry: TeamAgentRuntimeEntry | undefined;
  nextEntry: TeamAgentRuntimeEntry | undefined;
  nowMs: number;
}): boolean {
  if (!hasStrongLiveRuntimeEvidence(previousEntry)) return false;
  if (!isTransientRuntimeOfflineEntry(nextEntry)) return false;

  const previousObservedAtMs = previousEntry
    ? getEntryObservedAtMs(previousSnapshot, previousEntry)
    : null;
  if (previousObservedAtMs == null) return false;

  return nowMs - previousObservedAtMs <= TRANSIENT_RUNTIME_OFFLINE_GRACE_MS;
}

export function stabilizeTeamAgentRuntimeSnapshot(
  previousSnapshot: TeamAgentRuntimeSnapshot | undefined,
  nextSnapshot: TeamAgentRuntimeSnapshot,
  nowMs = Date.now()
): TeamAgentRuntimeSnapshot {
  if (
    !previousSnapshot ||
    previousSnapshot.teamName !== nextSnapshot.teamName ||
    previousSnapshot.runId !== nextSnapshot.runId
  ) {
    return nextSnapshot;
  }

  let stabilizedMembers: Record<string, TeamAgentRuntimeEntry> | null = null;

  for (const [memberName, nextEntry] of Object.entries(nextSnapshot.members)) {
    const previousEntry = previousSnapshot.members[memberName];
    if (!previousEntry) continue;
    if (
      !shouldKeepPreviousLiveRuntimeEntry({
        previousSnapshot,
        previousEntry,
        nextEntry,
        nowMs,
      })
    ) {
      continue;
    }

    stabilizedMembers ??= { ...nextSnapshot.members };
    stabilizedMembers[memberName] = previousEntry;
  }

  if (!stabilizedMembers) {
    return nextSnapshot;
  }

  return {
    ...nextSnapshot,
    members: stabilizedMembers,
  };
}
