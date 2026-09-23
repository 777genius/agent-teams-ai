import { spawnCli } from '@main/utils/childProcess';

import {
  applyLeadRuntimeSettingsToTeamMeta,
  assessLeadRuntimeRestart,
  restartLeadRuntime,
} from './provisioning/TeamProvisioningLeadRuntimeRestart';
import { TeamProvisioningOpenCodeAggregatePrimaryFacade } from './provisioning/TeamProvisioningOpenCodeAggregatePrimaryFacade';
import { killTeamProcessAndWait } from './provisioning/TeamProvisioningRunProgress';
import { TeamProvisioningRunWriterAuthority } from './provisioning/TeamProvisioningRunWriterAuthority';
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
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
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
  private readonly runWriterAuthority = new TeamProvisioningRunWriterAuthority();

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

  setDesktopWriterWorkflowLease(
    lease: <T>(
      teamName: string,
      operation: () => Promise<T>,
      continuation?: { assertGeneration(): void }
    ) => Promise<T>
  ): void {
    this.runWriterAuthority.configure(lease);
  }

  protected override async handleProcessExit(
    run: ProvisioningRun,
    code: number | null
  ): Promise<void> {
    await this.runWriterAuthority.persistForRun(run, () => super.handleProcessExit(run, code));
  }

  protected override async tryCompleteAfterTimeout(run: ProvisioningRun): Promise<boolean> {
    return this.runWriterAuthority.persistForRun(run, () => super.tryCompleteAfterTimeout(run));
  }

  protected override handleStreamJsonMessage(
    run: ProvisioningRun,
    message: Record<string, unknown>
  ): Promise<void> {
    return this.runWriterAuthority.persistForRun(run, () =>
      super.handleStreamJsonMessage(run, message)
    );
  }

  protected override handleProvisioningTurnComplete(run: ProvisioningRun): Promise<void> {
    return this.runWriterAuthority.persistForRun(run, () =>
      super.handleProvisioningTurnComplete(run)
    );
  }

  protected override sendMessageToRun(
    run: ProvisioningRun,
    message: string,
    attachments?: { data: string; mimeType: string; filename?: string }[]
  ): Promise<void> {
    return this.runWriterAuthority.persistForRun(run, () =>
      super.sendMessageToRun(run, message, attachments)
    );
  }

  protected override injectGeminiPostLaunchHydration(run: ProvisioningRun): Promise<void> {
    return this.runWriterAuthority.persistForRun(run, () =>
      super.injectGeminiPostLaunchHydration(run)
    );
  }

  protected override injectPostCompactReminder(run: ProvisioningRun): Promise<void> {
    return this.runWriterAuthority.persistForRun(run, () => super.injectPostCompactReminder(run));
  }

  override relayLeadInboxMessages(teamNameOrRun: string | ProvisioningRun): Promise<number> {
    if (typeof teamNameOrRun === 'string') {
      if (!this.runWriterAuthority.isConfigured()) {
        return super.relayLeadInboxMessages(teamNameOrRun);
      }
      const runId = this.runTracking.getTrackedRunId(teamNameOrRun);
      const run = runId ? this.runs.get(runId) : null;
      return run
        ? this.runWriterAuthority.persistForRun(run, () =>
            super.relayLeadInboxMessages(teamNameOrRun)
          )
        : Promise.resolve(0);
    }
    return this.runWriterAuthority.persistForRun(teamNameOrRun, () =>
      super.relayLeadInboxMessages(teamNameOrRun.teamName)
    );
  }

  protected override cleanupRun(run: ProvisioningRun): void {
    super.cleanupRun(run);
    this.runWriterAuthority.cleaned(run);
  }

  protected override persistLaunchStateSnapshot(
    run: ProvisioningRun,
    phase?: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.runWriterAuthority.persistForRun(run, () =>
      super.persistLaunchStateSnapshot(run, phase)
    );
  }

  setRuntimeRecoveryFailureObserver(
    observer: ((failure: LeadRuntimeFailureObservation) => Promise<void>) | null
  ): void {
    this.runtimeFailureObservationBoundary.setObserver(observer);
  }

  protected observeRuntimeFailure(
    run: ProvisioningRun,
    failure: RuntimeFailureObservationInput
  ): Promise<void> {
    return this.runtimeFailureObservationBoundary.observe(run, this.getRunLeadName(run), failure);
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
    return this.runWriterAuthority.start(
      request.teamName,
      onProgress,
      async (report) => {
        await this.waitForOpenCodeAggregatePrimaryRestart(request.teamName);
        await this.waitForMemberLifecycleOperations(request.teamName);
        return this.requestAdmissionBoundary.createTeam(request, report);
      },
      (runId) => this.runs.has(runId)
    );
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return this.runWriterAuthority.start(
      request.teamName,
      onProgress,
      async (report) => {
        await this.waitForOpenCodeAggregatePrimaryRestart(request.teamName);
        await this.waitForMemberLifecycleOperations(request.teamName);
        return this.requestAdmissionBoundary.launchTeam(request, report);
      },
      (runId) => this.runs.has(runId)
    );
  }
}
