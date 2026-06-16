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

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function areDiagnosticsEqual(left: unknown, right: unknown): boolean {
  const leftLength = getArrayLength(left);
  const rightLength = getArrayLength(right);
  if (leftLength !== rightLength) return false;
  if (leftLength === 0) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  for (let index = 0; index < leftLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function areResourceHistoryEntriesEqual(left: unknown, right: unknown): boolean {
  const leftLength = getArrayLength(left);
  const rightLength = getArrayLength(right);
  if (leftLength !== rightLength) return false;
  if (leftLength === 0) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  for (let index = 0; index < leftLength; index += 1) {
    if (!areTeamAgentRuntimeResourceSamplesEqual(left[index], right[index])) return false;
  }
  return true;
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
    areDiagnosticsEqual(left.diagnostics, right.diagnostics) &&
    areResourceHistoryEntriesEqual(left.resourceHistory, right.resourceHistory)
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
