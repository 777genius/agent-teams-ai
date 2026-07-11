import { createTeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { notifyTeamWatchScopeChanged } from '@main/services/infrastructure/teamWatchScope';
import { execCli, killProcessTree } from '@main/utils/childProcess';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type spawn } from 'child_process';
import { randomUUID } from 'crypto';

import {
  cleanupAnthropicTeamApiKeyHelperForTeam,
  cleanupAnthropicTeamApiKeyHelperMaterial,
} from '../runtime/anthropicTeamApiKeyHelper';
import { ProviderConnectionService } from '../runtime/ProviderConnectionService';

import { isOpenCodeServeCommand } from './opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { OpenCodePromptDeliveryFollowUpPolicy } from './opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import { type OpenCodePromptDeliveryWatchdogCoordinator } from './opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { type OpenCodePromptDeliveryWatchdogScheduler } from './opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { OpenCodeRuntimeDeliveryProofReader } from './opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import { type OpenCodeVisibleReplyProofService } from './opencode/delivery/OpenCodeVisibleReplyProofService';
import { scheduleStaleAnthropicTeamApiKeyHelperCleanup } from './provisioning/TeamProvisioningAnthropicApiKeyHelperCleanup';
import {
  createAppendDirectProcessRuntimeEventUseCase,
  createNodeAppendDirectProcessRuntimeEventUseCasePorts,
} from './provisioning/TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import { TeamProvisioningBootstrapEvidenceFacade } from './provisioning/TeamProvisioningBootstrapEvidenceFacade';
import { TeamProvisioningBootstrapTranscriptFacade } from './provisioning/TeamProvisioningBootstrapTranscriptFacade';
import {
  createTeamProvisioningCancellationBoundary,
  createTeamProvisioningCancellationBoundaryPortsFromService,
  type TeamProvisioningCancellationBoundary,
  type TeamProvisioningCancellationBoundaryServiceHost,
} from './provisioning/TeamProvisioningCancellationBoundary';
import { createTeamProvisioningClaudePermissionSettingsDelegation } from './provisioning/TeamProvisioningClaudePermissionSettingsDelegation';
import { type TeamProvisioningCompatibilityDelegation } from './provisioning/TeamProvisioningCompatibilityFacade';
import { TeamProvisioningConfigFacade } from './provisioning/TeamProvisioningConfigFacade';
import { type TeamProvisioningConfigTaskActivityBoundary } from './provisioning/TeamProvisioningConfigTaskActivityBoundary';
import { type TeamProvisioningCreateDeterministicSpawnFlowBoundary } from './provisioning/TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import { type ProvisioningEnvResolution } from './provisioning/TeamProvisioningEnvBuilder';
import { type TeamProvisioningIdlePromptInjectionBoundary } from './provisioning/TeamProvisioningIdlePromptInjectionPortsFactory';
import { type TeamProvisioningLaunchDeterministicFlowBoundary } from './provisioning/TeamProvisioningLaunchDeterministicFlowPortsFactory';
import { buildLaunchDiagnosticsFromRun } from './provisioning/TeamProvisioningLaunchDiagnostics';
import {
  createTeamProvisioningLaunchIdentityBoundary,
  type TeamProvisioningLaunchIdentityBoundary,
} from './provisioning/TeamProvisioningLaunchIdentityBoundaryFactory';
import { createTeamProvisioningLaunchNotificationsBoundary } from './provisioning/TeamProvisioningLaunchNotificationsBoundaryFactory';
import { type TeamProvisioningLaunchStateCompatibilityBoundary } from './provisioning/TeamProvisioningLaunchStateCompatibilityFacade';
import { getPersistedLaunchMemberNames } from './provisioning/TeamProvisioningLaunchStateProjection';
import { TeamProvisioningLaunchStateStoreBoundary } from './provisioning/TeamProvisioningLaunchStateStoreBoundary';
import { type TeamProvisioningLeadInboxRelayCompatibilityFacade } from './provisioning/TeamProvisioningLeadInboxRelayCompatibilityFacade';
import {
  createTeamProvisioningLiveLaunchSnapshotBoundaryFromService,
  type TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost,
} from './provisioning/TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import {
  type MemberLifecycleOperation,
  TeamProvisioningMemberLifecycleController,
} from './provisioning/TeamProvisioningMemberLifecycle';
import { type TeamProvisioningMemberLifecyclePublicFacade } from './provisioning/TeamProvisioningMemberLifecycleCompatibilityFacade';
import { createTeamProvisioningMemberLifecycleHostFromPortGroups } from './provisioning/TeamProvisioningMemberLifecycleHostFactory';
import { createTeamProvisioningMemberLifecycleOperationRunner } from './provisioning/TeamProvisioningMemberLifecycleOperationRunner';
import { createTeamProvisioningMemberLifecycleOperationUseCases } from './provisioning/TeamProvisioningMemberLifecycleOperationUseCases';
import { createTeamProvisioningMemberLifecycleServiceUseCases } from './provisioning/TeamProvisioningMemberLifecycleServiceUseCases';
import {
  createMemberSpawnStatusAuditPortsFromService,
  createMemberSpawnStatusMutationPortsFromService,
  type MemberSpawnStatusAuditPorts,
  type MemberSpawnStatusAuditServiceHost,
  type MemberSpawnStatusMutationPorts,
  type MemberSpawnStatusMutationServiceHost,
} from './provisioning/TeamProvisioningMemberSpawnSnapshots';
import { createTeamProvisioningMemberWorkSyncProofBoundary } from './provisioning/TeamProvisioningMemberWorkSyncProofBoundaryFactory';
import {
  createTeamProvisioningMixedSecondaryLaneWiring,
  createTeamProvisioningMixedSecondaryLaneWiringDepsFromService,
  type TeamProvisioningMixedSecondaryLaneWiringServiceHost,
} from './provisioning/TeamProvisioningMixedSecondaryLaneWiring';
import {
  createTeamProvisioningOpenCodeLaunchWiring,
  createTeamProvisioningOpenCodeLaunchWiringHostFromService,
  type TeamProvisioningOpenCodeLaunchWiringServiceHost,
} from './provisioning/TeamProvisioningOpenCodeLaunchWiring';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryFromService,
  type TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import { type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost } from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import { readProcessCommandByPid as readOpenCodeRuntimeLaneProcessCommandByPid } from './provisioning/TeamProvisioningOpenCodeRuntimeLaneCleanup';
import {
  createOpenCodeRuntimePendingPermissionsPersistencePortsFromService,
  createOpenCodeRuntimePermissionSpawnStatusPortsFromService,
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePendingPermissionsPersistenceServiceHost,
  type OpenCodeRuntimePermissionSpawnStatusPorts,
  type OpenCodeRuntimePermissionSpawnStatusServiceHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import {
  createRememberOpenCodeRuntimePidFromBridgePortsFromService,
  type RememberOpenCodeRuntimePidFromBridgeServiceHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimePidBridge';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import { type TeamProvisioningOpenCodeRuntimeRecoveryFacade } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryFacade';
import { createTeamProvisioningOpenCodeSecondaryBriefingBuilder } from './provisioning/TeamProvisioningOpenCodeSecondaryBriefingBuilder';
import { TeamProvisioningOutputRecoveryFacade } from './provisioning/TeamProvisioningOutputRecoveryFacade';
import { type TeamProvisioningPersistenceReconcileFacade } from './provisioning/TeamProvisioningPersistenceReconcileFacade';
import { createTeamProvisioningPersistentRuntimeCleanup } from './provisioning/TeamProvisioningPersistentRuntimeCleanup';
import { TeamProvisioningPrepareFacade } from './provisioning/TeamProvisioningPrepareFacade';
import { createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase } from './provisioning/TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import {
  createTeamProvisioningPrimaryBootstrapTruthReportingBoundaryFromService,
  type TeamProvisioningPrimaryBootstrapTruthReportingServiceHost,
} from './provisioning/TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';
import { type TeamProvisioningProcessExitPorts } from './provisioning/TeamProvisioningProcessExit';
import { TeamProvisioningRetainedProgressState } from './provisioning/TeamProvisioningProgressState';
import {
  type TeamProvisioningProviderRuntimeCompatibility,
  type TeamProvisioningProviderRuntimeFacade,
} from './provisioning/TeamProvisioningProviderRuntimeFacade';
import {
  createTeamProvisioningReevaluateMemberLaunchStatusBoundary,
  createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService,
  type TeamProvisioningReevaluateMemberLaunchStatusServiceHost,
} from './provisioning/TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';
import { type RetainedClaudeLogsSnapshot } from './provisioning/TeamProvisioningRetainedLogs';
import {
  MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
  type ProvisioningRun,
} from './provisioning/TeamProvisioningRunModel';
import { nowIso, updateProgress } from './provisioning/TeamProvisioningRunProgress';
import { TeamProvisioningRuntimeAdapterProgressState } from './provisioning/TeamProvisioningRuntimeAdapterProgressState';
import {
  getAnthropicFastModeDefault,
  getTeamProviderLabel,
} from './provisioning/TeamProvisioningRuntimeDiagnostics';
import { type TeamProvisioningRuntimeProjection } from './provisioning/TeamProvisioningRuntimeProjectionFactory';
import { createTeamProvisioningRuntimeResourceCacheBoundary } from './provisioning/TeamProvisioningRuntimeResourceCacheBoundary';
import { TeamProvisioningRunTrackingDeliveryHelper } from './provisioning/TeamProvisioningRunTrackingDelivery';
import {
  createSecondaryRuntimeRunStore,
  isOpenCodeSecondaryLaneMemberInRun,
  type MixedSecondaryRuntimeLaneState,
  type SecondaryRuntimeRunEntry,
} from './provisioning/TeamProvisioningSecondaryRuntimeRuns';
import {
  createTeamProvisioningServiceComposition,
  type RuntimeAdapterRunByTeamEntry,
  type TeamProvisioningServiceComposition,
} from './provisioning/TeamProvisioningServiceComposition';
import { TeamProvisioningServiceFacadeDelegates } from './provisioning/TeamProvisioningServiceFacadeDelegates';
import {
  createTeamProvisioningServiceMemberLifecycleHostPortGroups,
  type TeamProvisioningServiceMemberLifecycleHostPortGroupPorts,
  type TeamProvisioningServiceMemberLifecycleHostPortGroups,
} from './provisioning/TeamProvisioningServiceMemberLifecycleHostPortGroups';
import { createTeamProvisioningShutdownCoordination } from './provisioning/TeamProvisioningShutdownCoordination';
import { assertStandaloneOpenCodeRuntimeAdapterAvailableForServiceRequest } from './provisioning/TeamProvisioningStandaloneOpenCodeBoundary';
import { createNodeStopPrimaryOwnedRosterRuntimeUseCase } from './provisioning/TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import {
  killOrphanedTeamAgentProcesses,
  killPersistedPaneMembers,
} from './provisioning/TeamProvisioningStopProcessCleanup';
import { TeamProvisioningToolApprovalFacade } from './provisioning/TeamProvisioningToolApprovalFacade';
import { TeamProvisioningTransientRunState } from './provisioning/TeamProvisioningTransientRunState';
import { type TeamProvisioningVerificationProbePorts } from './provisioning/TeamProvisioningVerificationProbePortsFactory';
import { createTeamProvisioningWorkspaceTrustPreSpawnBoundary } from './provisioning/TeamProvisioningWorkspaceTrustPreSpawnBoundary';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { boundLaunchDiagnostics } from './progressPayload';
import { TeamAttachmentStore } from './TeamAttachmentStore';
import { readBootstrapLaunchSnapshot } from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
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

import type {
  InboxMessage,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const { AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES, createController } =
  agentTeamsControllerModule;

export class TeamProvisioningService extends TeamProvisioningServiceFacadeDelegates {
  protected readonly runtimeLaneCoordinator = createTeamRuntimeLaneCoordinator();
  private readonly providerConnectionService = ProviderConnectionService.getInstance();
  protected readonly launchIdentityBoundary: TeamProvisioningLaunchIdentityBoundary =
    createTeamProvisioningLaunchIdentityBoundary({
      execCli,
      providerConnectionService: this.providerConnectionService,
      getAnthropicFastModeDefault,
      getProviderLabel: getTeamProviderLabel,
      logger,
    });
  protected readonly openCodeSecondaryBriefingBuilder =
    createTeamProvisioningOpenCodeSecondaryBriefingBuilder({
      createController: (input) => createController(input),
      getClaudeBasePath,
    });
  protected readonly claudePermissionSettingsDelegation =
    createTeamProvisioningClaudePermissionSettingsDelegation({
      bootstrapToolNames: AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
      logger,
    });
  protected readonly runs = new Map<string, ProvisioningRun>();
  protected readonly provisioningRunByTeam = new Map<string, string>();
  private readonly aliveRunByTeam = new Map<string, string>();
  protected readonly runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  private readonly runtimeAdapterTraceLinesByRunId = new Map<string, string[]>();
  private readonly runtimeAdapterTraceKeyByRunId = new Map<string, string>();
  private readonly retainedProvisioningProgressState = new TeamProvisioningRetainedProgressState({
    runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
    runtimeAdapterTraceLinesByRunId: this.runtimeAdapterTraceLinesByRunId,
    runtimeAdapterTraceKeyByRunId: this.runtimeAdapterTraceKeyByRunId,
  });
  protected readonly runtimeAdapterProgressState = new TeamProvisioningRuntimeAdapterProgressState({
    state: {
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      runtimeAdapterTraceLinesByRunId: this.runtimeAdapterTraceLinesByRunId,
      runtimeAdapterTraceKeyByRunId: this.runtimeAdapterTraceKeyByRunId,
    },
    retainProvisioningProgress: (runId, progress) =>
      this.retainProvisioningProgress(runId, progress),
    isRuntimeAdapterRunStateReferenced: (runId) =>
      this.runs.has(runId) ||
      [...this.provisioningRunByTeam.values()].includes(runId) ||
      [...this.aliveRunByTeam.values()].includes(runId) ||
      [...this.runtimeAdapterRunByTeam.values()].some((entry) => entry.runId === runId),
  });
  protected readonly runtimeAdapterRunByTeam = new Map<string, RuntimeAdapterRunByTeamEntry>();
  protected readonly runTracking = new TeamProvisioningRunTrackingDeliveryHelper({
    state: {
      provisioningRunByTeam: this.provisioningRunByTeam,
      aliveRunByTeam: this.aliveRunByTeam,
      runs: this.runs,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      getRetainedProvisioningProgressMap: () =>
        this.retainedProvisioningProgressState.getRetainedProvisioningProgressMap(),
    },
    ports: {
      notifyTeamWatchScopeChanged,
      isTeamAlive: (teamName) => this.isTeamAlive(teamName),
      hasAlivePersistedTeamProcess: (teamName) =>
        this.openCodeStoppedLaneCleanup.hasAlivePersistedTeamProcess(teamName),
      hasOnlyExplicitlyStoppedPersistedTeamProcesses: (teamName) =>
        this.openCodeStoppedLaneCleanup.hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName),
      logDebug: (message) => logger.debug(message),
    },
    liveRuntimeSnapshotCacheTtlMs: 2_000,
    persistedRuntimeSnapshotCacheTtlMs: 10_000,
  });
  private readonly cancelledRuntimeAdapterRunIds = new Set<string>();
  protected readonly cancellationBoundary: TeamProvisioningCancellationBoundary =
    createTeamProvisioningCancellationBoundary<ProvisioningRun>(
      createTeamProvisioningCancellationBoundaryPortsFromService(
        this as unknown as TeamProvisioningCancellationBoundaryServiceHost<ProvisioningRun>,
        {
          logWarning: (message) => logger.warn(message),
        }
      )
    );
  private readonly transientProbeProcesses = new Set<ReturnType<typeof spawn>>();
  protected readonly secondaryRuntimeRunByTeam = new Map<
    string,
    Map<string, SecondaryRuntimeRunEntry>
  >();
  private readonly secondaryRuntimeRuns = createSecondaryRuntimeRunStore({
    secondaryRuntimeRunByTeam: this.secondaryRuntimeRunByTeam,
    ports: {
      clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
        this.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, options),
    },
  });
  private readonly hasSecondaryRuntimeRuns = this.secondaryRuntimeRuns.hasSecondaryRuntimeRuns;
  private readonly getSecondaryRuntimeRuns = this.secondaryRuntimeRuns.getSecondaryRuntimeRuns;
  private readonly setSecondaryRuntimeRun = this.secondaryRuntimeRuns.setSecondaryRuntimeRun;
  private readonly deleteSecondaryRuntimeRun = this.secondaryRuntimeRuns.deleteSecondaryRuntimeRun;
  private readonly clearSecondaryRuntimeRuns = this.secondaryRuntimeRuns.clearSecondaryRuntimeRuns;
  private readonly stoppingSecondaryRuntimeTeams = new Set<string>();
  protected readonly retainedClaudeLogsByTeam = new Map<string, RetainedClaudeLogsSnapshot>();
  protected readonly bootstrapTranscriptFacade!: TeamProvisioningBootstrapTranscriptFacade;
  protected readonly bootstrapEvidenceFacade!: TeamProvisioningBootstrapEvidenceFacade;

  private readonly teamOpLocks = new Map<string, Promise<void>>();
  protected readonly shutdownCoordination = createTeamProvisioningShutdownCoordination(
    {
      provisioningRunByTeam: this.provisioningRunByTeam,
      aliveRunByTeam: this.aliveRunByTeam,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      secondaryRuntimeRunByTeam: this.secondaryRuntimeRunByTeam,
      teamOpLocks: this.teamOpLocks,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      transientProbeProcesses: this.transientProbeProcesses,
    },
    {
      isCancellableRuntimeAdapterProgress: (progress) =>
        this.cancellationBoundary.isCancellableRuntimeAdapterProgress(progress),
      stopTeam: (teamName) => this.stopTeam(teamName),
      cancelRuntimeAdapterProvisioning: (runId, progress) =>
        this.cancellationBoundary.cancelRuntimeAdapterProvisioning(runId, progress),
      killProcessTree,
      logger,
    }
  );
  protected readonly memberWorkSyncProofBoundary =
    createTeamProvisioningMemberWorkSyncProofBoundary({
      getAcceptedReportChecker: () =>
        this.appShellBoundary.getMemberWorkSyncAcceptedReportChecker(),
      getProofMissingRecoveryScheduler: () =>
        this.appShellBoundary.getMemberWorkSyncProofMissingRecoveryScheduler(),
      logger,
      getErrorMessage,
    });
  protected readonly leadInboxRelayFacade!: TeamProvisioningLeadInboxRelayCompatibilityFacade<ProvisioningRun>;

  private readonly openCodeRuntimeDeliveryProofReader = new OpenCodeRuntimeDeliveryProofReader();
  protected readonly openCodeRuntimeDeliveryAdvisory =
    createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryFromService<ProvisioningRun>(
      this as unknown as TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost<ProvisioningRun>,
      {
        addTeamNotification: async (notification) => {
          await NotificationManager.getInstance().addTeamNotification(notification);
        },
        logInfo: (message, detail) =>
          detail === undefined ? logger.info(message) : logger.info(message, detail),
        logWarning: (message) => logger.warn(message),
        getErrorMessage,
      }
    );
  private readonly launchNotifications =
    createTeamProvisioningLaunchNotificationsBoundary<ProvisioningRun>({
      areAllExpectedLaunchMembersConfirmed: (run) => this.areAllExpectedLaunchMembersConfirmed(run),
      logger: {
        warn: (message) => logger.warn(message),
      },
    });
  private readonly liveLaunchSnapshotBoundary =
    createTeamProvisioningLiveLaunchSnapshotBoundaryFromService<ProvisioningRun>(
      this as unknown as TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost<ProvisioningRun>,
      {
        getPersistedLaunchMemberNames,
        buildRuntimeSpawnStatusRecord: (run) => this.buildRuntimeSpawnStatusRecord(run),
      }
    );
  private readonly primaryBootstrapTruthReporting =
    createTeamProvisioningPrimaryBootstrapTruthReportingBoundaryFromService<ProvisioningRun>(
      this as unknown as TeamProvisioningPrimaryBootstrapTruthReportingServiceHost<ProvisioningRun>,
      {
        isOpenCodeSecondaryLaneMemberInRun,
        readBootstrapLaunchSnapshot,
        nowIso,
        logger: {
          warn: (message) => logger.warn(message),
        },
      }
    );
  private readonly openCodeVisibleReplyProofService!: OpenCodeVisibleReplyProofService;
  protected readonly openCodePromptDeliveryWatchdogCoordinator!: OpenCodePromptDeliveryWatchdogCoordinator;
  private readonly openCodeRuntimeRecoveryBoundary =
    createTeamProvisioningOpenCodeRuntimeRecoveryBoundary({
      teamsBasePath: getTeamsBasePath(),
      logger,
      getOpenCodeRuntimeAdapter: () => this.appShellBoundary.getOpenCodeRuntimeAdapter(),
      createRunId: randomUUID,
      getErrorMessage,
    });
  private readonly openCodeRuntimePermissionPersistencePorts: OpenCodeRuntimePendingPermissionsPersistencePorts =
    createOpenCodeRuntimePendingPermissionsPersistencePortsFromService(
      this as unknown as OpenCodeRuntimePendingPermissionsPersistenceServiceHost,
      {
        nowIso,
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
        readLaunchState: (teamName) => this.launchStateStore.read(teamName).catch(() => null),
        logDebug: (message) => logger.debug(message),
      }
    );
  private readonly openCodeRuntimePermissionSpawnStatusPorts: OpenCodeRuntimePermissionSpawnStatusPorts<ProvisioningRun> =
    createOpenCodeRuntimePermissionSpawnStatusPortsFromService(
      this as unknown as OpenCodeRuntimePermissionSpawnStatusServiceHost<ProvisioningRun>,
      {
        nowIso,
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
        getRun: (runId) => this.runs.get(runId) ?? null,
      }
    );
  protected readonly openCodeRuntimePidBridgePorts =
    createRememberOpenCodeRuntimePidFromBridgePortsFromService(
      this as unknown as RememberOpenCodeRuntimePidFromBridgeServiceHost,
      {
        nowIso,
        readProcessCommandByPid: readOpenCodeRuntimeLaneProcessCommandByPid,
        isOpenCodeServeCommand,
        logDebug: (message) => logger.debug(message),
      }
    );
  protected readonly memberSpawnStatusMutationPorts: MemberSpawnStatusMutationPorts<ProvisioningRun> =
    createMemberSpawnStatusMutationPortsFromService(
      this as unknown as MemberSpawnStatusMutationServiceHost<ProvisioningRun>,
      {
        nowIso,
        buildLaunchDiagnostics: (run) => boundLaunchDiagnostics(buildLaunchDiagnosticsFromRun(run)),
      }
    );
  protected readonly memberSpawnStatusAuditPorts: MemberSpawnStatusAuditPorts<ProvisioningRun> =
    createMemberSpawnStatusAuditPortsFromService(
      this as unknown as MemberSpawnStatusAuditServiceHost<ProvisioningRun>,
      {
        nowMs: () => Date.now(),
        minAuditIntervalMs: MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
        isOpenCodeSecondaryLaneMemberInRun: (run, memberName) =>
          isOpenCodeSecondaryLaneMemberInRun(
            run as Parameters<typeof isOpenCodeSecondaryLaneMemberInRun>[0],
            memberName
          ),
      }
    );
  private readonly openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal: (input) => this.markOpenCodePromptLedgerFailedTerminal(input),
    logEvent: (event, record, extra) => this.logOpenCodePromptDeliveryEvent(event, record, extra),
    scheduleWatchdog: (input) => this.scheduleOpenCodePromptDeliveryWatchdog(input),
    nowIso,
  });
  protected readonly openCodePromptDeliveryWatchdogScheduler!: OpenCodePromptDeliveryWatchdogScheduler;
  protected readonly persistentRuntimeCleanup = createTeamProvisioningPersistentRuntimeCleanup({
    readPersistedRuntimeMembers: (teamName) => this.readPersistedRuntimeMembers(teamName),
    killPersistedPaneMembers: (teamName, members) =>
      killPersistedPaneMembers(teamName, members, logger),
    killOrphanedTeamAgentProcesses: (teamName, currentRunPid) =>
      killOrphanedTeamAgentProcesses({ teamName, currentRunPid, logger }),
    getCurrentRunPid: (teamName) => {
      const currentRunId = this.runTracking.getTrackedRunId(teamName);
      return currentRunId ? this.runs.get(currentRunId)?.child?.pid : undefined;
    },
    cleanupAnthropicTeamApiKeyHelperForTeam,
    getClaudeBasePath,
    logger,
  });

  private readonly runtimeResourceCacheBoundary =
    createTeamProvisioningRuntimeResourceCacheBoundary({
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      logDebug: (message) => logger.debug(message),
    });
  private readonly runtimeResourceSampling =
    this.runtimeResourceCacheBoundary.runtimeResourceSampling;
  private readonly persistedTeamConfigCache =
    this.runtimeResourceCacheBoundary.persistedTeamConfigCache;
  protected readonly runtimeSnapshotFacade!: TeamProvisioningRuntimeProjection['runtimeSnapshotFacade'];
  private readonly memberSpawnStatusesSnapshotCache =
    this.runtimeResourceCacheBoundary.memberSpawnStatusesSnapshotCache;
  private readonly memberSpawnStatusesInFlightByTeam =
    this.runtimeResourceCacheBoundary.memberSpawnStatusesInFlightByTeam;
  protected readonly runtimeSnapshotCacheBoundary =
    this.runtimeResourceCacheBoundary.runtimeSnapshotCacheBoundary;

  private readonly launchStateStore = new TeamLaunchStateStore();
  private readonly defaultLaunchStateStore = this.launchStateStore;
  private readonly configFacade!: TeamProvisioningConfigFacade;
  protected readonly openCodeRuntimeRecoveryFacade!: TeamProvisioningOpenCodeRuntimeRecoveryFacade;

  protected readonly liveRuntimeMetadataPorts!: TeamProvisioningRuntimeProjection['liveRuntimeMetadataPorts'];
  private readonly launchStateWrittenRunIdByTeam = new Map<string, string>();
  private readonly launchStateStoreBoundary!: TeamProvisioningLaunchStateStoreBoundary;
  private readonly persistenceReconcileFacade!: TeamProvisioningPersistenceReconcileFacade<ProvisioningRun>;
  protected readonly launchStateCompatibilityBoundary!: TeamProvisioningLaunchStateCompatibilityBoundary<ProvisioningRun>;
  private readonly configTaskActivityBoundary!: TeamProvisioningConfigTaskActivityBoundary<ProvisioningRun>;
  private readonly failedOpenCodeSecondaryRetryInFlightByTeam = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();
  private readonly memberLifecycleOperations = new Map<string, MemberLifecycleOperation>();
  private readonly memberLifecycleOperationRunner =
    createTeamProvisioningMemberLifecycleOperationRunner({
      memberLifecycleOperations: this.memberLifecycleOperations,
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      nowMs: () => Date.now(),
    });
  private readonly memberLifecycleUseCases = createTeamProvisioningMemberLifecycleServiceUseCases({
    persistSentMessage: (teamName, message) =>
      this.persistSentMessage(teamName, message as unknown as InboxMessage),
    readLaunchStateSnapshot: (teamName) => this.launchStateStore.read(teamName),
    getLiveTeamAgentRuntimeMetadata: (teamName) => this.getLiveTeamAgentRuntimeMetadata(teamName),
    appendDirectProcessRuntimeEvent: createAppendDirectProcessRuntimeEventUseCase(
      createNodeAppendDirectProcessRuntimeEventUseCasePorts({ nowIso })
    ),
    stopPrimaryOwnedRosterRuntime: createNodeStopPrimaryOwnedRosterRuntimeUseCase(),
    preparePrimaryOwnedMemberRestartRuntime:
      createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase(),
    nowIso,
    randomUUID,
  });
  private readonly memberLifecycleOperationUseCases =
    createTeamProvisioningMemberLifecycleOperationUseCases({
      operationRunner: this.memberLifecycleOperationRunner,
    });
  private readonly memberLifecycleHost = createTeamProvisioningMemberLifecycleHostFromPortGroups<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >(this.createMemberLifecycleHostPortGroups());
  private readonly memberLifecycleController = new TeamProvisioningMemberLifecycleController(
    this.memberLifecycleHost,
    this.memberLifecycleOperationUseCases,
    {
      restart: this.memberLifecycleUseCases,
      openCodeRetry: this.memberLifecycleUseCases,
    }
  );
  protected readonly memberLifecycleFacade: TeamProvisioningMemberLifecyclePublicFacade =
    this.memberLifecycleController;
  protected teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;
  protected readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly toolApprovalFacade!: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  protected readonly transientRunState!: TeamProvisioningTransientRunState;
  protected readonly idlePromptInjectionBoundary!: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  protected readonly providerRuntime!: TeamProvisioningProviderRuntimeFacade;
  private readonly providerRuntimeCompatibility!: TeamProvisioningProviderRuntimeCompatibility;
  protected readonly compatibilityDelegation!: TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly outputRecoveryFacade!: TeamProvisioningOutputRecoveryFacade<ProvisioningRun>;
  protected readonly deterministicCreateSpawnFlowBoundary!: TeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>;
  private readonly deterministicLaunchFlowBoundary!: TeamProvisioningLaunchDeterministicFlowBoundary<MixedSecondaryRuntimeLaneState>;
  protected readonly prepareFacade!: TeamProvisioningPrepareFacade;
  protected readonly verificationProbePorts!: TeamProvisioningVerificationProbePorts<ProvisioningRun>;
  protected readonly processExitPorts!: TeamProvisioningProcessExitPorts<ProvisioningRun>;
  private readonly workspaceTrustPreSpawnBoundary =
    createTeamProvisioningWorkspaceTrustPreSpawnBoundary<
      ProvisioningRun,
      ProvisioningEnvResolution
    >({
      getWorkspaceTrustCoordinator: () => this.appShellBoundary.getWorkspaceTrustCoordinator(),
      getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
      updateProgress,
      boundLaunchDiagnostics,
      isLaunchRunStillCurrent: (run) => this.isLaunchRunStillCurrent(run),
      isRunStillTracked: (run) => this.runs.get(run.runId) === run,
      cleanupAnthropicApiKeyHelperMaterial: cleanupAnthropicTeamApiKeyHelperMaterial,
      restorePrelaunchConfig: (teamName) => this.restorePrelaunchConfig(teamName),
      cleanupRun: (run) => this.cleanupRun(run),
      logger,
    });
  protected readonly reevaluateMemberLaunchStatusBoundary =
    createTeamProvisioningReevaluateMemberLaunchStatusBoundary<ProvisioningRun>(
      createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService(
        this as unknown as TeamProvisioningReevaluateMemberLaunchStatusServiceHost<ProvisioningRun>,
        {
          nowIso,
          nowMs: () => Date.now(),
          isOpenCodeSecondaryLaneMemberInRun,
        }
      )
    );
  protected readonly mixedSecondaryLaneWiring =
    createTeamProvisioningMixedSecondaryLaneWiring<ProvisioningRun>(
      createTeamProvisioningMixedSecondaryLaneWiringDepsFromService(
        this as unknown as TeamProvisioningMixedSecondaryLaneWiringServiceHost<ProvisioningRun>,
        { logger }
      )
    );
  protected readonly openCodeLaunchWiring =
    createTeamProvisioningOpenCodeLaunchWiring<ProvisioningRun>(
      createTeamProvisioningOpenCodeLaunchWiringHostFromService(
        this as unknown as TeamProvisioningOpenCodeLaunchWiringServiceHost<ProvisioningRun>
      )
    );
  private readonly requestAdmissionBoundary!: TeamProvisioningServiceComposition['requestAdmissionBoundary'];
  protected readonly openCodeRuntimeDeliveryBoundaryHost!: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun>;
  protected readonly openCodeRuntimeControlApi!: TeamProvisioningServiceComposition['openCodeRuntimeControlApi'];

  private createMemberLifecycleHostPortGroups(): TeamProvisioningServiceMemberLifecycleHostPortGroups {
    return createTeamProvisioningServiceMemberLifecycleHostPortGroups(
      this as unknown as TeamProvisioningServiceMemberLifecycleHostPortGroupPorts
    );
  }

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
    createTeamProvisioningServiceComposition(this);
    scheduleStaleAnthropicTeamApiKeyHelperCleanup({ baseClaudeDir: getClaudeBasePath(), logger });
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  private assertStandaloneOpenCodeRuntimeAdapterBoundary(request: {
    providerId?: TeamCreateRequest['providerId'];
    members?: TeamCreateRequest['members'];
  }): void {
    assertStandaloneOpenCodeRuntimeAdapterAvailableForServiceRequest(this, request);
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    this.assertStandaloneOpenCodeRuntimeAdapterBoundary(request);
    return this.requestAdmissionBoundary.createTeam(request, onProgress);
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    this.assertStandaloneOpenCodeRuntimeAdapterBoundary(request);
    return this.requestAdmissionBoundary.launchTeam(request, onProgress);
  }
}
