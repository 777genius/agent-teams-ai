import * as runtimeProviderManagementMain from '@features/runtime-provider-management/main';
import {
  createTeamProvisioningApplicationFeature,
  createTeamProvisioningStatusFeature,
  type TeamProvisioningApplicationFeature,
} from '@features/team-provisioning/main';
import { execCli, spawnCli } from '@main/utils/childProcess';
import { getAutoDetectedClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
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

import { cleanupRunOwnedAnthropicApiKeyHelper } from './TeamProvisioningAnthropicApiKeyHelperLease';
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
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost,
} from './TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
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
  killTeamProcessAndWait,
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
import type { TeamProvisioningServiceCompositionDeps } from './TeamProvisioningServiceCompositionDeps';
import type { TeamProviderId } from '@shared/types';

export type { TeamProvisioningServiceCompositionDeps } from './TeamProvisioningServiceCompositionDeps';

const logger = createLogger('Service:TeamProvisioning');
const { AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES } = agentTeamsControllerModule;
export interface RuntimeAdapterRunByTeamEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  allowExperimentalLocalModels?: boolean;
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
  applicationFeature: TeamProvisioningApplicationFeature;
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

export const TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS = [
  'configFacade',
  'liveRuntimeMetadataPorts',
  'runtimeSnapshotFacade',
  'openCodeRuntimeDeliveryBoundaryHost',
  'launchStateStoreBoundary',
  'persistenceReconcileFacade',
  'launchStateCompatibilityBoundary',
  'configTaskActivityBoundary',
  'toolApprovalFacade',
  'idlePromptInjectionBoundary',
  'providerRuntime',
  'providerRuntimeCompatibility',
  'openCodeRuntimeRecoveryFacade',
  'openCodePromptDeliveryWatchdogScheduler',
  'applicationFeature',
  'compatibilityDelegation',
  'outputRecoveryFacade',
  'deterministicLaunchFlowBoundary',
  'deterministicCreateSpawnFlowBoundary',
  'verificationProbePorts',
  'processExitPorts',
  'prepareFacade',
  'memberMcpLaunchConfigProvisioner',
  'openCodeVisibleReplyProofService',
  'openCodePromptDeliveryWatchdogCoordinator',
  'bootstrapTranscriptFacade',
  'bootstrapEvidenceFacade',
  'leadInboxRelayFacade',
  'cleanupRunPorts',
  'transientRunState',
  'requestAdmissionBoundary',
  'openCodeRuntimeControlApi',
] as const satisfies readonly (keyof TeamProvisioningServiceComposition)[];

type MissingTeamProvisioningServiceCompositionKey = Exclude<
  keyof TeamProvisioningServiceComposition,
  (typeof TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS)[number]
>;

type DuplicateTeamProvisioningServiceCompositionKey<
  Keys extends readonly PropertyKey[],
  Seen extends PropertyKey = never,
> = Keys extends readonly [
  infer Key extends PropertyKey,
  ...infer RemainingKeys extends readonly PropertyKey[],
]
  ? Key extends Seen
    ? Key
    : DuplicateTeamProvisioningServiceCompositionKey<RemainingKeys, Seen | Key>
  : never;

export const TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_EXHAUSTIVE: [
  MissingTeamProvisioningServiceCompositionKey,
] extends [never]
  ? true
  : false = true;

export const TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_UNIQUE: [
  DuplicateTeamProvisioningServiceCompositionKey<typeof TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS>,
] extends [never]
  ? true
  : false = true;

type TeamProvisioningServiceCompositionInstallTarget = {
  -readonly [K in keyof TeamProvisioningServiceComposition]?: TeamProvisioningServiceComposition[K];
};

interface TeamProvisioningServiceCompositionHostAdapters {
  installTarget: TeamProvisioningServiceCompositionInstallTarget;
  ports: ServiceCompositionPorts;
  deps: TeamProvisioningServiceCompositionDeps;
  runtimeProjection: TeamProvisioningRuntimeProjectionServiceHost<
    ProvisioningRun,
    RuntimeAdapterRunByTeamEntry
  >;
  launchStateStore: TeamProvisioningLaunchStateStoreBoundaryServiceHost;
  persistenceReconcile: TeamProvisioningPersistenceReconcileFacadeServiceHost<ProvisioningRun>;
  launchStateCompatibility: TeamProvisioningLaunchStateCompatibilityServiceHost<ProvisioningRun>;
  configTaskActivity: TeamProvisioningConfigTaskActivityBoundaryServiceHost;
  toolApproval: TeamProvisioningToolApprovalFacadeServiceHost<ProvisioningRun>;
  idlePromptInjection: TeamProvisioningIdlePromptInjectionServiceHost<ProvisioningRun>;
  providerRuntime: TeamProvisioningProviderRuntimeFacadeServiceHost;
  openCodeRuntimeRecovery: TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost;
  watchdogScheduler: TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost;
  outputRecovery: TeamProvisioningOutputRecoveryFacadeServiceHost<ProvisioningRun>;
  deterministicLaunch: TeamProvisioningLaunchDeterministicFlowServiceHost<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >;
  deterministicCreateSpawn: TeamProvisioningCreateDeterministicSpawnFlowServiceHost<ProvisioningRun>;
  verificationProbe: TeamProvisioningVerificationProbeServiceHost<ProvisioningRun>;
  processExit: TeamProvisioningProcessExitServiceHost<ProvisioningRun>;
  prepare: TeamProvisioningPrepareFacadeServiceHost;
  memberMcpLaunchConfig: TeamProvisioningMemberMcpLaunchConfigServiceHost<ProvisioningRun>;
  visibleReplyProof: OpenCodeVisibleReplyProofServiceHost;
  bootstrapTranscript: TeamProvisioningBootstrapTranscriptFacadeServiceHost;
  bootstrapEvidence: TeamProvisioningBootstrapEvidenceFacadeServiceHost;
  leadInboxRelay: TeamProvisioningLeadInboxRelayCompatibilityServiceHost<ProvisioningRun>;
  cleanupRun: TeamProvisioningCleanupRunServiceHost<ProvisioningRun>;
  transientRunState: TeamProvisioningTransientRunStateServiceHost;
  requestAdmission: TeamProvisioningRequestAdmissionServiceHost;
  runtimeControl: TeamRuntimeControlCompatibilityServiceHost;
}

function createTeamProvisioningServiceCompositionHostAdapters(
  service: object
): TeamProvisioningServiceCompositionHostAdapters {
  return {
    installTarget: service as TeamProvisioningServiceCompositionInstallTarget,
    ports: service as ServiceCompositionPorts,
    deps: service as TeamProvisioningServiceCompositionDeps,
    runtimeProjection: service as TeamProvisioningRuntimeProjectionServiceHost<
      ProvisioningRun,
      RuntimeAdapterRunByTeamEntry
    >,
    launchStateStore: service as TeamProvisioningLaunchStateStoreBoundaryServiceHost,
    persistenceReconcile:
      service as TeamProvisioningPersistenceReconcileFacadeServiceHost<ProvisioningRun>,
    launchStateCompatibility:
      service as TeamProvisioningLaunchStateCompatibilityServiceHost<ProvisioningRun>,
    configTaskActivity: service as TeamProvisioningConfigTaskActivityBoundaryServiceHost,
    toolApproval: service as TeamProvisioningToolApprovalFacadeServiceHost<ProvisioningRun>,
    idlePromptInjection: service as TeamProvisioningIdlePromptInjectionServiceHost<ProvisioningRun>,
    providerRuntime: service as TeamProvisioningProviderRuntimeFacadeServiceHost,
    openCodeRuntimeRecovery: service as TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost,
    watchdogScheduler:
      service as TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
    outputRecovery: service as TeamProvisioningOutputRecoveryFacadeServiceHost<ProvisioningRun>,
    deterministicLaunch: service as TeamProvisioningLaunchDeterministicFlowServiceHost<
      ProvisioningRun,
      MixedSecondaryRuntimeLaneState
    >,
    deterministicCreateSpawn:
      service as TeamProvisioningCreateDeterministicSpawnFlowServiceHost<ProvisioningRun>,
    verificationProbe: service as TeamProvisioningVerificationProbeServiceHost<ProvisioningRun>,
    processExit: service as TeamProvisioningProcessExitServiceHost<ProvisioningRun>,
    prepare: service as TeamProvisioningPrepareFacadeServiceHost,
    memberMcpLaunchConfig:
      service as TeamProvisioningMemberMcpLaunchConfigServiceHost<ProvisioningRun>,
    visibleReplyProof: service as OpenCodeVisibleReplyProofServiceHost,
    bootstrapTranscript: service as TeamProvisioningBootstrapTranscriptFacadeServiceHost,
    bootstrapEvidence: service as TeamProvisioningBootstrapEvidenceFacadeServiceHost,
    leadInboxRelay:
      service as TeamProvisioningLeadInboxRelayCompatibilityServiceHost<ProvisioningRun>,
    cleanupRun: service as TeamProvisioningCleanupRunServiceHost<ProvisioningRun>,
    transientRunState: service as TeamProvisioningTransientRunStateServiceHost,
    requestAdmission: service as TeamProvisioningRequestAdmissionServiceHost,
    runtimeControl: service as TeamRuntimeControlCompatibilityServiceHost,
  };
}

function getRunRuntimeFailureLabel(run: ProvisioningRun): string {
  return getRuntimeFailureLabelForRequest(run.request);
}

export function createTeamProvisioningServiceComposition(
  service: object
): TeamProvisioningServiceComposition {
  const host = createTeamProvisioningServiceCompositionHostAdapters(service);
  const installTarget = host.installTarget;
  const servicePorts = host.ports;
  const deps = host.deps;
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
  installTarget.configFacade = configFacade;
  const runtimeProjection = createTeamProvisioningRuntimeProjectionFromService<
    ProvisioningRun,
    RuntimeAdapterRunByTeamEntry
  >(host.runtimeProjection, {
    readBootstrapRuntimeState,
    logDebug: (message) => logger.debug(message),
  });
  installTarget.liveRuntimeMetadataPorts = runtimeProjection.liveRuntimeMetadataPorts;
  installTarget.runtimeSnapshotFacade = runtimeProjection.runtimeSnapshotFacade;
  const openCodePromptDeliveryWatchdogScheduler =
    createOpenCodePromptDeliveryWatchdogSchedulerFromService(host.watchdogScheduler, {
      logger,
      getErrorMessage,
    });
  installTarget.openCodePromptDeliveryWatchdogScheduler = openCodePromptDeliveryWatchdogScheduler;
  const openCodeRuntimeDeliveryBoundaryHost =
    servicePorts.createOpenCodeRuntimeDeliveryBoundaryHost();
  installTarget.openCodeRuntimeDeliveryBoundaryHost = openCodeRuntimeDeliveryBoundaryHost;
  const launchStateStoreBoundary = createTeamProvisioningLaunchStateStoreBoundaryFromService(
    host.launchStateStore,
    {
      areSnapshotsSemanticallyEqual: areLaunchStateSnapshotsSemanticallyEqual,
      clearBootstrapState,
      logDebug: (message) => logger.debug(message),
      nowMs: () => Date.now(),
    }
  );
  installTarget.launchStateStoreBoundary = launchStateStoreBoundary;
  const persistenceReconcileFacade = createTeamProvisioningPersistenceReconcileFacadeFromService(
    host.persistenceReconcile
  );
  installTarget.persistenceReconcileFacade = persistenceReconcileFacade;
  const launchStateCompatibilityBoundary =
    createTeamProvisioningLaunchStateCompatibilityBoundaryFromService(
      host.launchStateCompatibility
    );
  installTarget.launchStateCompatibilityBoundary = launchStateCompatibilityBoundary;
  const configTaskActivityBoundary =
    createTeamProvisioningConfigTaskActivityBoundaryFromService<ProvisioningRun>(
      host.configTaskActivity,
      { logger }
    );
  installTarget.configTaskActivityBoundary = configTaskActivityBoundary;
  const toolApprovalFacade = createTeamProvisioningToolApprovalFacadeFromService<ProvisioningRun>(
    host.toolApproval,
    {
      logger,
      nowIso,
      nowMs: () => Date.now(),
      joinPath: (...parts) => path.join(...parts),
      teammateOperationalToolNames: AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
    }
  );
  installTarget.toolApprovalFacade = toolApprovalFacade;
  const openCodeRuntimeControlApi = createTeamRuntimeControlCompatibilityApiFromService(
    host.runtimeControl
  );
  installTarget.openCodeRuntimeControlApi = openCodeRuntimeControlApi;
  const runtimeDeliveryBoundary =
    createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost<ProvisioningRun>(
      openCodeRuntimeDeliveryBoundaryHost,
      {
        getTeamsBasePath,
        nowIso,
        logger,
      }
    );
  const applicationFeature = createTeamProvisioningApplicationFeature({
    runtimeSnapshot: {
      readByTeamName: runtimeProjection.runtimeSnapshotFacade.getTeamAgentRuntimeSnapshot.bind(
        runtimeProjection.runtimeSnapshotFacade
      ),
    },
    toolApproval: {
      respondToToolApproval: ({ teamName, runId, requestId, allow, message }) =>
        toolApprovalFacade.respondToToolApproval(teamName, runId, requestId, allow, message),
      updateToolApprovalSettings: ({ teamName, settings }) =>
        toolApprovalFacade.updateToolApprovalSettings(teamName, settings),
    },
    runtimeDelivery: {
      deliverRuntimeMessage:
        openCodeRuntimeControlApi.deliverOpenCodeRuntimeMessage.bind(openCodeRuntimeControlApi),
      getRuntimeDeliveryStatus:
        runtimeDeliveryBoundary.getOpenCodeRuntimeDeliveryStatus.bind(runtimeDeliveryBoundary),
    },
  });
  installTarget.applicationFeature = applicationFeature;
  const idlePromptInjectionBoundary =
    createTeamProvisioningIdlePromptInjectionBoundaryFromService<ProvisioningRun>(
      host.idlePromptInjection,
      { logger }
    );
  installTarget.idlePromptInjectionBoundary = idlePromptInjectionBoundary;
  const providerRuntime = createTeamProvisioningProviderRuntimeFacadeFromService(
    host.providerRuntime,
    {
      transientProbeProcesses: deps.transientProbeProcesses,
      logger,
      isAuthFailureWarning,
      normalizeApiRetryErrorMessage,
    }
  );
  installTarget.providerRuntime = providerRuntime;
  const providerRuntimeCompatibility =
    createTeamProvisioningProviderRuntimeCompatibility(providerRuntime);
  installTarget.providerRuntimeCompatibility = providerRuntimeCompatibility;
  const openCodeRuntimeRecoveryFacade =
    createTeamProvisioningOpenCodeRuntimeRecoveryFacadeFromService(host.openCodeRuntimeRecovery, {
      getTeamsBasePath,
      logger,
    });
  installTarget.openCodeRuntimeRecoveryFacade = openCodeRuntimeRecoveryFacade;
  const provisioningStatus = createTeamProvisioningStatusFeature({
    progressSource: deps.retainedProvisioningProgressState,
    runs: deps.runs,
  });
  const compatibilityDelegation: TeamProvisioningCompatibilityDelegation<ProvisioningRun> = {
    providerRuntimeCompatibility,
    applicationFeature,
    configFacade,
    configTaskActivityBoundary,
    provisioningStatus,
    retainedProvisioningProgressState: deps.retainedProvisioningProgressState,
    cancellationBoundary: deps.cancellationBoundary,
    runtimeSnapshotFacade: runtimeProjection.runtimeSnapshotFacade,
    runTracking: deps.runTracking,
    runs: deps.runs,
    sendMessageToRunBoundary: deps.sendMessageToRunBoundary,
  };
  installTarget.compatibilityDelegation = compatibilityDelegation;
  const outputRecoveryFacade =
    createTeamProvisioningOutputRecoveryFacadeFromService<ProvisioningRun>(host.outputRecovery, {
      logger,
      killTeamProcess,
      killTeamProcessAndWait,
      cleanupRunOwnedAnthropicApiKeyHelper,
      updateProgress,
      emitLogsProgress,
      nowIso,
    });
  installTarget.outputRecoveryFacade = outputRecoveryFacade;
  const deterministicLaunchFlowHost = createTeamProvisioningLaunchDeterministicFlowHostFromService<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >(host.deterministicLaunch);
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
    killTeamProcessAndWait,
  });
  installTarget.deterministicLaunchFlowBoundary = deterministicLaunchFlowBoundary;
  const deterministicCreateSpawnFlowBoundary =
    createTeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>(
      createTeamProvisioningCreateDeterministicSpawnFlowDepsFromService(
        host.deterministicCreateSpawn,
        {
          spawnCli,
          updateProgress,
          killTeamProcessAndWait,
        }
      )
    );
  installTarget.deterministicCreateSpawnFlowBoundary = deterministicCreateSpawnFlowBoundary;
  const verificationProbePorts = createTeamProvisioningVerificationProbePorts<ProvisioningRun>(
    createTeamProvisioningVerificationProbePortsDepsFromService(host.verificationProbe, {
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
  installTarget.verificationProbePorts = verificationProbePorts;
  const processExitPorts = createTeamProvisioningProcessExitPorts<ProvisioningRun>(
    createTeamProvisioningProcessExitPortsDepsFromService(host.processExit, {
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
  installTarget.processExitPorts = processExitPorts;
  const prepareFacade = createTeamProvisioningPrepareFacadeFromService(host.prepare, {
    resolveClaudeBinaryPath: () => ClaudeBinaryResolver.resolve(),
    execCli,
    inspectOpenCodeLocalModelRuntime: (
      runtimeProviderManagementMain as typeof runtimeProviderManagementMain & {
        inspectOpenCodeLocalModelRuntimeReadiness?: NonNullable<
          Parameters<
            typeof createTeamProvisioningPrepareFacadeFromService
          >[1]['inspectOpenCodeLocalModelRuntime']
        >;
      }
    ).inspectOpenCodeLocalModelRuntimeReadiness,
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
  });
  installTarget.prepareFacade = prepareFacade;
  const memberMcpLaunchConfigProvisioner =
    createTeamProvisioningMemberMcpLaunchConfigProvisionerFromService(host.memberMcpLaunchConfig, {
      ensureCwdExists,
    });
  installTarget.memberMcpLaunchConfigProvisioner = memberMcpLaunchConfigProvisioner;
  const openCodeVisibleReplyProofService = createOpenCodeVisibleReplyProofServiceFromHost(
    host.visibleReplyProof,
    {
      warn: (message) => logger.warn(message),
      getErrorMessage,
      nowIso,
    }
  );
  installTarget.openCodeVisibleReplyProofService = openCodeVisibleReplyProofService;
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
  installTarget.openCodePromptDeliveryWatchdogCoordinator =
    openCodePromptDeliveryWatchdogCoordinator;
  const bootstrapTranscriptFacade = createTeamProvisioningBootstrapTranscriptFacadeFromService(
    host.bootstrapTranscript,
    { nowIso }
  );
  installTarget.bootstrapTranscriptFacade = bootstrapTranscriptFacade;
  const bootstrapEvidenceFacade = createTeamProvisioningBootstrapEvidenceFacadeFromService(
    host.bootstrapEvidence,
    {
      getTeamsBasePath,
      nowIso,
      warn: (message) => logger.warn(message),
    }
  );
  installTarget.bootstrapEvidenceFacade = bootstrapEvidenceFacade;
  const leadInboxRelayFacade = createTeamProvisioningLeadInboxRelayCompatibilityFacadeFromService(
    host.leadInboxRelay,
    {
      logger,
      getErrorMessage,
      nowIso,
      nowMs: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    }
  );
  installTarget.leadInboxRelayFacade = leadInboxRelayFacade;
  const cleanupRunPorts = createTeamProvisioningCleanupRunPorts<ProvisioningRun>(
    createTeamProvisioningCleanupRunPortsDepsFromService(host.cleanupRun)
  );
  installTarget.cleanupRunPorts = cleanupRunPorts;
  const transientRunState = new TeamProvisioningTransientRunState(
    createTeamProvisioningTransientRunStatePortsFromService(host.transientRunState, {
      cancelPendingAutoResume: (teamName) =>
        peekAutoResumeService()?.cancelPendingAutoResume(teamName),
      warn: (message) => logger.warn(message),
    })
  );
  installTarget.transientRunState = transientRunState;
  const requestAdmissionBoundary = createTeamProvisioningRequestAdmissionBoundary(
    host.requestAdmission
  );
  installTarget.requestAdmissionBoundary = requestAdmissionBoundary;
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
    applicationFeature,
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
