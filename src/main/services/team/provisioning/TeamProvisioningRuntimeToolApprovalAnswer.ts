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
  ports: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>
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
  const permissionInput = ports.buildOpenCodeRuntimePermissionAnswerInput(
    entry,
    allow,
    previousLaunchState
  );
  assertRuntimePermissionInputIdentity(expectedIdentity, permissionInput);
  const result = await adapter.answerRuntimePermission(permissionInput);
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  assertRuntimePermissionResultIdentity(expectedIdentity, result);

  if (expectedIdentity.laneId === 'primary') {
    const launchInput = ports.buildOpenCodeRuntimePermissionLaunchInput(entry, previousLaunchState);
    assertRuntimePermissionLaunchInputIdentity(expectedIdentity, launchInput);
    const { result: committed } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
      result,
      launchInput
    );
    assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
    assertRuntimePermissionResultIdentity(expectedIdentity, committed);
    if (committed.teamLaunchState === 'partial_failure') {
      ports.deleteRuntimeAdapterRunByTeam(expectedIdentity.teamName);
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
    await applyOpenCodeSecondaryPermissionAnswerResult(entry, result, ports, expectedIdentity);
    assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
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
  >,
  expectedIdentity: RuntimeToolApprovalIdentity<TRun> = captureTrackedRuntimeApprovalIdentity(
    entry,
    ports
  )
): Promise<void> {
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
}

function captureTrackedRuntimeApprovalIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
  entry: RuntimeToolApprovalEntry,
  ports: Pick<OpenCodeRuntimeToolApprovalAnswerPorts<TRun>, 'getTrackedRunId' | 'getRun'>
): RuntimeToolApprovalIdentity<TRun> {
  const teamName = entry.approval.teamName;
  const runtimeRunId = entry.approval.runId;
  const laneId = entry.laneId.trim() || 'primary';
  const memberName = entry.memberName;
  const providerRequestId = entry.providerRequestId;
  const cwd = entry.cwd;
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
    run,
    lane,
  };
}

function assertTrackedRuntimeApprovalIdentity<TRun extends OpenCodeRuntimePermissionAnswerRun>(
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
