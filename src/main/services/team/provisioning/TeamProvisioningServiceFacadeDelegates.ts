import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { type ParsedPermissionRequest, type PermissionSuggestion } from '@shared/utils/inboxNoise';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { resolve as resolvePath } from 'path';

import { type OpenCodeMemberIdentityResolution } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import { type TeamRuntimeStopInput } from '../runtime';

import { TeamProvisioningBootstrapEvidenceCompatibilityFacade } from './TeamProvisioningBootstrapEvidenceCompatibilityFacade';
import { type TeamProvisioningClaudePermissionSettingsDelegation } from './TeamProvisioningClaudePermissionSettingsDelegation';
import { type DeterministicCreateRunFlowPorts } from './TeamProvisioningCreateDeterministicRunFlow';
import {
  createTeamProvisioningCreateDeterministicRunFlowPortsFromService,
  type TeamProvisioningCreateDeterministicRunFlowServiceHost,
} from './TeamProvisioningCreateDeterministicRunFlowPortsFactory';
import { type DeterministicCreateSetupFlowPorts } from './TeamProvisioningCreateDeterministicSetupFlow';
import {
  createTeamProvisioningCreateDeterministicSetupFlowPortsFromService,
  type TeamProvisioningCreateDeterministicSetupFlowServiceHost,
} from './TeamProvisioningCreateDeterministicSetupFlowPortsFactory';
import { type DeterministicCreateSpawnFlowPorts } from './TeamProvisioningCreateDeterministicSpawnFlow';
import { type TeamProvisioningCreateDeterministicSpawnFlowBoundary } from './TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import {
  startProvisioningFilesystemMonitor,
  stopProvisioningFilesystemMonitor,
} from './TeamProvisioningFilesystemMonitor';
import { type TeamProvisioningIdlePromptInjectionBoundary } from './TeamProvisioningIdlePromptInjectionPortsFactory';
import { markTeamInboxMessagesReadWithDefaults } from './TeamProvisioningInboxPersistence';
import { getLeadRelayReadCommitBatch as getLeadRelayReadCommitBatchHelper } from './TeamProvisioningInboxRelayPolicy';
import { getRunTrackedCwdFromRun } from './TeamProvisioningLeadRunDerivation';
import { type TeamProvisioningMemberWorkSyncProofBoundary } from './TeamProvisioningMemberWorkSyncProofBoundaryFactory';
import {
  persistTeamProvisioningInboxMessage,
  persistTeamProvisioningSentMessage,
} from './TeamProvisioningMessagePersistence';
import { type TeamProvisioningMixedSecondaryLaneWiring } from './TeamProvisioningMixedSecondaryLaneWiring';
import {
  getOpenCodeAgendaSyncRecoveryBypassMessageIdsWithService,
  type OpenCodeAgendaSyncRecoveryBypassServiceHost,
} from './TeamProvisioningOpenCodeAgendaSyncRecovery';
import {
  createOpenCodeTeamThroughRuntimeAdapterFlow,
  launchOpenCodeTeamThroughRuntimeAdapterFlow,
  type OpenCodeRuntimeAdapterTeamFlowPorts,
} from './TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';
import {
  createOpenCodeRuntimeAdapterTeamFlowPortsFromService,
  type TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost,
} from './TeamProvisioningOpenCodeRuntimeAdapterTeamFlowPortsFactory';
import { type TeamProvisioningOpenCodeRuntimeRecoveryFacade } from './TeamProvisioningOpenCodeRuntimeRecoveryFacade';
import {
  type OpenCodeRuntimeLaneIdResolutionServiceHost,
  resolveOpenCodeRuntimeLaneIdWithService,
} from './TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import { type TeamProvisioningOpenCodeSecondaryBriefingBuilder } from './TeamProvisioningOpenCodeSecondaryBriefingBuilder';
import { writeOpenCodeTeamConfig } from './TeamProvisioningOpenCodeTeamConfigWriter';
import {
  handleProvisioningProcessExit,
  type TeamProvisioningProcessExitPorts,
} from './TeamProvisioningProcessExit';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { updateProgress } from './TeamProvisioningRunProgress';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import { type TeamProvisioningToolApprovalFacade } from './TeamProvisioningToolApprovalFacade';
import { type TeamProvisioningTransientRunState } from './TeamProvisioningTransientRunState';

import type {
  InboxMessage,
  PersistedTeamLaunchSnapshot,
  TaskRef,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const { createController } = agentTeamsControllerModule;

export abstract class TeamProvisioningServiceFacadeDelegates extends TeamProvisioningBootstrapEvidenceCompatibilityFacade<ProvisioningRun> {
  protected abstract readonly openCodeRuntimeRecoveryFacade: TeamProvisioningOpenCodeRuntimeRecoveryFacade;
  protected abstract readonly toolApprovalFacade: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  protected abstract readonly memberWorkSyncProofBoundary: TeamProvisioningMemberWorkSyncProofBoundary;
  protected abstract readonly transientRunState: TeamProvisioningTransientRunState;
  protected abstract readonly deterministicCreateSpawnFlowBoundary: TeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>;
  protected abstract readonly openCodeLaunchWiring: {
    runOpenCodeWorktreeRootAggregateLaunch(input: {
      request: TeamCreateRequest | TeamLaunchRequest;
      members: TeamCreateRequest['members'];
      lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
      prompt: string;
      sourceWarning?: string;
      onProgress: (progress: TeamProvisioningProgress) => void;
    }): Promise<TeamLaunchResponse>;
    runOpenCodeTeamRuntimeAdapterLaunch(input: {
      request: TeamCreateRequest | TeamLaunchRequest;
      members: TeamCreateRequest['members'];
      prompt: string;
      sourceWarning?: string;
      onProgress: (progress: TeamProvisioningProgress) => void;
    }): Promise<TeamLaunchResponse>;
  };
  protected abstract readonly openCodeSecondaryBriefingBuilder: TeamProvisioningOpenCodeSecondaryBriefingBuilder;
  protected abstract readonly mixedSecondaryLaneWiring: TeamProvisioningMixedSecondaryLaneWiring<ProvisioningRun>;
  protected abstract readonly idlePromptInjectionBoundary: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  protected abstract readonly claudePermissionSettingsDelegation: TeamProvisioningClaudePermissionSettingsDelegation;
  protected abstract readonly processExitPorts: TeamProvisioningProcessExitPorts<ProvisioningRun>;

  protected get openCodeRuntimeRecoveryIdentity(): TeamProvisioningOpenCodeRuntimeRecoveryFacade['openCodeRuntimeRecoveryIdentity'] {
    return this.openCodeRuntimeRecoveryFacade.openCodeRuntimeRecoveryIdentity;
  }

  protected async resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution> {
    return await this.openCodeRuntimeRecoveryFacade.resolveOpenCodeMemberDeliveryIdentity(
      teamName,
      memberName
    );
  }

  protected writeOpenCodeTeamConfig(
    launchRequest: Parameters<typeof writeOpenCodeTeamConfig>[0],
    members: Parameters<typeof writeOpenCodeTeamConfig>[1]
  ): ReturnType<typeof writeOpenCodeTeamConfig> {
    return writeOpenCodeTeamConfig(launchRequest, members);
  }

  protected async respondToTeammatePermission(
    run: Parameters<
      TeamProvisioningToolApprovalFacade<ProvisioningRun>['respondToTeammatePermission']
    >[0]['run'],
    agentId: string,
    requestId: string,
    allow: boolean,
    message?: string,
    permissionSuggestions?: PermissionSuggestion[],
    toolName?: string,
    toolInput?: Record<string, unknown>
  ): Promise<void> {
    await this.toolApprovalFacade.respondToTeammatePermission({
      run,
      agentId,
      requestId,
      allow,
      message,
      permissionSuggestions,
      toolName,
      toolInput,
    });
  }

  protected hasAcceptedLeadWorkSyncReport(input: {
    teamName: string;
    leadName: string;
  }): Promise<boolean> {
    return this.memberWorkSyncProofBoundary.hasAcceptedLeadWorkSyncReport(input);
  }

  protected scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean> {
    return this.memberWorkSyncProofBoundary.scheduleLeadProofMissingWorkSyncRecovery(input);
  }

  protected getLeadRelayReadCommitBatch(
    input: Omit<
      Parameters<typeof getLeadRelayReadCommitBatchHelper>[0],
      'hasAcceptedLeadWorkSyncReport' | 'scheduleLeadProofMissingWorkSyncRecovery'
    >
  ): ReturnType<typeof getLeadRelayReadCommitBatchHelper> {
    return getLeadRelayReadCommitBatchHelper({
      ...input,
      hasAcceptedLeadWorkSyncReport: (reportInput) =>
        this.hasAcceptedLeadWorkSyncReport(reportInput),
      scheduleLeadProofMissingWorkSyncRecovery: (recoveryInput) =>
        this.scheduleLeadProofMissingWorkSyncRecovery(recoveryInput),
    });
  }

  protected async tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean> {
    return await this.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
      input
    );
  }

  protected async tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  }): Promise<boolean> {
    return await this.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
      input
    );
  }

  protected async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    return await this.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
      input
    );
  }

  protected async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean> {
    return await this.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
      input
    );
  }

  protected async tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean } = {}
  ): Promise<string[]> {
    return await this.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
      teamName,
      options
    );
  }

  protected async resolveOpenCodeRuntimeLaneId(params: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string> {
    return resolveOpenCodeRuntimeLaneIdWithService(
      params,
      this as unknown as OpenCodeRuntimeLaneIdResolutionServiceHost
    );
  }

  protected clearSameTeamRetryTimers(teamName: string): void {
    this.transientRunState.clearSameTeamRetryTimers(teamName);
  }

  protected clearLeadInboxFollowUpRelayTimer(teamName: string): void {
    this.transientRunState.clearLeadInboxFollowUpRelayTimer(teamName);
  }

  protected scheduleLeadInboxFollowUpRelay(teamName: string): void {
    this.transientRunState.scheduleLeadInboxFollowUpRelay(teamName);
  }

  protected resetTeamScopedTransientStateForNewRun(teamName: string): void {
    this.transientRunState.resetTeamScopedTransientStateForNewRun(teamName);
  }

  protected async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    return this.transientRunState.withTeamLock(teamName, fn);
  }

  protected persistSentMessage(teamName: string, message: InboxMessage): void {
    persistTeamProvisioningSentMessage(teamName, message, {
      createController: (input) => createController(input),
      getClaudeBasePath,
      logger,
    });
  }

  protected persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void {
    persistTeamProvisioningInboxMessage(teamName, recipient, message, {
      createController: (input) => createController(input),
      getClaudeBasePath,
      logger,
      emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName, message) =>
        this.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message),
    });
  }

  protected getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null {
    return getRunTrackedCwdFromRun(run, resolvePath);
  }

  protected createOpenCodeRuntimeAdapterTeamFlowPorts(): OpenCodeRuntimeAdapterTeamFlowPorts {
    return createOpenCodeRuntimeAdapterTeamFlowPortsFromService(
      this as unknown as TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost,
      {
        warn: (message) => {
          logger.warn(message);
        },
      }
    );
  }

  protected createDeterministicCreateSetupFlowPorts(): DeterministicCreateSetupFlowPorts<MixedSecondaryRuntimeLaneState> {
    return createTeamProvisioningCreateDeterministicSetupFlowPortsFromService(
      this as unknown as TeamProvisioningCreateDeterministicSetupFlowServiceHost,
      { logger }
    );
  }

  protected createDeterministicCreateRunFlowPorts(): DeterministicCreateRunFlowPorts<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  > {
    return createTeamProvisioningCreateDeterministicRunFlowPortsFromService(
      this as unknown as TeamProvisioningCreateDeterministicRunFlowServiceHost
    );
  }

  protected createDeterministicCreateSpawnFlowPorts(input: {
    request: TeamCreateRequest;
    claudePath: string;
    shellEnv: NodeJS.ProcessEnv;
  }): DeterministicCreateSpawnFlowPorts<ProvisioningRun> {
    return this.deterministicCreateSpawnFlowBoundary.createSpawnFlowPorts(input);
  }

  protected async createOpenCodeTeamThroughRuntimeAdapter(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    return createOpenCodeTeamThroughRuntimeAdapterFlow(
      request,
      onProgress,
      this.createOpenCodeRuntimeAdapterTeamFlowPorts()
    );
  }

  protected async launchOpenCodeTeamThroughRuntimeAdapter(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return launchOpenCodeTeamThroughRuntimeAdapterFlow(
      request,
      onProgress,
      this.createOpenCodeRuntimeAdapterTeamFlowPorts()
    );
  }

  protected async runOpenCodeWorktreeRootAggregateLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    return this.openCodeLaunchWiring.runOpenCodeWorktreeRootAggregateLaunch(input);
  }

  protected async runOpenCodeTeamRuntimeAdapterLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    return this.openCodeLaunchWiring.runOpenCodeTeamRuntimeAdapterLaunch(input);
  }

  protected async getOpenCodeAgendaSyncRecoveryBypassMessageIds(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    taskRefs?: TaskRef[];
    foregroundMessages: InboxMessage[];
  }): Promise<Set<string>> {
    return getOpenCodeAgendaSyncRecoveryBypassMessageIdsWithService(
      input,
      this as unknown as OpenCodeAgendaSyncRecoveryBypassServiceHost
    );
  }

  protected async markInboxMessagesRead(
    teamName: string,
    member: string,
    messages: { messageId: string }[]
  ): Promise<void> {
    await markTeamInboxMessagesReadWithDefaults({ teamName, member, messages });
  }

  protected async buildOpenCodeSecondaryAppManagedLaunchPrompt(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<string> {
    return this.openCodeSecondaryBriefingBuilder.buildOpenCodeSecondaryAppManagedLaunchPrompt({
      teamName: run.teamName,
      memberName: lane.member.name,
    });
  }

  protected async launchSingleMixedSecondaryLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void> {
    await this.mixedSecondaryLaneWiring.launchSingleMixedSecondaryLane(run, lane);
  }

  protected async stopSingleMixedSecondaryRuntimeLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: TeamRuntimeStopInput['reason']
  ): Promise<void> {
    await this.mixedSecondaryLaneWiring.stopSingleMixedSecondaryRuntimeLane(run, lane, reason);
  }

  protected launchQueuedMixedSecondaryLaneInBackground(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): void {
    this.mixedSecondaryLaneWiring.launchQueuedMixedSecondaryLaneInBackground(run, lane);
  }

  protected async launchMixedSecondaryLaneIfNeeded(
    run: ProvisioningRun,
    options: { waitForCompletion?: boolean } = {}
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.mixedSecondaryLaneWiring.launchMixedSecondaryLaneIfNeeded(run, options);
  }

  protected async injectPostCompactReminder(run: ProvisioningRun): Promise<void> {
    await this.idlePromptInjectionBoundary.injectPostCompactReminder(run);
  }

  protected async injectGeminiPostLaunchHydration(run: ProvisioningRun): Promise<void> {
    await this.idlePromptInjectionBoundary.injectGeminiPostLaunchHydration(run);
  }

  protected handleControlRequest(run: ProvisioningRun, msg: Record<string, unknown>): void {
    this.toolApprovalFacade.handleControlRequest(run, msg);
  }

  protected handleTeammatePermissionRequest(
    run: ProvisioningRun,
    perm: ParsedPermissionRequest,
    messageTimestamp: string
  ): void {
    this.toolApprovalFacade.handleTeammatePermissionRequest(run, perm, messageTimestamp);
  }

  protected async addPermissionRulesToSettings(
    settingsPath: string,
    toolNames: string[],
    behavior: string
  ): Promise<number> {
    return this.claudePermissionSettingsDelegation.addPermissionRulesToSettings(
      settingsPath,
      toolNames,
      behavior
    );
  }

  protected async seedLeadBootstrapPermissionRules(
    teamName: string,
    projectCwd: string
  ): Promise<void> {
    await this.claudePermissionSettingsDelegation.seedLeadBootstrapPermissionRules(
      teamName,
      projectCwd
    );
  }

  protected startFilesystemMonitor(run: ProvisioningRun, request: TeamCreateRequest): void {
    startProvisioningFilesystemMonitor(run, request, {
      updateProgress,
      getRegisteredTeamMemberNames: (teamName) => this.getRegisteredTeamMemberNames(teamName),
      handleProvisioningTurnComplete: (run) => this.handleProvisioningTurnComplete(run),
    });
  }

  protected stopFilesystemMonitor(run: ProvisioningRun): void {
    stopProvisioningFilesystemMonitor(run);
  }

  protected async handleProcessExit(run: ProvisioningRun, code: number | null): Promise<void> {
    await handleProvisioningProcessExit(run, code, this.processExitPorts);
  }
}
