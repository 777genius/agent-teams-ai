import { resolve } from 'node:path';

import { createStandaloneHostedRouteReadiness } from './composition/hosted/standaloneHostedRouteReadiness';

import type { HostedDraftPublicationComposition } from './composition/hosted/hostedDraftPublicationComposition';
export { createStandaloneHostedRouteReadiness } from './composition/hosted/standaloneHostedRouteReadiness';

import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStream,
} from '@features/coordination-events/main';
import {
  createHostedAccessFeature,
  type HostedAccessFeature,
  probeHostedPairingMaterial,
  resolveHostedPairingCodePath,
} from '@features/hosted-access/main';
// eslint-disable-next-line no-restricted-imports -- Hosted operations exposes route descriptors for production composition.
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '@features/hosted-operations/main/hosted';
import {
  createInternalStorageFeature,
  type TeamIdentityReadGateway,
} from '@features/internal-storage/main';
// eslint-disable-next-line no-restricted-imports -- Hosted storage composition is main-process-only.
import {
  type createHostedPromotionStorageBackend,
  createHostedTeamIdentityReadBackend,
  type HostedTeamIdentityReadBackend,
} from '@features/internal-storage/main/hosted';
import { createRecentProjectsFeature } from '@features/recent-projects/main';
// eslint-disable-next-line no-restricted-imports -- Standalone binds the bounded hosted approval catalog.
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
import { isHostedMvpManualApprovalAvailable } from '@features/team-configuration/contracts';
import { createLogger } from '@shared/utils/logger';

import {
  createHostedRouteAdmissionBinding,
  type HostedRouteAdmissionBinding,
} from './composition/hosted/application';
import { createHostedApprovalProductionCompositionFromEnvironment } from './composition/hosted/createHostedApprovalProductionCompositionFromEnvironment';
import { createHostedExternalWriterSupervisor } from './composition/hosted/createHostedExternalWriterSupervisor';
import { createStandaloneHostedTeamConfiguration } from './composition/hosted/createStandaloneHostedTeamConfiguration';
import { createStandaloneHostedTeamRoutes } from './composition/hosted/createStandaloneHostedTeamRoutes';
import { createStandalonePromotionStorage } from './composition/hosted/createStandalonePromotionStorage';
import {
  createHostedAccessNodeLocalControlTransportFactory,
  createHostedAccessNodePlatform,
} from './composition/hosted/hostedAccessNodePlatform';
import { readHostedCoordinationEventRetentionPolicy } from './composition/hosted/hostedCoordinationEventRetentionPolicyFromEnvironment';
import { createHostedCoordinationEventStreamAuthorizer } from './composition/hosted/hostedCoordinationEventStreamAuthorizer';
import { hostedCoordinationEventStreamIdentityFactory } from './composition/hosted/hostedCoordinationEventStreamNodePlatform';
import {
  createHostedDiagnosticsComposition,
  type HostedDiagnosticsComposition,
} from './composition/hosted/hostedDiagnosticsComposition';
import { sameOrchestratorLifecycleOwnerBinding } from './composition/hosted/hostedLifecycleOrchestratorReadiness';
import { admitHostedLifecycleProductionOwner } from './composition/hosted/hostedLifecycleProductionOwnerAdmission';
import { configureHostedOpenCodeRuntimeAtStartup } from './composition/hosted/hostedOpenCodeRuntimeProduction';
import { type HostedOperatorProductionComposition } from './composition/hosted/hostedOperatorProductionComposition';
import { hostedProductionOwnerRouteDescriptors } from './composition/hosted/hostedProductionOwnerRouteDescriptors';
import { createHostedRuntimeCreationAdmission } from './composition/hosted/hostedRuntimeCreationAdmission';
import { type HostedTaskBoardReadRouteFactory } from './composition/hosted/hostedTaskBoardReadComposition';
import { type HostedTeamConfigurationComposition } from './composition/hosted/hostedTeamConfigurationComposition';
import {
  createHostedTeamMessageRouteFactory,
  type HostedTeamMessageRouteFactory,
} from './composition/hosted/hostedTeamMessageComposition';
import { type HostedTeamMessageOrchestratorAuthority } from './composition/hosted/hostedTeamMessageOrchestratorAuthority';
import { resolveHostedTeamWorkspaceId } from './composition/hosted/hostedTeamWorkspaceAttribution';
import { createHostedWorkspaceRegistryComposition } from './composition/hosted/hostedWorkspaceRegistryComposition';
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
  type TeamLifecycleReadHost,
} from './composition/hosted/teamLifecycleReadComposition';
import { createTeamLifecycleReadOnlyIdentitySource } from './composition/hosted/teamLifecycleReadOnlyIdentitySource';
import { createNodeWorkspaceTrustFeatures } from './composition/workspaceTrust/createNodeWorkspaceTrustFeatures';
import {
  type HostedWorkspaceEventBridge,
  registerHostedWorkspaceEventBridge,
  runWithEventStreamsDrained,
} from './http/events';
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getProjectsBasePath,
  getTodosBasePath,
  setClaudeBasePathOverride,
} from './utils/pathDecoder';
import { ensureProductTaskWriteLockDirectory } from './utils/productTaskWriteAuthorityLock';
import { classifyStandaloneHostedAuthorization as classifyHostedWorkspaceRegistryAuthorization } from './standaloneHostedAuthorizationPolicy';
import { createAdmittedHostedDraftPublication } from './standaloneHostedCanonicalStorage';
import { readHostedLifecycleOrchestratorTrustAnchor } from './standaloneHostedLifecycleTrustAnchor';
import {
  admitHostedReadRoot,
  resolveStandaloneAuthDataDirectory,
} from './standaloneHostedReadRoot';
import { admitStandaloneHostedState as admitHostedState } from './standaloneHostedStateAdmission';
import { sshConnectionManagerStub, updaterServiceStub } from './standaloneServiceStubs';
import {
  createStandaloneFatalFailStop,
  createStandaloneOrderlyOwnerLossGuard,
  registerStandaloneShutdownSignalHandlers,
  runStandaloneShutdownLifecycle,
} from './standaloneShutdownLifecycle';
import {
  createTeamLifecycleReadQueryContext,
  teamLifecycleReadNowMs,
} from './standaloneTeamLifecycleReadQueryContext';

import type { HostedExternalWriterInventorySupervisor } from './composition/hosted/hostedExternalWriterInventorySupervisor';
export { resolveHostedTeamWorkspaceId } from './composition/hosted/hostedTeamWorkspaceAttribution';
export { readHostedLifecycleOrchestratorTrustAnchor } from './standaloneHostedLifecycleTrustAnchor';
export { resolveStandaloneAuthDataDirectory } from './standaloneHostedReadRoot';
export type {
  StandaloneFatalFailStopActions,
  StandaloneShutdownActions,
} from './standaloneShutdownLifecycle';
export {
  createStandaloneFatalFailStop,
  createStandaloneOrderlyOwnerLossGuard,
  registerStandaloneShutdownSignalHandlers,
  runStandaloneShutdownLifecycle,
} from './standaloneShutdownLifecycle';
import type { HostedAuthStorageBackend, HttpServices } from './http';
import type { HttpServer } from './services/infrastructure/HttpServer';
import type { NotificationManager } from './services/infrastructure/NotificationManager';
import type { ServiceContext } from './services/infrastructure/ServiceContext';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';
const logger = createLogger('Standalone');
const classifyHostedTeamConfigurationAuthorization = classifyHostedWorkspaceRegistryAuthorization;
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = parseInt(process.env.PORT ?? '3456', 10);
const CLAUDE_ROOT = process.env.CLAUDE_ROOT;
const HOSTED_COORDINATION_EVENT_RETENTION_POLICY = readHostedCoordinationEventRetentionPolicy(
  process.env
);
if (!process.env.CORS_ORIGIN) process.env.CORS_ORIGIN = process.env.AUTH_PUBLIC_ORIGIN ?? '*';
let localContext: ServiceContext;
let notificationManager: NotificationManager;
let httpServer: HttpServer;
let configManager: { flush(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;
let hostedAuthStorageBackend: HostedAuthStorageBackend | null = null;
let hostedDraftPublication: HostedDraftPublicationComposition | null = null;
let hostedPromotionStorage: ReturnType<typeof createHostedPromotionStorageBackend> | null = null;
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
const orderlyOwnerLossGuard = createStandaloneOrderlyOwnerLossGuard(
  sameOrchestratorLifecycleOwnerBinding
);

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
async function start(): Promise<void> {
  logger.info('Starting standalone server...');
  logger.error('Hosted readiness diagnostic stage=startup_before_http outcome=started code=none');
  const hostedBootstrapEnvironment = Object.freeze({ ...process.env });
  const serializedHostedBootstrap = readTeamLifecycleReadBootstrapEnvironment(
    hostedBootstrapEnvironment
  );
  const hostedMode = serializedHostedBootstrap !== undefined || process.env.AUTH_MODE !== undefined;
  const authDataDirectory = resolveStandaloneAuthDataDirectory(process.env, hostedMode);
  const hostedStateAdmission = hostedMode
    ? await admitHostedState(
        hostedBootstrapEnvironment,
        __dirname,
        authDataDirectory,
        serializedHostedBootstrap !== undefined
      )
    : null;
  if (!hostedMode && hostedBootstrapEnvironment.HOSTED_OPENCODE_RUNTIME_MODE) {
    throw new Error('hosted_opencode_runtime_requires_hosted_mode');
  }
  hostedAuthStorageBackend = createInternalStorageFeature({
    userDataPath: authDataDirectory,
    scope: 'hosted-auth',
    productAuthorityLockDirectory: hostedMode
      ? ensureProductTaskWriteLockDirectory(authDataDirectory)
      : undefined,
  });
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

      hostedDraftPublication = await createAdmittedHostedDraftPublication({
        bootstrap,
        drafts: hostedAuthStorageBackend,
        authDataDirectory,
        pendingFirstBoot: hostedStateAdmission?.pendingCanonicalFirstBoot ?? false,
        completeFirstBoot: () => hostedStateAdmission!.completeCanonicalFirstBoot(),
      });
      if (hostedDraftPublication === null) {
        logger.warn(
          'Canonical draft publication unavailable; configuration mutations remain disabled.'
        );
      }
      const teamIdentityGateway = await createTeamLifecycleReadOnlyIdentitySource({
        appDataRoot,
        currentWriter: hostedDraftPublication?.identityReadSource,
      });
      if (teamIdentityGateway === null) {
        logger.warn(
          'Hosted team lifecycle identity admission unavailable; canonical reads remain disabled.'
        );
      } else {
        hostedTeamIdentityReadBackend = hostedDraftPublication
          ? null
          : createHostedTeamIdentityReadBackend(appDataRoot);
        const liveTeamIdentityGateway =
          hostedTeamIdentityReadBackend?.gateway ?? teamIdentityGateway;
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
  if (hostedMode) {
    const ready = await configureHostedOpenCodeRuntimeAtStartup({
      environment: hostedBootstrapEnvironment,
      runtimeEnvironment: process.env,
      authDataDirectory,
      lockFilePath: resolve(__dirname, '../opencode-hosted-runtime.lock.json'),
    });
    if (ready) logger.info('Hosted official OpenCode runtime verified and ready');
  }
  const { configManager: admittedConfigManager } =
    await import('./services/infrastructure/ConfigManager');
  configManager = admittedConfigManager;
  if (admittedHostedClaudeRoot !== null) {
    setClaudeBasePathOverride(admittedHostedClaudeRoot);
  }
  const [{ HttpServer }, { LocalFileSystemProvider }, { NotificationManager }, { ServiceContext }] =
    await Promise.all([
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
      ...hostedProductionOwnerRouteDescriptors(productionOwnerAdmission, hostedAccessFeature.mode),
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
  const runtimeCreationAdmission = createHostedRuntimeCreationAdmission({
    authMode: hostedAccessFeature.mode,
    pairingMaterial: () =>
      probeHostedPairingMaterial(resolveHostedPairingCodePath(process.env), hostedAuthHostPlatform),
    reportRefusal: (diagnostic) => logger.error(diagnostic),
  });
  logger.error('Hosted readiness diagnostic stage=lifecycle_composition outcome=started code=none');
  try {
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
            ...(hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT ===
            undefined
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
            onFatalOwnerLoss: (error, ownerBinding) => {
              if (orderlyOwnerLossGuard.isExpectedOwnerLoss(ownerBinding)) {
                logger.info('Hosted lifecycle owner closed during authenticated orderly shutdown');
                return;
              }
              requestStandaloneFatalFailStop?.('Hosted lifecycle orchestrator owner lost', error);
            },
            registerReadinessCleanup: (cleanup) => {
              hostedLifecycleReadinessCleanup = cleanup;
              if (fatalFailStop) cleanup?.();
            },
            restoreGeneration: hostedAccessFeature.restoreGeneration,
            runReservations: () => hostedPromotionStorage?.hostedRuns ?? null,
            currentAuthority: () => hostedPromotionStorage?.currentAuthority ?? null,
            mountGeneration:
              hostedTeamMessageRouteDependencies?.mountBinding.mountGeneration ?? null,
            routeAdmissionBinding: hostedRouteAdmissionBinding,
            admitLifecycleAction: runtimeCreationAdmission.admit,
          });
  } catch (error) {
    logger.error(
      'Hosted readiness diagnostic stage=lifecycle_composition outcome=failed code=unavailable'
    );
    throw error;
  }
  logger.error(
    `Hosted readiness diagnostic stage=lifecycle_composition outcome=${hostedLifecycleCommands === null ? 'skipped' : 'succeeded'} code=${hostedLifecycleCommands === null ? 'unavailable' : 'composition_created'}`
  );
  hostedOperatorProduction = await createHostedApprovalProductionCompositionFromEnvironment(
    hostedBootstrapEnvironment,
    {
      authentication: hostedAccessFeature.http,
      expectedDeploymentId: hostedAccessFeature.deploymentId,
      restoreGeneration: hostedAccessFeature.restoreGeneration,
      actorId: hostedApprovalActorId,
      routeDependencies: hostedTeamMessageRouteDependencies,
      approvalStorage: hostedAuthStorageBackend.teamApprovals,
      routeAdmissionBinding: hostedRouteAdmissionBinding,
      ownerAdmission: productionOwnerAdmission,
      ownerProofKey: lifecycleTrustAnchor,
      onApprovalOwnerLoss: (error) =>
        requestStandaloneFatalFailStop?.('Approval owner lost', error),
    },
    {
      drainStreams: (operation) => {
        if (!hostedCoordinationEventStream)
          throw new Error('hosted_coordination_stream_not_initialized');
        return hostedCoordinationEventStream.runWithStreamsDrained((retainAdmission) =>
          runWithEventStreamsDrained(() => operation(retainAdmission))
        );
      },
      createRouteAdmission: (isReady) =>
        createHostedRouteAdmissionBinding({
          routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
          routeScope: 'production',
          readiness: {
            readiness: async () =>
              createStandaloneHostedRouteReadiness({
                fatalFailStop,
                runtimeIdentityAvailable: hostedDiagnosticsRuntimeInstance !== null,
                diagnosticsAvailable: hostedDiagnostics?.isReady() === true,
                lifecycleOwnerAvailable: isReady(),
              }),
          },
        }),
      revokeLifecycle: () => {
        hostedTeamMessageWriter?.close();
        hostedLifecycleCommands?.close();
        hostedLifecycleReadinessCleanup?.();
      },
    },
    isHostedMvpManualApprovalAvailable()
  );
  const hostedTeamRoutes = createStandaloneHostedTeamRoutes({
    dependencies: hostedTeamMessageRouteDependencies,
    lifecycleCommands: hostedLifecycleCommands,
    currentLifecycleCommands: () => hostedLifecycleCommands,
    ownerProofKey: lifecycleTrustAnchor,
    restoreGeneration: hostedAccessFeature.restoreGeneration,
    externalWriterSupervisor: () => hostedExternalWriterSupervisor,
    reportReadDiagnostic: (stage, code) =>
      logger.error(`Hosted task-board unavailable: ${stage} diagnostic=${code}`),
  });
  hostedTeamMessageWriter = hostedTeamRoutes.writer;
  createHostedTeamMessageRoutes = hostedTeamRoutes.createTeamMessageRoutes;
  createHostedTaskBoardReadRoutes = hostedTeamRoutes.createTaskBoardReadRoutes;
  const { promotionRoot, promotionStorage } = await createStandalonePromotionStorage({
    authDataDirectory,
    productAuthorityLockDirectory: hostedAuthStorageBackend.productAuthorityLockDirectory,
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
    mountBinding: hostedTeamMessageRouteDependencies?.mountBinding,
    draftPublicationAvailable: hostedDraftPublication !== null,
    restoreGeneration: hostedAccessFeature.restoreGeneration,
  });
  hostedPromotionStorage = promotionStorage;
  hostedTeamConfiguration = createStandaloneHostedTeamConfiguration({
    hostedDiagnosticsRuntimeInstance,
    hostedAccessFeature,
    teamIdentityGrantFenceSource,
    hostedDraftPublication,
    hostedAuthStorageBackend,
    hostedPromotionStorage,
    promotionRoot,
    hostedLifecycleCommands,
    isReady: () => hostedTeamConfiguration?.isReady() === true,
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
    streamIdentityFactory: hostedCoordinationEventStreamIdentityFactory,
    retentionPolicy: HOSTED_COORDINATION_EVENT_RETENTION_POLICY,
    diagnosticObserver: (observation) => {
      logger.error('hosted_coordination_event_stream_transport', JSON.stringify(observation));
    },
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
    workspaceTrust: createNodeWorkspaceTrustFeatures({
      getClaudeConfigDir: getClaudeBasePath,
      getAutoDetectedClaudeConfigDir: getAutoDetectedClaudeBasePath,
      getHomeDir,
    }).status,
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
  hostedOperatorProduction?.close();
  hostedOperatorProduction = null;
  hostedTeamMessageWriter?.close();
  hostedTeamMessageWriter = null;
  hostedLifecycleReadinessCleanup?.();
  hostedLifecycleReadinessCleanup = null;
  hostedLifecycleCommands?.close();
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
        await hostedDraftPublication?.dispose();
        hostedDraftPublication = null;
        await hostedLifecycleCommands?.drainRetirement();
        hostedLifecycleCommands = null;
        await hostedPromotionStorage?.dispose();
        hostedPromotionStorage = null;
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
    beforeShutdown: () => {
      orderlyOwnerLossGuard.beginOrderlyShutdown(
        hostedLifecycleCommands?.mutationLease.currentBinding() ?? null
      );
    },
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
