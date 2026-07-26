import { TeamProvisioningAppShellFacade } from './TeamProvisioningAppShellFacade';

import type { TeamProvisioningCancellationBoundary } from './TeamProvisioningCancellationBoundary';
import type { TeamProvisioningConfigFacade } from './TeamProvisioningConfigFacade';
import type { TeamProvisioningConfigTaskActivityBoundary } from './TeamProvisioningConfigTaskActivityBoundary';
import type { RetainedProvisioningProgressRunLike } from './TeamProvisioningProgressState';
import type { TeamProvisioningRetainedProgressState } from './TeamProvisioningProgressState';
import type { TeamProvisioningProviderRuntimeCompatibility } from './TeamProvisioningProviderRuntimeFacade';
import type { TeamProvisioningRuntimeSnapshotFacade } from './TeamProvisioningRuntimeSnapshotFacade';
import type {
  TeamProvisioningSendMessageToRunBoundary,
  TeamProvisioningSendMessageToRunRun,
} from './TeamProvisioningSendMessageToRunBoundaryFactory';
import type { TeamProvisioningTaskActivityRepairBoundaryRun } from './TeamProvisioningTaskActivityRepairBoundary';
import type { TeamProvisioningStatusApi } from '@features/team-provisioning/contracts';
import type { TeamProvisioningProgress } from '@shared/types';

export type TeamProvisioningCompatibilityDelegationRun = TeamProvisioningSendMessageToRunRun &
  RetainedProvisioningProgressRunLike &
  TeamProvisioningTaskActivityRepairBoundaryRun;

export interface TeamProvisioningCompatibilityDelegation<
  TRun extends TeamProvisioningCompatibilityDelegationRun,
> {
  providerRuntimeCompatibility: TeamProvisioningProviderRuntimeCompatibility;
  configFacade: Pick<
    TeamProvisioningConfigFacade,
    | 'readConfigSnapshot'
    | 'readConfigForStrictDecision'
    | 'readPersistedRuntimeMembers'
    | 'readPersistedTeamProjectPath'
    | 'normalizeTeamConfigForLaunch'
    | 'assertConfigLeadOnlyForLaunch'
    | 'persistMembersMeta'
    | 'resolveLaunchExpectedMembers'
    | 'updateConfigPostLaunch'
  >;
  configTaskActivityBoundary: Pick<
    TeamProvisioningConfigTaskActivityBoundary<TRun>,
    | 'updateConfigProjectPath'
    | 'restorePrelaunchConfig'
    | 'cleanupPrelaunchBackup'
    | 'writeLaunchFailureArtifactPackBestEffort'
    | 'repairStaleTaskActivityIntervalsBeforeSnapshot'
  >;
  provisioningStatus: TeamProvisioningStatusApi;
  retainedProvisioningProgressState: Pick<
    TeamProvisioningRetainedProgressState,
    'retainProvisioningProgress'
  >;
  cancellationBoundary: Pick<TeamProvisioningCancellationBoundary, 'cancelProvisioning'>;
  runtimeSnapshotFacade: Pick<
    TeamProvisioningRuntimeSnapshotFacade,
    'hasProvisioningRun' | 'isTeamAlive' | 'getAliveTeams' | 'getRuntimeState'
  >;
  runTracking: {
    getAliveRunId(teamName: string): string | null;
  };
  runs: ReadonlyMap<string, TRun>;
  sendMessageToRunBoundary: TeamProvisioningSendMessageToRunBoundary<TRun>;
}

export abstract class TeamProvisioningCompatibilityFacade<
  TRun extends TeamProvisioningCompatibilityDelegationRun =
    TeamProvisioningCompatibilityDelegationRun,
> extends TeamProvisioningAppShellFacade {
  protected abstract readonly compatibilityDelegation: TeamProvisioningCompatibilityDelegation<TRun>;

  buildProvisioningEnv(
    ...args: Parameters<TeamProvisioningProviderRuntimeCompatibility['buildProvisioningEnv']>
  ): ReturnType<TeamProvisioningProviderRuntimeCompatibility['buildProvisioningEnv']> {
    return this.compatibilityDelegation.providerRuntimeCompatibility.buildProvisioningEnv(...args);
  }

  buildCrossProviderMemberArgs(
    ...args: Parameters<
      TeamProvisioningProviderRuntimeCompatibility['buildCrossProviderMemberArgs']
    >
  ): ReturnType<TeamProvisioningProviderRuntimeCompatibility['buildCrossProviderMemberArgs']> {
    return this.compatibilityDelegation.providerRuntimeCompatibility.buildCrossProviderMemberArgs(
      ...args
    );
  }

  validateAgentTeamsMcpRuntime(
    ...args: Parameters<
      TeamProvisioningProviderRuntimeCompatibility['validateAgentTeamsMcpRuntime']
    >
  ): ReturnType<TeamProvisioningProviderRuntimeCompatibility['validateAgentTeamsMcpRuntime']> {
    return this.compatibilityDelegation.providerRuntimeCompatibility.validateAgentTeamsMcpRuntime(
      ...args
    );
  }

  protected readConfigSnapshot(
    ...args: Parameters<TeamProvisioningConfigFacade['readConfigSnapshot']>
  ): ReturnType<TeamProvisioningConfigFacade['readConfigSnapshot']> {
    return this.compatibilityDelegation.configFacade.readConfigSnapshot(...args);
  }

  protected readConfigForStrictDecision(
    ...args: Parameters<TeamProvisioningConfigFacade['readConfigForStrictDecision']>
  ): ReturnType<TeamProvisioningConfigFacade['readConfigForStrictDecision']> {
    return this.compatibilityDelegation.configFacade.readConfigForStrictDecision(...args);
  }

  protected readPersistedRuntimeMembers(
    ...args: Parameters<TeamProvisioningConfigFacade['readPersistedRuntimeMembers']>
  ): ReturnType<TeamProvisioningConfigFacade['readPersistedRuntimeMembers']> {
    return this.compatibilityDelegation.configFacade.readPersistedRuntimeMembers(...args);
  }

  protected readPersistedTeamProjectPath(
    ...args: Parameters<TeamProvisioningConfigFacade['readPersistedTeamProjectPath']>
  ): ReturnType<TeamProvisioningConfigFacade['readPersistedTeamProjectPath']> {
    return this.compatibilityDelegation.configFacade.readPersistedTeamProjectPath(...args);
  }

  protected normalizeTeamConfigForLaunch(
    ...args: Parameters<TeamProvisioningConfigFacade['normalizeTeamConfigForLaunch']>
  ): ReturnType<TeamProvisioningConfigFacade['normalizeTeamConfigForLaunch']> {
    return this.compatibilityDelegation.configFacade.normalizeTeamConfigForLaunch(...args);
  }

  protected assertConfigLeadOnlyForLaunch(
    ...args: Parameters<TeamProvisioningConfigFacade['assertConfigLeadOnlyForLaunch']>
  ): ReturnType<TeamProvisioningConfigFacade['assertConfigLeadOnlyForLaunch']> {
    return this.compatibilityDelegation.configFacade.assertConfigLeadOnlyForLaunch(...args);
  }

  protected updateConfigProjectPath(
    ...args: Parameters<TeamProvisioningConfigTaskActivityBoundary<TRun>['updateConfigProjectPath']>
  ): ReturnType<TeamProvisioningConfigTaskActivityBoundary<TRun>['updateConfigProjectPath']> {
    return this.compatibilityDelegation.configTaskActivityBoundary.updateConfigProjectPath(...args);
  }

  protected restorePrelaunchConfig(
    ...args: Parameters<TeamProvisioningConfigTaskActivityBoundary<TRun>['restorePrelaunchConfig']>
  ): ReturnType<TeamProvisioningConfigTaskActivityBoundary<TRun>['restorePrelaunchConfig']> {
    return this.compatibilityDelegation.configTaskActivityBoundary.restorePrelaunchConfig(...args);
  }

  cleanupPrelaunchBackup(
    ...args: Parameters<TeamProvisioningConfigTaskActivityBoundary<TRun>['cleanupPrelaunchBackup']>
  ): ReturnType<TeamProvisioningConfigTaskActivityBoundary<TRun>['cleanupPrelaunchBackup']> {
    return this.compatibilityDelegation.configTaskActivityBoundary.cleanupPrelaunchBackup(...args);
  }

  protected persistMembersMeta(
    ...args: Parameters<TeamProvisioningConfigFacade['persistMembersMeta']>
  ): ReturnType<TeamProvisioningConfigFacade['persistMembersMeta']> {
    return this.compatibilityDelegation.configFacade.persistMembersMeta(...args);
  }

  protected resolveLaunchExpectedMembers(
    ...args: Parameters<TeamProvisioningConfigFacade['resolveLaunchExpectedMembers']>
  ): ReturnType<TeamProvisioningConfigFacade['resolveLaunchExpectedMembers']> {
    return this.compatibilityDelegation.configFacade.resolveLaunchExpectedMembers(...args);
  }

  protected updateConfigPostLaunch(
    ...args: Parameters<TeamProvisioningConfigFacade['updateConfigPostLaunch']>
  ): ReturnType<TeamProvisioningConfigFacade['updateConfigPostLaunch']> {
    return this.compatibilityDelegation.configFacade.updateConfigPostLaunch(...args);
  }

  protected writeLaunchFailureArtifactPackBestEffort(
    ...args: Parameters<
      TeamProvisioningConfigTaskActivityBoundary<TRun>['writeLaunchFailureArtifactPackBestEffort']
    >
  ): ReturnType<
    TeamProvisioningConfigTaskActivityBoundary<TRun>['writeLaunchFailureArtifactPackBestEffort']
  > {
    return void this.compatibilityDelegation.configTaskActivityBoundary.writeLaunchFailureArtifactPackBestEffort(
      ...args
    );
  }

  repairStaleTaskActivityIntervalsBeforeSnapshot(
    ...args: Parameters<
      TeamProvisioningConfigTaskActivityBoundary<TRun>['repairStaleTaskActivityIntervalsBeforeSnapshot']
    >
  ): ReturnType<
    TeamProvisioningConfigTaskActivityBoundary<TRun>['repairStaleTaskActivityIntervalsBeforeSnapshot']
  > {
    return this.compatibilityDelegation.configTaskActivityBoundary.repairStaleTaskActivityIntervalsBeforeSnapshot(
      ...args
    );
  }

  async getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress> {
    return this.compatibilityDelegation.provisioningStatus.getProvisioningStatus(runId);
  }

  protected retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void {
    this.compatibilityDelegation.retainedProvisioningProgressState.retainProvisioningProgress(
      runId,
      progress
    );
  }

  async cancelProvisioning(runId: string): Promise<void> {
    await this.compatibilityDelegation.cancellationBoundary.cancelProvisioning(runId);
  }

  async sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: { data: string; mimeType: string; filename?: string }[]
  ): Promise<void> {
    const runId = this.compatibilityDelegation.runTracking.getAliveRunId(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.compatibilityDelegation.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    await this.sendMessageToRun(run, message, attachments);
  }

  protected async sendMessageToRun(
    run: TRun,
    message: string,
    attachments?: { data: string; mimeType: string; filename?: string }[]
  ): Promise<void> {
    await this.compatibilityDelegation.sendMessageToRunBoundary.sendMessageToRun(
      run,
      message,
      attachments
    );
  }

  hasProvisioningRun(teamName: string): boolean {
    return this.compatibilityDelegation.runtimeSnapshotFacade.hasProvisioningRun(teamName);
  }

  isTeamAlive(teamName: string): boolean {
    return this.compatibilityDelegation.runtimeSnapshotFacade.isTeamAlive(teamName);
  }

  getAliveTeams(): string[] {
    return this.compatibilityDelegation.runtimeSnapshotFacade.getAliveTeams();
  }

  getRuntimeState(
    ...args: Parameters<TeamProvisioningRuntimeSnapshotFacade['getRuntimeState']>
  ): ReturnType<TeamProvisioningRuntimeSnapshotFacade['getRuntimeState']> {
    return this.compatibilityDelegation.runtimeSnapshotFacade.getRuntimeState(...args);
  }
}
