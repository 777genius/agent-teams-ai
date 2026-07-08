import { execCli, spawnCli } from '@main/utils/childProcess';
import { getAutoDetectedClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';

import { peekAutoResumeService } from '../AutoResumeService';
import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';
import { getConfiguredCliCommandLabel } from '../cliFlavor';
import {
  createOpenCodePromptDeliveryWatchdogCoordinator,
  type OpenCodePromptDeliveryWatchdogCoordinator,
  type OpenCodePromptDeliveryWatchdogCoordinatorPorts,
} from '../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { type OpenCodePromptDeliveryWatchdogScheduler } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { openCodeTaskRefsIncludeAll as openCodeTaskRefsIncludeAllValue } from '../opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';
import {
  createOpenCodeVisibleReplyProofServiceFromHost,
  OpenCodeVisibleReplyProofService,
  type OpenCodeVisibleReplyProofServiceHost,
} from '../opencode/delivery/OpenCodeVisibleReplyProofService';
import { readOpenCodeRuntimeLaneIndex } from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  clearBootstrapState,
  readBootstrapLaunchSnapshot,
  readBootstrapRuntimeState,
} from '../TeamBootstrapStateReader';
import { TeamConfigReader } from '../TeamConfigReader';
import { TeamInboxReader } from '../TeamInboxReader';
import { TeamLaunchStateStore } from '../TeamLaunchStateStore';
import { TeamMembersMetaStore } from '../TeamMembersMetaStore';

import { ensureCwdExists, sleep } from './TeamProvisioningAsyncUtils';
import {
  createTeamProvisioningBootstrapTranscriptFacadeFromService,
  TeamProvisioningBootstrapTranscriptFacade,
  type TeamProvisioningBootstrapTranscriptFacadeServiceHost,
} from './TeamProvisioningBootstrapTranscriptFacade';
import { type TeamProvisioningCancellationBoundary } from './TeamProvisioningCancellationBoundary';
import { type TeamProvisioningCleanupPorts } from './TeamProvisioningCleanup';
import {
  createTeamProvisioningCleanupRunPorts,
  createTeamProvisioningCleanupRunPortsDepsFromService,
  type TeamProvisioningCleanupRunServiceHost,
} from './TeamProvisioningCleanupRunPortsFactory';
import { type TeamProvisioningCompatibilityDelegation } from './TeamProvisioningCompatibilityFacade';
import { TeamProvisioningConfigFacade } from './TeamProvisioningConfigFacade';
import {
  createTeamProvisioningConfigTaskActivityBoundaryFromService,
  type TeamProvisioningConfigTaskActivityBoundary,
  type TeamProvisioningConfigTaskActivityBoundaryServiceHost,
} from './TeamProvisioningConfigTaskActivityBoundary';
import {
  createTeamProvisioningCreateDeterministicSpawnFlowBoundary,
  createTeamProvisioningCreateDeterministicSpawnFlowDepsFromService,
  type TeamProvisioningCreateDeterministicSpawnFlowBoundary,
  type TeamProvisioningCreateDeterministicSpawnFlowServiceHost,
} from './TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import {
  createTeamProvisioningIdlePromptInjectionBoundaryFromService,
  type TeamProvisioningIdlePromptInjectionBoundary,
  type TeamProvisioningIdlePromptInjectionServiceHost,
} from './TeamProvisioningIdlePromptInjectionPortsFactory';
import { hasStableInboxMessageId } from './TeamProvisioningInboxRelayPolicy';
import {
  createTeamProvisioningLaunchDeterministicFlowBoundary,
  createTeamProvisioningLaunchDeterministicFlowHostFromService,
  type TeamProvisioningLaunchDeterministicFlowBoundary,
  type TeamProvisioningLaunchDeterministicFlowServiceHost,
} from './TeamProvisioningLaunchDeterministicFlowPortsFactory';
import { areLaunchStateSnapshotsSemanticallyEqual } from './TeamProvisioningLaunchStateProjection';
import {
  createTeamProvisioningLaunchStateStoreBoundaryFromService,
  TeamProvisioningLaunchStateStoreBoundary,
  type TeamProvisioningLaunchStateStoreBoundaryServiceHost,
} from './TeamProvisioningLaunchStateStoreBoundary';
import {
  createTeamProvisioningMemberMcpLaunchConfigProvisionerFromService,
  TeamProvisioningMemberMcpLaunchConfigProvisioner,
  type TeamProvisioningMemberMcpLaunchConfigServiceHost,
} from './TeamProvisioningMemberMcpLaunchConfig';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost } from './TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import {
  createTeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeFromService,
  TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeServiceHost,
} from './TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';
import {
  isAuthFailureWarning,
  normalizeApiRetryErrorMessage,
} from './TeamProvisioningOutputErrorPolicy';
import {
  createTeamProvisioningOutputRecoveryFacadeFromService,
  TeamProvisioningOutputRecoveryFacade,
  type TeamProvisioningOutputRecoveryFacadeServiceHost,
} from './TeamProvisioningOutputRecoveryFacade';
import { type PersistedTeamConfigCacheEntry } from './TeamProvisioningPersistedTeamConfigAccess';
import {
  createTeamProvisioningPrepareFacadeFromService,
  TeamProvisioningPrepareFacade,
  type TeamProvisioningPrepareFacadeServiceHost,
} from './TeamProvisioningPrepareFacade';
import { type TeamProvisioningProcessExitPorts } from './TeamProvisioningProcessExit';
import {
  createTeamProvisioningProcessExitPorts,
  createTeamProvisioningProcessExitPortsDepsFromService,
  type TeamProvisioningProcessExitServiceHost,
} from './TeamProvisioningProcessExitPortsFactory';
import {
  createTeamProvisioningProviderRuntimeCompatibility,
  createTeamProvisioningProviderRuntimeFacadeFromService,
  type TeamProvisioningProviderRuntimeCompatibility,
  type TeamProvisioningProviderRuntimeFacade,
  type TeamProvisioningProviderRuntimeFacadeServiceHost,
} from './TeamProvisioningProviderRuntimeFacade';
import { tryReadRegularFileUtf8 } from './TeamProvisioningRegularFileRead';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';
import {
  type ProvisioningRun,
  TEAM_CONFIG_MAX_BYTES,
  TEAM_JSON_READ_TIMEOUT_MS,
  VERIFY_POLL_MS,
  VERIFY_TIMEOUT_MS,
} from './TeamProvisioningRunModel';
import {
  emitLogsProgress,
  killTeamProcess,
  nowIso,
  updateProgress,
} from './TeamProvisioningRunProgress';
import { getRuntimeFailureLabelForRequest } from './TeamProvisioningRuntimeFailureLabels';
import { logsSuggestShutdownOrCleanup } from './TeamProvisioningRuntimeLaunchSelection';
import {
  createTeamProvisioningRuntimeProjectionFromService,
  type TeamProvisioningRuntimeProjection,
  type TeamProvisioningRuntimeProjectionServiceHost,
} from './TeamProvisioningRuntimeProjectionFactory';
import {
  createDefaultTeamProvisioningSameTeamNativeDeliveryFromService,
  TeamProvisioningSameTeamNativeDelivery,
  type TeamProvisioningSameTeamNativeDeliveryServiceHost,
} from './TeamProvisioningSameTeamNativeDelivery';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import { type TeamProvisioningSendMessageToRunBoundary } from './TeamProvisioningSendMessageToRunBoundaryFactory';
import {
  createTeamProvisioningToolApprovalFacadeFromService,
  TeamProvisioningToolApprovalFacade,
  type TeamProvisioningToolApprovalFacadeServiceHost,
} from './TeamProvisioningToolApprovalFacade';
import {
  createTeamProvisioningTransientRunStatePortsFromService,
  TeamProvisioningTransientRunState,
  type TeamProvisioningTransientRunStateServiceHost,
} from './TeamProvisioningTransientRunState';
import {
  createTeamProvisioningVerificationProbePorts,
  createTeamProvisioningVerificationProbePortsDepsFromService,
  type TeamProvisioningVerificationProbePorts,
  type TeamProvisioningVerificationProbeServiceHost,
} from './TeamProvisioningVerificationProbePortsFactory';

import type { TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type { TeamProvisioningRetainedProgressState } from './TeamProvisioningProgressState';
import type { TeamProviderId } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const { AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES } = agentTeamsControllerModule;

export interface RuntimeAdapterRunByTeamEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

interface ServiceCompositionPorts {
  createOpenCodeRuntimeDeliveryBoundaryHost(): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun>;
  memberWorkSyncProofBoundary: {
    hasAcceptedMemberWorkSyncReport: OpenCodePromptDeliveryWatchdogCoordinatorPorts['hasAcceptedMemberWorkSyncReport'];
  };
  maybeSyncOpenCodeRuntimePermissionsAfterDelivery: OpenCodePromptDeliveryWatchdogCoordinatorPorts['maybeSyncRuntimePermissionsAfterDelivery'];
  rememberOpenCodeRuntimePidFromBridge: OpenCodePromptDeliveryWatchdogCoordinatorPorts['rememberRuntimePidFromBridge'];
  scheduleOpenCodePromptDeliveryWatchdog: NonNullable<
    OpenCodePromptDeliveryWatchdogCoordinatorPorts['schedulePromptDeliveryWatchdog']
  >;
  canDeliverToOpenCodeRuntimeForTeam: OpenCodePromptDeliveryWatchdogCoordinatorPorts['canDeliverToTeamRuntime'];
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog: OpenCodePromptDeliveryWatchdogCoordinatorPorts['recoverRuntimeLanesForWatchdog'];
  openCodeStoppedLaneCleanup: {
    stopOpenCodeRuntimeLanesForStoppedTeam: OpenCodePromptDeliveryWatchdogCoordinatorPorts['stopRuntimeLanesForStoppedTeam'];
  };
  createOpenCodePromptDeliveryLedger: OpenCodePromptDeliveryWatchdogCoordinatorPorts['createLedger'];
  openCodeRuntimeRecoveryIdentity: {
    resolveOpenCodeMembersForRuntimeLane: OpenCodePromptDeliveryWatchdogCoordinatorPorts['resolveMembersForRuntimeLane'];
    resolveCurrentOpenCodeRuntimeRunId: OpenCodePromptDeliveryWatchdogCoordinatorPorts['resolveCurrentRuntimeRunId'];
  };
  logOpenCodePromptDeliveryEvent: OpenCodePromptDeliveryWatchdogCoordinatorPorts['logPromptDeliveryEvent'];
}

export interface TeamProvisioningServiceCompositionDeps {
  configReader: TeamConfigReader;
  inboxReader: TeamInboxReader;
  membersMetaStore: TeamMembersMetaStore;
  launchStateStore: TeamLaunchStateStore;
  persistedTeamConfigCache: Map<string, PersistedTeamConfigCacheEntry>;
  retainedProvisioningProgressState: TeamProvisioningRetainedProgressState;
  cancellationBoundary: TeamProvisioningCancellationBoundary;
  runTracking: TeamProvisioningCompatibilityDelegation<ProvisioningRun>['runTracking'];
  runs: ReadonlyMap<string, ProvisioningRun>;
  sendMessageToRunBoundary: TeamProvisioningSendMessageToRunBoundary<ProvisioningRun>;
  transientProbeProcesses: Set<ReturnType<typeof spawn>>;
  openCodePromptDeliveryWatchdogScheduler: OpenCodePromptDeliveryWatchdogScheduler;
}

export interface TeamProvisioningServiceComposition {
  configFacade: TeamProvisioningConfigFacade;
  liveRuntimeMetadataPorts: TeamProvisioningRuntimeProjection['liveRuntimeMetadataPorts'];
  runtimeSnapshotFacade: TeamProvisioningRuntimeProjection['runtimeSnapshotFacade'];
  openCodeRuntimeLaneRecoveryFacade: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade;
  openCodeRuntimeDeliveryBoundaryHost: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun>;
  launchStateStoreBoundary: TeamProvisioningLaunchStateStoreBoundary;
  configTaskActivityBoundary: TeamProvisioningConfigTaskActivityBoundary<ProvisioningRun>;
  toolApprovalFacade: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  idlePromptInjectionBoundary: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  providerRuntime: TeamProvisioningProviderRuntimeFacade;
  providerRuntimeCompatibility: TeamProvisioningProviderRuntimeCompatibility;
  compatibilityDelegation: TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  outputRecoveryFacade: TeamProvisioningOutputRecoveryFacade<ProvisioningRun>;
  deterministicLaunchFlowBoundary: TeamProvisioningLaunchDeterministicFlowBoundary<MixedSecondaryRuntimeLaneState>;
  deterministicCreateSpawnFlowBoundary: TeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>;
  verificationProbePorts: TeamProvisioningVerificationProbePorts<ProvisioningRun>;
  processExitPorts: TeamProvisioningProcessExitPorts<ProvisioningRun>;
  prepareFacade: TeamProvisioningPrepareFacade;
  memberMcpLaunchConfigProvisioner: TeamProvisioningMemberMcpLaunchConfigProvisioner<ProvisioningRun>;
  openCodeVisibleReplyProofService: OpenCodeVisibleReplyProofService;
  openCodePromptDeliveryWatchdogCoordinator: OpenCodePromptDeliveryWatchdogCoordinator;
  bootstrapTranscriptFacade: TeamProvisioningBootstrapTranscriptFacade;
  sameTeamNativeDelivery: TeamProvisioningSameTeamNativeDelivery;
  cleanupRunPorts: TeamProvisioningCleanupPorts<ProvisioningRun>;
  transientRunState: TeamProvisioningTransientRunState;
}

function getRunRuntimeFailureLabel(run: ProvisioningRun): string {
  return getRuntimeFailureLabelForRequest(run.request);
}

function assignCompositionPart<K extends keyof TeamProvisioningServiceComposition>(
  service: unknown,
  key: K,
  value: TeamProvisioningServiceComposition[K]
): void {
  (service as Record<K, TeamProvisioningServiceComposition[K]>)[key] = value;
}

export function createTeamProvisioningServiceComposition(
  service: unknown
): TeamProvisioningServiceComposition {
  const servicePorts = service as ServiceCompositionPorts;
  const deps = service as TeamProvisioningServiceCompositionDeps;
  const configFacade = new TeamProvisioningConfigFacade({
    configReader: {
      getConfig: (teamName) => deps.configReader.getConfig(teamName),
      getConfigSnapshot: (teamName) =>
        typeof deps.configReader.getConfigSnapshot === 'function'
          ? deps.configReader.getConfigSnapshot(teamName)
          : deps.configReader.getConfig(teamName),
    },
    inboxReader: deps.inboxReader,
    membersMetaStore: deps.membersMetaStore,
    launchStateStore: deps.launchStateStore,
    persistedTeamConfigCache: deps.persistedTeamConfigCache,
    readBootstrapLaunchSnapshot,
    readRegularFileUtf8: tryReadRegularFileUtf8,
    logger,
  });
  assignCompositionPart(service, 'configFacade', configFacade);
  const runtimeProjection = createTeamProvisioningRuntimeProjectionFromService<
    ProvisioningRun,
    RuntimeAdapterRunByTeamEntry
  >(
    service as TeamProvisioningRuntimeProjectionServiceHost<
      ProvisioningRun,
      RuntimeAdapterRunByTeamEntry
    >,
    {
      readBootstrapRuntimeState,
      logDebug: (message) => logger.debug(message),
    }
  );
  assignCompositionPart(
    service,
    'liveRuntimeMetadataPorts',
    runtimeProjection.liveRuntimeMetadataPorts
  );
  assignCompositionPart(service, 'runtimeSnapshotFacade', runtimeProjection.runtimeSnapshotFacade);
  const openCodeRuntimeLaneRecoveryFacade =
    createTeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeFromService(
      service as TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeServiceHost,
      {
        getTeamsBasePath,
        logger,
      }
    );
  assignCompositionPart(
    service,
    'openCodeRuntimeLaneRecoveryFacade',
    openCodeRuntimeLaneRecoveryFacade
  );
  const openCodeRuntimeDeliveryBoundaryHost =
    servicePorts.createOpenCodeRuntimeDeliveryBoundaryHost();
  assignCompositionPart(
    service,
    'openCodeRuntimeDeliveryBoundaryHost',
    openCodeRuntimeDeliveryBoundaryHost
  );
  const launchStateStoreBoundary = createTeamProvisioningLaunchStateStoreBoundaryFromService(
    service as TeamProvisioningLaunchStateStoreBoundaryServiceHost,
    {
      areSnapshotsSemanticallyEqual: areLaunchStateSnapshotsSemanticallyEqual,
      clearBootstrapState,
      logDebug: (message) => logger.debug(message),
      nowMs: () => Date.now(),
    }
  );
  assignCompositionPart(service, 'launchStateStoreBoundary', launchStateStoreBoundary);
  const configTaskActivityBoundary =
    createTeamProvisioningConfigTaskActivityBoundaryFromService<ProvisioningRun>(
      service as TeamProvisioningConfigTaskActivityBoundaryServiceHost,
      { logger }
    );
  assignCompositionPart(service, 'configTaskActivityBoundary', configTaskActivityBoundary);
  const toolApprovalFacade = createTeamProvisioningToolApprovalFacadeFromService<ProvisioningRun>(
    service as TeamProvisioningToolApprovalFacadeServiceHost<ProvisioningRun>,
    {
      logger,
      nowIso,
      nowMs: () => Date.now(),
      joinPath: (...parts) => path.join(...parts),
      teammateOperationalToolNames: AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
    }
  );
  assignCompositionPart(service, 'toolApprovalFacade', toolApprovalFacade);
  const idlePromptInjectionBoundary =
    createTeamProvisioningIdlePromptInjectionBoundaryFromService<ProvisioningRun>(
      service as TeamProvisioningIdlePromptInjectionServiceHost<ProvisioningRun>,
      { logger }
    );
  assignCompositionPart(service, 'idlePromptInjectionBoundary', idlePromptInjectionBoundary);
  const providerRuntime = createTeamProvisioningProviderRuntimeFacadeFromService(
    service as TeamProvisioningProviderRuntimeFacadeServiceHost,
    {
      transientProbeProcesses: deps.transientProbeProcesses,
      logger,
      isAuthFailureWarning,
      normalizeApiRetryErrorMessage,
    }
  );
  assignCompositionPart(service, 'providerRuntime', providerRuntime);
  const providerRuntimeCompatibility =
    createTeamProvisioningProviderRuntimeCompatibility(providerRuntime);
  assignCompositionPart(service, 'providerRuntimeCompatibility', providerRuntimeCompatibility);
  const compatibilityDelegation: TeamProvisioningCompatibilityDelegation<ProvisioningRun> = {
    providerRuntimeCompatibility,
    configFacade,
    configTaskActivityBoundary,
    retainedProvisioningProgressState: deps.retainedProvisioningProgressState,
    cancellationBoundary: deps.cancellationBoundary,
    runtimeSnapshotFacade: runtimeProjection.runtimeSnapshotFacade,
    runTracking: deps.runTracking,
    runs: deps.runs,
    sendMessageToRunBoundary: deps.sendMessageToRunBoundary,
  };
  assignCompositionPart(service, 'compatibilityDelegation', compatibilityDelegation);
  const outputRecoveryFacade =
    createTeamProvisioningOutputRecoveryFacadeFromService<ProvisioningRun>(
      service as TeamProvisioningOutputRecoveryFacadeServiceHost<ProvisioningRun>,
      {
        logger,
        killTeamProcess,
        updateProgress,
        emitLogsProgress,
        nowIso,
      }
    );
  assignCompositionPart(service, 'outputRecoveryFacade', outputRecoveryFacade);
  const deterministicLaunchFlowHost = createTeamProvisioningLaunchDeterministicFlowHostFromService<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >(
    service as TeamProvisioningLaunchDeterministicFlowServiceHost<
      ProvisioningRun,
      MixedSecondaryRuntimeLaneState
    >
  );
  const deterministicLaunchFlowBoundary = createTeamProvisioningLaunchDeterministicFlowBoundary<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >({
    host: deterministicLaunchFlowHost,
    launchExpectedMembersPorts: configFacade.launchExpectedMembersPorts,
    createInitialMemberSpawnStatusEntry,
    randomUUID,
    nowIso,
    logger,
    spawnCli,
    updateProgress,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    killTeamProcess,
  });
  assignCompositionPart(
    service,
    'deterministicLaunchFlowBoundary',
    deterministicLaunchFlowBoundary
  );
  const deterministicCreateSpawnFlowBoundary =
    createTeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>(
      createTeamProvisioningCreateDeterministicSpawnFlowDepsFromService(
        service as TeamProvisioningCreateDeterministicSpawnFlowServiceHost<ProvisioningRun>,
        {
          spawnCli,
          updateProgress,
          killTeamProcess,
        }
      )
    );
  assignCompositionPart(
    service,
    'deterministicCreateSpawnFlowBoundary',
    deterministicCreateSpawnFlowBoundary
  );
  const verificationProbePorts = createTeamProvisioningVerificationProbePorts<ProvisioningRun>(
    createTeamProvisioningVerificationProbePortsDepsFromService(
      service as TeamProvisioningVerificationProbeServiceHost<ProvisioningRun>,
      {
        getTeamsBasePath,
        readRegularFileUtf8: tryReadRegularFileUtf8,
        updateProgress,
        verifyTimeoutMs: VERIFY_TIMEOUT_MS,
        verifyPollMs: VERIFY_POLL_MS,
        teamJsonReadTimeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        teamConfigMaxBytes: TEAM_CONFIG_MAX_BYTES,
        sleep,
      }
    )
  );
  assignCompositionPart(service, 'verificationProbePorts', verificationProbePorts);
  const processExitPorts = createTeamProvisioningProcessExitPorts<ProvisioningRun>(
    createTeamProvisioningProcessExitPortsDepsFromService(
      service as TeamProvisioningProcessExitServiceHost<ProvisioningRun>,
      {
        verificationProbePorts,
        logger,
        updateProgress,
        getTeamsBasePath,
        getAutoDetectedClaudeBasePath,
        getConfiguredCliCommandLabel,
        getRunRuntimeFailureLabel,
        getVerificationTimeoutMs: () => VERIFY_TIMEOUT_MS,
        extractCliLogsFromRun,
        logsSuggestShutdownOrCleanup,
      }
    )
  );
  assignCompositionPart(service, 'processExitPorts', processExitPorts);
  const prepareFacade = createTeamProvisioningPrepareFacadeFromService(
    service as TeamProvisioningPrepareFacadeServiceHost,
    {
      resolveClaudeBinaryPath: () => ClaudeBinaryResolver.resolve(),
      execCli,
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
    }
  );
  assignCompositionPart(service, 'prepareFacade', prepareFacade);
  const memberMcpLaunchConfigProvisioner =
    createTeamProvisioningMemberMcpLaunchConfigProvisionerFromService(
      service as TeamProvisioningMemberMcpLaunchConfigServiceHost<ProvisioningRun>,
      { ensureCwdExists }
    );
  assignCompositionPart(
    service,
    'memberMcpLaunchConfigProvisioner',
    memberMcpLaunchConfigProvisioner
  );
  const openCodeVisibleReplyProofService = createOpenCodeVisibleReplyProofServiceFromHost(
    service as OpenCodeVisibleReplyProofServiceHost,
    {
      warn: (message) => logger.warn(message),
      getErrorMessage,
      nowIso,
    }
  );
  assignCompositionPart(
    service,
    'openCodeVisibleReplyProofService',
    openCodeVisibleReplyProofService
  );
  const openCodePromptDeliveryWatchdogCoordinator = createOpenCodePromptDeliveryWatchdogCoordinator(
    {
      hasAcceptedMemberWorkSyncReport: (input) =>
        servicePorts.memberWorkSyncProofBoundary.hasAcceptedMemberWorkSyncReport(input),
      taskRefsIncludeAll: openCodeTaskRefsIncludeAllValue,
      visibleReplyProofService: openCodeVisibleReplyProofService,
      maybeSyncRuntimePermissionsAfterDelivery: (input) =>
        servicePorts.maybeSyncOpenCodeRuntimePermissionsAfterDelivery(input),
      rememberRuntimePidFromBridge: (input) =>
        servicePorts.rememberOpenCodeRuntimePidFromBridge(input),
      watchdogScheduler: deps.openCodePromptDeliveryWatchdogScheduler,
      schedulePromptDeliveryWatchdog: (input) =>
        servicePorts.scheduleOpenCodePromptDeliveryWatchdog(input),
      canDeliverToTeamRuntime: (teamName) =>
        servicePorts.canDeliverToOpenCodeRuntimeForTeam(teamName),
      recoverRuntimeLanesForWatchdog: (teamName, options) =>
        servicePorts.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(teamName, options),
      stopRuntimeLanesForStoppedTeam: (teamName) =>
        servicePorts.openCodeStoppedLaneCleanup.stopOpenCodeRuntimeLanesForStoppedTeam(teamName),
      readActiveRuntimeLaneIds: async (teamName) => {
        const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
          () => null
        );
        if (!laneIndex) {
          return null;
        }
        return Object.values(laneIndex.lanes)
          .filter((lane) => lane.state === 'active')
          .map((lane) => lane.laneId);
      },
      createLedger: (teamName, laneId) =>
        servicePorts.createOpenCodePromptDeliveryLedger(teamName, laneId),
      resolveMembersForRuntimeLane: (teamName, laneId) =>
        servicePorts.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMembersForRuntimeLane(
          teamName,
          laneId
        ),
      getInboxMessages: (teamName, memberName) =>
        deps.inboxReader.getMessagesFor(teamName, memberName),
      resolveCurrentRuntimeRunId: (teamName, laneId) =>
        servicePorts.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
          teamName,
          laneId
        ),
      hasStableInboxMessageId,
      logPromptDeliveryEvent: (event, record, extra) =>
        servicePorts.logOpenCodePromptDeliveryEvent(event, record, extra),
      info: (message, context) =>
        context === undefined ? logger.info(message) : logger.info(message, context),
      warn: (message) => logger.warn(message),
      nowIso,
      sleep,
      getErrorMessage,
    }
  );
  assignCompositionPart(
    service,
    'openCodePromptDeliveryWatchdogCoordinator',
    openCodePromptDeliveryWatchdogCoordinator
  );
  const bootstrapTranscriptFacade = createTeamProvisioningBootstrapTranscriptFacadeFromService(
    service as TeamProvisioningBootstrapTranscriptFacadeServiceHost,
    { nowIso }
  );
  assignCompositionPart(service, 'bootstrapTranscriptFacade', bootstrapTranscriptFacade);
  const sameTeamNativeDelivery = createDefaultTeamProvisioningSameTeamNativeDeliveryFromService(
    service as TeamProvisioningSameTeamNativeDeliveryServiceHost,
    { warn: (message) => logger.warn(message) }
  );
  assignCompositionPart(service, 'sameTeamNativeDelivery', sameTeamNativeDelivery);
  const cleanupRunPorts = createTeamProvisioningCleanupRunPorts<ProvisioningRun>(
    createTeamProvisioningCleanupRunPortsDepsFromService(
      service as TeamProvisioningCleanupRunServiceHost<ProvisioningRun>
    )
  );
  assignCompositionPart(service, 'cleanupRunPorts', cleanupRunPorts);
  const transientRunState = new TeamProvisioningTransientRunState(
    createTeamProvisioningTransientRunStatePortsFromService(
      service as TeamProvisioningTransientRunStateServiceHost,
      {
        cancelPendingAutoResume: (teamName) =>
          peekAutoResumeService()?.cancelPendingAutoResume(teamName),
        warn: (message) => logger.warn(message),
      }
    )
  );
  assignCompositionPart(service, 'transientRunState', transientRunState);

  return {
    configFacade,
    liveRuntimeMetadataPorts: runtimeProjection.liveRuntimeMetadataPorts,
    runtimeSnapshotFacade: runtimeProjection.runtimeSnapshotFacade,
    openCodeRuntimeLaneRecoveryFacade,
    openCodeRuntimeDeliveryBoundaryHost,
    launchStateStoreBoundary,
    configTaskActivityBoundary,
    toolApprovalFacade,
    idlePromptInjectionBoundary,
    providerRuntime,
    providerRuntimeCompatibility,
    compatibilityDelegation,
    outputRecoveryFacade,
    deterministicLaunchFlowBoundary,
    deterministicCreateSpawnFlowBoundary,
    verificationProbePorts,
    processExitPorts,
    prepareFacade,
    memberMcpLaunchConfigProvisioner,
    openCodeVisibleReplyProofService,
    openCodePromptDeliveryWatchdogCoordinator,
    bootstrapTranscriptFacade,
    sameTeamNativeDelivery,
    cleanupRunPorts,
    transientRunState,
  };
}
