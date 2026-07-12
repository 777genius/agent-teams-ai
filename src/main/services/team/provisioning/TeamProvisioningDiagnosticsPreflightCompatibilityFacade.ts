import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { type TeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { type OpenCodePromptDeliveryLedgerRecord } from '../opencode/delivery/OpenCodePromptDeliveryLedger';

import { getSystemLocale } from './TeamProvisioningAgentLanguage';
import { type TeamProvisioningBootstrapTranscriptFacade } from './TeamProvisioningBootstrapTranscriptFacade';
import { readTeamProvisioningClaudeLogs } from './TeamProvisioningClaudeLogs';
import { getCliHelpOutputWithProvisioningPorts } from './TeamProvisioningCliHelpOutputPortsFactory';
import {
  notifyAliveTeamsAboutLanguageChangeWithService,
  type TeamProvisioningLanguageChangeNotificationServiceHost,
} from './TeamProvisioningLanguageChangeNotification';
import { type TeamProvisioningLaunchIdentityBoundary } from './TeamProvisioningLaunchIdentityBoundaryFactory';
import { type TeamProvisioningLiveLeadMessagePortsBoundary } from './TeamProvisioningLiveLeadMessagePortsFactory';
import {
  type OpenCodeMemberInboxDeliveryWakePorts,
  scheduleOpenCodeMemberInboxDeliveryWakeWithPorts,
} from './TeamProvisioningOpenCodeMemberInboxRelay';
import { type OpenCodeRuntimeControlAck } from './TeamProvisioningOpenCodeRuntimeCheckin';
import {
  getOpenCodeMemberDeliveryBusyStatus as getOpenCodeMemberDeliveryBusyStatusWithPorts,
  type OpenCodeDeliveryIdentityResolution,
  type OpenCodeMemberDeliveryBusyStatusPorts,
  tryGetActiveOpenCodePromptDeliveryRecord as tryGetActiveOpenCodePromptDeliveryRecordWithPorts,
} from './TeamProvisioningOpenCodeRuntimeDelivery';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost,
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFromService,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryServiceHost,
} from './TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import {
  createTeamProvisioningOpenCodeRuntimePermissionAnswerBoundary,
  type TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary,
} from './TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary';
import { type TeamProvisioningPrepareFacade } from './TeamProvisioningPrepareFacade';
import { type CliHelpOutputCache } from './TeamProvisioningProviderPreflight';
import { type TeamProvisioningProviderRuntimeFacade } from './TeamProvisioningProviderRuntimeFacade';
import { type RetainedClaudeLogsSnapshot } from './TeamProvisioningRetainedLogs';
import { type ProvisioningRun, VERIFY_TIMEOUT_MS } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import {
  planRuntimeLanesOrThrow as planRuntimeLanesOrThrowHelper,
  shouldRouteOpenCodeToRuntimeAdapter as shouldRouteOpenCodeToRuntimeAdapterHelper,
} from './TeamProvisioningRuntimeBootstrapDelivery';
import {
  buildTeamRuntimeLaunchArgsPlan as buildTeamRuntimeLaunchArgsPlanHelper,
  type BuildTeamRuntimeLaunchArgsPlanInput,
  type RuntimeProviderLaunchFacts,
  type TeamRuntimeLaunchArgsPlan,
  type ValidConfigProbeResult,
} from './TeamProvisioningRuntimeLaunchSelection';
import {
  buildRuntimeTurnSettledHookSettingsArgs as buildRuntimeTurnSettledHookSettingsArgsHelper,
  buildRuntimeTurnSettledHookSettingsObject as buildRuntimeTurnSettledHookSettingsObjectHelper,
  type RuntimeTurnSettledEnvironmentProvider,
  type RuntimeTurnSettledHookSettingsProvider,
} from './TeamProvisioningRuntimeTurnSettledPlanning';
import { type TeamProvisioningRunTrackingDeliveryHelper } from './TeamProvisioningRunTrackingDelivery';
import { TeamProvisioningStatusQueryCompatibilityFacade } from './TeamProvisioningStatusQueryCompatibilityFacade';
import { type TeamProvisioningToolApprovalFacade } from './TeamProvisioningToolApprovalFacade';
import { type TeamProvisioningTransientRunState } from './TeamProvisioningTransientRunState';
import { type TeamProvisioningVerificationProbePorts } from './TeamProvisioningVerificationProbePortsFactory';

import type { ProvisioningEnvResolution } from './TeamProvisioningEnvBuilder';
import type {
  InboxMessage,
  ProviderModelLaunchIdentity,
  TaskRef,
  TeamCreateRequest,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  ToolApprovalEvent,
  ToolApprovalSettings,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export abstract class TeamProvisioningDiagnosticsPreflightCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningStatusQueryCompatibilityFacade<TRun> {
  protected abstract readonly launchIdentityBoundary: TeamProvisioningLaunchIdentityBoundary;
  protected abstract readonly runtimeLaneCoordinator: Pick<
    TeamRuntimeLaneCoordinator,
    'planProvisioningMembers'
  >;
  protected abstract readonly runTracking: Pick<
    TeamProvisioningRunTrackingDeliveryHelper<TRun>,
    'canDeliverToOpenCodeRuntimeForTeam' | 'getAliveRunId' | 'getAliveTeamNames' | 'getTrackedRunId'
  >;
  protected abstract readonly runs: ReadonlyMap<string, TRun>;
  protected abstract readonly retainedClaudeLogsByTeam: Map<string, RetainedClaudeLogsSnapshot>;
  protected abstract readonly bootstrapTranscriptFacade: Pick<
    TeamProvisioningBootstrapTranscriptFacade,
    'getPersistedTranscriptClaudeLogs'
  >;
  protected abstract readonly prepareFacade: TeamProvisioningPrepareFacade;
  protected abstract readonly providerRuntime: TeamProvisioningProviderRuntimeFacade;
  protected abstract readonly verificationProbePorts: TeamProvisioningVerificationProbePorts<TRun>;
  protected abstract readonly transientRunState: Pick<
    TeamProvisioningTransientRunState,
    'appendCliLogs'
  >;
  protected abstract readonly helpOutputCache: CliHelpOutputCache;
  protected abstract readonly shutdownCoordination: { getShutdownTrackedTeamNames(): string[] };
  protected abstract readonly toolApprovalFacade: Pick<
    TeamProvisioningToolApprovalFacade<TRun>,
    | 'dismissApprovalNotification'
    | 'answerRuntimeToolApproval'
    | 'respondToToolApproval'
    | 'setMainWindow'
    | 'setToolApprovalEventEmitter'
    | 'updateToolApprovalSettings'
  >;
  protected abstract readonly liveLeadMessagePortsBoundary: Pick<
    TeamProvisioningLiveLeadMessagePortsBoundary<TRun>,
    'getCurrentLeadSessionId' | 'getLiveLeadProcessMessages' | 'pruneLiveLeadMessagesForCleanedRun'
  >;
  protected abstract readonly openCodeRuntimeControlApi: {
    recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
    deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
    recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
    recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
    answerOpenCodeRuntimePermission(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  };
  protected abstract readonly openCodeRuntimeDeliveryBoundaryHost: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<TRun>;
  protected abstract readonly inboxReader: OpenCodeMemberDeliveryBusyStatusPorts['inboxReader'];
  protected abstract readonly openCodePromptDeliveryWatchdogScheduler: OpenCodeMemberInboxDeliveryWakePorts['watchdogScheduler'];

  private languageChangeInFlight: Promise<void> = Promise.resolve();
  private readonly cliHelpOutputCacheByCwd = new Map<string, CliHelpOutputCache>();
  private readonly cliHelpOutputInFlightByCwd = new Map<string, Promise<string>>();

  protected abstract scheduleOpenCodePromptDeliveryWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void;
  protected abstract resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeDeliveryIdentityResolution>;
  protected abstract tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  protected abstract tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean>;
  protected abstract getOpenCodeAgendaSyncRecoveryBypassMessageIds(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    taskRefs?: TaskRef[];
    foregroundMessages: InboxMessage[];
  }): Promise<Set<string>>;

  protected get runtimeTurnSettledHookSettingsProvider(): RuntimeTurnSettledHookSettingsProvider | null {
    return this.appShellBoundary.getRuntimeTurnSettledHookSettingsProvider();
  }

  protected get runtimeTurnSettledEnvironmentProvider(): RuntimeTurnSettledEnvironmentProvider | null {
    return this.appShellBoundary.getRuntimeTurnSettledEnvironmentProvider();
  }

  protected async buildTeamRuntimeLaunchArgsPlan(
    input: BuildTeamRuntimeLaunchArgsPlanInput
  ): Promise<TeamRuntimeLaunchArgsPlan> {
    return buildTeamRuntimeLaunchArgsPlanHelper(input, {
      buildRuntimeTurnSettledHookSettingsArgs: (providerId) =>
        buildRuntimeTurnSettledHookSettingsArgsHelper(
          { providerId },
          {
            hookSettingsProvider: this.runtimeTurnSettledHookSettingsProvider,
            logger,
          }
        ),
      buildRuntimeTurnSettledHookSettingsObject: (providerId) =>
        buildRuntimeTurnSettledHookSettingsObjectHelper(
          { providerId },
          {
            hookSettingsProvider: this.runtimeTurnSettledHookSettingsProvider,
            logger,
          }
        ),
    });
  }

  protected async readRuntimeProviderLaunchFacts(params: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
    limitContext?: boolean;
  }): Promise<RuntimeProviderLaunchFacts> {
    return this.launchIdentityBoundary.readRuntimeProviderLaunchFacts(params);
  }

  protected async resolveAndValidateLaunchIdentity(params: {
    claudePath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    request: Pick<
      TeamCreateRequest,
      'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
    >;
    effectiveMembers: TeamCreateRequest['members'];
    providerArgsByProvider?: Map<TeamProviderId, string[]>;
  }): Promise<ProviderModelLaunchIdentity> {
    return this.launchIdentityBoundary.resolveAndValidateLaunchIdentity(params);
  }

  protected async resolveDirectMemberLaunchIdentity(input: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    provisioningEnv: ProvisioningEnvResolution;
    memberSpec: TeamCreateRequest['members'][number];
    run: TRun;
  }): Promise<ProviderModelLaunchIdentity> {
    return this.launchIdentityBoundary.resolveDirectMemberLaunchIdentity({
      ...input,
      requestLimitContext: input.run.request.limitContext,
    });
  }

  async getClaudeLogs(
    teamName: string,
    query?: { offset?: number; limit?: number }
  ): Promise<{ lines: string[]; total: number; hasMore: boolean; updatedAt?: string }> {
    return readTeamProvisioningClaudeLogs(teamName, query, {
      runTracking: this.runTracking,
      runs: this.runs,
      retainedClaudeLogsByTeam: this.retainedClaudeLogsByTeam,
      readPersistedTranscriptClaudeLogs: (candidateTeamName) =>
        this.getPersistedTranscriptClaudeLogs(candidateTeamName),
    });
  }

  getAliveTeamNames(): string[] {
    return this.runTracking.getAliveTeamNames();
  }

  protected getPersistedTranscriptClaudeLogs(
    teamName: string
  ): Promise<RetainedClaudeLogsSnapshot | null> {
    return this.bootstrapTranscriptFacade.getPersistedTranscriptClaudeLogs(teamName);
  }

  protected appendCliLogs(run: TRun, stream: 'stdout' | 'stderr', text: string): void {
    this.transientRunState.appendCliLogs(run, stream, text);
  }

  async warmup(): Promise<void> {
    await this.prepareFacade.warmup();
  }

  async prepareForProvisioning(
    cwd?: string,
    opts?: {
      forceFresh?: boolean;
      providerId?: TeamProviderId;
      providerIds?: TeamProviderId[];
      modelIds?: string[];
      modelChecks?: TeamProvisioningModelCheckRequest[];
      limitContext?: boolean;
      modelVerificationMode?: TeamProvisioningModelVerificationMode;
    }
  ): Promise<TeamProvisioningPrepareResult> {
    return this.prepareFacade.prepareForProvisioning(cwd, opts);
  }

  protected materializeEffectiveTeamMemberSpecs(
    params: Parameters<TeamProvisioningPrepareFacade['materializeEffectiveTeamMemberSpecs']>[0]
  ): ReturnType<TeamProvisioningPrepareFacade['materializeEffectiveTeamMemberSpecs']> {
    return this.prepareFacade.materializeEffectiveTeamMemberSpecs(params);
  }

  protected resolveOpenCodeMemberWorkspacesForRuntime(
    params: Parameters<
      TeamProvisioningPrepareFacade['resolveOpenCodeMemberWorkspacesForRuntime']
    >[0]
  ): ReturnType<TeamProvisioningPrepareFacade['resolveOpenCodeMemberWorkspacesForRuntime']> {
    return this.prepareFacade.resolveOpenCodeMemberWorkspacesForRuntime(params);
  }

  protected shouldRouteOpenCodeToRuntimeAdapter(request: {
    providerId?: TeamProviderId;
    members?: readonly { providerId?: TeamProviderId; provider?: TeamProviderId }[];
  }): boolean {
    return shouldRouteOpenCodeToRuntimeAdapterHelper(
      request,
      this.appShellBoundary.getOpenCodeRuntimeAdapter() !== null
    );
  }

  protected planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ): TeamRuntimeLanePlan {
    return planRuntimeLanesOrThrowHelper(this.runtimeLaneCoordinator, {
      leadProviderId,
      members,
      baseCwd,
      hasOpenCodeRuntimeAdapter: this.appShellBoundary.getOpenCodeRuntimeAdapter() !== null,
    });
  }

  getCurrentRunId(teamName: string): string | null {
    return this.runTracking.getAliveRunId(teamName);
  }

  protected canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean {
    return this.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName);
  }

  hasActiveTeamRuntimes(): boolean {
    return this.shutdownCoordination.getShutdownTrackedTeamNames().length > 0;
  }

  async notifyLanguageChange(newLangCode: string): Promise<void> {
    this.languageChangeInFlight = this.languageChangeInFlight.then(() =>
      notifyAliveTeamsAboutLanguageChangeWithService(
        newLangCode,
        this as unknown as TeamProvisioningLanguageChangeNotificationServiceHost,
        {
          getSystemLocale,
          resolveLanguageName,
          logger,
        }
      )
    );
    return this.languageChangeInFlight;
  }

  setToolApprovalEventEmitter(emitter: (event: ToolApprovalEvent) => void): void {
    this.toolApprovalFacade.setToolApprovalEventEmitter(emitter);
  }

  setMainWindow(win: import('electron').BrowserWindow | null): void {
    this.toolApprovalFacade.setMainWindow(win);
  }

  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
    this.toolApprovalFacade.updateToolApprovalSettings(teamName, settings);
  }

  getLiveLeadProcessMessages(teamName: string): InboxMessage[] {
    return this.liveLeadMessagePortsBoundary.getLiveLeadProcessMessages(teamName);
  }

  protected pruneLiveLeadMessagesForCleanedRun(run: TRun): void {
    this.liveLeadMessagePortsBoundary.pruneLiveLeadMessagesForCleanedRun(run);
  }

  getCurrentLeadSessionId(teamName: string): string | null {
    return this.liveLeadMessagePortsBoundary.getCurrentLeadSessionId(teamName);
  }

  async recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.openCodeRuntimeControlApi.recordOpenCodeRuntimeBootstrapCheckin(raw);
  }

  async deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.openCodeRuntimeControlApi.deliverOpenCodeRuntimeMessage(raw);
  }

  async recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.openCodeRuntimeControlApi.recordOpenCodeRuntimeTaskEvent(raw);
  }

  async recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.openCodeRuntimeControlApi.recordOpenCodeRuntimeHeartbeat(raw);
  }

  async answerOpenCodeRuntimePermission(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.openCodeRuntimeControlApi.answerOpenCodeRuntimePermission(raw);
  }

  protected createOpenCodeRuntimeDeliveryBoundaryHost(): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<TRun> {
    return createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFromService<TRun>(
      this as unknown as TeamProvisioningOpenCodeRuntimeDeliveryBoundaryServiceHost<TRun>
    );
  }

  protected createOpenCodeRuntimeDeliveryBoundary(): TeamProvisioningOpenCodeRuntimeDeliveryBoundary<TRun> {
    return createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost<TRun>(
      this.openCodeRuntimeDeliveryBoundaryHost,
      {
        getTeamsBasePath,
        nowIso,
        logger,
      }
    );
  }

  protected createOpenCodeRuntimePermissionAnswerBoundary(): TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary {
    return createTeamProvisioningOpenCodeRuntimePermissionAnswerBoundary({
      answerRuntimeToolApproval: (entry, allow, message) =>
        this.toolApprovalFacade.answerRuntimeToolApproval(entry, allow, message),
      nowIso,
    });
  }

  protected createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): ReturnType<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundary<TRun>['createOpenCodePromptDeliveryLedger']
  > {
    return this.createOpenCodeRuntimeDeliveryBoundary().createOpenCodePromptDeliveryLedger(
      teamName,
      laneId
    );
  }

  async getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): ReturnType<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundary<TRun>['getOpenCodeRuntimeDeliveryStatus']
  > {
    return this.createOpenCodeRuntimeDeliveryBoundary().getOpenCodeRuntimeDeliveryStatus(
      teamName,
      messageId
    );
  }

  protected async tryGetActiveOpenCodePromptDeliveryRecord(input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    return tryGetActiveOpenCodePromptDeliveryRecordWithPorts(input, {
      teamsBasePath: getTeamsBasePath(),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        this.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoveryInput) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoveryInput),
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.createOpenCodePromptDeliveryLedger(teamName, laneId),
    });
  }

  async getOpenCodeMemberDeliveryBusyStatus(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    workSyncIntentKey?: string;
    taskRefs?: TaskRef[];
  }): Promise<{
    busy: boolean;
    reason?: string;
    retryAfterIso?: string;
    activeMessageId?: string;
    activeMessageKind?: string | null;
  }> {
    return getOpenCodeMemberDeliveryBusyStatusWithPorts(input, {
      teamsBasePath: getTeamsBasePath(),
      isOpenCodeRuntimeRecipient: (teamName, memberName) =>
        this.isOpenCodeRuntimeRecipient(teamName, memberName),
      inboxReader: this.inboxReader,
      getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
        this.getOpenCodeAgendaSyncRecoveryBypassMessageIds(bypassInput),
      tryGetActiveOpenCodePromptDeliveryRecord: (activeInput) =>
        this.tryGetActiveOpenCodePromptDeliveryRecord(activeInput),
      scheduleOpenCodeMemberInboxDeliveryWake: (wakeInput) =>
        this.scheduleOpenCodeMemberInboxDeliveryWake(wakeInput),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        this.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (recoveryInput) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(recoveryInput),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoveryInput) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoveryInput),
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.createOpenCodePromptDeliveryLedger(teamName, laneId),
    });
  }

  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void {
    this.scheduleOpenCodeMemberInboxDeliveryWakeInternal(input);
  }

  private scheduleOpenCodeMemberInboxDeliveryWakeInternal(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void {
    scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(input, {
      watchdogScheduler: this.openCodePromptDeliveryWatchdogScheduler,
      scheduleWake: (wakeInput) => this.scheduleOpenCodePromptDeliveryWatchdog(wakeInput),
    });
  }

  async recoverOpenCodeRuntimeDeliveryJournal(teamName: string): Promise<{ recovered: true }> {
    return this.createOpenCodeRuntimeDeliveryBoundary().recoverOpenCodeRuntimeDeliveryJournal(
      teamName
    );
  }

  /** Dismiss the OS notification for a resolved/dismissed approval. */
  dismissApprovalNotification(requestId: string): void {
    this.toolApprovalFacade.dismissApprovalNotification(requestId);
  }

  /**
   * Respond to a pending tool approval - sends control_response to CLI stdin.
   * Validates runId match and requestId existence before writing.
   */
  async respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    await this.toolApprovalFacade.respondToToolApproval(teamName, runId, requestId, allow, message);
  }

  protected async waitForValidConfig(
    run: TRun,
    timeoutMs: number = VERIFY_TIMEOUT_MS
  ): Promise<ValidConfigProbeResult> {
    return this.verificationProbePorts.waitForValidConfig(run, timeoutMs);
  }

  protected async waitForTeamInList(teamName: string, run?: TRun): Promise<boolean> {
    return this.verificationProbePorts.waitForTeamInList(teamName, run);
  }

  protected async waitForMissingInboxes(run: TRun): Promise<string[]> {
    return this.verificationProbePorts.waitForMissingInboxes(run);
  }

  protected async tryCompleteAfterTimeout(run: TRun): Promise<boolean> {
    return this.verificationProbePorts.tryCompleteAfterTimeout(run);
  }

  protected async pathExists(filePath: string): Promise<boolean> {
    return this.verificationProbePorts.pathExists(filePath);
  }

  async getCliHelpOutput(cwd?: string): Promise<string> {
    const targetCwd = path.resolve(cwd ?? process.cwd());
    const existingInFlight = this.cliHelpOutputInFlightByCwd.get(targetCwd);
    if (existingInFlight) {
      return existingInFlight;
    }

    let cache = this.cliHelpOutputCacheByCwd.get(targetCwd);
    if (!cache) {
      cache =
        this.cliHelpOutputCacheByCwd.size === 0
          ? this.helpOutputCache
          : { output: null, cachedAtMs: 0 };
      this.cliHelpOutputCacheByCwd.set(targetCwd, cache);
    }

    const inFlight = getCliHelpOutputWithProvisioningPorts({
      cwd: targetCwd,
      cache,
      getCachedOrProbeResult: (targetCwd, providerId) =>
        this.prepareFacade.getCachedOrProbeResult(targetCwd, providerId),
      providerRuntime: this.providerRuntime,
    });
    this.cliHelpOutputInFlightByCwd.set(targetCwd, inFlight);

    try {
      return await inFlight;
    } finally {
      if (this.cliHelpOutputInFlightByCwd.get(targetCwd) === inFlight) {
        this.cliHelpOutputInFlightByCwd.delete(targetCwd);
      }
    }
  }
}
