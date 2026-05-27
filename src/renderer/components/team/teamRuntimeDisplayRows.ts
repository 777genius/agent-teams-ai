import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidence,
  hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
} from '@shared/utils/teamLaunchFailureReason';

import type {
  MemberSpawnStatusEntry,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export type RuntimeDisplayState =
  | 'running'
  | 'starting'
  | 'waiting'
  | 'degraded'
  | 'stopped'
  | 'unknown';

export interface TeamRuntimeDisplayMember {
  name: string;
}

export interface TeamRuntimeDisplayRow {
  memberName: string;
  state: RuntimeDisplayState;
  stateReason: string;
  source: 'runtime' | 'spawn-status' | 'mixed';
  updatedAt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  runtimeModel?: string;
  diagnostic?: string;
  diagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  pidLabel?: string;
  actionsAllowed: false;
}

interface SpawnDegradation {
  reason: string;
  diagnostic?: string;
  diagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
}

interface SpawnStoppedEvidence {
  reason: string;
  diagnostic?: string;
  diagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
}

const ACTIVE_SPAWN_STATUSES = new Set(['waiting', 'spawning']);

export function buildTeamRuntimeDisplayRows({
  members,
  runtimeSnapshot,
  spawnStatuses,
}: {
  members: readonly TeamRuntimeDisplayMember[];
  runtimeSnapshot?: TeamAgentRuntimeSnapshot | null;
  spawnStatuses?: Record<string, MemberSpawnStatusEntry> | null;
}): TeamRuntimeDisplayRow[] {
  const runtimeByMember = buildRuntimeEntriesByMember(runtimeSnapshot);

  return members.map((member) => {
    const runtime = pickLatestRuntimeEntry(runtimeByMember.get(member.name) ?? []);
    const spawn = spawnStatuses?.[member.name];
    return buildRuntimeDisplayRow(member.name, runtime, spawn);
  });
}

function buildRuntimeEntriesByMember(
  runtimeSnapshot?: TeamAgentRuntimeSnapshot | null
): Map<string, TeamAgentRuntimeEntry[]> {
  const byMember = new Map<string, TeamAgentRuntimeEntry[]>();
  const runtimeMembers = runtimeSnapshot?.members;
  if (!runtimeMembers) return byMember;

  for (const [key, entry] of Object.entries(runtimeMembers)) {
    const memberName = entry.memberName || key;
    if (!memberName) continue;
    const entries = byMember.get(memberName);
    if (entries) {
      entries.push(entry);
    } else {
      byMember.set(memberName, [entry]);
    }
  }

  return byMember;
}

function pickLatestRuntimeEntry(
  entries: readonly TeamAgentRuntimeEntry[]
): TeamAgentRuntimeEntry | undefined {
  let latest: TeamAgentRuntimeEntry | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const timestamp = getRuntimeEntryTimestamp(entry);
    if (!latest || timestamp >= latestTimestamp) {
      latest = entry;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

function getRuntimeEntryTimestamp(entry: TeamAgentRuntimeEntry): number {
  const timestamp = Date.parse(entry.runtimeLastSeenAt ?? entry.updatedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildRuntimeDisplayRow(
  memberName: string,
  runtime?: TeamAgentRuntimeEntry,
  spawn?: MemberSpawnStatusEntry
): TeamRuntimeDisplayRow {
  if (runtime) {
    return buildRuntimeBackedDisplayRow(memberName, runtime, spawn);
  }

  if (spawn) {
    return buildSpawnBackedDisplayRow(memberName, spawn);
  }

  return {
    memberName,
    state: 'unknown',
    stateReason: 'No live runtime snapshot yet',
    source: 'spawn-status',
    actionsAllowed: false,
  };
}

function buildRuntimeBackedDisplayRow(
  memberName: string,
  runtime: TeamAgentRuntimeEntry,
  spawn?: MemberSpawnStatusEntry
): TeamRuntimeDisplayRow {
  const hasErrorDiagnostic = runtime.runtimeDiagnosticSeverity === 'error';
  const bootstrapConfirmedProvisionedButNotAlive =
    isBootstrapConfirmedProvisionedButNotAliveFailure(spawn);
  const spawnDegradation = getSpawnDegradation(spawn);
  const unsafeRuntimeEvidence = hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(
    spawn,
    runtime
  );
  const useBootstrapConfirmedState =
    bootstrapConfirmedProvisionedButNotAlive &&
    !hasErrorDiagnostic &&
    !unsafeRuntimeEvidence &&
    spawnDegradation == null;
  const spawnStoppedEvidence = spawnDegradation ? null : getSpawnStoppedEvidence(runtime, spawn);
  const state = useBootstrapConfirmedState
    ? 'running'
    : spawnStoppedEvidence
      ? 'stopped'
      : getRuntimeBackedState(runtime, hasErrorDiagnostic, spawnDegradation != null);
  const degradedReason = spawnDegradation
    ? withLiveProcessContext(spawnDegradation.reason, runtime)
    : undefined;
  const stateReason =
    (useBootstrapConfirmedState ? 'Bootstrap confirmed' : undefined) ??
    degradedReason ??
    spawnStoppedEvidence?.reason ??
    runtime.runtimeDiagnostic ??
    (runtime.alive === true ? 'Runtime heartbeat is alive' : 'Runtime heartbeat is not alive');

  return {
    memberName,
    state,
    stateReason,
    source: spawn ? 'mixed' : 'runtime',
    updatedAt: runtime.runtimeLastSeenAt ?? runtime.updatedAt,
    providerId: runtime.providerId,
    providerBackendId: runtime.providerBackendId,
    laneId: runtime.laneId,
    laneKind: runtime.laneKind,
    runtimeModel: runtime.runtimeModel,
    diagnostic:
      spawnDegradation && degradedReason
        ? withLiveProcessContext(spawnDegradation.diagnostic ?? degradedReason, runtime)
        : spawnStoppedEvidence
          ? spawnStoppedEvidence.diagnostic
          : runtime.runtimeDiagnostic,
    diagnosticSeverity:
      spawnDegradation?.diagnosticSeverity ??
      spawnStoppedEvidence?.diagnosticSeverity ??
      runtime.runtimeDiagnosticSeverity,
    pidLabel: formatRuntimePidLabel(runtime),
    actionsAllowed: false,
  };
}

function getSpawnDegradation(spawn?: MemberSpawnStatusEntry): SpawnDegradation | null {
  if (!spawn) return null;
  if (isBootstrapConfirmedProvisionedButNotAliveFailure(spawn)) {
    if (!hasUnsafeProvisionedButNotAliveRuntimeEvidence(spawn)) {
      return null;
    }
    const reason = spawn.runtimeDiagnostic ?? 'Runtime launch status needs attention';
    return {
      reason,
      diagnostic: spawn.runtimeDiagnostic ?? reason,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity === 'error' ? 'error' : 'warning',
    };
  }

  if (spawn.status === 'error' || spawn.hardFailure === true) {
    const reason =
      spawn.error ?? spawn.hardFailureReason ?? spawn.runtimeDiagnostic ?? 'Spawn failed';
    return {
      reason,
      diagnostic: spawn.runtimeDiagnostic ?? reason,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity ?? 'error',
    };
  }

  if (spawn.bootstrapStalled === true) {
    const reason = spawn.runtimeDiagnostic ?? 'Runtime is alive, but bootstrap did not confirm';
    return {
      reason,
      diagnostic: spawn.runtimeDiagnostic ?? reason,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity ?? 'warning',
    };
  }

  if ((spawn.pendingPermissionRequestIds?.length ?? 0) > 0) {
    const reason = spawn.runtimeDiagnostic ?? 'Runtime is waiting for permission approval';
    return {
      reason,
      diagnostic: spawn.runtimeDiagnostic ?? reason,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity ?? 'warning',
    };
  }

  if (spawn.runtimeDiagnosticSeverity === 'error') {
    const reason = spawn.runtimeDiagnostic ?? 'Runtime launch status needs attention';
    return {
      reason,
      diagnostic: spawn.runtimeDiagnostic,
      diagnosticSeverity: 'error',
    };
  }

  return null;
}

function getSpawnStoppedEvidence(
  runtime: TeamAgentRuntimeEntry,
  spawn?: MemberSpawnStatusEntry
): SpawnStoppedEvidence | null {
  if (isBootstrapConfirmedProvisionedButNotAliveFailure(spawn)) {
    return null;
  }
  if (spawn?.runtimeAlive !== false || runtime.livenessKind !== 'confirmed_bootstrap') {
    return null;
  }
  if (spawn.status !== 'online' && spawn.launchState !== 'confirmed_alive') {
    return null;
  }
  const reason = spawn.runtimeDiagnostic ?? 'Spawn status reports runtime is not alive';
  return {
    reason,
    diagnostic: spawn.runtimeDiagnostic ?? reason,
    diagnosticSeverity: spawn.runtimeDiagnosticSeverity ?? 'warning',
  };
}

function getRuntimeBackedState(
  runtime: TeamAgentRuntimeEntry,
  hasErrorDiagnostic: boolean,
  hasSpawnDegradation: boolean
): RuntimeDisplayState {
  if (hasSpawnDegradation || hasErrorDiagnostic) {
    return 'degraded';
  }

  return runtime.alive === true ? 'running' : 'stopped';
}

function withLiveProcessContext(reason: string, runtime: TeamAgentRuntimeEntry): string {
  if (
    runtime.alive !== true ||
    runtime.livenessKind === 'confirmed_bootstrap' ||
    /process is still alive/i.test(reason)
  ) {
    return reason;
  }
  return `${reason}. Process is still alive.`;
}

function buildSpawnBackedDisplayRow(
  memberName: string,
  spawn: MemberSpawnStatusEntry
): TeamRuntimeDisplayRow {
  if (
    isBootstrapConfirmedProvisionedButNotAliveFailure(spawn) &&
    !hasUnsafeProvisionedButNotAliveRuntimeEvidence(spawn)
  ) {
    return {
      memberName,
      state: 'running',
      stateReason: 'Bootstrap confirmed',
      source: 'spawn-status',
      updatedAt: spawn.livenessLastCheckedAt ?? spawn.lastHeartbeatAt ?? spawn.updatedAt,
      runtimeModel: spawn.runtimeModel,
      diagnostic: spawn.runtimeDiagnostic,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity,
      actionsAllowed: false,
    };
  }

  const spawnDegradation = getSpawnDegradation(spawn);
  if (spawnDegradation) {
    return {
      memberName,
      state: 'degraded',
      stateReason: spawnDegradation.reason,
      source: 'spawn-status',
      updatedAt: spawn.livenessLastCheckedAt ?? spawn.updatedAt,
      runtimeModel: spawn.runtimeModel,
      diagnostic: spawnDegradation.diagnostic,
      diagnosticSeverity: spawnDegradation.diagnosticSeverity,
      actionsAllowed: false,
    };
  }

  const spawnStoppedEvidence = getSpawnOnlyStoppedEvidence(spawn);
  if (spawnStoppedEvidence) {
    return {
      memberName,
      state: 'stopped',
      stateReason: spawnStoppedEvidence.reason,
      source: 'spawn-status',
      updatedAt: spawn.livenessLastCheckedAt ?? spawn.updatedAt,
      runtimeModel: spawn.runtimeModel,
      diagnostic: spawnStoppedEvidence.diagnostic,
      diagnosticSeverity: spawnStoppedEvidence.diagnosticSeverity,
      actionsAllowed: false,
    };
  }

  if (
    (spawn.status === 'online' && hasConfirmedSpawnLiveness(spawn)) ||
    isConfirmedSpawnLaunch(spawn)
  ) {
    return {
      memberName,
      state: 'running',
      stateReason: spawn.runtimeDiagnostic ?? 'Bootstrap confirmed',
      source: 'spawn-status',
      updatedAt: spawn.livenessLastCheckedAt ?? spawn.lastHeartbeatAt ?? spawn.updatedAt,
      runtimeModel: spawn.runtimeModel,
      diagnostic: spawn.runtimeDiagnostic,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity,
      actionsAllowed: false,
    };
  }

  if (ACTIVE_SPAWN_STATUSES.has(spawn.status)) {
    return {
      memberName,
      state: spawn.status === 'waiting' ? 'waiting' : 'starting',
      stateReason: spawn.runtimeDiagnostic ?? `Spawn status is ${spawn.status}`,
      source: 'spawn-status',
      updatedAt: spawn.livenessLastCheckedAt ?? spawn.updatedAt,
      runtimeModel: spawn.runtimeModel,
      diagnostic: spawn.runtimeDiagnostic,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity,
      actionsAllowed: false,
    };
  }

  if (spawn.status === 'offline' || spawn.status === 'skipped') {
    return {
      memberName,
      state: 'stopped',
      stateReason:
        spawn.status === 'skipped'
          ? (spawn.skipReason ?? 'Member was skipped for launch')
          : 'Spawn status is offline',
      source: 'spawn-status',
      updatedAt: spawn.updatedAt,
      runtimeModel: spawn.runtimeModel,
      diagnostic: spawn.runtimeDiagnostic,
      diagnosticSeverity: spawn.runtimeDiagnosticSeverity,
      actionsAllowed: false,
    };
  }

  return {
    memberName,
    state: 'unknown',
    stateReason: `Spawn status is ${String(spawn.status)}`,
    source: 'spawn-status',
    updatedAt: spawn.updatedAt,
    runtimeModel: spawn.runtimeModel,
    diagnostic: spawn.runtimeDiagnostic,
    diagnosticSeverity: spawn.runtimeDiagnosticSeverity,
    actionsAllowed: false,
  };
}

function getSpawnOnlyStoppedEvidence(spawn: MemberSpawnStatusEntry): SpawnStoppedEvidence | null {
  if (isBootstrapConfirmedProvisionedButNotAliveFailure(spawn)) return null;
  if (spawn.runtimeAlive !== false) return null;
  if (spawn.status !== 'online' && spawn.launchState !== 'confirmed_alive') return null;

  const reason = spawn.runtimeDiagnostic ?? 'Spawn status reports runtime is not alive';
  return {
    reason,
    diagnostic: spawn.runtimeDiagnostic ?? reason,
    diagnosticSeverity: spawn.runtimeDiagnosticSeverity ?? 'warning',
  };
}

function hasConfirmedSpawnLiveness(spawn: MemberSpawnStatusEntry): boolean {
  return (
    spawn.runtimeAlive === true ||
    spawn.bootstrapConfirmed === true ||
    spawn.livenessSource === 'heartbeat' ||
    spawn.livenessSource === 'process'
  );
}

function isConfirmedSpawnLaunch(spawn: MemberSpawnStatusEntry): boolean {
  return spawn.launchState === 'confirmed_alive' && spawn.bootstrapConfirmed === true;
}

function formatRuntimePidLabel(runtime: TeamAgentRuntimeEntry): string | undefined {
  const runtimePid = getFinitePid(runtime.runtimePid);
  if (runtimePid != null) return `runtime pid ${runtimePid}`;

  const processPid = getFinitePid(runtime.pid);
  if (processPid != null) return `${runtime.pidSource ?? 'process'} pid ${processPid}`;

  const panePid = getFinitePid(runtime.panePid);
  if (panePid != null) return `pane pid ${panePid}`;

  return undefined;
}

function getFinitePid(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
