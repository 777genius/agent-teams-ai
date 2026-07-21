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

import { cleanupAnthropicTeamApiKeyHelperForTeam } from '../../runtime/anthropicTeamApiKeyHelper';
import { ProviderConnectionService } from '../../runtime/ProviderConnectionService';
import { isOpenCodeServeCommand } from '../opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { OpenCodePromptDeliveryFollowUpPolicy } from '../opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import { type OpenCodePromptDeliveryWatchdogCoordinator } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { type OpenCodePromptDeliveryWatchdogScheduler } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { OpenCodeRuntimeDeliveryProofReader } from '../opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import { type OpenCodeVisibleReplyProofService } from '../opencode/delivery/OpenCodeVisibleReplyProofService';
import { boundLaunchDiagnostics } from '../progressPayload';
import { readBootstrapLaunchSnapshot } from '../TeamBootstrapStateReader';
import { TeamLaunchStateStore } from '../TeamLaunchStateStore';

import {
  createTeamProvisioningCancellationBoundary,
  createTeamProvisioningCancellationBoundaryPortsFromService,
  type TeamProvisioningCancellationBoundary,
  type TeamProvisioningCancellationBoundaryServiceHost,
} from './TeamProvisioningCancellationBoundary';
import { createTeamProvisioningClaudePermissionSettingsDelegation } from './TeamProvisioningClaudePermissionSettingsDelegation';
import { type TeamProvisioningConfigTaskActivityBoundary } from './TeamProvisioningConfigTaskActivityBoundary';
import { buildLaunchDiagnosticsFromRun } from './TeamProvisioningLaunchDiagnostics';
import {
  createTeamProvisioningLaunchIdentityBoundary,
  type TeamProvisioningLaunchIdentityBoundary,
} from './TeamProvisioningLaunchIdentityBoundaryFactory';
import { createTeamProvisioningLaunchNotificationsBoundary } from './TeamProvisioningLaunchNotificationsBoundaryFactory';
import { type TeamProvisioningLaunchStateCompatibilityBoundary } from './TeamProvisioningLaunchStateCompatibilityFacade';
import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import { type TeamProvisioningLeadInboxRelayCompatibilityFacade } from './TeamProvisioningLeadInboxRelayCompatibilityFacade';
import {
  createTeamProvisioningLiveLaunchSnapshotBoundaryFromService,
  type TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost,
} from './TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import {
  createMemberSpawnStatusAuditPortsFromService,
  createMemberSpawnStatusMutationPortsFromService,
  type MemberSpawnStatusAuditPorts,
  type MemberSpawnStatusAuditServiceHost,
  type MemberSpawnStatusMutationPorts,
  type MemberSpawnStatusMutationServiceHost,
} from './TeamProvisioningMemberSpawnSnapshots';
import { createTeamProvisioningMemberWorkSyncProofBoundary } from './TeamProvisioningMemberWorkSyncProofBoundaryFactory';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryFromService,
  type TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost,
} from './TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import { readProcessCommandByPid as readOpenCodeRuntimeLaneProcessCommandByPid } from './TeamProvisioningOpenCodeRuntimeLaneCleanup';
import {
  createOpenCodeRuntimePendingPermissionsPersistencePortsFromService,
  createOpenCodeRuntimePermissionSpawnStatusPortsFromService,
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePendingPermissionsPersistenceServiceHost,
  type OpenCodeRuntimePermissionSpawnStatusPorts,
  type OpenCodeRuntimePermissionSpawnStatusServiceHost,
} from './TeamProvisioningOpenCodeRuntimePermissions';
import {
  createRememberOpenCodeRuntimePidFromBridgePortsFromService,
  type RememberOpenCodeRuntimePidFromBridgeServiceHost,
} from './TeamProvisioningOpenCodeRuntimePidBridge';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from './TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import { type TeamProvisioningOpenCodeRuntimeRecoveryFacade } from './TeamProvisioningOpenCodeRuntimeRecoveryFacade';
import { createTeamProvisioningOpenCodeSecondaryBriefingBuilder } from './TeamProvisioningOpenCodeSecondaryBriefingBuilder';
import { type TeamProvisioningPersistenceReconcileFacade } from './TeamProvisioningPersistenceReconcileFacade';
import { createTeamProvisioningPersistentRuntimeCleanup } from './TeamProvisioningPersistentRuntimeCleanup';
import {
  createTeamProvisioningPrimaryBootstrapTruthReportingBoundaryFromService,
  type TeamProvisioningPrimaryBootstrapTruthReportingServiceHost,
} from './TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';
import { TeamProvisioningRetainedProgressState } from './TeamProvisioningProgressState';
import {
  MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
  type ProvisioningRun,
} from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { TeamProvisioningRuntimeAdapterProgressState } from './TeamProvisioningRuntimeAdapterProgressState';
import {
  getAnthropicFastModeDefault,
  getTeamProviderLabel,
} from './TeamProvisioningRuntimeDiagnostics';
import { type TeamProvisioningRuntimeProjection } from './TeamProvisioningRuntimeProjectionFactory';
import { createTeamProvisioningRuntimeResourceCacheBoundary } from './TeamProvisioningRuntimeResourceCacheBoundary';
import { TeamProvisioningRunTrackingDeliveryHelper } from './TeamProvisioningRunTrackingDelivery';
import {
  createSecondaryRuntimeRunStore,
  isOpenCodeSecondaryLaneMemberInRun,
  type SecondaryRuntimeRunEntry,
} from './TeamProvisioningSecondaryRuntimeRuns';
import { type RuntimeAdapterRunByTeamEntry } from './TeamProvisioningServiceComposition';
import { TeamProvisioningServiceFacadeDelegates } from './TeamProvisioningServiceFacadeDelegates';
import { createTeamProvisioningShutdownCoordination } from './TeamProvisioningShutdownCoordination';
import {
  killOrphanedTeamAgentProcesses,
  killPersistedPaneMembers,
} from './TeamProvisioningStopProcessCleanup';

import type { TeamProvisioningBootstrapEvidenceFacade } from './TeamProvisioningBootstrapEvidenceFacade';
import type { TeamProvisioningBootstrapTranscriptFacade } from './TeamProvisioningBootstrapTranscriptFacade';
import type { TeamProvisioningConfigFacade } from './TeamProvisioningConfigFacade';
import type { TeamProvisioningLaunchStateStoreBoundary } from './TeamProvisioningLaunchStateStoreBoundary';
import type { RetainedClaudeLogsSnapshot } from './TeamProvisioningRetainedLogs';
import type { TeamProvisioningProgress } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const { AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES, createController } =
  agentTeamsControllerModule;

/**
 * Owns the long-lived runtime state and infrastructure-facing boundaries used by
 * the compatibility facade chain. Lifecycle construction and restart
 * orchestration live in the next focused layers.
 */
export abstract class TeamProvisioningServiceRuntimeStateFacade extends TeamProvisioningServiceFacadeDelegates {
  protected abstract getOpenCodeAggregatePrimaryRestartTeamNamesForShutdown(): Iterable<string>;
  protected abstract getOpenCodeRuntimeAdapterStopInFlightTeamNamesForShutdown(): Iterable<string>;

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
  protected readonly hasSecondaryRuntimeRuns = (teamName: string): boolean =>
    this.secondaryRuntimeRuns.hasSecondaryRuntimeRuns(teamName);
  private readonly getSecondaryRuntimeRuns = (teamName: string): SecondaryRuntimeRunEntry[] =>
    this.secondaryRuntimeRuns.getSecondaryRuntimeRuns(teamName);
  private readonly getSecondaryRuntimeRun = (
    teamName: string,
    laneId: string
  ): SecondaryRuntimeRunEntry | undefined =>
    this.secondaryRuntimeRunByTeam.get(teamName)?.get(laneId);
  private readonly setSecondaryRuntimeRun = (
    input: SecondaryRuntimeRunEntry & { teamName: string }
  ): void => this.secondaryRuntimeRuns.setSecondaryRuntimeRun(input);
  private readonly deleteSecondaryRuntimeRun = (teamName: string, laneId: string): void =>
    this.secondaryRuntimeRuns.deleteSecondaryRuntimeRun(teamName, laneId);
  private readonly deleteSecondaryRuntimeRunIfOwned = (
    teamName: string,
    laneId: string,
    runId: string
  ): boolean => {
    const current = this.getSecondaryRuntimeRun(teamName, laneId);
    if (current?.providerId !== 'opencode' || current.runId !== runId) {
      return false;
    }
    this.secondaryRuntimeRuns.deleteSecondaryRuntimeRun(teamName, laneId);
    return true;
  };
  private readonly clearSecondaryRuntimeRuns = (teamName: string): void =>
    this.secondaryRuntimeRuns.clearSecondaryRuntimeRuns(teamName);
  private readonly stoppingSecondaryRuntimeTeams = new Set<string>();
  protected readonly retainedClaudeLogsByTeam = new Map<string, RetainedClaudeLogsSnapshot>();
  protected readonly bootstrapTranscriptFacade!: TeamProvisioningBootstrapTranscriptFacade;
  protected readonly bootstrapEvidenceFacade!: TeamProvisioningBootstrapEvidenceFacade;

  protected readonly teamOpLocks = new Map<string, Promise<void>>();
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
      getOpenCodeAggregatePrimaryRestartTeamNames: () =>
        this.getOpenCodeAggregatePrimaryRestartTeamNamesForShutdown(),
      getOpenCodeRuntimeAdapterStopInFlightTeamNames: () =>
        this.getOpenCodeRuntimeAdapterStopInFlightTeamNamesForShutdown(),
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
        reportBackgroundPersistenceError: (run, error) =>
          logger.warn(
            `[${run.teamName}] Failed to persist background member spawn status: ${getErrorMessage(error)}`
          ),
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

  protected readonly launchStateStore = new TeamLaunchStateStore();
  private readonly defaultLaunchStateStore = this.launchStateStore;
  protected readonly configFacade!: TeamProvisioningConfigFacade;
  protected readonly openCodeRuntimeRecoveryFacade!: TeamProvisioningOpenCodeRuntimeRecoveryFacade;
  protected readonly liveRuntimeMetadataPorts!: TeamProvisioningRuntimeProjection['liveRuntimeMetadataPorts'];
  protected readonly launchStateWrittenRunIdByTeam = new Map<string, string>();
  private readonly launchStateStoreBoundary!: TeamProvisioningLaunchStateStoreBoundary;
  private readonly persistenceReconcileFacade!: TeamProvisioningPersistenceReconcileFacade<ProvisioningRun>;
  protected readonly launchStateCompatibilityBoundary!: TeamProvisioningLaunchStateCompatibilityBoundary<ProvisioningRun>;
  private readonly configTaskActivityBoundary!: TeamProvisioningConfigTaskActivityBoundary<ProvisioningRun>;
}
