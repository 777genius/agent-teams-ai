import { spawnCli } from '@main/utils/childProcess';

import {
  applyLeadRuntimeSettingsToTeamMeta,
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

  /**
   * Launch prompt for an OpenCode team: queued as a normal user inbox message
   * for the lead once the lanes are ready, so the inbox relay delivers it under
   * the standard user-reply contract. The orchestrator's own `leadPrompt` slot
   * replays the prompt on every session rebuild, which a memoryless cloud lead
   * then re-executes.
   *
   * The caller's ownership fence is handed to the writer rather than checked
   * here: the inbox lock is where the wait happens, so that is where a launch
   * that no longer owns the team has to be refused.
   */
  async deliverOpenCodeLaunchPromptToLead(input: {
    teamName: string;
    leadName: string;
    prompt: string;
    isLaunchStillCurrent: () => boolean;
  }): Promise<void> {
    const text = input.prompt.trim();
    if (!text) return;
    await this.inboxWriter.sendMessage(
      input.teamName,
      {
        member: input.leadName,
        to: input.leadName,
        from: 'user',
        text,
        source: 'user_sent',
      },
      { shouldStillWrite: input.isLaunchStillCurrent }
    );
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
      syncPersistedMetadata: async ({ teamName, settings, launchIdentity }) => {
        await this.teamMetaStore.updateMeta(teamName, (meta) => {
          if (!meta) throw new Error(`Team metadata is unavailable: ${teamName}`);
          return applyLeadRuntimeSettingsToTeamMeta(meta, settings, launchIdentity);
        });
        try {
          TeamConfigReader.invalidateTeam(teamName);
        } catch {
          // Metadata is committed; file watching remains the fallback refresh path.
        }
      },
      stopPersistentTeamMembers: (teamName) =>
        this.persistentRuntimeCleanup.stopPersistentTeamMembers(teamName),
      hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
      stopMixedSecondaryRuntimeLanes: (teamName) => this.stopMixedSecondaryRuntimeLanes(teamName),
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
