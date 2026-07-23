import { getErrorMessage } from '@shared/utils/errorHandling';

import { hasRetainableOpenCodeRuntimeMember } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { RuntimeToolApprovalEntry } from '../approvals/RuntimeToolApprovalCoordinator';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimePermissionAnswerInput,
} from '../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot, TeamChangeEvent, TeamProviderId } from '@shared/types';

export interface RuntimeAdapterRunEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

export interface OpenCodeRuntimeToolApprovalSyncInput {
  teamName: string;
  runId: string;
  laneId: string;
  cwd: string;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  expectedMembers: TeamRuntimeMemberSpec[];
  teamColor?: string;
  teamDisplayName?: string;
}

export interface OpenCodeRuntimePermissionAnswerRun {
  mixedSecondaryLanes?: MixedSecondaryRuntimeLaneState[];
}

interface RuntimeToolApprovalIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun> {
  readonly teamName: string;
  readonly runtimeRunId: string;
  readonly trackedRunId: string;
  readonly laneId: string;
  readonly memberName: string;
  readonly providerRequestId: string;
  readonly cwd: string | undefined;
  readonly runtimeOwner:
    | RuntimeAdapterRunEntry
    | { runId: string; providerId: TeamProviderId; cwd?: string };
  readonly runtimeOwnerCwd: string | undefined;
  readonly run: TRun | undefined;
  readonly lane: MixedSecondaryRuntimeLaneState | undefined;
}

export interface OpenCodeRuntimeToolApprovalAnswerPorts<
  TRun extends OpenCodeRuntimePermissionAnswerRun,
> {
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  buildOpenCodeRuntimePermissionAnswerInput(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    previousLaunchState: PersistedTeamLaunchSnapshot | null
  ): TeamRuntimePermissionAnswerInput;
  buildOpenCodeRuntimePermissionLaunchInput(
    entry: RuntimeToolApprovalEntry,
    previousLaunchState: PersistedTeamLaunchSnapshot | null
  ): TeamRuntimeLaunchInput;
  persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{ result: TeamRuntimeLaunchResult }>;
  deleteRuntimeAdapterRunByTeam(teamName: string): void;
  getRuntimeAdapterRunByTeam?(teamName: string): RuntimeAdapterRunEntry | undefined;
  deleteRuntimeAdapterRunIfOwned?(teamName: string, runId: string): boolean;
  getSecondaryRuntimeRun?(
    teamName: string,
    laneId: string
  ): { runId: string; providerId: TeamProviderId; cwd?: string } | undefined;
  deleteSecondaryRuntimeRunIfOwned?(teamName: string, laneId: string, runId: string): boolean;
  markOpenCodeRuntimeLaneDegraded?(input: {
    teamName: string;
    laneId: string;
    diagnostics: string[];
  }): Promise<void>;
  deleteAliveRunIdIfNoRuntime?(teamName: string, trackedRunId: string): boolean;
  logWarning(message: string): void;
  setRuntimeAdapterRunByTeam(teamName: string, entry: RuntimeAdapterRunEntry): void;
  setAliveRunId(teamName: string, runId: string): void;
  getTrackedRunId(teamName: string): string | null | undefined;
  getRun(runId: string): TRun | undefined;
  guardCommittedOpenCodeSecondaryLaneEvidence(input: {
    teamName: string;
    laneId: string;
    memberName: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult>;
  publishMixedSecondaryLaneStatusChange(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  syncOpenCodeRuntimeToolApprovals(input: OpenCodeRuntimeToolApprovalSyncInput): void;
  emitTeamChange(event: TeamChangeEvent): void;
}

export async function answerOpenCodeRuntimeToolApproval<
  TRun extends OpenCodeRuntimePermissionAnswerRun,
>(
  entry: RuntimeToolApprovalEntry,
  allow: boolean,
  ports: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>,
  message?: string
): Promise<void> {
  if (entry.providerId !== 'opencode') {
    throw new Error(`Runtime approval provider is not supported: ${entry.providerId}`);
  }
  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (!adapter?.answerRuntimePermission) {
    throw new Error('OpenCode runtime permission answer bridge is not available');
  }
  const expectedIdentity = captureTrackedRuntimeApprovalIdentity(entry, ports);

  const previousLaunchState = await ports.readLaunchState(expectedIdentity.teamName);
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  const basePermissionInput = ports.buildOpenCodeRuntimePermissionAnswerInput(
    entry,
    allow,
    previousLaunchState
  );
  const permissionInput: TeamRuntimePermissionAnswerInput = {
    ...basePermissionInput,
    cwd: expectedIdentity.cwd ?? '',
    ...(message === undefined ? {} : { message }),
  };
  assertRuntimePermissionInputIdentity(expectedIdentity, permissionInput);
  const result = await adapter.answerRuntimePermission(permissionInput);
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  assertRuntimePermissionResultIdentity(expectedIdentity, result);

  let removedUnretainableRuntime = false;
  if (expectedIdentity.laneId === 'primary') {
    const launchInput = {
      ...ports.buildOpenCodeRuntimePermissionLaunchInput(entry, previousLaunchState),
      cwd: expectedIdentity.cwd ?? '',
    };
    assertRuntimePermissionLaunchInputIdentity(expectedIdentity, launchInput);
    const { result: committed } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
      result,
      launchInput
    );
    assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
    assertRuntimePermissionResultIdentity(expectedIdentity, committed);
    if (
      committed.teamLaunchState === 'partial_failure' &&
      !hasRetainableOpenCodeRuntimeMember(committed)
    ) {
      removedUnretainableRuntime = await stopUnretainableOpenCodePermissionRuntime(
        adapter,
        expectedIdentity,
        committed,
        previousLaunchState,
        ports
      );
    } else {
      ports.setRuntimeAdapterRunByTeam(expectedIdentity.teamName, {
        runId: expectedIdentity.runtimeRunId,
        providerId: 'opencode',
        cwd: expectedIdentity.cwd,
        members: committed.members,
      });
      ports.setAliveRunId(expectedIdentity.teamName, expectedIdentity.runtimeRunId);
    }
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName: expectedIdentity.teamName,
      runId: expectedIdentity.runtimeRunId,
      laneId: expectedIdentity.laneId,
      cwd: expectedIdentity.cwd ?? '',
      members: committed.members,
      expectedMembers: entry.expectedMembers ?? [],
      teamDisplayName: entry.approval.teamDisplayName,
      teamColor: entry.approval.teamColor,
    });
  } else {
    removedUnretainableRuntime = await applyOpenCodeSecondaryPermissionAnswerResult(
      entry,
      result,
      ports,
      expectedIdentity,
      previousLaunchState
    );
    if (removedUnretainableRuntime) {
      assertTrackedRuntimeApprovalRunIdentity(expectedIdentity, ports);
    } else {
      assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
    }
  }

  if (removedUnretainableRuntime) {
    ports.deleteAliveRunIdIfNoRuntime?.(expectedIdentity.teamName, expectedIdentity.trackedRunId);
  }

  ports.emitTeamChange({
    type: 'process',
    teamName: expectedIdentity.teamName,
    runId: expectedIdentity.runtimeRunId,
    detail: allow ? 'permission-allowed' : 'permission-denied',
  });
}

export async function applyOpenCodeSecondaryPermissionAnswerResult<
  TRun extends OpenCodeRuntimePermissionAnswerRun,
>(
  entry: RuntimeToolApprovalEntry,
  result: TeamRuntimeLaunchResult,
  ports: Pick<
    OpenCodeRuntimeToolApprovalAnswerPorts<TRun>,
    | 'getTrackedRunId'
    | 'getRun'
    | 'guardCommittedOpenCodeSecondaryLaneEvidence'
    | 'publishMixedSecondaryLaneStatusChange'
    | 'syncOpenCodeRuntimeToolApprovals'
    | 'deleteRuntimeAdapterRunByTeam'
    | 'logWarning'
  > &
    Partial<
      Pick<
        OpenCodeRuntimeToolApprovalAnswerPorts<TRun>,
        | 'getOpenCodeRuntimeAdapter'
        | 'getRuntimeAdapterRunByTeam'
        | 'deleteRuntimeAdapterRunIfOwned'
        | 'getSecondaryRuntimeRun'
        | 'deleteSecondaryRuntimeRunIfOwned'
        | 'markOpenCodeRuntimeLaneDegraded'
      >
    >,
  expectedIdentity: RuntimeToolApprovalIdentity<TRun> = captureTrackedRuntimeApprovalIdentity(
    entry,
    ports
  ),
  previousLaunchState: PersistedTeamLaunchSnapshot | null = null
): Promise<boolean> {
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  assertRuntimePermissionResultIdentity(expectedIdentity, result);
  const run = expectedIdentity.run;
  if (!run) {
    throw new Error(`Run not found for team "${expectedIdentity.teamName}"`);
  }
  const lane = expectedIdentity.lane;
  if (!lane) {
    throw new Error(
      `OpenCode secondary lane ${expectedIdentity.laneId} was not found for team "${expectedIdentity.teamName}"`
    );
  }

  const guarded = await ports.guardCommittedOpenCodeSecondaryLaneEvidence({
    teamName: expectedIdentity.teamName,
    laneId: expectedIdentity.laneId,
    memberName: expectedIdentity.memberName,
    result,
  });
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  assertRuntimePermissionResultIdentity(expectedIdentity, guarded);
  lane.result = guarded;
  lane.warnings = [...guarded.warnings];
  lane.diagnostics = [...guarded.diagnostics];
  lane.state = 'finished';
  await ports.publishMixedSecondaryLaneStatusChange(run, lane);
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  let removedUnretainableRuntime = false;
  if (
    guarded.teamLaunchState === 'partial_failure' &&
    !hasRetainableOpenCodeRuntimeMember(guarded)
  ) {
    const adapter = ports.getOpenCodeRuntimeAdapter?.();
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is not available for failed lane cleanup');
    }
    removedUnretainableRuntime = await stopUnretainableOpenCodePermissionRuntime(
      adapter,
      expectedIdentity,
      guarded,
      previousLaunchState,
      ports
    );
  }
  ports.syncOpenCodeRuntimeToolApprovals({
    teamName: expectedIdentity.teamName,
    runId: expectedIdentity.runtimeRunId,
    laneId: expectedIdentity.laneId,
    cwd: expectedIdentity.cwd ?? '',
    members: guarded.members,
    expectedMembers: entry.expectedMembers ?? [],
    teamDisplayName: entry.approval.teamDisplayName,
    teamColor: entry.approval.teamColor,
  });
  return removedUnretainableRuntime;
}

async function stopUnretainableOpenCodePermissionRuntime<
  TRun extends OpenCodeRuntimePermissionAnswerRun,
>(
  adapter: TeamLaunchRuntimeAdapter,
  expectedIdentity: RuntimeToolApprovalIdentity<TRun>,
  result: TeamRuntimeLaunchResult,
  previousLaunchState: PersistedTeamLaunchSnapshot | null,
  ports: Pick<
    OpenCodeRuntimeToolApprovalAnswerPorts<TRun>,
    | 'getTrackedRunId'
    | 'getRun'
    | 'deleteRuntimeAdapterRunByTeam'
    | 'getRuntimeAdapterRunByTeam'
    | 'deleteRuntimeAdapterRunIfOwned'
    | 'getSecondaryRuntimeRun'
    | 'deleteSecondaryRuntimeRunIfOwned'
    | 'markOpenCodeRuntimeLaneDegraded'
    | 'logWarning'
  >
): Promise<boolean> {
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  const isPrimary = expectedIdentity.laneId === 'primary';
  const runtimeOwner = isPrimary
    ? ports.getRuntimeAdapterRunByTeam?.(expectedIdentity.teamName)
    : ports.getSecondaryRuntimeRun?.(expectedIdentity.teamName, expectedIdentity.laneId);
  if (
    runtimeOwner &&
    (runtimeOwner.providerId !== 'opencode' || runtimeOwner.runId !== expectedIdentity.runtimeRunId)
  ) {
    throw new Error(
      `Stale runtime approval: runtime owner changed for team "${expectedIdentity.teamName}" lane ${expectedIdentity.laneId}`
    );
  }

  const cleanupCwd =
    expectedIdentity.runtimeOwnerCwd ??
    expectedIdentity.cwd ??
    expectedIdentity.lane?.member.cwd?.trim() ??
    '';
  try {
    const stopResult = await adapter.stop({
      runId: expectedIdentity.runtimeRunId,
      laneId: expectedIdentity.laneId,
      teamName: expectedIdentity.teamName,
      cwd: cleanupCwd,
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState,
      force: true,
    });
    if (!stopResult.stopped) {
      const detail = [...stopResult.diagnostics, ...stopResult.warnings]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join('; ');
      throw new Error(
        detail
          ? `OpenCode runtime lane did not confirm stop: ${detail}`
          : 'OpenCode runtime lane did not confirm stop'
      );
    }
  } catch (error) {
    ports.logWarning(
      `[${expectedIdentity.teamName}] Failed to stop unretainable OpenCode runtime lane ${expectedIdentity.laneId}: ${getErrorMessage(error)}`
    );
    return false;
  }
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  const runtimeOwnerAfterStop = isPrimary
    ? ports.getRuntimeAdapterRunByTeam?.(expectedIdentity.teamName)
    : ports.getSecondaryRuntimeRun?.(expectedIdentity.teamName, expectedIdentity.laneId);
  if (runtimeOwner && runtimeOwnerAfterStop !== runtimeOwner) {
    throw new Error(
      `Stale runtime approval: runtime owner changed for team "${expectedIdentity.teamName}" lane ${expectedIdentity.laneId}`
    );
  }

  if (isPrimary) {
    if (ports.deleteRuntimeAdapterRunIfOwned) {
      ports.deleteRuntimeAdapterRunIfOwned(
        expectedIdentity.teamName,
        expectedIdentity.runtimeRunId
      );
    } else {
      ports.deleteRuntimeAdapterRunByTeam(expectedIdentity.teamName);
    }
  } else {
    ports.deleteSecondaryRuntimeRunIfOwned?.(
      expectedIdentity.teamName,
      expectedIdentity.laneId,
      expectedIdentity.runtimeRunId
    );
  }

  const diagnostics = Array.from(
    new Set(
      [
        ...result.diagnostics,
        ...Object.values(result.members).flatMap((member) => [
          member.hardFailureReason,
          member.runtimeDiagnostic,
          ...member.diagnostics,
        ]),
      ].filter((diagnostic): diagnostic is string => Boolean(diagnostic?.trim()))
    )
  );
  try {
    await ports.markOpenCodeRuntimeLaneDegraded?.({
      teamName: expectedIdentity.teamName,
      laneId: expectedIdentity.laneId,
      diagnostics,
    });
  } catch (error) {
    ports.logWarning(
      `[${expectedIdentity.teamName}] Failed to mark OpenCode runtime lane ${expectedIdentity.laneId} degraded after cleanup: ${getErrorMessage(error)}`
    );
  }
  assertTrackedRuntimeApprovalRunIdentity(expectedIdentity, ports);
  const replacementOwner = isPrimary
    ? ports.getRuntimeAdapterRunByTeam?.(expectedIdentity.teamName)
    : ports.getSecondaryRuntimeRun?.(expectedIdentity.teamName, expectedIdentity.laneId);
  if (replacementOwner) {
    throw new Error(
      `Stale runtime approval: replacement runtime owner appeared for team "${expectedIdentity.teamName}" lane ${expectedIdentity.laneId}`
    );
  }
  return true;
}

function captureTrackedRuntimeApprovalIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
  entry: RuntimeToolApprovalEntry,
  ports: Pick<
    OpenCodeRuntimeToolApprovalAnswerPorts<TRun>,
    'getTrackedRunId' | 'getRun' | 'getRuntimeAdapterRunByTeam' | 'getSecondaryRuntimeRun'
  >
): RuntimeToolApprovalIdentity<TRun> {
  const teamName = entry.approval.teamName;
  const runtimeRunId = entry.approval.runId;
  const laneId = entry.laneId.trim() || 'primary';
  const memberName = entry.memberName;
  const providerRequestId = entry.providerRequestId;
  const runtimeOwner =
    laneId === 'primary'
      ? ports.getRuntimeAdapterRunByTeam?.(teamName)
      : ports.getSecondaryRuntimeRun?.(teamName, laneId);
  if (runtimeOwner?.providerId !== 'opencode' || runtimeOwner.runId !== runtimeRunId) {
    throw new Error(
      `Stale runtime approval: exact runtime owner is no longer current for team "${teamName}" lane ${laneId}`
    );
  }
  const entryCwd = entry.cwd?.trim() || undefined;
  const runtimeOwnerCwd = runtimeOwner.cwd?.trim() || undefined;
  if (entryCwd && runtimeOwnerCwd && entryCwd !== runtimeOwnerCwd) {
    throw new Error(
      `Stale runtime approval: runtime owner cwd changed for team "${teamName}" lane ${laneId}`
    );
  }
  const cwd = runtimeOwnerCwd ?? entryCwd;
  const trackedRunId = ports.getTrackedRunId(teamName);
  if (!trackedRunId) {
    throw new Error(`Run not found for team "${teamName}"`);
  }
  const run = ports.getRun(trackedRunId);
  if (laneId === 'primary') {
    if (trackedRunId !== runtimeRunId) {
      throw new Error(
        `Stale runtime approval: tracked runId mismatch for team "${teamName}" (expected ${runtimeRunId}, got ${trackedRunId})`
      );
    }
    return {
      teamName,
      runtimeRunId,
      trackedRunId,
      laneId,
      memberName,
      providerRequestId,
      cwd,
      runtimeOwner,
      runtimeOwnerCwd,
      run,
      lane: undefined,
    };
  }
  if (!run) {
    throw new Error(`Run not found for team "${teamName}"`);
  }
  const lane = (run.mixedSecondaryLanes ?? []).find((candidate) => candidate.laneId === laneId);
  if (!lane) {
    throw new Error(`OpenCode secondary lane ${laneId} was not found for team "${teamName}"`);
  }
  if (lane.runId !== runtimeRunId) {
    throw new Error(
      `Stale runtime approval: secondary lane runId mismatch for team "${teamName}" lane ${laneId} (expected ${runtimeRunId}, got ${lane.runId ?? 'none'})`
    );
  }
  return {
    teamName,
    runtimeRunId,
    trackedRunId,
    laneId,
    memberName,
    providerRequestId,
    cwd,
    runtimeOwner,
    runtimeOwnerCwd,
    run,
    lane,
  };
}

function assertTrackedRuntimeApprovalIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
  expectedIdentity: RuntimeToolApprovalIdentity<TRun>,
  ports: Pick<
    OpenCodeRuntimeToolApprovalAnswerPorts<TRun>,
    'getTrackedRunId' | 'getRun' | 'getRuntimeAdapterRunByTeam' | 'getSecondaryRuntimeRun'
  >
): void {
  assertTrackedRuntimeApprovalRunIdentity(expectedIdentity, ports);
  const runtimeOwner =
    expectedIdentity.laneId === 'primary'
      ? ports.getRuntimeAdapterRunByTeam?.(expectedIdentity.teamName)
      : ports.getSecondaryRuntimeRun?.(expectedIdentity.teamName, expectedIdentity.laneId);
  if (runtimeOwner !== expectedIdentity.runtimeOwner) {
    throw new Error(
      `Stale runtime approval: exact runtime owner changed for team "${expectedIdentity.teamName}" lane ${expectedIdentity.laneId}`
    );
  }
  if (
    runtimeOwner.providerId !== 'opencode' ||
    runtimeOwner.runId !== expectedIdentity.runtimeRunId ||
    (runtimeOwner.cwd?.trim() || undefined) !== expectedIdentity.runtimeOwnerCwd
  ) {
    throw new Error(
      `Stale runtime approval: runtime owner identity changed for team "${expectedIdentity.teamName}" lane ${expectedIdentity.laneId}`
    );
  }
}

function assertTrackedRuntimeApprovalRunIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
  expectedIdentity: RuntimeToolApprovalIdentity<TRun>,
  ports: Pick<OpenCodeRuntimeToolApprovalAnswerPorts<TRun>, 'getTrackedRunId' | 'getRun'>
): void {
  const trackedRunId = ports.getTrackedRunId(expectedIdentity.teamName);
  if (!trackedRunId) {
    throw new Error(`Run not found for team "${expectedIdentity.teamName}"`);
  }
  if (trackedRunId !== expectedIdentity.trackedRunId) {
    throw new Error(
      `Stale runtime approval: tracked runId mismatch for team "${expectedIdentity.teamName}" (expected ${expectedIdentity.trackedRunId}, got ${trackedRunId})`
    );
  }
  const run = ports.getRun(expectedIdentity.trackedRunId);
  if (run !== expectedIdentity.run) {
    throw new Error(
      `Stale runtime approval: tracked run identity changed for team "${expectedIdentity.teamName}"`
    );
  }
  if (!expectedIdentity.lane) {
    return;
  }
  const lane = (run?.mixedSecondaryLanes ?? []).find(
    (candidate) => candidate.laneId === expectedIdentity.lane?.laneId
  );
  if (lane !== expectedIdentity.lane) {
    throw new Error(
      `Stale runtime approval: secondary lane identity changed for team "${expectedIdentity.teamName}" lane ${expectedIdentity.lane.laneId}`
    );
  }
  if (lane.runId !== expectedIdentity.runtimeRunId) {
    throw new Error(
      `Stale runtime approval: secondary lane runId mismatch for team "${expectedIdentity.teamName}" lane ${lane.laneId} (expected ${expectedIdentity.runtimeRunId}, got ${lane.runId ?? 'none'})`
    );
  }
}

function assertRuntimePermissionInputIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
  expectedIdentity: RuntimeToolApprovalIdentity<TRun>,
  input: TeamRuntimePermissionAnswerInput
): void {
  const laneId = input.laneId?.trim() || 'primary';
  if (
    input.teamName !== expectedIdentity.teamName ||
    input.runId !== expectedIdentity.runtimeRunId ||
    laneId !== expectedIdentity.laneId ||
    input.memberName !== expectedIdentity.memberName ||
    input.requestId !== expectedIdentity.providerRequestId ||
    input.cwd !== (expectedIdentity.cwd ?? '')
  ) {
    throw new Error(
      `Runtime permission answer input identity changed for team "${expectedIdentity.teamName}"`
    );
  }
}

function assertRuntimePermissionLaunchInputIdentity<
  TRun extends OpenCodeRuntimePermissionAnswerRun,
>(expectedIdentity: RuntimeToolApprovalIdentity<TRun>, input: TeamRuntimeLaunchInput): void {
  const laneId = input.laneId?.trim() || 'primary';
  if (
    input.teamName !== expectedIdentity.teamName ||
    input.runId !== expectedIdentity.runtimeRunId ||
    laneId !== expectedIdentity.laneId ||
    input.cwd !== (expectedIdentity.cwd ?? '')
  ) {
    throw new Error(
      `Runtime permission launch input identity changed for team "${expectedIdentity.teamName}"`
    );
  }
}

function assertRuntimePermissionResultIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
  expectedIdentity: RuntimeToolApprovalIdentity<TRun>,
  result: TeamRuntimeLaunchResult
): void {
  if (
    result.teamName !== expectedIdentity.teamName ||
    result.runId !== expectedIdentity.runtimeRunId
  ) {
    throw new Error(
      `Runtime permission answer identity mismatch for team "${expectedIdentity.teamName}" (expected runId ${expectedIdentity.runtimeRunId}, got team "${result.teamName}" runId ${result.runId})`
    );
  }
}
