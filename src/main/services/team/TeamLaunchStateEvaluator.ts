import { isLeadMember } from '@shared/utils/leadDetection';

import type {
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberSources,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
  TeamLaunchAggregateState,
} from '@shared/types';

interface LegacyPartialLaunchStateFile {
  version?: unknown;
  state?: unknown;
  updatedAt?: unknown;
  leadSessionId?: unknown;
  expectedMembers?: unknown;
  confirmedMembers?: unknown;
  missingMembers?: unknown;
}

type RuntimeMemberSpawnState = Pick<
  MemberSpawnStatusEntry,
  | 'launchState'
  | 'status'
  | 'error'
  | 'hardFailureReason'
  | 'livenessSource'
  | 'agentToolAccepted'
  | 'runtimeAlive'
  | 'bootstrapConfirmed'
  | 'hardFailure'
  | 'firstSpawnAcceptedAt'
  | 'lastHeartbeatAt'
  | 'updatedAt'
>;

function normalizeMemberName(name: string): string {
  return name.trim();
}

function buildDiagnostics(
  member: Pick<
    PersistedTeamLaunchMemberState,
    'agentToolAccepted' | 'runtimeAlive' | 'bootstrapConfirmed' | 'hardFailureReason' | 'sources'
  >
): string[] {
  const diagnostics: string[] = [];
  if (member.agentToolAccepted) diagnostics.push('spawn accepted');
  if (member.runtimeAlive) diagnostics.push('runtime alive');
  if (member.bootstrapConfirmed) diagnostics.push('late heartbeat received');
  if (member.runtimeAlive && !member.bootstrapConfirmed)
    diagnostics.push('waiting for teammate check-in');
  if (member.hardFailureReason)
    diagnostics.push(`hard failure reason: ${member.hardFailureReason}`);
  if (member.sources?.duplicateRespawnBlocked) diagnostics.push('respawn blocked as duplicate');
  if (member.sources?.configDrift) diagnostics.push('config drift detected');
  return diagnostics;
}

export function deriveTeamLaunchAggregateState(
  summary: PersistedTeamLaunchSummary
): TeamLaunchAggregateState {
  if (summary.failedCount > 0) {
    return 'partial_failure';
  }
  if (summary.pendingCount > 0) {
    return 'partial_pending';
  }
  return 'clean_success';
}

export function summarizePersistedLaunchMembers(
  expectedMembers: readonly string[],
  members: Record<string, PersistedTeamLaunchMemberState>
): PersistedTeamLaunchSummary {
  let confirmedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let runtimeAlivePendingCount = 0;
  const normalizedExpected = expectedMembers.map(normalizeMemberName).filter(Boolean);

  for (const memberName of normalizedExpected) {
    const entry = members[memberName];
    if (!entry) {
      pendingCount += 1;
      continue;
    }
    if (entry.launchState === 'confirmed_alive') {
      confirmedCount += 1;
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
  }

  return { confirmedCount, pendingCount, failedCount, runtimeAlivePendingCount };
}

function deriveMemberLaunchState(
  member: Pick<
    PersistedTeamLaunchMemberState,
    'hardFailure' | 'bootstrapConfirmed' | 'runtimeAlive' | 'agentToolAccepted'
  >
): MemberLaunchState {
  if (member.hardFailure) {
    return 'failed_to_start';
  }
  if (member.bootstrapConfirmed) {
    return 'confirmed_alive';
  }
  if (member.runtimeAlive || member.agentToolAccepted) {
    return 'runtime_pending_bootstrap';
  }
  return 'starting';
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeSources(value: unknown): PersistedTeamLaunchMemberSources | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const normalized: PersistedTeamLaunchMemberSources = {
    inboxHeartbeat: toBoolean(source.inboxHeartbeat),
    nativeHeartbeat: toBoolean(source.nativeHeartbeat),
    processAlive: toBoolean(source.processAlive),
    configRegistered: toBoolean(source.configRegistered),
    configDrift: toBoolean(source.configDrift),
    hardFailureSignal: toBoolean(source.hardFailureSignal),
    duplicateRespawnBlocked: toBoolean(source.duplicateRespawnBlocked),
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function normalizePersistedMemberState(
  memberName: string,
  value: unknown,
  updatedAtFallback: string
): PersistedTeamLaunchMemberState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const parsed = value as Record<string, unknown>;
  const normalizedName = normalizeMemberName(memberName);
  if (!normalizedName || normalizedName === 'user' || isLeadMember({ name: normalizedName })) {
    return null;
  }
  const next: PersistedTeamLaunchMemberState = {
    name: normalizedName,
    launchState: 'starting',
    agentToolAccepted: toBoolean(parsed.agentToolAccepted),
    runtimeAlive: toBoolean(parsed.runtimeAlive),
    bootstrapConfirmed: toBoolean(parsed.bootstrapConfirmed),
    hardFailure: toBoolean(parsed.hardFailure),
    hardFailureReason:
      typeof parsed.hardFailureReason === 'string' && parsed.hardFailureReason.trim().length > 0
        ? parsed.hardFailureReason.trim()
        : undefined,
    firstSpawnAcceptedAt:
      typeof parsed.firstSpawnAcceptedAt === 'string' ? parsed.firstSpawnAcceptedAt : undefined,
    lastHeartbeatAt:
      typeof parsed.lastHeartbeatAt === 'string' ? parsed.lastHeartbeatAt : undefined,
    lastRuntimeAliveAt:
      typeof parsed.lastRuntimeAliveAt === 'string' ? parsed.lastRuntimeAliveAt : undefined,
    lastEvaluatedAt:
      typeof parsed.lastEvaluatedAt === 'string' ? parsed.lastEvaluatedAt : updatedAtFallback,
    sources: normalizeSources(parsed.sources),
    diagnostics: Array.isArray(parsed.diagnostics)
      ? parsed.diagnostics.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : undefined,
  };
  const launchState =
    parsed.launchState === 'starting' ||
    parsed.launchState === 'runtime_pending_bootstrap' ||
    parsed.launchState === 'confirmed_alive' ||
    parsed.launchState === 'failed_to_start'
      ? parsed.launchState
      : deriveMemberLaunchState(next);
  next.launchState = launchState;
  next.diagnostics = next.diagnostics?.length ? next.diagnostics : buildDiagnostics(next);
  return next;
}

export function createPersistedLaunchSnapshot(params: {
  teamName: string;
  expectedMembers: readonly string[];
  leadSessionId?: string;
  launchPhase?: PersistedTeamLaunchPhase;
  members?: Record<string, PersistedTeamLaunchMemberState>;
  updatedAt?: string;
}): PersistedTeamLaunchSnapshot {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  const expectedMembers = Array.from(
    new Set(
      params.expectedMembers
        .map(normalizeMemberName)
        .filter((name) => name.length > 0 && name !== 'user' && !isLeadMember({ name }))
    )
  );
  const members = params.members ?? {};
  const launchPhase = params.launchPhase ?? 'active';

  // When the launch is over (finished/reconciled), members still in 'starting' state
  // (never spawned — agentToolAccepted is false) are unreachable and should be marked
  // as failed. Without this, they stay as 'pending' forever, causing the UI to show
  // "Last launch is still reconciling" indefinitely after a crash or incomplete launch.
  if (launchPhase !== 'active') {
    for (const name of expectedMembers) {
      const member = members[name];
      if (
        member &&
        member.launchState === 'starting' &&
        !member.agentToolAccepted &&
        !member.runtimeAlive &&
        !member.bootstrapConfirmed &&
        !member.hardFailure
      ) {
        member.hardFailure = true;
        member.hardFailureReason =
          member.hardFailureReason ?? 'Teammate was never spawned during launch.';
        member.launchState = deriveMemberLaunchState(member);
        member.diagnostics = buildDiagnostics(member);
      }
    }
  }

  const summary = summarizePersistedLaunchMembers(expectedMembers, members);
  return {
    version: 2,
    teamName: params.teamName,
    updatedAt,
    ...(params.leadSessionId ? { leadSessionId: params.leadSessionId } : {}),
    launchPhase,
    expectedMembers,
    members,
    summary,
    teamLaunchState: deriveTeamLaunchAggregateState(summary),
  };
}

export function snapshotFromRuntimeMemberStatuses(params: {
  teamName: string;
  expectedMembers: readonly string[];
  leadSessionId?: string;
  launchPhase?: PersistedTeamLaunchPhase;
  statuses: Record<string, RuntimeMemberSpawnState>;
  updatedAt?: string;
}): PersistedTeamLaunchSnapshot {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  const members: Record<string, PersistedTeamLaunchMemberState> = {};

  for (const expected of params.expectedMembers) {
    const name = normalizeMemberName(expected);
    if (!name || name === 'user' || isLeadMember({ name })) continue;
    const runtime = params.statuses[name];
    const sources: PersistedTeamLaunchMemberSources = {};
    if (runtime?.livenessSource === 'heartbeat') {
      sources.nativeHeartbeat = true;
      sources.inboxHeartbeat = true;
    }
    if (runtime?.livenessSource === 'process' || runtime?.runtimeAlive) {
      sources.processAlive = true;
    }
    const entry: PersistedTeamLaunchMemberState = {
      name,
      launchState: runtime?.launchState ?? 'starting',
      agentToolAccepted: runtime?.agentToolAccepted === true,
      runtimeAlive: runtime?.runtimeAlive === true,
      bootstrapConfirmed: runtime?.bootstrapConfirmed === true,
      hardFailure: runtime?.hardFailure === true || runtime?.launchState === 'failed_to_start',
      hardFailureReason: runtime?.hardFailureReason ?? runtime?.error,
      firstSpawnAcceptedAt: runtime?.firstSpawnAcceptedAt,
      lastHeartbeatAt: runtime?.lastHeartbeatAt,
      lastRuntimeAliveAt: runtime?.runtimeAlive ? updatedAt : undefined,
      lastEvaluatedAt: runtime?.updatedAt ?? updatedAt,
      sources: Object.values(sources).some(Boolean) ? sources : undefined,
      diagnostics: undefined,
    };
    entry.launchState = deriveMemberLaunchState(entry);
    entry.diagnostics = buildDiagnostics(entry);
    members[name] = entry;
  }

  return createPersistedLaunchSnapshot({
    teamName: params.teamName,
    expectedMembers: params.expectedMembers,
    leadSessionId: params.leadSessionId,
    launchPhase: params.launchPhase,
    members,
    updatedAt,
  });
}

export function snapshotToMemberSpawnStatuses(
  snapshot: PersistedTeamLaunchSnapshot | null
): Record<string, MemberSpawnStatusEntry> {
  if (!snapshot) return {};
  const statuses: Record<string, MemberSpawnStatusEntry> = {};
  for (const memberName of snapshot.expectedMembers) {
    const entry = snapshot.members[memberName];
    if (!entry) continue;
    let status: MemberSpawnStatusEntry['status'] = 'offline';
    let livenessSource: MemberSpawnLivenessSource | undefined;
    if (entry.launchState === 'failed_to_start') {
      status = 'error';
    } else if (entry.launchState === 'confirmed_alive') {
      status = 'online';
      livenessSource = 'heartbeat';
    } else if (entry.launchState === 'runtime_pending_bootstrap') {
      status = entry.runtimeAlive ? 'online' : 'waiting';
      livenessSource = entry.runtimeAlive ? 'process' : undefined;
    } else {
      status = entry.agentToolAccepted ? 'waiting' : 'spawning';
    }
    statuses[memberName] = {
      status,
      launchState: entry.launchState,
      error: entry.hardFailure ? entry.hardFailureReason : undefined,
      hardFailureReason: entry.hardFailureReason,
      livenessSource,
      agentToolAccepted: entry.agentToolAccepted,
      runtimeAlive: entry.runtimeAlive,
      bootstrapConfirmed: entry.bootstrapConfirmed,
      hardFailure: entry.hardFailure,
      firstSpawnAcceptedAt: entry.firstSpawnAcceptedAt,
      lastHeartbeatAt: entry.lastHeartbeatAt,
      updatedAt: entry.lastEvaluatedAt,
    };
  }
  return statuses;
}

export function normalizePersistedLaunchSnapshot(
  teamName: string,
  parsed: unknown
): PersistedTeamLaunchSnapshot | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const maybeLegacy = parsed as LegacyPartialLaunchStateFile;
  if (maybeLegacy.state === 'partial_launch_failure') {
    const expectedMembers = Array.isArray(maybeLegacy.expectedMembers)
      ? maybeLegacy.expectedMembers.filter(
          (name): name is string => typeof name === 'string' && normalizeMemberName(name).length > 0
        )
      : [];
    const confirmedMembers = Array.isArray(maybeLegacy.confirmedMembers)
      ? maybeLegacy.confirmedMembers.filter(
          (name): name is string => typeof name === 'string' && normalizeMemberName(name).length > 0
        )
      : [];
    const missingMembers = Array.isArray(maybeLegacy.missingMembers)
      ? maybeLegacy.missingMembers.filter(
          (name): name is string => typeof name === 'string' && normalizeMemberName(name).length > 0
        )
      : [];
    if (expectedMembers.length === 0 || missingMembers.length === 0) {
      return null;
    }
    const updatedAt =
      typeof maybeLegacy.updatedAt === 'string' ? maybeLegacy.updatedAt : new Date().toISOString();
    const members: Record<string, PersistedTeamLaunchMemberState> = {};
    for (const name of expectedMembers) {
      const failed = missingMembers.includes(name);
      const confirmed = confirmedMembers.includes(name);
      const entry: PersistedTeamLaunchMemberState = {
        name,
        launchState: failed ? 'failed_to_start' : confirmed ? 'confirmed_alive' : 'starting',
        agentToolAccepted: true,
        runtimeAlive: confirmed,
        bootstrapConfirmed: confirmed,
        hardFailure: failed,
        hardFailureReason: failed
          ? 'Legacy partial launch marker reported teammate missing.'
          : undefined,
        lastEvaluatedAt: updatedAt,
        diagnostics: undefined,
      };
      entry.diagnostics = buildDiagnostics(entry);
      members[name] = entry;
    }
    return createPersistedLaunchSnapshot({
      teamName,
      expectedMembers,
      leadSessionId:
        typeof maybeLegacy.leadSessionId === 'string' && maybeLegacy.leadSessionId.trim().length > 0
          ? maybeLegacy.leadSessionId.trim()
          : undefined,
      launchPhase: 'finished',
      members,
      updatedAt,
    });
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 2) {
    return null;
  }
  const expectedMembers = Array.isArray(record.expectedMembers)
    ? record.expectedMembers.filter(
        (name): name is string => typeof name === 'string' && normalizeMemberName(name).length > 0
      )
    : [];
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim().length > 0
      ? record.updatedAt
      : new Date().toISOString();
  const normalizedMembers: Record<string, PersistedTeamLaunchMemberState> = {};
  const rawMembers =
    record.members && typeof record.members === 'object'
      ? (record.members as Record<string, unknown>)
      : {};
  for (const [memberName, value] of Object.entries(rawMembers)) {
    const normalized = normalizePersistedMemberState(memberName, value, updatedAt);
    if (!normalized) continue;
    normalizedMembers[normalized.name] = normalized;
  }
  return createPersistedLaunchSnapshot({
    teamName:
      typeof record.teamName === 'string' && record.teamName.trim().length > 0
        ? record.teamName.trim()
        : teamName,
    expectedMembers,
    leadSessionId:
      typeof record.leadSessionId === 'string' && record.leadSessionId.trim().length > 0
        ? record.leadSessionId.trim()
        : undefined,
    launchPhase:
      record.launchPhase === 'active' ||
      record.launchPhase === 'finished' ||
      record.launchPhase === 'reconciled'
        ? record.launchPhase
        : 'finished',
    members: normalizedMembers,
    updatedAt,
  });
}
