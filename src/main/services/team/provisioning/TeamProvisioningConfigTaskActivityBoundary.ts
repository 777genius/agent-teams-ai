import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from '../TeamBootstrapStateReader';
import { writeTeamLaunchFailureArtifactPack } from '../TeamLaunchFailureArtifactPack';

import { buildLaunchDiagnosticsFromRun } from './TeamProvisioningLaunchDiagnostics';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';
import {
  TeamProvisioningTaskActivityRepairBoundary,
  type TeamProvisioningTaskActivityRepairBoundaryRun,
} from './TeamProvisioningTaskActivityRepairBoundary';

import type { TaskActivityRepairServicePort } from './TeamProvisioningTaskActivityRepair';
import type { PersistedTeamLaunchSnapshot, TeamConfig } from '@shared/types';

export interface TeamProvisioningConfigTaskActivityConfigPort {
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  updateConfigProjectPath(teamName: string, cwd: string): Promise<void>;
  restorePrelaunchConfig(teamName: string): Promise<void>;
  cleanupPrelaunchBackup(teamName: string): Promise<void>;
}

export interface TeamProvisioningConfigTaskActivityRepairPort<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
> {
  repairStaleTaskActivityIntervalsOnce(
    teamName: string,
    launchSnapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean;
  readTaskActivityRepairLaunchSnapshot(
    teamName: string
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchFailureArtifactPackBestEffort(
    run: TRun,
    options: {
      reason: string;
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
    }
  ): void;
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

export interface TeamProvisioningConfigTaskActivityBoundaryPorts<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
> {
  config: TeamProvisioningConfigTaskActivityConfigPort;
  taskActivityRepair: TeamProvisioningConfigTaskActivityRepairPort<TRun>;
}

export class TeamProvisioningConfigTaskActivityBoundary<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
> {
  constructor(private readonly ports: TeamProvisioningConfigTaskActivityBoundaryPorts<TRun>) {}

  readConfigSnapshot(teamName: string): Promise<TeamConfig | null> {
    return this.ports.config.readConfigSnapshot(teamName);
  }

  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null> {
    return this.ports.config.readConfigForStrictDecision(teamName);
  }

  updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    return this.ports.config.updateConfigProjectPath(teamName, cwd);
  }

  restorePrelaunchConfig(teamName: string): Promise<void> {
    return this.ports.config.restorePrelaunchConfig(teamName);
  }

  cleanupPrelaunchBackup(teamName: string): Promise<void> {
    return this.ports.config.cleanupPrelaunchBackup(teamName);
  }

  repairStaleTaskActivityIntervalsOnce(
    teamName: string,
    launchSnapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return this.ports.taskActivityRepair.repairStaleTaskActivityIntervalsOnce(
      teamName,
      launchSnapshot
    );
  }

  readTaskActivityRepairLaunchSnapshot(
    teamName: string
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.ports.taskActivityRepair.readTaskActivityRepairLaunchSnapshot(teamName);
  }

  writeLaunchFailureArtifactPackBestEffort(
    run: TRun,
    options: {
      reason: string;
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
    }
  ): void {
    this.ports.taskActivityRepair.writeLaunchFailureArtifactPackBestEffort(run, options);
  }

  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void> {
    return this.ports.taskActivityRepair.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName);
  }
}

export interface TeamProvisioningConfigTaskActivityBoundaryFactoryOptions {
  config: TeamProvisioningConfigTaskActivityConfigPort;
  taskActivityIntervalService: TaskActivityRepairServicePort;
  runTracking: {
    getTrackedRunId(teamName: string): string | null;
  };
  runs: {
    has(runId: string): boolean;
  };
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  };
  runtimeAdapterTraceLinesByRunId: {
    get(runId: string): string[] | undefined;
  };
  logger: {
    warn(message: string): void;
  };
}

export interface TeamProvisioningConfigTaskActivityBoundaryServiceHost {
  configFacade: TeamProvisioningConfigTaskActivityConfigPort;
  taskActivityIntervalService: TaskActivityRepairServicePort;
  runTracking: TeamProvisioningConfigTaskActivityBoundaryFactoryOptions['runTracking'];
  runs: TeamProvisioningConfigTaskActivityBoundaryFactoryOptions['runs'];
  launchStateStore: TeamProvisioningConfigTaskActivityBoundaryFactoryOptions['launchStateStore'];
  runtimeAdapterTraceLinesByRunId: TeamProvisioningConfigTaskActivityBoundaryFactoryOptions['runtimeAdapterTraceLinesByRunId'];
}

export interface TeamProvisioningConfigTaskActivityBoundaryServiceHostOptions {
  logger: TeamProvisioningConfigTaskActivityBoundaryFactoryOptions['logger'];
}

export function createTeamProvisioningConfigTaskActivityBoundary<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
>(
  options: TeamProvisioningConfigTaskActivityBoundaryFactoryOptions
): TeamProvisioningConfigTaskActivityBoundary<TRun> {
  return new TeamProvisioningConfigTaskActivityBoundary<TRun>({
    config: options.config,
    taskActivityRepair: new TeamProvisioningTaskActivityRepairBoundary<TRun>({
      taskActivityIntervalService: options.taskActivityIntervalService,
      runTracking: options.runTracking,
      runs: options.runs,
      readBootstrapLaunchSnapshot,
      readLaunchState: (teamName) => options.launchStateStore.read(teamName),
      choosePreferredLaunchSnapshot,
      artifactWriter: {
        write: writeTeamLaunchFailureArtifactPack,
      },
      buildLaunchDiagnosticsFromRun,
      extractCliLogsFromRun,
      getRuntimeAdapterTraceLines: (runId) => options.runtimeAdapterTraceLinesByRunId.get(runId),
      warn: (message) => options.logger.warn(message),
    }),
  });
}

export function createTeamProvisioningConfigTaskActivityBoundaryFromService<
  TRun extends TeamProvisioningTaskActivityRepairBoundaryRun,
>(
  service: TeamProvisioningConfigTaskActivityBoundaryServiceHost,
  options: TeamProvisioningConfigTaskActivityBoundaryServiceHostOptions
): TeamProvisioningConfigTaskActivityBoundary<TRun> {
  return createTeamProvisioningConfigTaskActivityBoundary<TRun>({
    config: service.configFacade,
    taskActivityIntervalService: service.taskActivityIntervalService,
    runTracking: service.runTracking,
    runs: service.runs,
    launchStateStore: service.launchStateStore,
    runtimeAdapterTraceLinesByRunId: service.runtimeAdapterTraceLinesByRunId,
    logger: options.logger,
  });
}
