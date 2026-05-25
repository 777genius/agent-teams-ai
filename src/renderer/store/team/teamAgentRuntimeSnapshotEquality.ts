import type {
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeResourceSample,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

function isTeamAgentRuntimeResourceSampleLike(
  value: unknown
): value is TeamAgentRuntimeResourceSample {
  return Boolean(value) && typeof value === 'object';
}

export function areTeamAgentRuntimeResourceSamplesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isTeamAgentRuntimeResourceSampleLike(left) || !isTeamAgentRuntimeResourceSampleLike(right)) {
    return false;
  }
  return (
    left.timestamp === right.timestamp &&
    left.cpuPercent === right.cpuPercent &&
    left.rssBytes === right.rssBytes &&
    left.primaryCpuPercent === right.primaryCpuPercent &&
    left.primaryRssBytes === right.primaryRssBytes &&
    left.childCpuPercent === right.childCpuPercent &&
    left.childRssBytes === right.childRssBytes &&
    left.processCount === right.processCount &&
    left.runtimeLoadScope === right.runtimeLoadScope &&
    left.runtimeLoadTruncated === right.runtimeLoadTruncated &&
    left.pidSource === right.pidSource &&
    left.pid === right.pid &&
    left.runtimePid === right.runtimePid
  );
}

export function areTeamAgentRuntimeEntriesEqual(
  left: TeamAgentRuntimeEntry | undefined,
  right: TeamAgentRuntimeEntry | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  const leftDiagnostics = Array.isArray(left.diagnostics) ? left.diagnostics : [];
  const rightDiagnostics = Array.isArray(right.diagnostics) ? right.diagnostics : [];
  const leftResourceHistory = Array.isArray(left.resourceHistory) ? left.resourceHistory : [];
  const rightResourceHistory = Array.isArray(right.resourceHistory) ? right.resourceHistory : [];
  return (
    left.memberName === right.memberName &&
    left.alive === right.alive &&
    left.restartable === right.restartable &&
    left.backendType === right.backendType &&
    left.providerId === right.providerId &&
    left.providerBackendId === right.providerBackendId &&
    left.laneId === right.laneId &&
    left.laneKind === right.laneKind &&
    left.pid === right.pid &&
    left.runtimeModel === right.runtimeModel &&
    left.rssBytes === right.rssBytes &&
    left.cpuPercent === right.cpuPercent &&
    left.primaryCpuPercent === right.primaryCpuPercent &&
    left.primaryRssBytes === right.primaryRssBytes &&
    left.childCpuPercent === right.childCpuPercent &&
    left.childRssBytes === right.childRssBytes &&
    left.processCount === right.processCount &&
    left.runtimeLoadScope === right.runtimeLoadScope &&
    left.runtimeLoadTruncated === right.runtimeLoadTruncated &&
    left.livenessKind === right.livenessKind &&
    left.pidSource === right.pidSource &&
    left.processCommand === right.processCommand &&
    left.paneId === right.paneId &&
    left.panePid === right.panePid &&
    left.paneCurrentCommand === right.paneCurrentCommand &&
    left.runtimePid === right.runtimePid &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.runtimeDiagnostic === right.runtimeDiagnostic &&
    left.runtimeDiagnosticSeverity === right.runtimeDiagnosticSeverity &&
    left.runtimeLastSeenAt === right.runtimeLastSeenAt &&
    left.historicalBootstrapConfirmed === right.historicalBootstrapConfirmed &&
    leftDiagnostics.length === rightDiagnostics.length &&
    leftDiagnostics.every((value, index) => value === rightDiagnostics[index]) &&
    leftResourceHistory.length === rightResourceHistory.length &&
    leftResourceHistory.every((value, index) =>
      areTeamAgentRuntimeResourceSamplesEqual(value, rightResourceHistory[index])
    )
  );
}

export function areTeamAgentRuntimeSnapshotsEqual(
  left: TeamAgentRuntimeSnapshot | undefined,
  right: TeamAgentRuntimeSnapshot
): boolean {
  if (!left) return false;
  if (left.teamName !== right.teamName || left.runId !== right.runId) {
    return false;
  }
  const leftKeys = Object.keys(left.members);
  const rightKeys = Object.keys(right.members);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in right.members)) {
      return false;
    }
    if (!areTeamAgentRuntimeEntriesEqual(left.members[key], right.members[key])) {
      return false;
    }
  }
  return true;
}
