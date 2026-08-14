import { isAbsolute, resolve } from 'node:path';

import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStream,
} from '@features/coordination-events/main';
import { createHostedAccessFeature, type HostedAccessFeature } from '@features/hosted-access/main';
// eslint-disable-next-line no-restricted-imports -- Hosted operations exposes route descriptors for production composition.
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '@features/hosted-operations/main/hosted';
import { type TeamIdentityReadGateway } from '@features/internal-storage/main';
// eslint-disable-next-line no-restricted-imports -- Hosted storage composition is main-process-only.
import {
  createHostedTeamIdentityReadBackend,
  type HostedTeamIdentityReadBackend,
} from '@features/internal-storage/main/hosted';
import { createRecentProjectsFeature } from '@features/recent-projects/main';
import { createQueryContext } from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';

import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  type HostedRouteAdmissionBinding,
} from './composition/hosted/application';
import { createOptionalHostedApprovalProductionComposition } from './composition/hosted/createHostedApprovalProductionComposition';
import { createHostedExternalWriterSupervisor } from './composition/hosted/createHostedExternalWriterSupervisor';
import {
  createHostedAccessNodeLocalControlTransportFactory,
  createHostedAccessNodePlatform,
} from './composition/hosted/hostedAccessNodePlatform';
import { createHostedCoordinationEventStreamAuthorizer } from './composition/hosted/hostedCoordinationEventStreamAuthorizer';
import {
  createHostedDiagnosticsComposition,
  type HostedDiagnosticsComposition,
} from './composition/hosted/hostedDiagnosticsComposition';
import { admitHostedLifecycleProductionOwner } from './composition/hosted/hostedLifecycleProductionOwnerAdmission';
import { type HostedOperatorProductionComposition } from './composition/hosted/hostedOperatorProductionComposition';
import { hostedProductionOwnerRouteDescriptors } from './composition/hosted/hostedProductionOwnerRouteDescriptors';
import { HostedTaskBoardOrchestratorAuthority } from './composition/hosted/hostedTaskBoardOrchestratorAuthority';
import {
  createHostedTaskBoardReadRouteFactory,
  type HostedTaskBoardReadRouteFactory,
} from './composition/hosted/hostedTaskBoardReadComposition';
import {
  classifyHostedTeamConfigurationAuthorization as classifyHostedTeamConfigurationAuthorizationFallback,
  createHostedTeamConfigurationComposition,
  createHostedTeamConfigurationRouteAdmissionBinding,
  type HostedTeamConfigurationComposition,
} from './composition/hosted/hostedTeamConfigurationComposition';
import {
  classifyHostedTeamMessageAuthorization,
  createHostedTeamMessageRouteFactory,
} from './composition/hosted/hostedTeamMessageComposition';
import { HostedTeamMessageOrchestratorAuthority } from './composition/hosted/hostedTeamMessageOrchestratorAuthority';
import { resolveHostedTeamWorkspaceId } from './composition/hosted/hostedTeamWorkspaceAttribution';
import {
  classifyHostedWorkspaceRegistryAuthorization,
  createHostedWorkspaceRegistryComposition,
} from './composition/hosted/hostedWorkspaceRegistryComposition';
import {
  createOptionalTeamLifecycleCommandComposition,
  type TeamLifecycleCommandComposition,
} from './composition/hosted/teamLifecycleCommandComposition';
import {
  readTeamLifecycleReadBootstrapEnvironment,
  TeamLifecycleReadBootstrapSource,
} from './composition/hosted/teamLifecycleReadBootstrapSource';
import {
  createMountBindingScopedTeamLifecycleReadPorts,
  createTeamLifecycleReadComposition,
  createTeamLifecycleReadHost,
  createUnavailableTeamLifecycleReadHost,
  type TeamLifecycleReadAuthority,
  type TeamLifecycleReadHost,
} from './composition/hosted/teamLifecycleReadComposition';
import { createTeamLifecycleReadOnlyIdentitySource } from './composition/hosted/teamLifecycleReadOnlyIdentitySource';
import {
  type HostedWorkspaceEventBridge,
  registerHostedWorkspaceEventBridge,
  runWithEventStreamsDrained,
} from './http/events';
import {
  getProjectsBasePath,
  getTodosBasePath,
  setClaudeBasePathOverride,
} from './utils/pathDecoder';
import { readHostedLifecycleOrchestratorTrustAnchor } from './standaloneHostedLifecycleTrustAnchor';
import { sshConnectionManagerStub, updaterServiceStub } from './standaloneServiceStubs';
import {
  createStandaloneFatalFailStop,
  registerStandaloneShutdownSignalHandlers,
  runStandaloneShutdownLifecycle,
} from './standaloneShutdownLifecycle';

import type { HostedExternalWriterInventorySupervisor } from './composition/hosted/hostedExternalWriterInventorySupervisor';
export { resolveHostedTeamWorkspaceId } from './composition/hosted/hostedTeamWorkspaceAttribution';
export { readHostedLifecycleOrchestratorTrustAnchor } from './standaloneHostedLifecycleTrustAnchor';
export type {
  StandaloneFatalFailStopActions,
  StandaloneShutdownActions,
} from './standaloneShutdownLifecycle';
export {
  createStandaloneFatalFailStop,
  registerStandaloneShutdownSignalHandlers,
  runStandaloneShutdownLifecycle,
} from './standaloneShutdownLifecycle';
import type { HostedTeamMessageRouteFactory } from './composition/hosted/hostedTeamMessageComposition';
import type { HostedAuthStorageBackend, HttpServices } from './http';
import type { HttpServer } from './services/infrastructure/HttpServer';
import type { NotificationManager } from './services/infrastructure/NotificationManager';
import type { ServiceContext } from './services/infrastructure/ServiceContext';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

const logger = createLogger('Standalone');
const classifyHostedTeamConfigurationAuthorization = (method: string, url: string) =>
  classifyHostedTeamMessageAuthorization(method, url, (messageMethod, messageUrl) =>
    classifyHostedWorkspaceRegistryAuthorization(
      messageMethod,
      messageUrl,
      classifyHostedTeamConfigurationAuthorizationFallback
    )
  );
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = parseInt(process.env.PORT ?? '3456', 10);
const CLAUDE_ROOT = process.env.CLAUDE_ROOT;

function hostedRetentionInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new TypeError(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

const HOSTED_COORDINATION_EVENT_RETENTION_POLICY = Object.freeze({
  intervalMs: hostedRetentionInteger(
    'HOSTED_COORDINATION_EVENT_RETENTION_INTERVAL_MS',
    60_000,
    50,
    86_400_000
  ),
  maxRetainedEvents: hostedRetentionInteger(
    'HOSTED_COORDINATION_EVENT_RETENTION_MAX_EVENTS',
    10_000,
    1,
    1_000_000
  ),
});
if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = process.env.AUTH_PUBLIC_ORIGIN ?? '*';
}
let localContext: ServiceContext;
let notificationManager: NotificationManager;
let httpServer: HttpServer;
let configManager: { flush(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;
let hostedAuthStorageBackend: HostedAuthStorageBackend | null = null;
let hostedTeamIdentityReadBackend: HostedTeamIdentityReadBackend | null = null;
let hostedAccessFeature: HostedAccessFeature | null = null;
let hostedCoordinationEventStream: HostedCoordinationEventStream | null = null;
let hostedExternalWriterSupervisor: HostedExternalWriterInventorySupervisor | null = null;
let hostedDiagnostics: HostedDiagnosticsComposition | null = null;
let hostedOperatorProduction: HostedOperatorProductionComposition | null = null;
let hostedDiagnosticsRuntimeInstance: RuntimeInstanceContext | null = null;
let hostedLifecycleCommands: TeamLifecycleCommandComposition | null = null;
let hostedLifecycleReadinessCleanup: (() => void) | null = null;
let hostedTeamMessageWriter: HostedTeamMessageOrchestratorAuthority | null = null;
let hostedTeamConfiguration: HostedTeamConfigurationComposition | null = null;
let hostedRouteAdmissionBinding: HostedRouteAdmissionBinding | null = null;
let hostedWorkspaceEventBridge: HostedWorkspaceEventBridge | null = null;
let hostedAuthLocalControlHandle: { close(): Promise<void> } | null = null;
let fatalFailStop = false;
let standaloneRequestedExitCode = 0;
let requestStandaloneFatalFailStop: ((label: string, error: unknown) => void) | null = null;

export function createStandaloneHostedRouteReadiness(input: {
  readonly fatalFailStop: boolean;
  readonly runtimeIdentityAvailable: boolean;
  readonly diagnosticsAvailable: boolean;
  readonly lifecycleOwnerAvailable: boolean;
}): {
  readonly revision: number;
  readonly dimensions: HostedReadinessDimensionStates;
} {
  const { fatalFailStop, runtimeIdentityAvailable, diagnosticsAvailable, lifecycleOwnerAvailable } =
    input;
  const readiness = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => {
      const ready =
        !fatalFailStop &&
        (dimension === 'live' ||
          dimension === 'serve' ||
          dimension === 'auth' ||
          (dimension === 'read' && runtimeIdentityAvailable && diagnosticsAvailable) ||
          (dimension === 'mutation' && lifecycleOwnerAvailable) ||
          (dimension === 'runtime-control' && lifecycleOwnerAvailable));
      const reason = fatalFailStop
        ? 'fatal_fail_stop'
        : !runtimeIdentityAvailable
          ? 'runtime_identity_unavailable'
          : !diagnosticsAvailable
            ? 'diagnostics_unavailable'
            : runtimeIdentityAvailable
              ? 'external_orchestrator_unavailable'
              : 'runtime_identity_unavailable';
      return [
        dimension,
        Object.freeze({
          dimension,
          status: ready ? ('ready' as const) : ('not_ready' as const),
          reasons: Object.freeze(ready ? [] : [reason]),
        }),
      ];
    })
  );
  return Object.freeze({
    revision:
      (runtimeIdentityAvailable ? 1 : 0) +
      (diagnosticsAvailable ? 1 : 0) +
      (lifecycleOwnerAvailable ? 1 : 0),
    dimensions: Object.freeze({
      ...readiness,
      terminal: HOSTED_TERMINAL_READINESS,
    }) as HostedReadinessDimensionStates,
  });
}

function hostedRouteReadiness(): ReturnType<typeof createStandaloneHostedRouteReadiness> {
  const runtimeIdentityAvailable = hostedDiagnosticsRuntimeInstance !== null;
  return createStandaloneHostedRouteReadiness({
    fatalFailStop,
    runtimeIdentityAvailable,
    diagnosticsAvailable: hostedDiagnostics?.isReady() === true,
    lifecycleOwnerAvailable:
      !fatalFailStop && runtimeIdentityAvailable && hostedLifecycleCommands?.isReady() === true,
  });
}

function admitHostedReadRoot(reference: string): string {
  if (
    !isAbsolute(reference) ||
    resolve(reference) !== reference ||
    reference === resolve(reference, '/')
  ) {
    throw new TypeError('team-lifecycle-read-runtime-root-invalid');
  }
  return reference;
}

export function resolveStandaloneAuthDataDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  hostedMode: boolean
): string {
  const configured = environment.AUTH_DATA_DIR;
  if (hostedMode && configured === undefined) {
    throw new Error('hosted_auth_data_dir_required');
  }
  return admitHostedReadRoot(configured ?? '/data/.agent-teams');
}
const teamLifecycleReadNowMs = (): number => Date.now();
function createTeamLifecycleReadQueryContext(
  authority: TeamLifecycleReadAuthority,
  requestSignal: AbortSignal
) {
  return createQueryContext({
    actorId: authority.actorId,
    sessionId: 'session_team-lifecycle-read-standalone',
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    requestId: `request_team-lifecycle-read-standalone-${++teamLifecycleReadRequestSequence}`,
    authorizedScope: authority.authorizedScope,
    deadlineAtMs: teamLifecycleReadNowMs() + 10_000,
    signal: requestSignal,
  });
}
let teamLifecycleReadRequestSequence = 0;

async function start(): Promise<void> {
  logger.info('Starting standalone server...');
  const hostedBootstrapEnvironment = Object.freeze({ ...process.env });
  const serializedHostedBootstrap = readTeamLifecycleReadBootstrapEnvironment(
    hostedBootstrapEnvironment
  );
  const hostedMode = serializedHostedBootstrap !== undefined || process.env.AUTH_MODE !== undefined;
  const productionOwnerAdmission =
    serializedHostedBootstrap === undefined
      ? null
      : admitHostedLifecycleProductionOwner(hostedBootstrapEnvironment);
  if (serializedHostedBootstrap !== undefined && productionOwnerAdmission === null) {
    throw new Error('hosted_lifecycle_bootstrap_authentication_failed');
  }
  let teamLifecycleReadHost: TeamLifecycleReadHost = createUnavailableTeamLifecycleReadHost();
  let workspaceRegistrySnapshot: WorkspaceRegistryStartupSnapshot | null = null;
  let createHostedTaskBoardReadRoutes: HostedTaskBoardReadRouteFactory | null = null;
  let createHostedTeamMessageRoutes: HostedTeamMessageRouteFactory | null = null;
  let hostedTeamMessageRouteDependencies:
    | Parameters<typeof createHostedTeamMessageRouteFactory>[0]
    | null = null;
  let admittedHostedClaudeRoot: string | null = null;
  let hostedApprovalActorId: string | null = null;
  let teamIdentityGrantFenceSource: TeamIdentityReadGateway | null = null;
  let externalWriterTeamIdentityInventorySource: Awaited<
    ReturnType<typeof createTeamLifecycleReadOnlyIdentitySource>
  > = null;
  if (hostedMode) {
    if (serializedHostedBootstrap === undefined) {
      if (CLAUDE_ROOT === undefined) throw new Error('hosted_claude_root_required');
      admittedHostedClaudeRoot = admitHostedReadRoot(CLAUDE_ROOT);
      setClaudeBasePathOverride(admittedHostedClaudeRoot);
    } else {
      if (productionOwnerAdmission === null) {
        throw new Error('hosted_lifecycle_bootstrap_authentication_failed');
      }
      const bootstrap = await new TeamLifecycleReadBootstrapSource({
        input: {
          readSerializedBootstrap: () => serializedHostedBootstrap,
        },
        nowMs: teamLifecycleReadNowMs,
        authenticatedBootstrapBinding: productionOwnerAdmission.bootstrapBinding,
      }).load();
      hostedDiagnosticsRuntimeInstance = bootstrap.runtimeInstance;
      workspaceRegistrySnapshot = bootstrap.workspaceRegistrySnapshot;
      const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference);
      const claudeRoot = admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference);
      admittedHostedClaudeRoot = claudeRoot;
      setClaudeBasePathOverride(admittedHostedClaudeRoot);

      const teamIdentityGateway = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
      if (teamIdentityGateway === null) {
        logger.warn(
          'Hosted team lifecycle identity admission unavailable; canonical reads remain disabled.'
        );
      } else {
        hostedTeamIdentityReadBackend = createHostedTeamIdentityReadBackend(appDataRoot);
        const liveTeamIdentityGateway = hostedTeamIdentityReadBackend.gateway;
        const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
          authority: bootstrap.authority,
          mountBinding: bootstrap.mountBinding,
          runtimeInstance: bootstrap.runtimeInstance,
          teamIdentities: liveTeamIdentityGateway,
          nowMs: teamLifecycleReadNowMs,
        });
        await readPorts.teamIdentities.listTeamIdentities();
        const composition = createTeamLifecycleReadComposition({
          authority: bootstrap.authority,
          ...readPorts,
          nowMs: teamLifecycleReadNowMs,
        });
        teamLifecycleReadHost = createTeamLifecycleReadHost(
          composition,
          createTeamLifecycleReadQueryContext
        );
        hostedTeamMessageRouteDependencies = {
          runtimeInstance: bootstrap.runtimeInstance,
          mountBinding: bootstrap.mountBinding,
          teamIdentities: liveTeamIdentityGateway,
          reportReadDiagnostic: (stage, code) =>
            logger.error(`Hosted team-message unavailable: ${stage} diagnostic=${code}`),
        };
        hostedApprovalActorId = bootstrap.actorId;
        teamIdentityGrantFenceSource = readPorts.teamIdentities;
        externalWriterTeamIdentityInventorySource = liveTeamIdentityGateway;
      }
    }
  } else if (CLAUDE_ROOT) {
    setClaudeBasePathOverride(CLAUDE_ROOT);
    logger.info(`Using CLAUDE_ROOT: ${CLAUDE_ROOT}`);
  }
  const { configManager: admittedConfigManager } =
    await import('./services/infrastructure/ConfigManager');
  configManager = admittedConfigManager;
  if (admittedHostedClaudeRoot !== null) {
    setClaudeBasePathOverride(admittedHostedClaudeRoot);
  }
  const [
    { createHostedAuthStorageBackend },
    { HttpServer },
    { LocalFileSystemProvider },
    { NotificationManager },
    { ServiceContext },
  ] = await Promise.all([
    import('./http'),
    import('./services/infrastructure/HttpServer'),
    import('./services/infrastructure/LocalFileSystemProvider'),
    import('./services/infrastructure/NotificationManager'),
    import('./services/infrastructure/ServiceContext'),
  ]);
  const projectsDir = getProjectsBasePath();
  const todosDir = getTodosBasePath();

  logger.info(`Projects directory: ${projectsDir}`);
  logger.info(`Todos directory: ${todosDir}`);

  localContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir,
    todosDir,
  });
  if (hostedMode) localContext.startCacheOnly();
  else localContext.start();

  notificationManager = NotificationManager.getInstance();
  localContext.fileWatcher.setNotificationManager(notificationManager);

  httpServer = new HttpServer();
  const authDataDirectory = resolveStandaloneAuthDataDirectory(process.env, hostedMode);
  hostedAuthStorageBackend = createHostedAuthStorageBackend(authDataDirectory);
  const hostedAuthHostPlatform = createHostedAccessNodePlatform();
  hostedAccessFeature = await createHostedAccessFeature({
    environment: process.env,
    storage: hostedAuthStorageBackend.gateway,
    dataDirectory: authDataDirectory,
    hostPlatform: hostedAuthHostPlatform,
    localControlTransportFactory:
      createHostedAccessNodeLocalControlTransportFactory(hostedAuthHostPlatform),
    noRuntimeMutationAtStartup: true,
    runWithBrowserStreamsDrained: runWithEventStreamsDrained,
    authorizationPolicy: classifyHostedTeamConfigurationAuthorization,
    isLifecycleOwnerReady: () => hostedLifecycleCommands?.isReady() === true,
    isTaskBoardMutationRouteEnabled: () =>
      hostedLifecycleCommands?.isReady() === true &&
      hostedTeamTaskBoardRoutes?.mutationsEnabled === true,
    isTeamMessageSendRouteEnabled: () =>
      hostedLifecycleCommands?.isReady() === true && hostedTeamMessageWriter !== null,
    resolveTeamWorkspaceId: (teamId) =>
      teamIdentityGrantFenceSource === null
        ? Promise.resolve(Object.freeze({ kind: 'unavailable' as const }))
        : resolveHostedTeamWorkspaceId(teamLifecycleReadHost, teamId, teamIdentityGrantFenceSource),
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
  });
  hostedRouteAdmissionBinding = createHostedRouteAdmissionBinding({
    routes: [
      ...HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
      ...hostedProductionOwnerRouteDescriptors(productionOwnerAdmission),
    ],
    readiness: { readiness: async () => hostedRouteReadiness() },
    routeScope: 'production',
  });
  hostedDiagnostics = createHostedDiagnosticsComposition({
    authentication: hostedAccessFeature.http,
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
    expectedDeploymentId: hostedAccessFeature.deploymentId,
    routeAdmissionBinding: hostedRouteAdmissionBinding,
  });
  const lifecycleTrustAnchor =
    hostedDiagnosticsRuntimeInstance === null || productionOwnerAdmission === null
      ? null
      : readHostedLifecycleOrchestratorTrustAnchor(
          hostedDiagnosticsRuntimeInstance,
          hostedBootstrapEnvironment
        );
  hostedLifecycleCommands =
    hostedDiagnosticsRuntimeInstance === null ||
    productionOwnerAdmission === null ||
    lifecycleTrustAnchor === null
      ? null
      : await createOptionalTeamLifecycleCommandComposition({
          authentication: hostedAccessFeature.http,
          runtimeInstance: hostedDiagnosticsRuntimeInstance,
          expectedDeploymentId: hostedAccessFeature.deploymentId,
          ...(hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET === undefined
            ? {}
            : {
                orchestratorSocketPath:
                  hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET,
              }),
          ...(hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT === undefined
            ? {}
            : {
                orchestratorOwnerHighWaterPath:
                  hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT,
              }),
          orchestratorTrustAnchor: lifecycleTrustAnchor,
          orchestratorExpectedOwnerBinding: productionOwnerAdmission.expectedOwnerBinding,
          orchestratorBootstrapBinding: productionOwnerAdmission.bootstrapBinding,
          orchestratorExpectedUid: process.getuid?.(),
          orchestratorExpectedGid: process.getgid?.(),
          orchestratorExpectedMode: 0o600,
          onFatalOwnerLoss: (error) => {
            requestStandaloneFatalFailStop?.('Hosted lifecycle orchestrator owner lost', error);
          },
          registerReadinessCleanup: (cleanup) => {
            hostedLifecycleReadinessCleanup = cleanup;
            if (fatalFailStop) cleanup?.();
          },
          restoreGeneration: hostedAccessFeature.restoreGeneration,
          mountGeneration: hostedTeamMessageRouteDependencies?.mountBinding.mountGeneration ?? null,
          routeAdmissionBinding: hostedRouteAdmissionBinding,
        });
  hostedOperatorProduction = createOptionalHostedApprovalProductionComposition({
    authentication: hostedAccessFeature.http,
    expectedDeploymentId: hostedAccessFeature.deploymentId,
    restoreGeneration: hostedAccessFeature.restoreGeneration,
    actorId: hostedApprovalActorId,
    routeDependencies: hostedTeamMessageRouteDependencies,
    approvalStorage: hostedAuthStorageBackend.teamApprovals,
    routeAdmissionBinding: hostedRouteAdmissionBinding,
    ownerAdmission: productionOwnerAdmission,
    mutationLease: hostedLifecycleCommands?.mutationLease ?? null,
    ownerProofKey: lifecycleTrustAnchor,
  });
  hostedTeamMessageWriter =
    hostedLifecycleCommands === null ||
    lifecycleTrustAnchor === null ||
    hostedTeamMessageRouteDependencies === null
      ? null
      : new HostedTeamMessageOrchestratorAuthority({
          lease: hostedLifecycleCommands.mutationLease,
          ownerProofKey: lifecycleTrustAnchor,
          mountBinding: hostedTeamMessageRouteDependencies.mountBinding,
          teamIdentities: hostedTeamMessageRouteDependencies.teamIdentities,
          restoreGeneration: hostedAccessFeature.restoreGeneration,
        });
  createHostedTeamMessageRoutes =
    hostedTeamMessageRouteDependencies === null
      ? null
      : createHostedTeamMessageRouteFactory({
          ...hostedTeamMessageRouteDependencies,
          ...(hostedTeamMessageWriter === null ? {} : { writer: hostedTeamMessageWriter }),
          ...(hostedLifecycleCommands === null || lifecycleTrustAnchor === null
            ? {}
            : {
                ownerProvenance: {
                  ownerProofKey: lifecycleTrustAnchor,
                  currentOwnerBinding: () =>
                    hostedLifecycleCommands?.mutationLease.currentBinding() ?? null,
                },
              }),
        });
  if (hostedTeamMessageRouteDependencies !== null) {
    createHostedTaskBoardReadRoutes = createHostedTaskBoardReadRouteFactory({
      runtimeInstance: hostedTeamMessageRouteDependencies.runtimeInstance,
      mountBinding: hostedTeamMessageRouteDependencies.mountBinding,
      teamIdentities: hostedTeamMessageRouteDependencies.teamIdentities,
      reportReadDiagnostic: (stage, code) =>
        logger.error(`Hosted task-board unavailable: ${stage} diagnostic=${code}`),
      ...(hostedTeamMessageWriter === null
        ? {}
        : {
            mutationAuthority: new HostedTaskBoardOrchestratorAuthority(hostedTeamMessageWriter, {
              beginTaskSelfWrite: (operationId, teamId) => {
                if (!hostedExternalWriterSupervisor) {
                  return Promise.reject(new Error('hosted-external-writer-self-write-unavailable'));
                }
                return hostedExternalWriterSupervisor.beginTaskSelfWrite(operationId, teamId);
              },
              completeTaskSelfWrite: (operationId, effects) => {
                if (!hostedExternalWriterSupervisor) {
                  return Promise.reject(new Error('hosted-external-writer-self-write-unavailable'));
                }
                return hostedExternalWriterSupervisor.completeTaskSelfWrite(operationId, effects);
              },
              abortTaskSelfWrite: (operationId) =>
                hostedExternalWriterSupervisor?.abortTaskSelfWrite(operationId) ??
                Promise.resolve(),
            }),
          }),
    });
  }
  hostedTeamConfiguration =
    hostedDiagnosticsRuntimeInstance === null
      ? null
      : createHostedTeamConfigurationComposition({
          authentication: hostedAccessFeature.http,
          storage: hostedAuthStorageBackend.teamConfigurations,
          runtimeInstance: hostedDiagnosticsRuntimeInstance,
          expectedDeploymentId: hostedAccessFeature.deploymentId,
          routeAdmissionBinding: createHostedTeamConfigurationRouteAdmissionBinding(
            () => hostedTeamConfiguration?.isReady() === true
          ),
        });
  const hostedTeamTaskBoardRoutes = createHostedTaskBoardReadRoutes?.(hostedAccessFeature);
  const hostedWorkspaceRegistryRoutes =
    hostedDiagnosticsRuntimeInstance === null || workspaceRegistrySnapshot === null
      ? undefined
      : createHostedWorkspaceRegistryComposition({
          authentication: hostedAccessFeature.http,
          snapshot: workspaceRegistrySnapshot,
          runtimeInstance: hostedDiagnosticsRuntimeInstance,
          expectedDeploymentId: hostedAccessFeature.deploymentId,
        });
  hostedCoordinationEventStream = createHostedCoordinationEventStream({
    storage: hostedAuthStorageBackend.coordinationEvents,
    deploymentId: hostedAccessFeature.deploymentId,
    authorizer: createHostedCoordinationEventStreamAuthorizer(hostedAccessFeature.http),
    retentionPolicy: HOSTED_COORDINATION_EVENT_RETENTION_POLICY,
  });
  if (
    admittedHostedClaudeRoot !== null &&
    externalWriterTeamIdentityInventorySource !== null &&
    hostedDiagnosticsRuntimeInstance !== null
  ) {
    hostedExternalWriterSupervisor = createHostedExternalWriterSupervisor({
      admittedClaudeRoot: admittedHostedClaudeRoot,
      deploymentId: hostedAccessFeature.deploymentId,
      storage: hostedAuthStorageBackend,
      eventStream: hostedCoordinationEventStream,
      teamIdentities: externalWriterTeamIdentityInventorySource,
    });
    await hostedExternalWriterSupervisor.start();
  }
  hostedAuthLocalControlHandle = await hostedAccessFeature.startLocalControl(
    process.env.AUTH_CONTROL_SOCKET ?? '/run/agent-teams/control.sock'
  );
  const recentProjectsFeature = createRecentProjectsFeature({
    getActiveContext: () => localContext,
    getLocalContext: () => localContext,
    logger: createLogger('Feature:RecentProjects'),
  });
  hostedWorkspaceEventBridge = registerHostedWorkspaceEventBridge({
    fileEvents: localContext.fileWatcher,
    notificationEvents: notificationManager,
    isWorkspaceRegistered: (runtimeWorkspaceId) =>
      hostedAccessFeature!.http.isWorkspaceRegistered(runtimeWorkspaceId),
    broadcast: (channel, data) => {
      httpServer!.broadcast(channel, data);
    },
  });

  const services: HttpServices = {
    projectScanner: localContext.projectScanner,
    sessionParser: localContext.sessionParser,
    subagentResolver: localContext.subagentResolver,
    chunkBuilder: localContext.chunkBuilder,
    dataCache: localContext.dataCache,
    recentProjectsFeature,
    updaterService: updaterServiceStub,
    sshConnectionManager: sshConnectionManagerStub,
    teamLifecycleReadHost,
    hostedAuth: hostedAccessFeature.http,
    hostedCoordinationEventRoutes: hostedCoordinationEventStream,
    hostedDiagnosticsRoutes: hostedDiagnostics,
    hostedOperatorSurfaceRoutes: hostedOperatorProduction ?? undefined,
    ...(hostedLifecycleCommands === null
      ? {}
      : { hostedLifecycleCommandRoutes: hostedLifecycleCommands }),
    hostedWorkspaceRegistryRoutes,
    hostedTeamTaskBoardRoutes,
    hostedTeamMessageRoutes: createHostedTeamMessageRoutes?.(hostedAccessFeature),
    hostedTeamConfigurationRoutes: hostedTeamConfiguration ?? undefined,
  };

  const modeSwitchHandler = async (): Promise<void> => {};

  const port = await httpServer.start(services, modeSwitchHandler, PORT, HOST);
  logger.info(`Standalone server running at http://${HOST}:${port}`);
  logger.info('Open in your browser to view Claude Code sessions');
}

function closeHostedMutationAdmissions(): void {
  fatalFailStop = true;
  hostedTeamMessageWriter?.close();
  hostedTeamMessageWriter = null;
  hostedLifecycleReadinessCleanup?.();
  hostedLifecycleReadinessCleanup = null;
  hostedLifecycleCommands?.close();
  hostedLifecycleCommands = null;
  hostedTeamConfiguration = null;
}

async function shutdown(requestedExitCode = 0): Promise<void> {
  standaloneRequestedExitCode = Math.max(
    standaloneRequestedExitCode,
    requestedExitCode === 0 ? 0 : 1
  );
  if (standaloneRequestedExitCode !== 0) process.exitCode = 1;
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = runStandaloneShutdownLifecycle(
    {
      stopHttpServer: async () => {
        const failures: unknown[] = [];
        try {
          closeHostedMutationAdmissions();
        } catch (error) {
          failures.push(error);
        }
        try {
          hostedOperatorProduction?.close();
        } catch (error) {
          failures.push(error);
        }
        hostedOperatorProduction = null;
        try {
          hostedDiagnostics?.close();
        } catch (error) {
          failures.push(error);
        }
        hostedDiagnostics = null;
        hostedRouteAdmissionBinding = null;
        hostedDiagnosticsRuntimeInstance = null;
        try {
          await hostedExternalWriterSupervisor?.shutdown();
        } catch (error) {
          failures.push(error);
        }
        hostedExternalWriterSupervisor = null;
        try {
          hostedCoordinationEventStream?.close();
        } catch (error) {
          failures.push(error);
        }
        hostedCoordinationEventStream = null;
        try {
          await hostedWorkspaceEventBridge?.close();
        } catch (error) {
          failures.push(error);
        }
        hostedWorkspaceEventBridge = null;
        try {
          await hostedAuthLocalControlHandle?.close();
        } catch (error) {
          failures.push(error);
        }
        hostedAuthLocalControlHandle = null;
        try {
          if (httpServer?.isRunning()) {
            await httpServer.stop();
          }
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Hosted network surface shutdown failed');
        }
      },
      disposeLocalContext: () => {
        if (localContext) {
          localContext.dispose();
        }
      },
      flushConfig: async () => {
        await configManager?.flush();
        await hostedAuthStorageBackend?.dispose();
        hostedAuthStorageBackend = null;
        await hostedTeamIdentityReadBackend?.dispose();
        hostedTeamIdentityReadBackend = null;
        hostedAccessFeature = null;
      },
      logInfo: (message) => logger.info(message),
      logError: (message, error) => logger.error(message, error),
      setExitCode: (code) => {
        process.exitCode = code;
      },
      exit: (code) => process.exit(code),
      requestedExitCode: () => standaloneRequestedExitCode,
    },
    standaloneRequestedExitCode
  );

  return shutdownPromise;
}

if (!process.env.VITEST) {
  registerStandaloneShutdownSignalHandlers({
    platform: process.platform,
    onSignal: (signal, listener) => process.on(signal, listener),
    shutdown,
  });

  const fatal = createStandaloneFatalFailStop({
    closeAdmissions: closeHostedMutationAdmissions,
    shutdown: () => shutdown(1),
    setExitCode: (code) => {
      standaloneRequestedExitCode = Math.max(standaloneRequestedExitCode, code);
      process.exitCode = code;
    },
    exit: (code) => process.exit(code),
    logError: (message, error) => logger.error(message, error),
    setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
    clearTimer: (timer) => clearTimeout(timer),
  });
  requestStandaloneFatalFailStop = fatal;

  process.on('unhandledRejection', (reason) => {
    fatal('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    fatal('Uncaught exception', error);
  });

  void start().catch((error) => {
    logger.error('Standalone startup failed:', error);
    void shutdown(1);
  });
}
