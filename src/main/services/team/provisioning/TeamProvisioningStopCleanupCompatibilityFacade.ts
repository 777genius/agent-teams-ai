import { AsyncLocalStorage } from 'node:async_hooks';

import { killTrackedCliProcesses } from '@main/utils/childProcess';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { clearOpenCodeRuntimeLaneStorage } from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import {
  cleanupProvisioningRun,
  finalizeIncompleteLaunchStateBeforeCleanup as finalizeIncompleteLaunchStateBeforeCleanupHelper,
  type TeamProvisioningCleanupPorts,
} from './TeamProvisioningCleanup';
import { TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityFacade } from './TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityFacade';
import {
  createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
  type TeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
} from './TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { killTeamProcess, nowIso, updateProgress } from './TeamProvisioningRunProgress';
import { stopAllTeamsFlow } from './TeamProvisioningStopFlow';
import {
  createTeamProvisioningStopFlowBoundary,
  createTeamProvisioningStopFlowDepsFromService,
  type TeamProvisioningStopFlowBoundary,
  type TeamProvisioningStopFlowServiceHost,
} from './TeamProvisioningStopFlowPortsFactory';

import type { TeamConfig, TeamMember } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

interface MarkUnconfirmedBootstrapMembersFailedOptions {
  cleanupRequested?: boolean;
  preserveExistingFailure?: boolean;
}

export interface TeamProvisioningStopCleanupCompatibilityServiceHost<
  TRun extends ProvisioningRun,
> extends TeamProvisioningStopFlowServiceHost<TRun> {
  runTracking: TeamProvisioningStopFlowServiceHost<TRun>['runTracking'] & {
    canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  };
  configFacade: {
    readConfigForObservation(teamName: string): Promise<TeamConfig | null>;
    listPersistedTeamNames(): string[];
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<readonly TeamMember[]>;
  };
  cleanupRunPorts: TeamProvisioningCleanupPorts<TRun>;
  outputRecoveryFacade: {
    getUnconfirmedBootstrapMemberNames(run: TRun): string[];
    buildStdoutCarryDiagnostic(run: TRun): Record<string, unknown>;
  };
  markUnconfirmedBootstrapMembersFailed(
    run: TRun,
    reason: string,
    options?: MarkUnconfirmedBootstrapMembersFailedOptions
  ): void;
  shutdownCoordination: {
    getShutdownTrackedTeamNames(): string[];
    killTransientProbeProcessesForShutdown(): void;
    stopTrackedTeamsForShutdown(label: string): Promise<string[]>;
    cancelPendingRuntimeAdapterLaunchesForShutdown(): Promise<void>;
    waitForInFlightTeamOperationsForShutdown(): Promise<void>;
  };
}

export abstract class TeamProvisioningStopCleanupCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityFacade<TRun> {
  protected stopAllTeamsGeneration = 0;
  protected readonly cleanedStoppedTeamOpenCodeRuntimeLanes = new Set<string>();
  protected readonly cleanupRunPorts!: TeamProvisioningCleanupPorts<TRun>;

  private readonly liveRosterMutationLockContext = new AsyncLocalStorage<{
    teamKey: string;
    token: symbol;
  }>();
  private readonly activeLiveRosterMutationTokens = new Map<string, symbol>();
  private stopFlowBoundaryValue: TeamProvisioningStopFlowBoundary | null = null;
  private openCodeStoppedLaneCleanupBoundary: TeamProvisioningOpenCodeStoppedLaneCleanupBoundary | null =
    null;

  protected get openCodeStoppedLaneCleanup(): TeamProvisioningOpenCodeStoppedLaneCleanupBoundary {
    if (!this.openCodeStoppedLaneCleanupBoundary) {
      const service = this.stopCleanupServiceHost;
      this.openCodeStoppedLaneCleanupBoundary =
        createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(
          {
            canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
              service.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
            getOpenCodeRuntimeAdapter: () => service.appShellBoundary.getOpenCodeRuntimeAdapter(),
            readPreviousLaunchState: (teamName) => service.launchStateStore.read(teamName),
            readConfigForObservation: (teamName) =>
              service.configFacade.readConfigForObservation(teamName),
            readMembersMeta: (teamName) => service.membersMetaStore.getMembers(teamName),
            readPersistedTeamProjectPath: (teamName) =>
              service.readPersistedTeamProjectPath(teamName),
            deleteSecondaryRuntimeRun: (teamName, laneId) =>
              service.deleteSecondaryRuntimeRun(teamName, laneId),
            clearPrimaryRuntimeRun: (teamName) => {
              service.runtimeAdapterRunByTeam.delete(teamName);
              service.runTracking.deleteAliveRunId(teamName);
              service.provisioningRunByTeam.delete(teamName);
              service.invalidateRuntimeSnapshotCaches(teamName);
            },
            markStoppedTeamOpenCodeRuntimeLanesCleaned: (teamName) => {
              this.cleanedStoppedTeamOpenCodeRuntimeLanes.add(teamName);
            },
            logInfo: (message) => logger.info(message),
            logWarning: (message) => logger.warn(message),
          },
          { getTeamsBasePath }
        );
    }
    return this.openCodeStoppedLaneCleanupBoundary;
  }

  private get stopCleanupServiceHost(): TeamProvisioningStopCleanupCompatibilityServiceHost<TRun> {
    return this as unknown as TeamProvisioningStopCleanupCompatibilityServiceHost<TRun>;
  }

  private get stopFlowBoundary(): TeamProvisioningStopFlowBoundary {
    if (!this.stopFlowBoundaryValue) {
      this.stopFlowBoundaryValue = createTeamProvisioningStopFlowBoundary<TRun>(
        createTeamProvisioningStopFlowDepsFromService<TRun>(this.stopCleanupServiceHost, {
          getTeamsBasePath,
          clearOpenCodeRuntimeLaneStorage,
          killTeamProcess,
          updateProgress,
          logger,
          nowIso,
        })
      );
    }
    return this.stopFlowBoundaryValue;
  }

  protected async executeLiveRosterMutation(
    teamName: string,
    mutation: () => Promise<void>
  ): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    if (this.isLiveRosterMutationLockHeld(teamName)) {
      await mutation();
      return;
    }

    await this.stopCleanupServiceHost.withTeamLock(teamName, async () => {
      const token = Symbol(`live-roster-mutation:${teamKey}`);
      this.activeLiveRosterMutationTokens.set(teamKey, token);
      try {
        await this.liveRosterMutationLockContext.run({ teamKey, token }, mutation);
      } finally {
        if (this.activeLiveRosterMutationTokens.get(teamKey) === token) {
          this.activeLiveRosterMutationTokens.delete(teamKey);
        }
      }
    });
  }

  protected isLiveRosterMutationLockHeld(teamName: string): boolean {
    const context = this.liveRosterMutationLockContext.getStore();
    const teamKey = teamName.trim().toLowerCase();
    return (
      context?.teamKey === teamKey &&
      this.activeLiveRosterMutationTokens.get(teamKey) === context.token
    );
  }

  private hasActiveLiveRosterMutation(teamName: string): boolean {
    return this.activeLiveRosterMutationTokens.has(teamName.trim().toLowerCase());
  }

  /**
   * Stop the running process for a team. No-op if team is not running.
   * Always uses SIGKILL via killTeamProcess() to prevent CLI cleanup.
   */
  async stopTeam(teamName: string): Promise<void> {
    const stop = (): Promise<void> => this.stopFlowBoundary.stopTeam(teamName);
    if (
      this.hasActiveLiveRosterMutation(teamName) &&
      !this.isLiveRosterMutationLockHeld(teamName)
    ) {
      await this.stopCleanupServiceHost.withTeamLock(teamName, stop);
      return;
    }

    await stop();
  }

  protected async stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void> {
    await this.stopFlowBoundary.stopMixedSecondaryRuntimeLanes(teamName);
  }

  protected async stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void> {
    await this.stopFlowBoundary.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
  }

  /**
   * Stop all running team processes. Called during app shutdown.
   * Uses killTeamProcess() (SIGKILL) to guarantee instant death
   * without CLI cleanup that would delete team files.
   */
  async stopAllTeams(): Promise<void> {
    const service = this.stopCleanupServiceHost;
    await stopAllTeamsFlow({
      incrementStopAllTeamsGeneration: () => {
        this.stopAllTeamsGeneration += 1;
      },
      getShutdownTrackedTeamNames: () => service.shutdownCoordination.getShutdownTrackedTeamNames(),
      pauseActiveIntervalsForTeam: (teamName) =>
        service.taskActivityIntervalService.pauseActiveIntervalsForTeam(teamName),
      killTrackedCliProcesses,
      killTransientProbeProcessesForShutdown: () =>
        service.shutdownCoordination.killTransientProbeProcessesForShutdown(),
      stopTrackedTeamsForShutdown: (label) =>
        service.shutdownCoordination.stopTrackedTeamsForShutdown(label),
      cancelPendingRuntimeAdapterLaunchesForShutdown: () =>
        service.shutdownCoordination.cancelPendingRuntimeAdapterLaunchesForShutdown(),
      waitForInFlightTeamOperationsForShutdown: () =>
        service.shutdownCoordination.waitForInFlightTeamOperationsForShutdown(),
      listPersistedTeamNames: () => service.configFacade.listPersistedTeamNames(),
      stopPersistentTeamMembers: (teamName) =>
        service.persistentRuntimeCleanup.stopPersistentTeamMembers(teamName),
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
        service.persistentRuntimeCleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(
          teamName
        ),
      logger,
    });
  }

  protected markIncompleteLaunchStateFinalized(run: TRun, cleanupReason: string): void {
    const service = this.stopCleanupServiceHost;
    logger.warn(`[${run.teamName}] Launch cleanup finalizing unconfirmed bootstrap members`, {
      runId: run.runId,
      progressState: run.progress.state,
      progressMessage: run.progress.message,
      progressError: run.progress.error ?? null,
      cleanupReason,
      unconfirmedMembers: service.outputRecoveryFacade.getUnconfirmedBootstrapMemberNames(run),
      ...service.outputRecoveryFacade.buildStdoutCarryDiagnostic(run),
    });
    service.markUnconfirmedBootstrapMembersFailed(run, cleanupReason, {
      cleanupRequested: true,
      preserveExistingFailure: true,
    });
    run.launchCleanupStateFinalized = true;
  }

  protected async finalizeIncompleteLaunchStateBeforeCleanup(
    run: TRun,
    fallbackReason?: string
  ): Promise<void> {
    await finalizeIncompleteLaunchStateBeforeCleanupHelper(run, this.cleanupRunPorts, {
      fallbackReason,
      onPersistFailure: (targetRun, error) => {
        logger.warn(
          `[${targetRun.teamName}] Failed to finalize launch state before cleanup: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
    });
  }

  /**
   * Remove a run from tracking maps.
   */
  protected cleanupRun(run: TRun): void {
    cleanupProvisioningRun(run, this.cleanupRunPorts);
  }
}
