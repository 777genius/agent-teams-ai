import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStream,
} from '@features/coordination-events/main';
import { createHostedAccessFeature, type HostedAccessFeature } from '@features/hosted-access/main';
// eslint-disable-next-line no-restricted-imports -- Hosted operations exposes route descriptors for production composition.
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '@features/hosted-operations/main/hosted';
import { createRecentProjectsFeature } from '@features/recent-projects/main';
// eslint-disable-next-line no-restricted-imports -- Team approvals exposes route descriptors for production composition.
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Team lifecycle exposes route descriptors for production composition.
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';
import { createQueryContext } from '@shared/contracts/hosted';
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
  type OrchestratorLifecycleOwnerProofKey,
  parseOrchestratorLifecycleOwnerProofKey,
} from './composition/hosted/hostedLifecycleOrchestratorReadiness';
import { admitHostedLifecycleProductionOwner } from './composition/hosted/hostedLifecycleProductionOwnerAdmission';
import {
  createHostedOperatorProductionComposition,
  type HostedOperatorProductionComposition,
} from './composition/hosted/hostedOperatorProductionComposition';
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
import { sshConnectionManagerStub, updaterServiceStub } from './standaloneServiceStubs';
import {
  createStandaloneFatalFailStop,
  registerStandaloneShutdownSignalHandlers,
  runStandaloneShutdownLifecycle,
} from './standaloneShutdownLifecycle';

export { resolveHostedTeamWorkspaceId } from './composition/hosted/hostedTeamWorkspaceAttribution';
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
// Default CORS to allow all in standalone mode (Docker isolation replaces CORS)
if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = process.env.AUTH_PUBLIC_ORIGIN ?? '*';
}
let localContext: ServiceContext;
let notificationManager: NotificationManager;
let httpServer: HttpServer;
let configManager: { flush(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;
let hostedAuthStorageBackend: HostedAuthStorageBackend | null = null;
let hostedAccessFeature: HostedAccessFeature | null = null;
let hostedCoordinationEventStream: HostedCoordinationEventStream | null = null;
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

function hostedRouteReadiness(): {
  readonly revision: number;
  readonly dimensions: HostedReadinessDimensionStates;
} {
  const runtimeIdentityAvailable = hostedDiagnosticsRuntimeInstance !== null;
  const diagnosticsAvailable = hostedDiagnostics?.isReady() === true;
  const operatorAvailable = hostedOperatorProduction?.isReady() === true;
  const lifecycleOwnerAvailable =
    !fatalFailStop && runtimeIdentityAvailable && hostedLifecycleCommands?.isReady() === true;
  const readiness = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => {
      const ready =
        !fatalFailStop &&
        (dimension === 'live' ||
          dimension === 'serve' ||
          dimension === 'auth' ||
          (dimension === 'read' && runtimeIdentityAvailable && diagnosticsAvailable) ||
          (dimension === 'mutation' && lifecycleOwnerAvailable && operatorAvailable) ||
          (dimension === 'runtime-control' && lifecycleOwnerAvailable));
      const reason = fatalFailStop
        ? 'fatal_fail_stop'
        : !runtimeIdentityAvailable
          ? 'runtime_identity_unavailable'
          : !diagnosticsAvailable
            ? 'diagnostics_unavailable'
            : !operatorAvailable
              ? 'operator_surfaces_unavailable'
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
      (operatorAvailable ? 1 : 0) +
      (lifecycleOwnerAvailable ? 1 : 0),
    dimensions: Object.freeze({
      ...readiness,
      terminal: HOSTED_TERMINAL_READINESS,
    }) as HostedReadinessDimensionStates,
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

export function readHostedLifecycleOrchestratorTrustAnchor(
  runtimeInstance: null,
  environment: Readonly<Record<string, string | undefined>>
): null;
export function readHostedLifecycleOrchestratorTrustAnchor(
  runtimeInstance: RuntimeInstanceContext,
  environment: Readonly<Record<string, string | undefined>>
): OrchestratorLifecycleOwnerProofKey;
export function readHostedLifecycleOrchestratorTrustAnchor(
  runtimeInstance: RuntimeInstanceContext | null,
  environment: Readonly<Record<string, string | undefined>>
): OrchestratorLifecycleOwnerProofKey | null {
  if (runtimeInstance === null) return null;
  const inline = environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR;
  const filePath = environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE;
  if (inline !== undefined && filePath !== undefined) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-source-ambiguous');
  }
  if (
    inline !== undefined &&
    environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TEST_ONLY_INLINE_TRUST_ANCHOR !== '1'
  ) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-inline-production-forbidden');
  }
  if (filePath === undefined) return parseOrchestratorLifecycleOwnerProofKey(inline);
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath || filePath.includes('\0')) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-invalid');
  }
  const before = lstatSync(filePath, { bigint: true });
  let descriptor: number;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-invalid');
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const mode = Number(stat.mode & 0o777n);
    const runtimeUid = process.getuid?.() ?? 0;
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !stat.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      (stat.uid !== 0n && stat.uid !== BigInt(runtimeUid)) ||
      mode !== 0o400 ||
      stat.size < 64n ||
      stat.size > 65n
    ) {
      throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-invalid');
    }
    const bytes = Buffer.alloc(Number(stat.size));
    const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    if (bytesRead !== bytes.byteLength) {
      throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-substituted');
    }
    const text = bytes.toString('utf8');
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(filePath, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      descriptorAfter.dev !== stat.dev ||
      descriptorAfter.ino !== stat.ino ||
      descriptorAfter.size !== stat.size ||
      descriptorAfter.mtimeNs !== stat.mtimeNs ||
      descriptorAfter.ctimeNs !== stat.ctimeNs ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-substituted');
    }
    return parseOrchestratorLifecycleOwnerProofKey(text.endsWith('\n') ? text.slice(0, -1) : text);
  } finally {
    closeSync(descriptor);
  }
}

async function start(): Promise<void> {
  logger.info('Starting standalone server...');
  // The read bootstrap and owner manifest admission must bind the same immutable environment bytes.
  const hostedBootstrapEnvironment = Object.freeze({ ...process.env });
  const serializedHostedBootstrap = readTeamLifecycleReadBootstrapEnvironment(
    hostedBootstrapEnvironment
  );
  // AUTH_MODE declares hosted deployment; do not fall through to the legacy watcher.
  const hostedMode = serializedHostedBootstrap !== undefined || process.env.AUTH_MODE !== undefined;
  // The descriptor-safe owner admission HMAC covers the exact bootstrap bytes. Authenticate that
  // envelope (including its independently supplied release trust) before parsing either admitted
  // root or constructing ConfigManager, storage, watchers, and read routes.
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
  let teamIdentityGrantFenceSource: Awaited<
    ReturnType<typeof createTeamLifecycleReadOnlyIdentitySource>
  > = null;
  if (hostedMode) {
    if (serializedHostedBootstrap === undefined) {
      // Without canonical identity, mount exactly, start cache-only, and keep that feature unavailable.
      if (CLAUDE_ROOT === undefined) throw new Error('hosted_claude_root_required');
      admittedHostedClaudeRoot = admitHostedReadRoot(CLAUDE_ROOT);
      setClaudeBasePathOverride(admittedHostedClaudeRoot);
    } else {
      if (productionOwnerAdmission === null) {
        throw new Error('hosted_lifecycle_bootstrap_authentication_failed');
      }
      // Hosted admission is complete before any ServiceContext/FileWatcher or HTTP service exists.
      // An invalid launcher envelope aborts startup; unavailable identity storage leaves only the
      // canonical read facet unavailable and never falls back to ambient discovery.
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

      // Authenticate the canonical identity database from the admitted app-data root before any
      // ambient ConfigManager, ServiceContext, watcher, or HTTP route can be constructed. The
      // gateway pins that admitted path identity and revalidates a bounded descriptor snapshot on
      // every later call so identity revisions remain visible without ambient discovery.
      const teamIdentityGateway = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
      if (teamIdentityGateway === null) {
        logger.warn(
          'Hosted team lifecycle identity admission unavailable; canonical reads remain disabled.'
        );
      } else {
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
        hostedTeamMessageRouteDependencies = {
          runtimeInstance: bootstrap.runtimeInstance,
          mountBinding: bootstrap.mountBinding,
          teamIdentities: teamIdentityGateway,
          reportReadDiagnostic: (stage, code) =>
            logger.error(`Hosted team-message read unavailable: stage=${stage} code=${code}`),
        };
        teamIdentityGrantFenceSource = readPorts.teamIdentities;
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
  if (admittedHostedClaudeRoot !== null) {
    setClaudeBasePathOverride(admittedHostedClaudeRoot);
  }
  // Import services after applying CLAUDE_ROOT so ConfigManager picks up the correct base path.
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
  // Authentication/session state is a distinct deployment-owned database. The launcher's admitted
  // appDataRoot is authority only for canonical team identity/read projection and must never
  // redirect hosted auth persistence.
  const authDataDirectory = resolveStandaloneAuthDataDirectory(process.env, hostedMode);
  hostedAuthStorageBackend = createHostedAuthStorageBackend(authDataDirectory);
  const hostedAuthHostPlatform = createHostedAccessNodePlatform();
  // Team attribution is lifecycle authority, not authentication persistence. Fence it with the
  // mount-scoped gateway derived from the launcher-admitted canonical appDataRoot database.
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
  if (productionOwnerAdmission === null) {
    logger.warn(
      'No release-pinned production lifecycle owner is admitted; hosted mutation routes remain unmounted.'
    );
  }
  hostedRouteAdmissionBinding = createHostedRouteAdmissionBinding({
    routes: [
      ...HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
      ...(hostedTeamMessageRouteDependencies === null
        ? []
        : HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS),
      ...(productionOwnerAdmission === null ? [] : HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS),
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
  hostedOperatorProduction =
    hostedDiagnosticsRuntimeInstance === null || hostedTeamMessageRouteDependencies === null
      ? null
      : createHostedOperatorProductionComposition({
          authentication: hostedAccessFeature.http,
          runtimeInstance: hostedDiagnosticsRuntimeInstance,
          expectedDeploymentId: hostedAccessFeature.deploymentId,
          workspaceId: hostedTeamMessageRouteDependencies.mountBinding.workspaceId,
          mountGeneration: hostedTeamMessageRouteDependencies.mountBinding.mountGeneration,
          restoreGeneration: hostedAccessFeature.restoreGeneration,
          teamIdentities: hostedTeamMessageRouteDependencies.teamIdentities,
          approvalStorage: hostedAuthStorageBackend.teamApprovals,
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
      ...(hostedTeamMessageWriter === null
        ? {}
        : {
            mutationAuthority: new HostedTaskBoardOrchestratorAuthority(hostedTeamMessageWriter),
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
    hostedOperatorSurfaceRoutes: hostedOperatorProduction ?? undefined,
    ...(hostedLifecycleCommands === null
      ? {}
      : { hostedLifecycleCommandRoutes: hostedLifecycleCommands }),
    hostedWorkspaceRegistryRoutes,
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
      requestedExitCode: () => standaloneRequestedExitCode,
    },
    standaloneRequestedExitCode
  );

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

  // Start
  void start().catch((error) => {
    logger.error('Standalone startup failed:', error);
    void shutdown(1);
  });
}
