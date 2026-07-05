import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import { deriveMemberLaunchState } from './TeamProvisioningLaunchFailurePolicy';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimePendingPermission,
  TeamRuntimePermissionListResult,
} from '../runtime';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
} from '@shared/types';

export type OpenCodeRuntimePermissionListingAdapter = TeamLaunchRuntimeAdapter & {
  listRuntimePermissions(input: {
    teamName: string;
    laneId: string;
    cwd: string;
    memberName?: string;
    sessionId?: string | null;
  }): Promise<TeamRuntimePermissionListResult>;
};

export interface OpenCodeRuntimePermissionSyncInput {
  teamName: string;
  runId?: string | null;
  laneId: string;
  memberName: string;
  cwd: string;
  sessionId?: string | null;
  responseState?: string;
  reason?: string | null;
  diagnostics?: readonly string[];
  teamColor?: string;
  teamDisplayName?: string;
}

export interface OpenCodeRuntimePermissionTrackedRunLike {
  runId: string;
  request: Pick<TeamCreateRequest, 'providerId'>;
  allEffectiveMembers?: readonly TeamCreateRequest['members'][number][];
  effectiveMembers?: readonly TeamCreateRequest['members'][number][];
  mixedSecondaryLanes?: OpenCodeRuntimePermissionLaneLike[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  isLaunch: boolean;
  provisioningComplete?: boolean;
}

export interface OpenCodeRuntimePermissionLaneLike {
  laneId: string;
  result: TeamRuntimeLaunchResult | null;
}

export interface OpenCodeRuntimePermissionRuntimeRunLike {
  runId: string;
  providerId: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

export interface OpenCodeRuntimePendingPermissionsPersistenceInput {
  teamName: string;
  runId?: string | null;
  laneId: string;
  sessionId?: string | null;
  permissionsByMember: ReadonlyMap<string, readonly TeamRuntimePendingPermission[]>;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}

export interface OpenCodeRuntimePermissionSpawnStatusSyncInput {
  teamName: string;
  runId?: string | null;
  laneId: string;
  permissionsByMember: ReadonlyMap<string, readonly TeamRuntimePendingPermission[]>;
}

export interface OpenCodeRuntimePermissionToolApprovalSyncInput {
  teamName: string;
  runId: string;
  laneId: string;
  cwd: string;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  expectedMembers: TeamRuntimeMemberSpec[];
  memberNames?: readonly string[];
  teamColor?: string;
  teamDisplayName?: string;
}

export interface OpenCodeRuntimePermissionSyncPorts {
  getTrackedRunId(teamName: string): string | null;
  getPermissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getTrackedRun(teamName: string): OpenCodeRuntimePermissionTrackedRunLike | null;
  getRuntimeAdapterRun(teamName: string): OpenCodeRuntimePermissionRuntimeRunLike | null;
  persistPendingPermissions(
    input: OpenCodeRuntimePendingPermissionsPersistenceInput
  ): Promise<void>;
  syncSpawnStatuses(input: OpenCodeRuntimePermissionSpawnStatusSyncInput): void;
  syncToolApprovals(input: OpenCodeRuntimePermissionToolApprovalSyncInput): void;
  logWarning(message: string): void;
}

export interface OpenCodeRuntimePendingPermissionsPersistencePorts {
  nowIso(): string;
  getTrackedRunId(teamName: string): string | null;
  enqueueLaunchStateStoreOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<unknown>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  emitMemberSpawnChange(input: {
    teamName: string;
    runId?: string | null;
    memberName: string;
  }): void;
  logDebug(message: string): void;
}

export interface OpenCodeRuntimePermissionSpawnStatusPorts<
  TRun extends OpenCodeRuntimePermissionTrackedRunLike,
> {
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TRun | null;
  nowIso(): string;
  isCurrentTrackedRun(run: TRun): boolean;
  emitMemberSpawnChange(run: TRun, memberName: string): void;
  persistLaunchStateSnapshot(run: TRun, launchPhase: 'active' | 'finished'): void | Promise<void>;
}

export const OPENCODE_PENDING_PERMISSION_REQUEST_PATTERN =
  /\b(?:pending permission request(?:\(s\)|s)?|permission[_ -]blocked)\b/i;

const OPENCODE_RUNTIME_PERMISSION_DIAGNOSTIC =
  'OpenCode runtime is waiting for permission approval';

export function extractOpenCodeRuntimeLaneMemberName(laneId: string): string | null {
  const match = /^secondary:opencode:(.+)$/i.exec(laneId.trim());
  return match?.[1]?.trim() || null;
}

export function hasOpenCodePendingPermissionSignal(input: {
  responseState?: string;
  reason?: string | null;
  diagnostics?: readonly string[];
}): boolean {
  if (input.responseState === 'permission_blocked') {
    return true;
  }
  const text = [input.reason ?? undefined, ...(input.diagnostics ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
  return OPENCODE_PENDING_PERMISSION_REQUEST_PATTERN.test(text);
}

export function resolvePersistedLaunchMemberDisplayName(
  key: string,
  member: PersistedTeamLaunchMemberState
): string {
  const storedName = member.name?.trim();
  const laneId = member.laneId?.trim();
  const laneMemberName =
    (laneId ? extractOpenCodeRuntimeLaneMemberName(laneId) : null) ??
    extractOpenCodeRuntimeLaneMemberName(key);
  if (storedName && storedName !== laneId && storedName !== key.trim()) {
    return storedName;
  }
  return laneMemberName ?? storedName ?? key.trim();
}

export function findPersistedLaunchMemberForLane(input: {
  previousLaunchState: PersistedTeamLaunchSnapshot | null | undefined;
  laneId: string;
  memberName: string;
  runId?: string | null;
}): { key: string; member: PersistedTeamLaunchMemberState } | null {
  const members = input.previousLaunchState?.members;
  if (!members) {
    return null;
  }
  const laneId = input.laneId.trim() || 'primary';
  const memberName = input.memberName.trim();
  const runId = input.runId?.trim();
  const candidates = Object.entries(members).filter(([key, member]) => {
    const storedName = resolvePersistedLaunchMemberDisplayName(key, member);
    if (storedName !== memberName) {
      return false;
    }
    if ((member.laneId?.trim() || 'primary') !== laneId) {
      return false;
    }
    const memberRunId = member.runtimeRunId?.trim();
    return !(runId && memberRunId && memberRunId !== runId);
  });
  if (candidates.length === 0) {
    return null;
  }
  const direct = candidates.find(([key]) => key === memberName);
  const [key, member] = direct ?? candidates[0];
  return { key, member };
}

export function isOpenCodeRuntimePermissionForDeliveryTarget(
  input: {
    sessionId?: string | null;
  },
  permission: TeamRuntimePendingPermission
): boolean {
  const permissionSessionId = permission.sessionId?.trim();
  const inputSessionId = input.sessionId?.trim();
  if (permissionSessionId && inputSessionId) {
    return permissionSessionId === inputSessionId;
  }
  return true;
}

export async function syncOpenCodeRuntimePermissionsAfterDelivery(
  input: OpenCodeRuntimePermissionSyncInput,
  ports: OpenCodeRuntimePermissionSyncPorts
): Promise<void> {
  if (!input.runId?.trim()) {
    return;
  }
  const runId = input.runId.trim();
  if (ports.getTrackedRunId(input.teamName) !== runId) {
    return;
  }
  if (!hasOpenCodePendingPermissionSignal(input)) {
    return;
  }

  const adapter = ports.getPermissionListingAdapter();
  if (!adapter) {
    ports.logWarning(
      `[${input.teamName}] OpenCode runtime permission signal observed for ${input.memberName}, but permission listing bridge is unavailable.`
    );
    return;
  }

  let listed: { permissions: TeamRuntimePendingPermission[]; diagnostics: string[] };
  try {
    listed = await adapter.listRuntimePermissions({
      teamName: input.teamName,
      laneId: input.laneId,
      cwd: input.cwd,
      memberName: input.memberName,
      sessionId: input.sessionId,
    });
  } catch (error) {
    ports.logWarning(
      `[${input.teamName}] Failed to list OpenCode runtime permissions for ${input.memberName}: ${getErrorMessage(error)}`
    );
    return;
  }

  if (ports.getTrackedRunId(input.teamName) !== runId) {
    return;
  }

  const pendingPermissions = listed.permissions.filter((permission) =>
    isOpenCodeRuntimePermissionForDeliveryTarget(input, permission)
  );
  if (pendingPermissions.length === 0) {
    const listedDiagnostics = listed.diagnostics.length
      ? ` Diagnostics: ${listed.diagnostics.join(' | ')}`
      : '';
    ports.logWarning(
      `[${input.teamName}] OpenCode runtime permission signal observed for ${input.memberName}, but bridge listed no matching pending permissions.${listedDiagnostics}`
    );
    return;
  }

  const previousLaunchState = await ports.readLaunchState(input.teamName);
  if (ports.getTrackedRunId(input.teamName) !== runId) {
    return;
  }
  const expectedMembers = resolveOpenCodeRuntimePermissionExpectedMembers({
    runId,
    laneId: input.laneId,
    memberName: input.memberName,
    cwd: input.cwd,
    previousLaunchState,
    trackedRun: ports.getTrackedRun(input.teamName),
    runtimeAdapterRun: ports.getRuntimeAdapterRun(input.teamName),
  });
  const permissionsByMember = groupOpenCodeRuntimePermissionsByMember({
    permissions: pendingPermissions,
    laneId: input.laneId,
    memberName: input.memberName,
    runId,
    sessionId: input.sessionId,
    expectedMembers,
    previousLaunchState,
    trackedRun: ports.getTrackedRun(input.teamName),
    runtimeAdapterRun: ports.getRuntimeAdapterRun(input.teamName),
  });
  if (permissionsByMember.size === 0) {
    return;
  }

  await ports.persistPendingPermissions({
    ...input,
    permissionsByMember,
    previousLaunchState,
  });
  if (ports.getTrackedRunId(input.teamName) !== runId) {
    return;
  }
  ports.syncSpawnStatuses({
    ...input,
    permissionsByMember,
  });

  const members: Record<string, TeamRuntimeMemberLaunchEvidence> = {};
  for (const [memberName, permissions] of permissionsByMember) {
    members[memberName] = buildOpenCodePermissionPendingEvidence({
      laneId: input.laneId,
      memberName,
      permissions,
      runId,
      sessionId: input.sessionId,
      previousLaunchState,
    });
  }

  ports.syncToolApprovals({
    teamName: input.teamName,
    runId,
    laneId: input.laneId,
    cwd: input.cwd,
    members,
    expectedMembers,
    memberNames: Array.from(permissionsByMember.keys()),
    teamColor: input.teamColor,
    teamDisplayName: input.teamDisplayName,
  });
}

export function resolveOpenCodeRuntimePermissionExpectedMembers(input: {
  runId: string;
  laneId: string;
  memberName: string;
  cwd: string;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
  trackedRun?: OpenCodeRuntimePermissionTrackedRunLike | null;
  runtimeAdapterRun?: OpenCodeRuntimePermissionRuntimeRunLike | null;
}): TeamRuntimeMemberSpec[] {
  const members = new Map<string, TeamRuntimeMemberSpec>();
  for (const [memberKey, member] of Object.entries(input.previousLaunchState?.members ?? {})) {
    if (member.providerId !== 'opencode') continue;
    if ((member.laneId?.trim() || 'primary') !== input.laneId) continue;
    const memberRunId = member.runtimeRunId?.trim();
    if (memberRunId && memberRunId !== input.runId) continue;
    const displayName = resolvePersistedLaunchMemberDisplayName(memberKey, member);
    members.set(displayName, {
      name: displayName,
      role: undefined,
      workflow: undefined,
      isolation: undefined,
      providerId: 'opencode',
      model: member.model,
      effort: member.effort,
      cwd: member.cwd?.trim() || input.cwd,
    });
  }

  const trackedRun = input.trackedRun;
  for (const member of [
    ...(trackedRun?.allEffectiveMembers ?? []),
    ...(trackedRun?.effectiveMembers ?? []),
  ]) {
    if (member.providerId !== 'opencode' || members.has(member.name)) continue;
    const laneIdentity = buildPlannedMemberLaneIdentity({
      leadProviderId: resolveTeamProviderId(trackedRun?.request.providerId),
      member: {
        name: member.name,
        providerId: 'opencode',
      },
    });
    if (laneIdentity.laneId !== input.laneId) continue;
    members.set(member.name, {
      name: member.name,
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
      providerId: 'opencode',
      model: member.model,
      effort: member.effort,
      cwd: member.cwd?.trim() || input.cwd,
    });
  }
  const runtimeRun = input.runtimeAdapterRun;
  if (
    (input.laneId.trim() || 'primary') === 'primary' &&
    runtimeRun?.runId === input.runId &&
    runtimeRun.providerId === 'opencode'
  ) {
    for (const [memberKey, evidence] of Object.entries(runtimeRun.members ?? {})) {
      const memberName = evidence.memberName?.trim() || memberKey;
      if (!memberName || members.has(memberName)) continue;
      members.set(memberName, {
        name: memberName,
        providerId: 'opencode',
        model: evidence.model,
        cwd: input.cwd,
      });
    }
  }

  if (!members.has(input.memberName)) {
    members.set(input.memberName, {
      name: input.memberName,
      providerId: 'opencode',
      cwd: input.cwd,
    });
  }
  return Array.from(members.values());
}

export function groupOpenCodeRuntimePermissionsByMember(input: {
  permissions: readonly TeamRuntimePendingPermission[];
  laneId: string;
  memberName: string;
  runId: string;
  sessionId?: string | null;
  expectedMembers: readonly TeamRuntimeMemberSpec[];
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
  trackedRun?: OpenCodeRuntimePermissionTrackedRunLike | null;
  runtimeAdapterRun?: OpenCodeRuntimePermissionRuntimeRunLike | null;
}): Map<string, TeamRuntimePendingPermission[]> {
  const sessionToMember = new Map<string, string>();
  for (const [memberName, member] of Object.entries(input.previousLaunchState?.members ?? {})) {
    if ((member.laneId?.trim() || 'primary') !== input.laneId) continue;
    const memberRunId = member.runtimeRunId?.trim();
    if (memberRunId && memberRunId !== input.runId) continue;
    const sessionId = member.runtimeSessionId?.trim();
    if (sessionId) {
      sessionToMember.set(sessionId, resolvePersistedLaunchMemberDisplayName(memberName, member));
    }
  }
  const lane = input.trackedRun?.mixedSecondaryLanes?.find(
    (candidate) => candidate.laneId === input.laneId
  );
  for (const [memberName, evidence] of Object.entries(lane?.result?.members ?? {})) {
    const sessionId = evidence.sessionId?.trim();
    if (sessionId) {
      sessionToMember.set(sessionId, evidence.memberName?.trim() || memberName);
    }
  }
  const runtimeRun = input.runtimeAdapterRun;
  if (
    (input.laneId.trim() || 'primary') === 'primary' &&
    runtimeRun?.runId === input.runId &&
    runtimeRun.providerId === 'opencode'
  ) {
    for (const [memberName, evidence] of Object.entries(runtimeRun.members ?? {})) {
      const sessionId = evidence.sessionId?.trim();
      if (sessionId) {
        sessionToMember.set(sessionId, evidence.memberName?.trim() || memberName);
      }
    }
  }

  const singleExpectedMember =
    input.expectedMembers.length === 1 ? input.expectedMembers[0]?.name : undefined;
  const inputSessionId = input.sessionId?.trim();
  const result = new Map<string, TeamRuntimePendingPermission[]>();
  for (const permission of input.permissions) {
    const permissionSessionId = permission.sessionId?.trim();
    const memberName = permissionSessionId
      ? (sessionToMember.get(permissionSessionId) ??
        (inputSessionId === permissionSessionId ? input.memberName : undefined) ??
        singleExpectedMember)
      : (singleExpectedMember ?? input.memberName);
    if (!memberName) {
      continue;
    }
    result.set(memberName, [...(result.get(memberName) ?? []), permission]);
  }
  return result;
}

export function buildOpenCodePermissionPendingEvidence(input: {
  laneId: string;
  memberName: string;
  permissions: readonly TeamRuntimePendingPermission[];
  runId: string;
  sessionId?: string | null;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}): TeamRuntimeMemberLaunchEvidence {
  const previous = findPersistedLaunchMemberForLane({
    previousLaunchState: input.previousLaunchState,
    laneId: input.laneId,
    memberName: input.memberName,
    runId: input.runId,
  })?.member;
  const ids = Array.from(new Set(input.permissions.map((permission) => permission.requestId)));
  const sessionId = previous?.runtimeSessionId ?? input.sessionId?.trim() ?? undefined;
  return {
    memberName: input.memberName,
    providerId: 'opencode',
    ...(previous?.model ? { model: previous.model } : {}),
    launchState: 'runtime_pending_permission',
    agentToolAccepted: previous?.agentToolAccepted ?? true,
    runtimeAlive: previous?.runtimeAlive ?? false,
    bootstrapConfirmed: previous?.bootstrapConfirmed ?? false,
    hardFailure: false,
    pendingPermissionRequestIds: ids,
    pendingApprovals: [...input.permissions],
    pendingPermissions: [...input.permissions],
    ...(sessionId ? { sessionId } : {}),
    livenessKind: previous?.livenessKind ?? 'permission_blocked',
    runtimeDiagnostic: OPENCODE_RUNTIME_PERMISSION_DIAGNOSTIC,
    runtimeDiagnosticSeverity: 'warning',
    diagnostics: [
      'OpenCode runtime permission request discovered after delivery was blocked.',
      ...(previous?.diagnostics ?? []),
    ],
  };
}

export function buildOpenCodeRuntimePendingPermissionsLaunchSnapshot(input: {
  previous: PersistedTeamLaunchSnapshot;
  runId?: string | null;
  laneId: string;
  sessionId?: string | null;
  permissionsByMember: ReadonlyMap<string, readonly TeamRuntimePendingPermission[]>;
  observedAt: string;
}): PersistedTeamLaunchSnapshot | null {
  const incomingRunId = input.runId?.trim();
  let didChange = false;
  const members = { ...input.previous.members };
  for (const [memberName, permissions] of input.permissionsByMember) {
    const previousEntry = findPersistedLaunchMemberForLane({
      previousLaunchState: input.previous,
      laneId: input.laneId,
      memberName,
      runId: input.runId,
    });
    if (!previousEntry || previousEntry.member.providerId !== 'opencode') {
      continue;
    }
    const previousMember = previousEntry.member;
    if ((previousMember.laneId?.trim() || 'primary') !== input.laneId) {
      continue;
    }
    const previousRunId = previousMember.runtimeRunId?.trim();
    if (previousRunId && incomingRunId && previousRunId !== incomingRunId) {
      continue;
    }
    const previousSessionId = previousMember.runtimeSessionId?.trim();
    const incomingSessionId = input.sessionId?.trim();
    if (previousSessionId && incomingSessionId && previousSessionId !== incomingSessionId) {
      continue;
    }
    const pendingPermissionRequestIds = getOpenCodePendingPermissionRequestIds(permissions);
    const nextMember: PersistedTeamLaunchMemberState = {
      ...previousMember,
      name: memberName,
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      hardFailureReason: undefined,
      pendingPermissionRequestIds,
      ...(incomingRunId ? { runtimeRunId: incomingRunId } : {}),
      ...(incomingSessionId && !previousSessionId ? { runtimeSessionId: incomingSessionId } : {}),
      livenessKind: previousMember.livenessKind ?? 'permission_blocked',
      runtimeDiagnostic: OPENCODE_RUNTIME_PERMISSION_DIAGNOSTIC,
      runtimeDiagnosticSeverity: 'warning',
      lastEvaluatedAt: input.observedAt,
      diagnostics: mergeRuntimeDiagnostics(
        previousMember.diagnostics,
        ['waiting for permission approval'],
        previousMember.runtimeDiagnostic
      ),
    };
    if (
      previousMember.name === nextMember.name &&
      previousMember.launchState === nextMember.launchState &&
      previousMember.hardFailure === nextMember.hardFailure &&
      previousMember.hardFailureReason === nextMember.hardFailureReason &&
      previousMember.pendingPermissionRequestIds?.join('\0') ===
        nextMember.pendingPermissionRequestIds?.join('\0') &&
      previousMember.runtimeRunId === nextMember.runtimeRunId &&
      previousMember.runtimeSessionId === nextMember.runtimeSessionId &&
      previousMember.livenessKind === nextMember.livenessKind &&
      previousMember.runtimeDiagnostic === nextMember.runtimeDiagnostic &&
      previousMember.runtimeDiagnosticSeverity === nextMember.runtimeDiagnosticSeverity
    ) {
      continue;
    }
    members[previousEntry.key] = nextMember;
    didChange = true;
  }
  if (!didChange) {
    return null;
  }
  return createPersistedLaunchSnapshot({
    teamName: input.previous.teamName,
    expectedMembers: input.previous.expectedMembers,
    bootstrapExpectedMembers: input.previous.bootstrapExpectedMembers,
    leadSessionId: input.previous.leadSessionId,
    launchPhase: input.previous.launchPhase,
    members,
    updatedAt: input.observedAt,
  });
}

export async function persistOpenCodeRuntimePendingPermissions(
  input: OpenCodeRuntimePendingPermissionsPersistenceInput,
  ports: OpenCodeRuntimePendingPermissionsPersistencePorts
): Promise<void> {
  if (!input.previousLaunchState) {
    return;
  }
  const observedAt = ports.nowIso();
  try {
    const changed = await ports.enqueueLaunchStateStoreOperation(input.teamName, async () => {
      const incomingRunId = input.runId?.trim();
      if (incomingRunId && ports.getTrackedRunId(input.teamName) !== incomingRunId) {
        return false;
      }
      const previous = await ports.readLaunchState(input.teamName);
      if (!previous) {
        return false;
      }
      const nextSnapshot = buildOpenCodeRuntimePendingPermissionsLaunchSnapshot({
        previous,
        runId: input.runId,
        laneId: input.laneId,
        sessionId: input.sessionId,
        permissionsByMember: input.permissionsByMember,
        observedAt,
      });
      if (!nextSnapshot) {
        return false;
      }
      await ports.writeLaunchStateSnapshot(input.teamName, nextSnapshot);
      return true;
    });
    if (changed) {
      ports.invalidateRuntimeSnapshotCaches(input.teamName);
      for (const memberName of input.permissionsByMember.keys()) {
        ports.emitMemberSpawnChange({
          teamName: input.teamName,
          runId: input.runId,
          memberName,
        });
      }
    }
  } catch (error) {
    ports.logDebug(
      `[${input.teamName}] Failed to persist OpenCode pending runtime permissions: ${getErrorMessage(error)}`
    );
  }
}

export function syncOpenCodeRuntimePermissionSpawnStatusesForTrackedRun<
  TRun extends OpenCodeRuntimePermissionTrackedRunLike,
>(
  input: OpenCodeRuntimePermissionSpawnStatusSyncInput,
  ports: OpenCodeRuntimePermissionSpawnStatusPorts<TRun>
): void {
  const trackedRunId = ports.getTrackedRunId(input.teamName);
  const run = trackedRunId ? ports.getRun(trackedRunId) : null;
  const result = syncOpenCodeRuntimePermissionSpawnStatuses({
    run: run ?? null,
    expectedRunId: input.runId,
    laneId: input.laneId,
    permissionsByMember: input.permissionsByMember,
    updatedAt: ports.nowIso(),
    isCurrentTrackedRun: (candidateRun) => ports.isCurrentTrackedRun(candidateRun as TRun),
    emitMemberSpawnChange: (memberName) => {
      if (run) {
        ports.emitMemberSpawnChange(run, memberName);
      }
    },
  });
  if (run && result.shouldPersistLaunchSnapshot) {
    void ports.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
  }
}

export function syncOpenCodeRuntimePermissionSpawnStatuses(input: {
  run: OpenCodeRuntimePermissionTrackedRunLike | null;
  expectedRunId?: string | null;
  laneId: string;
  permissionsByMember: ReadonlyMap<string, readonly TeamRuntimePendingPermission[]>;
  updatedAt: string;
  isCurrentTrackedRun(run: OpenCodeRuntimePermissionTrackedRunLike): boolean;
  emitMemberSpawnChange(memberName: string): void;
}): { shouldPersistLaunchSnapshot: boolean } {
  const { run } = input;
  if (!run || run.runId !== input.expectedRunId) {
    return { shouldPersistLaunchSnapshot: false };
  }
  for (const [memberName, permissions] of input.permissionsByMember) {
    const prev = run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
    const lane = run.mixedSecondaryLanes?.find((candidate) => candidate.laneId === input.laneId);
    const laneEvidence = lane?.result?.members?.[memberName];
    const pendingPermissionRequestIds = getOpenCodePendingPermissionRequestIds(permissions);
    const joinedPendingPermissionRequestIds = pendingPermissionRequestIds.join('\0');
    const laneEvidenceNeedsUpdate = Boolean(
      lane?.result &&
      laneEvidence &&
      (laneEvidence.pendingPermissionRequestIds?.join('\0') !== joinedPendingPermissionRequestIds ||
        laneEvidence.runtimeDiagnostic !== OPENCODE_RUNTIME_PERMISSION_DIAGNOSTIC ||
        laneEvidence.runtimeDiagnosticSeverity !== 'warning')
    );
    const hasPendingPermissions = pendingPermissionRequestIds.length > 0;
    const next: MemberSpawnStatusEntry = {
      ...prev,
      status:
        hasPendingPermissions || laneEvidenceNeedsUpdate
          ? 'waiting'
          : prev.bootstrapConfirmed || laneEvidence?.bootstrapConfirmed
            ? 'online'
            : 'waiting',
      launchState: prev.launchState,
      agentToolAccepted: true,
      runtimeAlive: prev.runtimeAlive === true || laneEvidence?.runtimeAlive === true,
      bootstrapConfirmed:
        prev.bootstrapConfirmed === true || laneEvidence?.bootstrapConfirmed === true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      pendingPermissionRequestIds,
      livenessKind: prev.livenessKind ?? laneEvidence?.livenessKind ?? 'permission_blocked',
      runtimeDiagnostic: OPENCODE_RUNTIME_PERMISSION_DIAGNOSTIC,
      runtimeDiagnosticSeverity: 'warning',
      updatedAt: input.updatedAt,
    };
    next.launchState = hasPendingPermissions
      ? 'runtime_pending_permission'
      : deriveMemberLaunchState(next);
    if (
      prev.pendingPermissionRequestIds?.join('\0') === joinedPendingPermissionRequestIds &&
      prev.launchState === next.launchState &&
      prev.runtimeDiagnostic === next.runtimeDiagnostic &&
      !laneEvidenceNeedsUpdate
    ) {
      continue;
    }
    run.memberSpawnStatuses.set(memberName, next);
    if (lane?.result && laneEvidence) {
      lane.result = {
        ...lane.result,
        members: {
          ...lane.result.members,
          [memberName]: {
            ...laneEvidence,
            hardFailure: false,
            hardFailureReason: undefined,
            pendingPermissionRequestIds,
            pendingApprovals: [...permissions],
            pendingPermissions: [...permissions],
            runtimeDiagnostic: OPENCODE_RUNTIME_PERMISSION_DIAGNOSTIC,
            runtimeDiagnosticSeverity: 'warning',
            diagnostics:
              mergeRuntimeDiagnostics(
                laneEvidence.diagnostics,
                ['waiting for permission approval'],
                laneEvidence.runtimeDiagnostic
              ) ?? [],
          },
        },
      };
    }
    if (input.isCurrentTrackedRun(run)) {
      input.emitMemberSpawnChange(memberName);
    }
  }
  return { shouldPersistLaunchSnapshot: run.isLaunch };
}

function getOpenCodePendingPermissionRequestIds(
  permissions: readonly TeamRuntimePendingPermission[]
): string[] {
  return Array.from(
    new Set(permissions.map((permission) => permission.requestId.trim()).filter(Boolean))
  );
}

function normalizeDiagnosticStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function mergeRuntimeDiagnostics(
  previous: string[] | undefined,
  incoming: unknown,
  fallback?: string
): string[] | undefined {
  const merged = [
    ...(previous ?? []),
    ...normalizeDiagnosticStringArray(incoming),
    ...(fallback ? [fallback] : []),
  ].filter((value) => value.trim().length > 0);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}
