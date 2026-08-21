import { spawnCli } from '@main/utils/childProcess';

import {
  assessLeadRuntimeRestart,
  restartLeadRuntime,
} from './provisioning/TeamProvisioningLeadRuntimeRestart';
import { TeamProvisioningOpenCodeAggregatePrimaryFacade } from './provisioning/TeamProvisioningOpenCodeAggregatePrimaryFacade';
import { killTeamProcessAndWait } from './provisioning/TeamProvisioningRunProgress';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { TeamAttachmentStore } from './TeamAttachmentStore';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamMcpConfigBuilder } from './TeamMcpConfigBuilder';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMemberWorktreeManager } from './TeamMemberWorktreeManager';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';

export type { RuntimeBootstrapMemberMcpLaunchConfig } from './provisioning/TeamProvisioningBootstrapSpec';
export { buildDirectTmuxRestartEnvAssignments } from './provisioning/TeamProvisioningDirectRestart';
export {
  getMixedLaunchFallbackRecoveryError,
  getOpenCodeMixedProviderProvisioningError,
} from './provisioning/TeamProvisioningLaunchCompatibility';
export {
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
export {
  buildAddMemberSpawnMessage,
  buildRestartMemberSpawnMessage,
} from './provisioning/TeamProvisioningPromptBuilders';
export type { LeadRuntimeFailureObservation } from './provisioning/TeamProvisioningRuntimeFailureObservationBoundary';

import type { ProvisioningRun } from './provisioning/TeamProvisioningRunModel';
import type {
  LeadRuntimeFailureObservation,
  RuntimeFailureObservationInput,
} from './provisioning/TeamProvisioningRuntimeFailureObservationBoundary';
import type {
  EffortLevel,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

/** Stable app-shell facade. Construction and orchestration live in focused delegate layers. */
export class TeamProvisioningService extends TeamProvisioningOpenCodeAggregatePrimaryFacade {
  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    protected readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    protected readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly mcpConfigBuilder: TeamMcpConfigBuilder = new TeamMcpConfigBuilder(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly openCodeTaskLogAttributionStore: OpenCodeTaskLogAttributionStore = new OpenCodeTaskLogAttributionStore(),
    private readonly memberWorktreeManager: TeamMemberWorktreeManager = new TeamMemberWorktreeManager(),
    private readonly attachmentStore: TeamAttachmentStore = new TeamAttachmentStore()
  ) {
    super();
    this.initializeTeamProvisioningService();
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  setRuntimeRecoveryFailureObserver(
    observer: ((failure: LeadRuntimeFailureObservation) => void) | null
  ): void {
    this.runtimeFailureObservationBoundary.setObserver(observer);
  }

  protected observeRuntimeFailure(
    run: ProvisioningRun,
    failure: RuntimeFailureObservationInput
  ): void {
    this.runtimeFailureObservationBoundary.observe(run, this.getRunLeadName(run), failure);
  }

  async assessLeadRuntimeRestart(input: {
    teamName: string;
    providerId: Exclude<TeamProviderId, 'opencode'>;
    model: string | null;
    effort: EffortLevel | null;
  }): Promise<
    { outcome: 'ready'; token: string } | { outcome: 'busy' } | { outcome: 'relaunch_required' }
  > {
    const result = assessLeadRuntimeRestart(
      input.teamName,
      { providerId: input.providerId, model: input.model, effort: input.effort },
      {
        getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
        getRun: (runId) => this.runs.get(runId),
      }
    );
    return result.outcome === 'ready'
      ? { outcome: 'ready', token: result.runId }
      : { outcome: result.outcome };
  }

  async restartLeadRuntime(input: {
    teamName: string;
    expectedRunId: string;
    before: {
      providerId: Exclude<TeamProviderId, 'opencode'>;
      model: string | null;
      effort: EffortLevel | null;
    };
    after: {
      providerId: Exclude<TeamProviderId, 'opencode'>;
      model: string | null;
      effort: EffortLevel | null;
    };
  }): Promise<void> {
    await restartLeadRuntime(input, {
      spawn: spawnCli,
      killAndWait: killTeamProcessAndWait,
      attachStdout: (run) => this.outputRecoveryFacade.attachStdoutHandler(run),
      attachStderr: (run) => this.outputRecoveryFacade.attachStderrHandler(run),
      startStallWatchdog: (run) => this.outputRecoveryFacade.startStallWatchdog(run),
      stopStallWatchdog: (run) => this.outputRecoveryFacade.stopStallWatchdog(run),
      handleProcessExit: (run, code) => this.handleProcessExit(run, code),
      getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
      invalidateRuntimeSnapshot: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
    });
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    await this.waitForOpenCodeAggregatePrimaryRestart(request.teamName);
    await this.waitForMemberLifecycleOperations(request.teamName);
    return this.requestAdmissionBoundary.createTeam(request, onProgress);
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    await this.waitForOpenCodeAggregatePrimaryRestart(request.teamName);
    await this.waitForMemberLifecycleOperations(request.teamName);
    return this.requestAdmissionBoundary.launchTeam(request, onProgress);
  }
}
