/**
 * Standalone (non-Electron) entry point for Agent Teams AI.
 *
 * Runs the HTTP server + API without Electron, suitable for Docker
 * or any headless/remote environment. The renderer is served as
 * static files over HTTP.
 *
 * Environment variables:
 * - HOST: Bind address (default '0.0.0.0')
 * - PORT: Listen port (default 3456)
 * - CLAUDE_ROOT: Path to .claude directory (default ~/.claude)
 * - CORS_ORIGIN: CORS origin policy (default '*')
 */

// Note: Sentry is NOT imported here. @sentry/electron/main requires Electron
// runtime which is unavailable in standalone (pure Node.js) mode. Standalone
// error tracking can be added later with @sentry/node if needed.

import { isAbsolute, resolve } from 'node:path';

import { createRecentProjectsFeature } from '@features/recent-projects/main';
import { createQueryContext } from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';

import {
  PHASE2_READ_BOOTSTRAP_ENV,
  Phase2ReadBootstrapSource,
} from './composition/hosted/phase2ReadBootstrapSource';
import {
  createMountBindingScopedPhase2ReadPorts,
  createPhase2ReadComposition,
  createPhase2ReadHost,
  createUnavailablePhase2ReadHost,
  type Phase2ReadAuthority,
  type Phase2ReadHost,
} from './composition/hosted/phase2ReadComposition';
import { createPhase2ReadOnlyIdentitySource } from './composition/hosted/phase2ReadOnlyIdentitySource';
import { LocalFileSystemProvider } from './services/infrastructure/LocalFileSystemProvider';
import {
  getProjectsBasePath,
  getTodosBasePath,
  setClaudeBasePathOverride,
} from './utils/pathDecoder';

import type { HttpServices } from './http';
import type { HttpServer } from './services/infrastructure/HttpServer';
import type { NotificationManager } from './services/infrastructure/NotificationManager';
import type { ServiceContext } from './services/infrastructure/ServiceContext';
import type { SshConnectionManager } from './services/infrastructure/SshConnectionManager';
import type { UpdaterService } from './services/infrastructure/UpdaterService';

const logger = createLogger('Standalone');

// =============================================================================
// Configuration
// =============================================================================

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = parseInt(process.env.PORT ?? '3456', 10);
const CLAUDE_ROOT = process.env.CLAUDE_ROOT;

// Default CORS to allow all in standalone mode (Docker isolation replaces CORS)
if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = '*';
}

// =============================================================================
// Stub services (Electron-only features unavailable in standalone)
// =============================================================================

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

// =============================================================================
// Application State
// =============================================================================

let localContext: ServiceContext;
let notificationManager: NotificationManager;
let httpServer: HttpServer;
let configManager: { flush(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;

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
    throw new TypeError('phase2-read-runtime-root-invalid');
  }
  return reference;
}

const phase2ReadNowMs = (): number => Date.now();

function createPhase2ReadQueryContext(authority: Phase2ReadAuthority, requestSignal: AbortSignal) {
  return createQueryContext({
    actorId: authority.actorId,
    sessionId: 'session_phase2-standalone',
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    requestId: `request_phase2-standalone-${++phase2ReadRequestSequence}`,
    authorizedScope: authority.authorizedScope,
    deadlineAtMs: phase2ReadNowMs() + 10_000,
    signal: requestSignal,
  });
}

let phase2ReadRequestSequence = 0;

// =============================================================================
// Lifecycle
// =============================================================================

async function start(): Promise<void> {
  logger.info('Starting standalone server...');

  const serializedHostedBootstrap = process.env[PHASE2_READ_BOOTSTRAP_ENV];
  const hostedMode = serializedHostedBootstrap !== undefined;
  let phase2ReadHost: Phase2ReadHost = createUnavailablePhase2ReadHost();

  if (hostedMode) {
    // Hosted admission is complete before any ServiceContext/FileWatcher or HTTP service exists.
    // An invalid launcher envelope aborts startup; unavailable identity storage leaves only the
    // canonical read facet unavailable and never falls back to ambient discovery.
    const bootstrap = await new Phase2ReadBootstrapSource({
      input: {
        readSerializedBootstrap: () => serializedHostedBootstrap,
      },
      nowMs: phase2ReadNowMs,
    }).load();
    const claudeRoot = admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference);
    const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference);
    setClaudeBasePathOverride(claudeRoot);

    const teamIdentityGateway = await createPhase2ReadOnlyIdentitySource({ appDataRoot });
    if (teamIdentityGateway) {
      try {
        const readPorts = createMountBindingScopedPhase2ReadPorts({
          authority: bootstrap.authority,
          mountBinding: bootstrap.mountBinding,
          runtimeInstance: bootstrap.runtimeInstance,
          teamIdentities: teamIdentityGateway,
          nowMs: phase2ReadNowMs,
        });
        await readPorts.teamIdentities.listTeamIdentities();
        const composition = createPhase2ReadComposition({
          authority: bootstrap.authority,
          ...readPorts,
          nowMs: phase2ReadNowMs,
        });
        phase2ReadHost = createPhase2ReadHost(composition, createPhase2ReadQueryContext);
      } catch {
        logger.warn(
          'Hosted Phase 2 identity admission unavailable; canonical reads remain disabled.'
        );
      }
    } else {
      logger.warn('Hosted Phase 2 identity storage unavailable; canonical reads remain disabled.');
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
  const [{ HttpServer }, { NotificationManager }, { ServiceContext }] = await Promise.all([
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
  const recentProjectsFeature = createRecentProjectsFeature({
    getActiveContext: () => localContext,
    getLocalContext: () => localContext,
    logger: createLogger('Feature:RecentProjects'),
  });
  // Wire file watcher events to SSE broadcast
  localContext.fileWatcher.on('file-change', (event: unknown) => {
    httpServer.broadcast('file-change', event);
  });
  localContext.fileWatcher.on('todo-change', (event: unknown) => {
    httpServer.broadcast('todo-change', event);
  });

  // Forward notification events to SSE
  notificationManager.on('notification-new', (notification: unknown) => {
    httpServer.broadcast('notification:new', notification);
  });
  notificationManager.on('notification-updated', (data: unknown) => {
    httpServer.broadcast('notification:updated', data);
  });
  notificationManager.on('notification-clicked', (data: unknown) => {
    httpServer.broadcast('notification:clicked', data);
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
    phase2ReadHost,
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
      if (httpServer?.isRunning()) {
        await httpServer.stop();
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

// =============================================================================
// Signal Handlers
// =============================================================================

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

  // =============================================================================
  // Start
  // =============================================================================

  void start();
}
