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
  createTeamRuntimeControlCompatibilityApiFromService,
  type OpenCodeRuntimeControlApi,
  type TeamRuntimeControlCompatibilityServiceHost,
} from '../runtime-control';
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
  createTeamProvisioningBootstrapEvidenceFacadeFromService,
  TeamProvisioningBootstrapEvidenceFacade,
  type TeamProvisioningBootstrapEvidenceFacadeServiceHost,
} from './TeamProvisioningBootstrapEvidenceFacade';
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
import {
  createTeamProvisioningLaunchStateCompatibilityBoundaryFromService,
  type TeamProvisioningLaunchStateCompatibilityBoundary,
  type TeamProvisioningLaunchStateCompatibilityServiceHost,
} from './TeamProvisioningLaunchStateCompatibilityFacade';
import { areLaunchStateSnapshotsSemanticallyEqual } from './TeamProvisioningLaunchStateProjection';
import {
  createTeamProvisioningLaunchStateStoreBoundaryFromService,
  TeamProvisioningLaunchStateStoreBoundary,
  type TeamProvisioningLaunchStateStoreBoundaryServiceHost,
} from './TeamProvisioningLaunchStateStoreBoundary';
import {
  createTeamProvisioningLeadInboxRelayCompatibilityFacadeFromService,
  type TeamProvisioningLeadInboxRelayCompatibilityFacade,
  type TeamProvisioningLeadInboxRelayCompatibilityServiceHost,
} from './TeamProvisioningLeadInboxRelayCompatibilityFacade';
import {
  createTeamProvisioningMemberMcpLaunchConfigProvisionerFromService,
  TeamProvisioningMemberMcpLaunchConfigProvisioner,
  type TeamProvisioningMemberMcpLaunchConfigServiceHost,
} from './TeamProvisioningMemberMcpLaunchConfig';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  createOpenCodePromptDeliveryWatchdogSchedulerFromService,
  type TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
} from './TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerFactory';
import { type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost } from './TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import {
  createTeamProvisioningOpenCodeRuntimeRecoveryFacadeFromService,
  type TeamProvisioningOpenCodeRuntimeRecoveryFacade,
  type TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost,
} from './TeamProvisioningOpenCodeRuntimeRecoveryFacade';
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
  createTeamProvisioningPersistenceReconcileFacadeFromService,
  TeamProvisioningPersistenceReconcileFacade,
  type TeamProvisioningPersistenceReconcileFacadeServiceHost,
} from './TeamProvisioningPersistenceReconcileFacade';
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
import {
  createTeamProvisioningRequestAdmissionBoundary,
  type TeamProvisioningRequestAdmissionBoundary,
  type TeamProvisioningRequestAdmissionServiceHost,
} from './TeamProvisioningRequestAdmission';
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
}

export interface TeamProvisioningServiceComposition {
  configFacade: TeamProvisioningConfigFacade;
  liveRuntimeMetadataPorts: TeamProvisioningRuntimeProjection['liveRuntimeMetadataPorts'];
  runtimeSnapshotFacade: TeamProvisioningRuntimeProjection['runtimeSnapshotFacade'];
  openCodeRuntimeDeliveryBoundaryHost: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun>;
  launchStateStoreBoundary: TeamProvisioningLaunchStateStoreBoundary;
  persistenceReconcileFacade: TeamProvisioningPersistenceReconcileFacade<ProvisioningRun>;
  launchStateCompatibilityBoundary: TeamProvisioningLaunchStateCompatibilityBoundary<ProvisioningRun>;
  configTaskActivityBoundary: TeamProvisioningConfigTaskActivityBoundary<ProvisioningRun>;
  toolApprovalFacade: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  idlePromptInjectionBoundary: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  providerRuntime: TeamProvisioningProviderRuntimeFacade;
  providerRuntimeCompatibility: TeamProvisioningProviderRuntimeCompatibility;
  openCodeRuntimeRecoveryFacade: TeamProvisioningOpenCodeRuntimeRecoveryFacade;
  openCodePromptDeliveryWatchdogScheduler: OpenCodePromptDeliveryWatchdogScheduler;
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
  bootstrapEvidenceFacade: TeamProvisioningBootstrapEvidenceFacade;
  leadInboxRelayFacade: TeamProvisioningLeadInboxRelayCompatibilityFacade<ProvisioningRun>;
  cleanupRunPorts: TeamProvisioningCleanupPorts<ProvisioningRun>;
  transientRunState: TeamProvisioningTransientRunState;
  requestAdmissionBoundary: TeamProvisioningRequestAdmissionBoundary;
  openCodeRuntimeControlApi: OpenCodeRuntimeControlApi;
}

type TeamProvisioningServiceCompositionInstallTarget = {
  -readonly [K in keyof TeamProvisioningServiceComposition]?: TeamProvisioningServiceComposition[K];
};

type TeamProvisioningServiceCompositionSource = ServiceCompositionPorts &
  TeamProvisioningServiceCompositionDeps &
  TeamProvisioningRuntimeProjectionServiceHost<ProvisioningRun, RuntimeAdapterRunByTeamEntry> &
  TeamProvisioningLaunchStateStoreBoundaryServiceHost &
  TeamProvisioningPersistenceReconcileFacadeServiceHost<ProvisioningRun> &
  TeamProvisioningLaunchStateCompatibilityServiceHost<ProvisioningRun> &
  TeamProvisioningConfigTaskActivityBoundaryServiceHost &
  TeamProvisioningToolApprovalFacadeServiceHost<ProvisioningRun> &
  TeamProvisioningIdlePromptInjectionServiceHost<ProvisioningRun> &
  TeamProvisioningProviderRuntimeFacadeServiceHost &
  TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost &
  TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost &
  TeamProvisioningOutputRecoveryFacadeServiceHost<ProvisioningRun> &
  TeamProvisioningLaunchDeterministicFlowServiceHost<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  > &
  TeamProvisioningCreateDeterministicSpawnFlowServiceHost<ProvisioningRun> &
  TeamProvisioningVerificationProbeServiceHost<ProvisioningRun> &
  TeamProvisioningProcessExitServiceHost<ProvisioningRun> &
  TeamProvisioningPrepareFacadeServiceHost &
  TeamProvisioningMemberMcpLaunchConfigServiceHost<ProvisioningRun> &
  OpenCodeVisibleReplyProofServiceHost &
  TeamProvisioningBootstrapTranscriptFacadeServiceHost &
  TeamProvisioningBootstrapEvidenceFacadeServiceHost &
  TeamProvisioningLeadInboxRelayCompatibilityServiceHost<ProvisioningRun> &
  TeamProvisioningCleanupRunServiceHost<ProvisioningRun> &
  TeamProvisioningTransientRunStateServiceHost &
  TeamProvisioningRequestAdmissionServiceHost &
  TeamRuntimeControlCompatibilityServiceHost;

type TeamProvisioningServiceCompositionHost = TeamProvisioningServiceCompositionSource &
  TeamProvisioningServiceCompositionInstallTarget;

function getRunRuntimeFailureLabel(run: ProvisioningRun): string {
  return getRuntimeFailureLabelForRequest(run.request);
}

function assignCompositionPart<K extends keyof TeamProvisioningServiceComposition>(
  service: TeamProvisioningServiceCompositionInstallTarget,
  key: K,
  value: TeamProvisioningServiceComposition[K]
): void {
  service[key] = value;
}

export function createTeamProvisioningServiceComposition(
  service: unknown
): TeamProvisioningServiceComposition {
  const host = service as TeamProvisioningServiceCompositionHost;
  const servicePorts = host;
  const deps = host;
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
  assignCompositionPart(host, 'configFacade', configFacade);
  const runtimeProjection = createTeamProvisioningRuntimeProjectionFromService<
    ProvisioningRun,
    RuntimeAdapterRunByTeamEntry
  >(host, {
    readBootstrapRuntimeState,
    logDebug: (message) => logger.debug(message),
  });
  assignCompositionPart(
    host,
    'liveRuntimeMetadataPorts',
    runtimeProjection.liveRuntimeMetadataPorts
  );
  assignCompositionPart(host, 'runtimeSnapshotFacade', runtimeProjection.runtimeSnapshotFacade);
  const openCodeRuntimeDeliveryBoundaryHost =
    servicePorts.createOpenCodeRuntimeDeliveryBoundaryHost();
  assignCompositionPart(
    host,
    'openCodeRuntimeDeliveryBoundaryHost',
    openCodeRuntimeDeliveryBoundaryHost
  );
  const launchStateStoreBoundary = createTeamProvisioningLaunchStateStoreBoundaryFromService(host, {
    areSnapshotsSemanticallyEqual: areLaunchStateSnapshotsSemanticallyEqual,
    clearBootstrapState,
    logDebug: (message) => logger.debug(message),
    nowMs: () => Date.now(),
  });
  assignCompositionPart(host, 'launchStateStoreBoundary', launchStateStoreBoundary);
  const persistenceReconcileFacade =
    createTeamProvisioningPersistenceReconcileFacadeFromService(host);
  assignCompositionPart(host, 'persistenceReconcileFacade', persistenceReconcileFacade);
  const launchStateCompatibilityBoundary =
    createTeamProvisioningLaunchStateCompatibilityBoundaryFromService(host);
  assignCompositionPart(host, 'launchStateCompatibilityBoundary', launchStateCompatibilityBoundary);
  const configTaskActivityBoundary =
    createTeamProvisioningConfigTaskActivityBoundaryFromService<ProvisioningRun>(host, { logger });
  assignCompositionPart(host, 'configTaskActivityBoundary', configTaskActivityBoundary);
  const toolApprovalFacade = createTeamProvisioningToolApprovalFacadeFromService<ProvisioningRun>(
    host,
    {
      logger,
      nowIso,
      nowMs: () => Date.now(),
      joinPath: (...parts) => path.join(...parts),
      teammateOperationalToolNames: AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
    }
  );
  assignCompositionPart(host, 'toolApprovalFacade', toolApprovalFacade);
  const idlePromptInjectionBoundary =
    createTeamProvisioningIdlePromptInjectionBoundaryFromService<ProvisioningRun>(host, { logger });
  assignCompositionPart(host, 'idlePromptInjectionBoundary', idlePromptInjectionBoundary);
  const providerRuntime = createTeamProvisioningProviderRuntimeFacadeFromService(host, {
    transientProbeProcesses: deps.transientProbeProcesses,
    logger,
    isAuthFailureWarning,
    normalizeApiRetryErrorMessage,
  });
  assignCompositionPart(host, 'providerRuntime', providerRuntime);
  const providerRuntimeCompatibility =
    createTeamProvisioningProviderRuntimeCompatibility(providerRuntime);
  assignCompositionPart(host, 'providerRuntimeCompatibility', providerRuntimeCompatibility);
  const openCodeRuntimeRecoveryFacade =
    createTeamProvisioningOpenCodeRuntimeRecoveryFacadeFromService(host, {
      getTeamsBasePath,
      logger,
    });
  assignCompositionPart(host, 'openCodeRuntimeRecoveryFacade', openCodeRuntimeRecoveryFacade);
  const openCodePromptDeliveryWatchdogScheduler =
    createOpenCodePromptDeliveryWatchdogSchedulerFromService(host, {
      logger,
      getErrorMessage,
    });
  assignCompositionPart(
    host,
    'openCodePromptDeliveryWatchdogScheduler',
    openCodePromptDeliveryWatchdogScheduler
  );
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
  assignCompositionPart(host, 'compatibilityDelegation', compatibilityDelegation);
  const outputRecoveryFacade =
    createTeamProvisioningOutputRecoveryFacadeFromService<ProvisioningRun>(host, {
      logger,
      killTeamProcess,
      updateProgress,
      emitLogsProgress,
      nowIso,
    });
  assignCompositionPart(host, 'outputRecoveryFacade', outputRecoveryFacade);
  const deterministicLaunchFlowHost = createTeamProvisioningLaunchDeterministicFlowHostFromService<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >(host);
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
  assignCompositionPart(host, 'deterministicLaunchFlowBoundary', deterministicLaunchFlowBoundary);
  const deterministicCreateSpawnFlowBoundary =
    createTeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>(
      createTeamProvisioningCreateDeterministicSpawnFlowDepsFromService(host, {
        spawnCli,
        updateProgress,
        killTeamProcess,
      })
    );
  assignCompositionPart(
    host,
    'deterministicCreateSpawnFlowBoundary',
    deterministicCreateSpawnFlowBoundary
  );
  const verificationProbePorts = createTeamProvisioningVerificationProbePorts<ProvisioningRun>(
    createTeamProvisioningVerificationProbePortsDepsFromService(host, {
      getTeamsBasePath,
      readRegularFileUtf8: tryReadRegularFileUtf8,
      updateProgress,
      verifyTimeoutMs: VERIFY_TIMEOUT_MS,
      verifyPollMs: VERIFY_POLL_MS,
      teamJsonReadTimeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      teamConfigMaxBytes: TEAM_CONFIG_MAX_BYTES,
      sleep,
    })
  );
  assignCompositionPart(host, 'verificationProbePorts', verificationProbePorts);
  const processExitPorts = createTeamProvisioningProcessExitPorts<ProvisioningRun>(
    createTeamProvisioningProcessExitPortsDepsFromService(host, {
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
    })
  );
  assignCompositionPart(host, 'processExitPorts', processExitPorts);
  const prepareFacade = createTeamProvisioningPrepareFacadeFromService(host, {
    resolveClaudeBinaryPath: () => ClaudeBinaryResolver.resolve(),
    execCli,
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
  });
  assignCompositionPart(host, 'prepareFacade', prepareFacade);
  const memberMcpLaunchConfigProvisioner =
    createTeamProvisioningMemberMcpLaunchConfigProvisionerFromService(host, { ensureCwdExists });
  assignCompositionPart(host, 'memberMcpLaunchConfigProvisioner', memberMcpLaunchConfigProvisioner);
  const openCodeVisibleReplyProofService = createOpenCodeVisibleReplyProofServiceFromHost(host, {
    warn: (message) => logger.warn(message),
    getErrorMessage,
    nowIso,
  });
  assignCompositionPart(host, 'openCodeVisibleReplyProofService', openCodeVisibleReplyProofService);
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
      watchdogScheduler: openCodePromptDeliveryWatchdogScheduler,
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
    host,
    'openCodePromptDeliveryWatchdogCoordinator',
    openCodePromptDeliveryWatchdogCoordinator
  );
  const bootstrapTranscriptFacade = createTeamProvisioningBootstrapTranscriptFacadeFromService(
    host,
    { nowIso }
  );
  assignCompositionPart(host, 'bootstrapTranscriptFacade', bootstrapTranscriptFacade);
  const bootstrapEvidenceFacade = createTeamProvisioningBootstrapEvidenceFacadeFromService(host, {
    getTeamsBasePath,
    nowIso,
    warn: (message) => logger.warn(message),
  });
  assignCompositionPart(host, 'bootstrapEvidenceFacade', bootstrapEvidenceFacade);
  const leadInboxRelayFacade = createTeamProvisioningLeadInboxRelayCompatibilityFacadeFromService(
    host,
    {
      logger,
      getErrorMessage,
      nowIso,
      nowMs: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    }
  );
  assignCompositionPart(host, 'leadInboxRelayFacade', leadInboxRelayFacade);
  const cleanupRunPorts = createTeamProvisioningCleanupRunPorts<ProvisioningRun>(
    createTeamProvisioningCleanupRunPortsDepsFromService(host)
  );
  assignCompositionPart(host, 'cleanupRunPorts', cleanupRunPorts);
  const transientRunState = new TeamProvisioningTransientRunState(
    createTeamProvisioningTransientRunStatePortsFromService(host, {
      cancelPendingAutoResume: (teamName) =>
        peekAutoResumeService()?.cancelPendingAutoResume(teamName),
      warn: (message) => logger.warn(message),
    })
  );
  assignCompositionPart(host, 'transientRunState', transientRunState);
  const requestAdmissionBoundary = createTeamProvisioningRequestAdmissionBoundary(host);
  assignCompositionPart(host, 'requestAdmissionBoundary', requestAdmissionBoundary);
  const openCodeRuntimeControlApi = createTeamRuntimeControlCompatibilityApiFromService(host);
  assignCompositionPart(host, 'openCodeRuntimeControlApi', openCodeRuntimeControlApi);

  return {
    configFacade,
    liveRuntimeMetadataPorts: runtimeProjection.liveRuntimeMetadataPorts,
    runtimeSnapshotFacade: runtimeProjection.runtimeSnapshotFacade,
    openCodeRuntimeDeliveryBoundaryHost,
    launchStateStoreBoundary,
    persistenceReconcileFacade,
    launchStateCompatibilityBoundary,
    configTaskActivityBoundary,
    toolApprovalFacade,
    idlePromptInjectionBoundary,
    providerRuntime,
    providerRuntimeCompatibility,
    openCodeRuntimeRecoveryFacade,
    openCodePromptDeliveryWatchdogScheduler,
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
    bootstrapEvidenceFacade,
    leadInboxRelayFacade,
    cleanupRunPorts,
    transientRunState,
    requestAdmissionBoundary,
    openCodeRuntimeControlApi,
  };
}
