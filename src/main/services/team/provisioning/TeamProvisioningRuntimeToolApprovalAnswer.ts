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

export interface OpenCodeRuntimeToolApprovalAnswerPorts<TRun extends OpenCodeRuntimePermissionAnswerRun> {
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

  const previousLaunchState = await ports.readLaunchState(entry.approval.teamName);
  const result = await adapter.answerRuntimePermission(
    ports.buildOpenCodeRuntimePermissionAnswerInput(entry, allow, previousLaunchState)
  );

  if (entry.laneId === 'primary') {
    const launchInput = ports.buildOpenCodeRuntimePermissionLaunchInput(
      entry,
      previousLaunchState
    );
    const { result: committed } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
      result,
      launchInput
    );
    if (committed.teamLaunchState === 'partial_failure') {
      ports.deleteRuntimeAdapterRunByTeam(entry.approval.teamName);
    } else {
      ports.setRuntimeAdapterRunByTeam(entry.approval.teamName, {
        runId: entry.approval.runId,
        providerId: 'opencode',
        cwd: entry.cwd,
        members: committed.members,
      });
      ports.setAliveRunId(entry.approval.teamName, entry.approval.runId);
    }
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName: entry.approval.teamName,
      runId: entry.approval.runId,
      laneId: entry.laneId,
      cwd: entry.cwd ?? '',
      members: committed.members,
      expectedMembers: entry.expectedMembers ?? [],
      teamDisplayName: entry.approval.teamDisplayName,
      teamColor: entry.approval.teamColor,
    });
  } else {
    await applyOpenCodeSecondaryPermissionAnswerResult(entry, result, ports);
  }

  ports.emitTeamChange({
    type: 'process',
    teamName: entry.approval.teamName,
    runId: entry.approval.runId,
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
  >
): Promise<void> {
  const trackedRunId = ports.getTrackedRunId(entry.approval.teamName);
  const run = trackedRunId ? ports.getRun(trackedRunId) : null;
  if (!run) {
    throw new Error(`Run not found for team "${entry.approval.teamName}"`);
  }
  const lane = (run.mixedSecondaryLanes ?? []).find(
    (candidate) => candidate.laneId === entry.laneId
  );
  if (!lane) {
    throw new Error(
      `OpenCode secondary lane ${entry.laneId} was not found for team "${entry.approval.teamName}"`
    );
  }

  const guarded = await ports.guardCommittedOpenCodeSecondaryLaneEvidence({
    teamName: entry.approval.teamName,
    laneId: entry.laneId,
    memberName: entry.memberName,
    result,
  });
  lane.result = guarded;
  lane.warnings = [...guarded.warnings];
  lane.diagnostics = [...guarded.diagnostics];
  lane.state = 'finished';
  await ports.publishMixedSecondaryLaneStatusChange(run, lane);
  ports.syncOpenCodeRuntimeToolApprovals({
    teamName: entry.approval.teamName,
    runId: entry.approval.runId,
    laneId: entry.laneId,
    cwd: entry.cwd ?? '',
    members: guarded.members,
    expectedMembers: entry.expectedMembers ?? [],
    teamDisplayName: entry.approval.teamDisplayName,
    teamColor: entry.approval.teamColor,
  });
}
