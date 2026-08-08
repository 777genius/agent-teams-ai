import { isAbsolute, resolve } from 'node:path';

import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStream,
} from '@features/coordination-events/main';
import { createHostedAccessFeature, type HostedAccessFeature } from '@features/hosted-access/main';
// eslint-disable-next-line no-restricted-imports -- Hosted operations exposes route descriptors for production composition.
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '@features/hosted-operations/main/hosted';
import { createRecentProjectsFeature } from '@features/recent-projects/main';
import { TEAM_LIFECYCLE_READ_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
// eslint-disable-next-line no-restricted-imports -- Team lifecycle exposes route descriptors for production composition.
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';
import {
  createQueryContext,
  type Cursor,
  type Revision,
  type TeamId,
} from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';

import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  type HostedRouteAdmissionBinding,
} from './composition/hosted/application';
import {
  createHostedAccessNodeLocalControlTransportFactory,
  createHostedAccessNodePlatform,
} from './composition/hosted/hostedAccessNodePlatform';
import { createHostedCoordinationEventStreamAuthorizer } from './composition/hosted/hostedCoordinationEventStreamAuthorizer';
import {
  createHostedDiagnosticsComposition,
  type HostedDiagnosticsComposition,
} from './composition/hosted/hostedDiagnosticsComposition';
import {
  createHostedTaskBoardReadRouteFactory,
  type HostedTaskBoardReadRouteFactory,
} from './composition/hosted/hostedTaskBoardReadComposition';
import {
  classifyHostedTeamConfigurationAuthorization,
  createHostedTeamConfigurationComposition,
  createHostedTeamConfigurationRouteAdmissionBinding,
  type HostedTeamConfigurationComposition,
} from './composition/hosted/hostedTeamConfigurationComposition';
import { createHostedTeamMessageRouteFactory } from './composition/hosted/hostedTeamMessageComposition';
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
import { LocalFileSystemProvider } from './services/infrastructure/LocalFileSystemProvider';
import {
  getProjectsBasePath,
  getTodosBasePath,
  setClaudeBasePathOverride,
} from './utils/pathDecoder';

import type { HostedTeamMessageRouteFactory } from './composition/hosted/hostedTeamMessageComposition';
import type { HostedAuthStorageBackend, HttpServices } from './http';
import type { HttpServer } from './services/infrastructure/HttpServer';
import type { NotificationManager } from './services/infrastructure/NotificationManager';
import type { ServiceContext } from './services/infrastructure/ServiceContext';
import type { SshConnectionManager } from './services/infrastructure/SshConnectionManager';
import type { UpdaterService } from './services/infrastructure/UpdaterService';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

const logger = createLogger('Standalone');
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = parseInt(process.env.PORT ?? '3456', 10);
const CLAUDE_ROOT = process.env.CLAUDE_ROOT;
// Default CORS to allow all in standalone mode (Docker isolation replaces CORS)
if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = process.env.AUTH_PUBLIC_ORIGIN ?? '*';
}
/** No-op UpdaterService stub — auto-updater requires Electron. */
const updaterServiceStub = {
  checkForUpdates: async () => {},
  downloadUpdate: async () => {},
  quitAndInstall: async () => {},
  setMainWindow: () => {},
} as unknown as UpdaterService;
/** No-op SshConnectionManager stub — SSH is managed per-user in the Electron app. */
const sshConnectionManagerStub = {
  getStatus: () => ({
    state: 'disconnected' as const,
    host: null,
    error: null,
    remoteProjectsPath: null,
  }),
  getProvider: () => new LocalFileSystemProvider(),
  isRemote: () => false,
  connect: async () => {},
  disconnect: () => {},
  testConnection: async () => ({ success: false, error: 'SSH not available in standalone mode' }),
  getConfigHosts: async () => [],
  resolveHostConfig: async () => null,
  dispose: () => {},
  on: () => sshConnectionManagerStub,
  off: () => sshConnectionManagerStub,
  emit: () => false,
} as unknown as SshConnectionManager;
let localContext: ServiceContext;
let notificationManager: NotificationManager;
let httpServer: HttpServer;
let configManager: { flush(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;
let hostedAuthStorageBackend: HostedAuthStorageBackend | null = null;
let hostedAccessFeature: HostedAccessFeature | null = null;
let hostedCoordinationEventStream: HostedCoordinationEventStream | null = null;
let hostedDiagnostics: HostedDiagnosticsComposition | null = null;
let hostedDiagnosticsRuntimeInstance: RuntimeInstanceContext | null = null;
let hostedLifecycleCommands: TeamLifecycleCommandComposition | null = null;
let hostedTeamConfiguration: HostedTeamConfigurationComposition | null = null;
let hostedRouteAdmissionBinding: HostedRouteAdmissionBinding | null = null;
let hostedWorkspaceEventBridge: HostedWorkspaceEventBridge | null = null;
let hostedAuthLocalControlHandle: { close(): Promise<void> } | null = null;

function hostedRouteReadiness(): {
  readonly revision: number;
  readonly dimensions: HostedReadinessDimensionStates;
} {
  const runtimeIdentityAvailable = hostedDiagnosticsRuntimeInstance !== null;
  const lifecycleOwnerAvailable =
    runtimeIdentityAvailable && hostedLifecycleCommands?.isReady() === true;
  const readiness = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => {
      const ready =
        dimension === 'live' ||
        dimension === 'serve' ||
        dimension === 'auth' ||
        (dimension === 'read' && runtimeIdentityAvailable) ||
        (dimension === 'mutation' && lifecycleOwnerAvailable) ||
        (dimension === 'runtime-control' && lifecycleOwnerAvailable);
      const reason = runtimeIdentityAvailable
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
    revision: (runtimeIdentityAvailable ? 1 : 0) + (lifecycleOwnerAvailable ? 1 : 0),
    dimensions: Object.freeze({
      ...readiness,
      terminal: HOSTED_TERMINAL_READINESS,
    }) as HostedReadinessDimensionStates,
  });
}

export interface StandaloneShutdownActions {
  stopHttpServer: () => Promise<void>;
  disposeLocalContext: () => void;
  flushConfig: () => Promise<void>;
  logInfo: (message: string) => void;
  logError: (message: string, error: unknown) => void;
  setExitCode: (code: number) => void;
  exit: (code: number) => void;
}
export async function runStandaloneShutdownLifecycle(
  actions: StandaloneShutdownActions
): Promise<void> {
  actions.logInfo('Shutting down...');
  let exitCode = 0;
  const recordFailure = (label: string, error: unknown): void => {
    exitCode = 1;
    actions.setExitCode(1);
    actions.logError(`${label}:`, error);
  };
  try {
    await actions.stopHttpServer();
  } catch (error) {
    recordFailure('HTTP server shutdown failed', error);
  }
  try {
    actions.disposeLocalContext();
  } catch (error) {
    recordFailure('Local context shutdown failed', error);
  }
  try {
    await actions.flushConfig();
  } catch (error) {
    recordFailure('ConfigManager flush failed during shutdown', error);
  }
  if (exitCode === 0) {
    actions.logInfo('Shutdown complete');
  }
  actions.exit(exitCode);
}
type StandaloneShutdownSignal = 'SIGINT' | 'SIGTERM';
export function registerStandaloneShutdownSignalHandlers(input: {
  platform: NodeJS.Platform;
  onSignal: (signal: StandaloneShutdownSignal, listener: () => void) => void;
  shutdown: () => Promise<void>;
}): void {
  const requestShutdown = (): void => {
    void input.shutdown();
  };
  input.onSignal('SIGINT', requestShutdown);
  if (input.platform !== 'win32') {
    input.onSignal('SIGTERM', requestShutdown);
  }
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
const HOSTED_TEAM_WORKSPACE_RESOLUTION_MAXIMUM_PAGES = 16;
/** Resolves team attribution through one bounded, revision-pinned canonical snapshot. */
export async function resolveHostedTeamWorkspaceId(
  host: TeamLifecycleReadHost,
  teamIdValue: TeamId
): Promise<string | null> {
  let cursor: Cursor | null = null;
  let expectedRevision: Revision | null = null;
  let resolvedWorkspaceId: string | null = null;
  try {
    for (let page = 0; page < HOSTED_TEAM_WORKSPACE_RESOLUTION_MAXIMUM_PAGES; page += 1) {
      const result = await host.listTeamLifecycle({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor,
        expectedRevision,
      });
      if (result.kind !== 'success') return null;
      if (expectedRevision !== null && result.snapshotRevision !== expectedRevision) return null;
      for (const item of result.items) {
        if (item.teamId !== teamIdValue) continue;
        if (resolvedWorkspaceId !== null) return null;
        resolvedWorkspaceId = item.workspaceId;
      }
      if (result.nextCursor === null) return resolvedWorkspaceId;
      cursor = result.nextCursor;
      expectedRevision = result.snapshotRevision;
    }
  } catch {
    return null;
  }
  return null;
}
async function start(): Promise<void> {
  logger.info('Starting standalone server...');
  const serializedHostedBootstrap = readTeamLifecycleReadBootstrapEnvironment(process.env);
  // AUTH_MODE declares hosted deployment; do not fall through to the legacy watcher.
  const hostedMode = serializedHostedBootstrap !== undefined || process.env.AUTH_MODE !== undefined;
  let teamLifecycleReadHost: TeamLifecycleReadHost = createUnavailableTeamLifecycleReadHost();
  let createHostedTaskBoardReadRoutes: HostedTaskBoardReadRouteFactory | null = null;
  let createHostedTeamMessageRoutes: HostedTeamMessageRouteFactory | null = null;
  if (hostedMode) {
    if (serializedHostedBootstrap === undefined) {
      // Without canonical identity, mount exactly, start cache-only, and keep that feature unavailable.
      if (CLAUDE_ROOT === undefined) throw new Error('hosted_claude_root_required');
      setClaudeBasePathOverride(admitHostedReadRoot(CLAUDE_ROOT));
    } else {
      // Hosted admission is complete before any ServiceContext/FileWatcher or HTTP service exists.
      // An invalid launcher envelope aborts startup; unavailable identity storage leaves only the
      // canonical read facet unavailable and never falls back to ambient discovery.
      const bootstrap = await new TeamLifecycleReadBootstrapSource({
        input: {
          readSerializedBootstrap: () => serializedHostedBootstrap,
        },
        nowMs: teamLifecycleReadNowMs,
      }).load();
      hostedDiagnosticsRuntimeInstance = bootstrap.runtimeInstance;
      const claudeRoot = admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference);
      const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference);
      setClaudeBasePathOverride(claudeRoot);
      const teamIdentityGateway = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
      if (teamIdentityGateway) {
        try {
          const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
            authority: bootstrap.authority,
            mountBinding: bootstrap.mountBinding,
            runtimeInstance: bootstrap.runtimeInstance,
            teamIdentities: teamIdentityGateway,
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
          const routeDeps = {
            runtimeInstance: bootstrap.runtimeInstance,
            mountBinding: bootstrap.mountBinding,
            teamIdentities: teamIdentityGateway,
          };
          createHostedTaskBoardReadRoutes = createHostedTaskBoardReadRouteFactory(routeDeps);
          createHostedTeamMessageRoutes = createHostedTeamMessageRouteFactory(routeDeps);
        } catch {
          logger.warn(
            'Hosted team lifecycle identity admission unavailable; canonical reads remain disabled.'
          );
        }
      } else {
        logger.warn(
          'Hosted team lifecycle identity storage unavailable; canonical reads remain disabled.'
        );
      }
    }
  } else if (CLAUDE_ROOT) {
    setClaudeBasePathOverride(CLAUDE_ROOT);
    logger.info(`Using CLAUDE_ROOT: ${CLAUDE_ROOT}`);
  }
  // ConfigManager is intentionally obtained only after hosted/non-hosted root admission.
  // The dynamic module export is the same singleton used by the desktop composition.
  const { configManager: admittedConfigManager } =
    await import('./services/infrastructure/ConfigManager');
  configManager = admittedConfigManager;
  // Import services after applying CLAUDE_ROOT so ConfigManager picks up the correct base path.
  const [
    { createHostedAuthStorageBackend },
    { HttpServer },
    { NotificationManager },
    { ServiceContext },
  ] = await Promise.all([
    import('./http'),
    import('./services/infrastructure/HttpServer'),
    import('./services/infrastructure/NotificationManager'),
    import('./services/infrastructure/ServiceContext'),
  ]);
  const projectsDir = getProjectsBasePath();
  const todosDir = getTodosBasePath();

  logger.info(`Projects directory: ${projectsDir}`);
  logger.info(`Todos directory: ${todosDir}`);

  // Create local context (the only context in standalone mode)
  localContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir,
    todosDir,
  });
  if (hostedMode) localContext.startCacheOnly();
  else localContext.start();

  // Initialize notification manager
  notificationManager = NotificationManager.getInstance();
  localContext.fileWatcher.setNotificationManager(notificationManager);

  // Create HTTP server
  httpServer = new HttpServer();
  const authDataDirectory = process.env.AUTH_DATA_DIR ?? '/data/.agent-teams';
  hostedAuthStorageBackend = createHostedAuthStorageBackend(authDataDirectory);
  const hostedAuthHostPlatform = createHostedAccessNodePlatform();
  hostedAccessFeature = await createHostedAccessFeature({
    environment: process.env,
    storage: hostedAuthStorageBackend.gateway,
    dataDirectory: authDataDirectory,
    hostPlatform: hostedAuthHostPlatform,
    localControlTransportFactory:
      createHostedAccessNodeLocalControlTransportFactory(hostedAuthHostPlatform),
    // Hosted standalone has no runtime/process mutation; destructive reset still requires AR evidence.
    noRuntimeMutationAtStartup: true,
    runWithBrowserStreamsDrained: runWithEventStreamsDrained,
    authorizationPolicy: classifyHostedTeamConfigurationAuthorization,
    isTaskBoardMutationRouteEnabled: () => hostedTeamTaskBoardRoutes?.mutationsEnabled === true,
    resolveTeamWorkspaceId: (teamId) => resolveHostedTeamWorkspaceId(teamLifecycleReadHost, teamId),
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
  });
  hostedRouteAdmissionBinding = createHostedRouteAdmissionBinding({
    routes: [
      ...HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
      ...HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
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
  hostedLifecycleCommands = await createOptionalTeamLifecycleCommandComposition({
    authentication: hostedAccessFeature.http,
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
    expectedDeploymentId: hostedAccessFeature.deploymentId,
    orchestratorSocketPath: process.env.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET,
    orchestratorExpectedUid: process.getuid?.(),
    orchestratorExpectedGid: process.getgid?.(),
    orchestratorExpectedMode: 0o600,
    restoreGeneration: hostedAccessFeature.restoreGeneration,
    routeAdmissionBinding: hostedRouteAdmissionBinding,
  });
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
  hostedCoordinationEventStream = createHostedCoordinationEventStream({
    storage: hostedAuthStorageBackend.coordinationEvents,
    deploymentId: hostedAccessFeature.deploymentId,
    authorizer: createHostedCoordinationEventStreamAuthorizer(hostedAccessFeature.http),
  });
  hostedAuthLocalControlHandle = await hostedAccessFeature.startLocalControl(
    process.env.AUTH_CONTROL_SOCKET ?? '/run/agent-teams/control.sock'
  );
  const recentProjectsFeature = createRecentProjectsFeature({
    getActiveContext: () => localContext,
    getLocalContext: () => localContext,
    logger: createLogger('Feature:RecentProjects'),
  });
  // Hosted events revalidate session and grant before opaque projection from one active workspace.
  hostedWorkspaceEventBridge = registerHostedWorkspaceEventBridge({
    fileEvents: localContext.fileWatcher,
    notificationEvents: notificationManager,
    isWorkspaceRegistered: (runtimeWorkspaceId) =>
      hostedAccessFeature!.http.isWorkspaceRegistered(runtimeWorkspaceId),
    broadcast: (channel, data) => {
      httpServer!.broadcast(channel, data);
    },
  });

  // Build services for HTTP routes
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
    ...(hostedLifecycleCommands === null
      ? {}
      : { hostedLifecycleCommandRoutes: hostedLifecycleCommands }),
    hostedTeamTaskBoardRoutes,
    hostedTeamMessageRoutes: createHostedTeamMessageRoutes?.(hostedAccessFeature),
    hostedTeamConfigurationRoutes: hostedTeamConfiguration ?? undefined,
  };

  // No-op mode switch handler (no SSH in standalone)
  const modeSwitchHandler = async (): Promise<void> => {};

  // Start the server
  const port = await httpServer.start(services, modeSwitchHandler, PORT, HOST);
  logger.info(`Standalone server running at http://${HOST}:${port}`);
  logger.info('Open in your browser to view Claude Code sessions');
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = runStandaloneShutdownLifecycle({
    stopHttpServer: async () => {
      const failures: unknown[] = [];
      try {
        hostedLifecycleCommands?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedLifecycleCommands = null;
      hostedTeamConfiguration = null;
      try {
        hostedDiagnostics?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedDiagnostics = null;
      hostedRouteAdmissionBinding = null;
      hostedDiagnosticsRuntimeInstance = null;
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
      // Keep ConfigManager as the final persistence drain before process exit.
      await configManager?.flush();
      await hostedAuthStorageBackend?.dispose();
      hostedAuthStorageBackend = null;
      hostedAccessFeature = null;
    },
    logInfo: (message) => logger.info(message),
    logError: (message, error) => logger.error(message, error),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    exit: (code) => process.exit(code),
  });

  return shutdownPromise;
}

// Signal Handlers
if (!process.env.VITEST) {
  // SIGINT works on all platforms (Ctrl+C), but SIGTERM does not exist on Windows.
  registerStandaloneShutdownSignalHandlers({
    platform: process.platform,
    onSignal: (signal, listener) => process.on(signal, listener),
    shutdown,
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
  });

  // Start
  void start().catch((error) => {
    logger.error('Standalone startup failed:', error);
    process.exitCode = 1;
    void shutdown();
  });
}
