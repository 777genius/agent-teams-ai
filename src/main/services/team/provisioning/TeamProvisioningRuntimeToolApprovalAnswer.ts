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

interface RuntimeToolApprovalIdentity {
  readonly teamName: string;
  readonly runId: string;
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
  const expectedIdentity: RuntimeToolApprovalIdentity = {
    teamName: entry.approval.teamName,
    runId: entry.approval.runId,
  };
  if (entry.providerId !== 'opencode') {
    throw new Error(`Runtime approval provider is not supported: ${entry.providerId}`);
  }
  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (!adapter?.answerRuntimePermission) {
    throw new Error('OpenCode runtime permission answer bridge is not available');
  }
  if (entry.laneId !== 'primary') {
    assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  }

  const previousLaunchState = await ports.readLaunchState(expectedIdentity.teamName);
  const result = await adapter.answerRuntimePermission(
    ports.buildOpenCodeRuntimePermissionAnswerInput(entry, allow, previousLaunchState)
  );

  if (entry.laneId === 'primary') {
    const launchInput = ports.buildOpenCodeRuntimePermissionLaunchInput(entry, previousLaunchState);
    const { result: committed } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
      result,
      launchInput
    );
    if (committed.teamLaunchState === 'partial_failure') {
      ports.deleteRuntimeAdapterRunByTeam(expectedIdentity.teamName);
    } else {
      ports.setRuntimeAdapterRunByTeam(expectedIdentity.teamName, {
        runId: expectedIdentity.runId,
        providerId: 'opencode',
        cwd: entry.cwd,
        members: committed.members,
      });
      ports.setAliveRunId(expectedIdentity.teamName, expectedIdentity.runId);
    }
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName: expectedIdentity.teamName,
      runId: expectedIdentity.runId,
      laneId: entry.laneId,
      cwd: entry.cwd ?? '',
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
    runId: expectedIdentity.runId,
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
  expectedIdentity: RuntimeToolApprovalIdentity = {
    teamName: entry.approval.teamName,
    runId: entry.approval.runId,
  }
): Promise<void> {
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  const run = ports.getRun(expectedIdentity.runId);
  if (!run) {
    throw new Error(`Run not found for team "${expectedIdentity.teamName}"`);
  }
  const lane = (run.mixedSecondaryLanes ?? []).find(
    (candidate) => candidate.laneId === entry.laneId
  );
  if (!lane) {
    throw new Error(
      `OpenCode secondary lane ${entry.laneId} was not found for team "${expectedIdentity.teamName}"`
    );
  }

  const guarded = await ports.guardCommittedOpenCodeSecondaryLaneEvidence({
    teamName: expectedIdentity.teamName,
    laneId: entry.laneId,
    memberName: entry.memberName,
    result,
  });
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  lane.result = guarded;
  lane.warnings = [...guarded.warnings];
  lane.diagnostics = [...guarded.diagnostics];
  lane.state = 'finished';
  await ports.publishMixedSecondaryLaneStatusChange(run, lane);
  assertTrackedRuntimeApprovalIdentity(expectedIdentity, ports);
  ports.syncOpenCodeRuntimeToolApprovals({
    teamName: expectedIdentity.teamName,
    runId: expectedIdentity.runId,
    laneId: entry.laneId,
    cwd: entry.cwd ?? '',
    members: guarded.members,
    expectedMembers: entry.expectedMembers ?? [],
    teamDisplayName: entry.approval.teamDisplayName,
    teamColor: entry.approval.teamColor,
  });
}

function assertTrackedRuntimeApprovalIdentity(
  expectedIdentity: RuntimeToolApprovalIdentity,
  ports: Pick<
    OpenCodeRuntimeToolApprovalAnswerPorts<OpenCodeRuntimePermissionAnswerRun>,
    'getTrackedRunId'
  >
): void {
  const trackedRunId = ports.getTrackedRunId(expectedIdentity.teamName);
  if (!trackedRunId) {
    throw new Error(`Run not found for team "${expectedIdentity.teamName}"`);
  }
  if (trackedRunId !== expectedIdentity.runId) {
    throw new Error(
      `Stale runtime approval: tracked runId mismatch for team "${expectedIdentity.teamName}" (expected ${expectedIdentity.runId}, got ${trackedRunId})`
    );
  }
}
