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
 * - CORS_ORIGIN: Comma-separated exact allowed browser origins (same origin by default)
 * - AGENT_TEAMS_HTTP_PUBLIC_ORIGIN: Explicit public/LAN/reverse-proxy origin
 * - AGENT_TEAMS_HTTP_AUTH_DIR: Private generated authority directory (default app data directory)
 */

// Note: Sentry is NOT imported here. @sentry/electron/main requires Electron
// runtime which is unavailable in standalone (pure Node.js) mode. Standalone
// error tracking can be added later with @sentry/node if needed.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ApiAuthority } from '@features/local-http-auth/contracts';
import {
  apiProfileScope,
  checkApiReadiness,
  closePublicationAdmission,
  configurePublicationHelper,
  disposePublicationHelper,
  publishApiAuthority,
} from '@features/local-http-auth/main';
import { createRecentProjectsFeature } from '@features/recent-projects/main';
import { createWorkspaceTrustFeatures } from '@features/workspace-trust/main';
import { createLogger } from '@shared/utils/logger';

import { LocalFileSystemProvider } from './services/infrastructure/LocalFileSystemProvider';
import { buildTeamControlApiBaseUrl } from './services/team/TeamControlApiState';
import {
  getAppDataBasePath,
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
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

// =============================================================================
// Lifecycle
// =============================================================================

async function start(): Promise<void> {
  const moduleDirectory =
    typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  configurePublicationHelper({
    directory: path.resolve(
      moduleDirectory,
      path.basename(moduleDirectory) === 'dist-standalone'
        ? '../dist-local-http-auth'
        : '../../dist-local-http-auth',
    ),
    mode: 'node',
    prepareStandaloneRoot: true,
  });
  logger.info('Starting standalone server...');

  // Apply Claude root override if set
  if (CLAUDE_ROOT) {
    setClaudeBasePathOverride(CLAUDE_ROOT);
    logger.info(`Using CLAUDE_ROOT: ${CLAUDE_ROOT}`);
  }

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
  localContext.start();

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
    workspaceTrust: createWorkspaceTrustFeatures({
      getClaudeConfigDir: getClaudeBasePath,
      getAutoDetectedClaudeConfigDir: getAutoDetectedClaudeBasePath,
      getHomeDir,
    }).status,
    updaterService: updaterServiceStub,
    sshConnectionManager: sshConnectionManagerStub,
  };

  // No-op mode switch handler (no SSH in standalone)
  const modeSwitchHandler = async (): Promise<void> => {};

  // Start the server
  const port = await httpServer.start(services, modeSwitchHandler, PORT, HOST);
  const root = process.env.AGENT_TEAMS_HTTP_AUTH_DIR?.trim() || getAppDataBasePath();
  const token = httpServer.getAuthToken();
  if (!token) throw new Error('HTTP credential generation failed');
  const authority: ApiAuthority = {
    schemaVersion: 1,
    service: 'api',
    profileScope: apiProfileScope(root),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl:
      process.env.AGENT_TEAMS_HTTP_PUBLIC_ORIGIN?.trim() ||
      `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST}:${port}`,
    token,
  };
  try {
    await checkApiReadiness(buildTeamControlApiBaseUrl(port, HOST), token);
    await publishApiAuthority(root, authority);
  } catch (error) {
    await httpServer.stop();
    throw error;
  }
  logger.info(
    `API access key is in the owner-only authority descriptor referenced by ${path.join(root, 'team-control-api.json')}`
  );
  logger.info(`Standalone server running at http://${HOST}:${port}`);
  logger.info(`Open ${httpServer.getAccessUrl()} and enter the generated API access key`);
}

async function shutdown(): Promise<void> {
  closePublicationAdmission();
  logger.info('Shutting down...');
  if (httpServer?.isRunning()) {
    await httpServer.stop();
  }
  await disposePublicationHelper();

  if (localContext) {
    localContext.dispose();
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

// =============================================================================
// Signal Handlers
// =============================================================================

// SIGINT works on all platforms (Ctrl+C), but SIGTERM does not exist on Windows.
process.on('SIGINT', () => void shutdown());
if (process.platform !== 'win32') {
  process.on('SIGTERM', () => void shutdown());
}

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
