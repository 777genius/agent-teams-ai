import type { TeamLaunchFailureArtifactPackInput } from '../TeamLaunchFailureArtifactPack';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

export interface TaskActivityRepairResult {
  failed?: boolean;
}

export interface TaskActivityRepairServicePort {
  repairStaleIntervalsAfterCrash(
    teamName: string,
    launchSnapshot: PersistedTeamLaunchSnapshot | null
  ): TaskActivityRepairResult;
}

export interface TaskActivityRepairSnapshotStorePort {
  has(teamName: string): boolean;
  get(teamName: string): PersistedTeamLaunchSnapshot | null | undefined;
  set(teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot | null): unknown;
  delete(teamName: string): unknown;
}

export interface TaskActivityRepairTeamSetPort {
  has(teamName: string): boolean;
  add(teamName: string): unknown;
}

export interface TaskActivityRepairTrackingPorts {
  repairedTeams: TaskActivityRepairTeamSetPort;
  pendingSnapshots: TaskActivityRepairSnapshotStorePort;
}

export interface StaleTaskActivityRepairDecisionInput {
  alreadyRepaired: boolean;
  hasPendingSnapshot: boolean;
  pendingSnapshot?: PersistedTeamLaunchSnapshot | null;
  launchSnapshot?: PersistedTeamLaunchSnapshot | null;
}

export type StaleTaskActivityRepairDecision =
  | { action: 'skip-repaired' }
  | {
      action: 'repair';
      repairSnapshot: PersistedTeamLaunchSnapshot | null;
      snapshotToRememberOnFailure: PersistedTeamLaunchSnapshot | null;
      shouldRememberSnapshotOnFailure: boolean;
    };

export function decideStaleTaskActivityRepair(
  input: StaleTaskActivityRepairDecisionInput
): StaleTaskActivityRepairDecision {
  if (input.alreadyRepaired) {
    return { action: 'skip-repaired' };
  }

  const launchSnapshot = input.launchSnapshot ?? null;
  const pendingSnapshot = input.hasPendingSnapshot ? (input.pendingSnapshot ?? null) : null;
  return {
    action: 'repair',
    repairSnapshot: input.hasPendingSnapshot ? pendingSnapshot : launchSnapshot,
    snapshotToRememberOnFailure: launchSnapshot,
    shouldRememberSnapshotOnFailure: !input.hasPendingSnapshot,
  };
}

export function repairStaleTaskActivityIntervalsOnce(
  teamName: string,
  launchSnapshot: PersistedTeamLaunchSnapshot | null | undefined,
  ports: {
    taskActivityIntervalService: TaskActivityRepairServicePort;
    tracking: TaskActivityRepairTrackingPorts;
  }
): boolean {
  const hasPendingSnapshot = ports.tracking.pendingSnapshots.has(teamName);
  const decision = decideStaleTaskActivityRepair({
    alreadyRepaired: ports.tracking.repairedTeams.has(teamName),
    hasPendingSnapshot,
    pendingSnapshot: hasPendingSnapshot ? ports.tracking.pendingSnapshots.get(teamName) : null,
    launchSnapshot,
  });

  if (decision.action === 'skip-repaired') {
    return true;
  }

  const result = ports.taskActivityIntervalService.repairStaleIntervalsAfterCrash(
    teamName,
    decision.repairSnapshot
  );
  if (result.failed) {
    if (decision.shouldRememberSnapshotOnFailure) {
      ports.tracking.pendingSnapshots.set(teamName, decision.snapshotToRememberOnFailure);
    }
    return false;
  }

  ports.tracking.pendingSnapshots.delete(teamName);
  ports.tracking.repairedTeams.add(teamName);
  return true;
}

export interface TaskActivityRepairLaunchSnapshotPorts {
  readBootstrapLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  choosePreferredLaunchSnapshot(
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    launchSnapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null;
}

export async function readTaskActivityRepairLaunchSnapshot(
  teamName: string,
  ports: TaskActivityRepairLaunchSnapshotPorts
): Promise<PersistedTeamLaunchSnapshot | null> {
  const [bootstrapSnapshot, launchSnapshot] = await Promise.all([
    ports.readBootstrapLaunchSnapshot(teamName).catch(() => null),
    ports.readLaunchState(teamName).catch(() => null),
  ]);
  return ports.choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
}

export interface RepairStaleTaskActivityIntervalsBeforeSnapshotPorts {
  tracking: Pick<TaskActivityRepairTrackingPorts, 'repairedTeams'> & {
    pendingSnapshots: TaskActivityRepairSnapshotStorePort;
  };
  getTrackedRunId(teamName: string): string | null;
  hasRun(runId: string): boolean;
  readRepairLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  repairOnce(teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot | null): boolean;
}

export async function repairStaleTaskActivityIntervalsBeforeSnapshot(
  teamName: string,
  ports: RepairStaleTaskActivityIntervalsBeforeSnapshotPorts
): Promise<void> {
  if (ports.tracking.repairedTeams.has(teamName)) {
    return;
  }

  const runId = ports.getTrackedRunId(teamName);
  if (runId && ports.hasRun(runId)) {
    return;
  }

  const repairSnapshot = await ports.readRepairLaunchSnapshot(teamName);
  const repaired = ports.repairOnce(teamName, repairSnapshot);
  if (!repaired) {
    throw new Error(`Task activity interval repair failed before snapshot for team ${teamName}`);
  }
}

export interface LaunchFailureArtifactPackRun {
  teamName: string;
  runId: string;
  startedAt: string;
  request?: Partial<TeamCreateRequest>;
  child?: { pid?: number | null } | null;
  progress: TeamProvisioningProgress;
  expectedMembers: string[];
  allEffectiveMembers: TeamCreateRequest['members'];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  provisioningTraceLines: string[];
  isLaunch: boolean;
  provisioningComplete: boolean;
  deterministicBootstrap: boolean;
  workspaceTrustDiagnostics?: unknown;
  processKilled: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
}

export interface LaunchFailureArtifactPackDecisionInput {
  alreadyWritten: boolean;
}

export type LaunchFailureArtifactPackDecision = { action: 'skip' } | { action: 'write' };

export function decideLaunchFailureArtifactPackWrite(
  input: LaunchFailureArtifactPackDecisionInput
): LaunchFailureArtifactPackDecision {
  return input.alreadyWritten ? { action: 'skip' } : { action: 'write' };
}

export function getLaunchFailureArtifactPackRunKey(
  run: Pick<LaunchFailureArtifactPackRun, 'teamName' | 'runId'>
): string {
  return `${run.teamName}:${run.runId}`;
}

export function buildLaunchFailureArtifactPackInput<TRun extends LaunchFailureArtifactPackRun>(
  run: TRun,
  options: {
    reason: string;
    launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  },
  ports: {
    buildLaunchDiagnosticsFromRun(run: TRun): TeamProvisioningProgress['launchDiagnostics'];
    extractCliLogsFromRun(run: TRun): string | undefined;
    getRuntimeAdapterTraceLines(runId: string): string[] | undefined;
  }
): TeamLaunchFailureArtifactPackInput {
  const request = run.request;
  return {
    teamName: run.teamName,
    runId: run.runId,
    reason: options.reason,
    startedAt: run.startedAt,
    cwd: request?.cwd ?? '',
    pid: run.child?.pid ?? run.progress.pid ?? null,
    providerId: request?.providerId,
    providerBackendId: request?.providerBackendId,
    model: request?.model,
    expectedMembers: run.expectedMembers,
    effectiveMembers: run.allEffectiveMembers,
    progress: run.progress,
    launchSnapshot: options.launchSnapshot ?? null,
    launchDiagnostics: run.progress.launchDiagnostics ?? ports.buildLaunchDiagnosticsFromRun(run),
    memberSpawnStatuses: Object.fromEntries(run.memberSpawnStatuses.entries()),
    cliLogs: ports.extractCliLogsFromRun(run),
    progressTraceLines: run.provisioningTraceLines,
    runtimeAdapterTraceLines: ports.getRuntimeAdapterTraceLines(run.runId),
    flags: {
      isLaunch: run.isLaunch,
      provisioningComplete: run.provisioningComplete,
      deterministicBootstrap: run.deterministicBootstrap,
      workspaceTrustPreflight: run.workspaceTrustDiagnostics ?? null,
      processKilled: run.processKilled,
      finalizingByTimeout: run.finalizingByTimeout,
      cancelRequested: run.cancelRequested,
    },
  };
}

export interface LaunchFailureArtifactPackWriterPort {
  write(input: TeamLaunchFailureArtifactPackInput): Promise<unknown>;
}

export function writeLaunchFailureArtifactPackBestEffort<TRun extends LaunchFailureArtifactPackRun>(
  run: TRun,
  options: {
    reason: string;
    launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  },
  ports: {
    writtenRunIds: Set<string>;
    artifactWriter: LaunchFailureArtifactPackWriterPort;
    buildLaunchDiagnosticsFromRun(run: TRun): TeamProvisioningProgress['launchDiagnostics'];
    extractCliLogsFromRun(run: TRun): string | undefined;
    getRuntimeAdapterTraceLines(runId: string): string[] | undefined;
    onWriteError(error: unknown): void;
  }
): void {
  const key = getLaunchFailureArtifactPackRunKey(run);
  const decision = decideLaunchFailureArtifactPackWrite({
    alreadyWritten: ports.writtenRunIds.has(key),
  });
  if (decision.action === 'skip') return;

  ports.writtenRunIds.add(key);
  const input = buildLaunchFailureArtifactPackInput(run, options, ports);
  void ports.artifactWriter.write(input).catch((error: unknown) => {
    ports.writtenRunIds.delete(key);
    ports.onWriteError(error);
  });
}
