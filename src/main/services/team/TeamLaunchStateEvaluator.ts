import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberSources,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
  ProviderModelLaunchIdentity,
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
  | 'pendingPermissionRequestIds'
  | 'firstSpawnAcceptedAt'
  | 'lastHeartbeatAt'
  | 'updatedAt'
>;

function normalizePendingPermissionRequestIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function normalizeRuntimePid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeMemberName(name: string): string {
  return name.trim();
}

function buildDiagnostics(
  member: Pick<
    PersistedTeamLaunchMemberState,
    | 'agentToolAccepted'
    | 'runtimeAlive'
    | 'bootstrapConfirmed'
    | 'hardFailureReason'
    | 'sources'
    | 'pendingPermissionRequestIds'
  >
): string[] {
  const diagnostics: string[] = [];
  if (member.agentToolAccepted) diagnostics.push('spawn accepted');
  if (member.runtimeAlive) diagnostics.push('runtime alive');
  if (member.bootstrapConfirmed) diagnostics.push('late heartbeat received');
  if ((member.pendingPermissionRequestIds?.length ?? 0) > 0) {
    diagnostics.push('waiting for permission approval');
  } else if (member.runtimeAlive && !member.bootstrapConfirmed) {
    diagnostics.push('waiting for teammate check-in');
  }
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
  const memberNames = Array.from(
    new Set([
      ...normalizedExpected,
      ...Object.keys(members).map(normalizeMemberName).filter(Boolean),
    ])
  );

  for (const memberName of memberNames) {
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

export function hasMixedPersistedLaunchMetadata(
  snapshot: PersistedTeamLaunchSnapshot | null | undefined
): boolean {
  if (!snapshot) {
    return false;
  }
  if (
    Array.isArray(snapshot.bootstrapExpectedMembers) &&
    snapshot.bootstrapExpectedMembers.join('\u0000') !== snapshot.expectedMembers.join('\u0000')
  ) {
    return true;
  }
  return Object.values(snapshot.members).some(
    (member) =>
      Boolean(member?.laneId) ||
      Boolean(member?.laneKind) ||
      Boolean(member?.laneOwnerProviderId) ||
      Boolean(member?.launchIdentity)
  );
}

function deriveMemberLaunchState(
  member: Pick<
    PersistedTeamLaunchMemberState,
    | 'hardFailure'
    | 'bootstrapConfirmed'
    | 'runtimeAlive'
    | 'agentToolAccepted'
    | 'pendingPermissionRequestIds'
  >
): MemberLaunchState {
  if (member.hardFailure) {
    return 'failed_to_start';
  }
  if (member.bootstrapConfirmed) {
    return 'confirmed_alive';
  }
  if ((member.pendingPermissionRequestIds?.length ?? 0) > 0) {
    return 'runtime_pending_permission';
  }
  if (member.runtimeAlive || member.agentToolAccepted) {
    return 'runtime_pending_bootstrap';
  }
  return 'starting';
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeFastMode(value: unknown): PersistedTeamLaunchMemberState['selectedFastMode'] {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : undefined;
}

function normalizeLaunchIdentity(
  value: unknown,
  fallbackProviderId?: PersistedTeamLaunchMemberState['providerId']
): ProviderModelLaunchIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const providerId =
    normalizeOptionalTeamProviderId(raw.providerId) ??
    normalizeOptionalTeamProviderId(fallbackProviderId);
  if (!providerId) {
    return undefined;
  }
  const selectedModelKind =
    raw.selectedModelKind === 'explicit' || raw.selectedModelKind === 'default'
      ? raw.selectedModelKind
      : 'default';
  const catalogSource =
    raw.catalogSource === 'anthropic-models-api' ||
    raw.catalogSource === 'app-server' ||
    raw.catalogSource === 'static-fallback' ||
    raw.catalogSource === 'runtime' ||
    raw.catalogSource === 'unavailable'
      ? raw.catalogSource
      : 'unavailable';
  return {
    providerId,
    providerBackendId:
      migrateProviderBackendId(
        providerId,
        typeof raw.providerBackendId === 'string' ? raw.providerBackendId : undefined
      ) ?? null,
    selectedModel: typeof raw.selectedModel === 'string' ? raw.selectedModel.trim() || null : null,
    selectedModelKind,
    resolvedLaunchModel:
      typeof raw.resolvedLaunchModel === 'string' ? raw.resolvedLaunchModel.trim() || null : null,
    catalogId: typeof raw.catalogId === 'string' ? raw.catalogId.trim() || null : null,
    catalogSource,
    catalogFetchedAt:
      typeof raw.catalogFetchedAt === 'string' ? raw.catalogFetchedAt.trim() || null : null,
    selectedEffort:
      raw.selectedEffort === 'none' ||
      raw.selectedEffort === 'minimal' ||
      raw.selectedEffort === 'low' ||
      raw.selectedEffort === 'medium' ||
      raw.selectedEffort === 'high' ||
      raw.selectedEffort === 'xhigh' ||
      raw.selectedEffort === 'max'
        ? raw.selectedEffort
        : null,
    resolvedEffort:
      raw.resolvedEffort === 'none' ||
      raw.resolvedEffort === 'minimal' ||
      raw.resolvedEffort === 'low' ||
      raw.resolvedEffort === 'medium' ||
      raw.resolvedEffort === 'high' ||
      raw.resolvedEffort === 'xhigh' ||
      raw.resolvedEffort === 'max'
        ? raw.resolvedEffort
        : null,
    selectedFastMode:
      raw.selectedFastMode === 'inherit' ||
      raw.selectedFastMode === 'on' ||
      raw.selectedFastMode === 'off'
        ? raw.selectedFastMode
        : null,
    resolvedFastMode: typeof raw.resolvedFastMode === 'boolean' ? raw.resolvedFastMode : null,
    fastResolutionReason:
      typeof raw.fastResolutionReason === 'string' ? raw.fastResolutionReason.trim() || null : null,
  };
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
  const providerId = normalizeOptionalTeamProviderId(parsed.providerId);
  const next: PersistedTeamLaunchMemberState = {
    name: normalizedName,
    providerId,
    providerBackendId: migrateProviderBackendId(
      providerId,
      typeof parsed.providerBackendId === 'string' ? parsed.providerBackendId : undefined
    ),
    model: typeof parsed.model === 'string' ? parsed.model.trim() || undefined : undefined,
    effort:
      parsed.effort === 'none' ||
      parsed.effort === 'minimal' ||
      parsed.effort === 'low' ||
      parsed.effort === 'medium' ||
      parsed.effort === 'high' ||
      parsed.effort === 'xhigh' ||
      parsed.effort === 'max'
        ? parsed.effort
        : undefined,
    selectedFastMode: normalizeFastMode(parsed.selectedFastMode),
    resolvedFastMode:
      typeof parsed.resolvedFastMode === 'boolean' ? parsed.resolvedFastMode : undefined,
    laneId: typeof parsed.laneId === 'string' ? parsed.laneId.trim() || undefined : undefined,
    laneKind:
      parsed.laneKind === 'primary' || parsed.laneKind === 'secondary'
        ? parsed.laneKind
        : undefined,
    laneOwnerProviderId: normalizeOptionalTeamProviderId(parsed.laneOwnerProviderId),
    launchIdentity: normalizeLaunchIdentity(parsed.launchIdentity, providerId),
    launchState: 'starting',
    agentToolAccepted: toBoolean(parsed.agentToolAccepted),
    runtimeAlive: toBoolean(parsed.runtimeAlive),
    bootstrapConfirmed: toBoolean(parsed.bootstrapConfirmed),
    hardFailure: toBoolean(parsed.hardFailure),
    hardFailureReason:
      typeof parsed.hardFailureReason === 'string' && parsed.hardFailureReason.trim().length > 0
        ? parsed.hardFailureReason.trim()
        : undefined,
    pendingPermissionRequestIds: normalizePendingPermissionRequestIds(
      parsed.pendingPermissionRequestIds
    ),
    runtimePid: normalizeRuntimePid(parsed.runtimePid),
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
    parsed.launchState === 'runtime_pending_permission' ||
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
  bootstrapExpectedMembers?: readonly string[];
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
  const bootstrapExpectedMembers = Array.from(
    new Set(
      (params.bootstrapExpectedMembers ?? expectedMembers)
        .map(normalizeMemberName)
        .filter((name) => name.length > 0 && name !== 'user' && !isLeadMember({ name }))
    )
  );
  const members = params.members ?? {};
  const launchPhase = params.launchPhase ?? 'active';

  for (const name of expectedMembers) {
    if (members[name]) {
      continue;
    }
    members[name] = {
      name,
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: updatedAt,
      diagnostics: [],
    };
  }

  // When the launch is over (finished/reconciled), members still in 'starting' state
  // (never spawned — agentToolAccepted is false) are unreachable and should be marked
  // as failed. Without this, they stay as 'pending' forever, causing the UI to show
  // "Last launch is still reconciling" indefinitely after a crash or incomplete launch.
  if (launchPhase !== 'active') {
    for (const name of expectedMembers) {
      const member = members[name];
      const isRecoverableOpenCodeSecondaryLane =
        member?.laneKind === 'secondary' &&
        member.laneOwnerProviderId === 'opencode' &&
        typeof member.laneId === 'string' &&
        member.laneId.trim().length > 0;
      if (
        member?.launchState === 'starting' &&
        !member.agentToolAccepted &&
        !member.runtimeAlive &&
        !member.bootstrapConfirmed &&
        !member.hardFailure &&
        !isRecoverableOpenCodeSecondaryLane
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
    ...(bootstrapExpectedMembers.length > 0 &&
    bootstrapExpectedMembers.join('\u0000') !== expectedMembers.join('\u0000')
      ? { bootstrapExpectedMembers }
      : {}),
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
      pendingPermissionRequestIds: runtime?.pendingPermissionRequestIds?.length
        ? [...new Set(runtime.pendingPermissionRequestIds)]
        : undefined,
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
  const memberNames = Array.from(
    new Set([
      ...snapshot.expectedMembers.map(normalizeMemberName).filter(Boolean),
      ...Object.keys(snapshot.members).map(normalizeMemberName).filter(Boolean),
    ])
  );
  for (const memberName of memberNames) {
    const entry = snapshot.members[memberName];
    if (!entry) continue;
    let status: MemberSpawnStatusEntry['status'] = 'offline';
    let livenessSource: MemberSpawnLivenessSource | undefined;
    if (entry.launchState === 'failed_to_start') {
      status = 'error';
    } else if (entry.launchState === 'confirmed_alive') {
      status = 'online';
      livenessSource = 'heartbeat';
    } else if (
      entry.launchState === 'runtime_pending_permission' ||
      entry.launchState === 'runtime_pending_bootstrap'
    ) {
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
      pendingPermissionRequestIds: entry.pendingPermissionRequestIds,
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
        runtimeAlive: false,
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
      launchPhase: 'reconciled',
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
  const bootstrapExpectedMembers = Array.isArray(record.bootstrapExpectedMembers)
    ? record.bootstrapExpectedMembers.filter(
        (name): name is string => typeof name === 'string' && normalizeMemberName(name).length > 0
      )
    : undefined;
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
    bootstrapExpectedMembers,
    members: normalizedMembers,
    updatedAt,
  });
}
