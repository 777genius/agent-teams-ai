import {
  type LaunchFailureArtifactPackRun,
  type LaunchFailureArtifactPackWriterPort,
  readTaskActivityRepairLaunchSnapshot,
  repairStaleTaskActivityIntervalsBeforeSnapshot,
  repairStaleTaskActivityIntervalsOnce,
  type TaskActivityRepairLaunchSnapshotPorts,
  type TaskActivityRepairServicePort,
  writeLaunchFailureArtifactPackBestEffort,
} from './TeamProvisioningTaskActivityRepair';

import type { PersistedTeamLaunchSnapshot, TeamProvisioningProgress } from '@shared/types';

export type TeamProvisioningTaskActivityRepairBoundaryRun = LaunchFailureArtifactPackRun;

export interface TeamProvisioningTaskActivityRepairBoundaryPorts<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
> extends TaskActivityRepairLaunchSnapshotPorts {
  taskActivityIntervalService: TaskActivityRepairServicePort;
  runTracking: {
    getTrackedRunId(teamName: string): string | null;
  };
  runs: {
    has(runId: string): boolean;
  };
  artifactWriter: LaunchFailureArtifactPackWriterPort;
  buildLaunchDiagnosticsFromRun(run: TRun): TeamProvisioningProgress['launchDiagnostics'];
  extractCliLogsFromRun(run: TRun): string | undefined;
  getRuntimeAdapterTraceLines(runId: string): string[] | undefined;
  warn(message: string): void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TeamProvisioningTaskActivityRepairBoundary<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
> {
  private readonly launchFailureArtifactPackRunIds = new Set<string>();
  private readonly crashRepairedActivityIntervalsByTeam = new Set<string>();
  private readonly pendingCrashRepairSnapshotByTeam = new Map<
    string,
    PersistedTeamLaunchSnapshot | null
  >();

  constructor(private readonly ports: TeamProvisioningTaskActivityRepairBoundaryPorts<TRun>) {}

  repairStaleTaskActivityIntervalsOnce(
    teamName: string,
    launchSnapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return repairStaleTaskActivityIntervalsOnce(teamName, launchSnapshot, {
      taskActivityIntervalService: this.ports.taskActivityIntervalService,
      tracking: {
        repairedTeams: this.crashRepairedActivityIntervalsByTeam,
        pendingSnapshots: this.pendingCrashRepairSnapshotByTeam,
      },
    });
  }

  readTaskActivityRepairLaunchSnapshot(
    teamName: string
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return readTaskActivityRepairLaunchSnapshot(teamName, this.ports);
  }

  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void> {
    return repairStaleTaskActivityIntervalsBeforeSnapshot(teamName, {
      tracking: {
        repairedTeams: this.crashRepairedActivityIntervalsByTeam,
        pendingSnapshots: this.pendingCrashRepairSnapshotByTeam,
      },
      getTrackedRunId: (targetTeamName) => this.ports.runTracking.getTrackedRunId(targetTeamName),
      hasRun: (runId) => this.ports.runs.has(runId),
      readRepairLaunchSnapshot: (targetTeamName) =>
        this.readTaskActivityRepairLaunchSnapshot(targetTeamName),
      repairOnce: (targetTeamName, launchSnapshot) =>
        this.repairStaleTaskActivityIntervalsOnce(targetTeamName, launchSnapshot),
    });
  }

  writeLaunchFailureArtifactPackBestEffort(
    run: TRun,
    options: {
      reason: string;
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
    }
  ): void {
    writeLaunchFailureArtifactPackBestEffort(run, options, {
      writtenRunIds: this.launchFailureArtifactPackRunIds,
      artifactWriter: this.ports.artifactWriter,
      buildLaunchDiagnosticsFromRun: (targetRun) =>
        this.ports.buildLaunchDiagnosticsFromRun(targetRun),
      extractCliLogsFromRun: (targetRun) => this.ports.extractCliLogsFromRun(targetRun),
      getRuntimeAdapterTraceLines: (runId) => this.ports.getRuntimeAdapterTraceLines(runId),
      onWriteError: (error) => {
        this.ports.warn(
          `[${run.teamName}] Failed to write launch failure artifact pack: ${getErrorMessage(
            error
          )}`
        );
      },
    });
  }
}
