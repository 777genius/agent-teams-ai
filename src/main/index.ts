/**
 * Main process entry point for Claude Agent Teams UI.
 *
 * Responsibilities:
 * - Initialize Electron app and main window
 * - Set up IPC handlers for data access
 * - Initialize ServiceContextRegistry with local context
 * - Start file watcher for live updates
 * - Manage application lifecycle
 */

import { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import { FileContentResolver } from '@main/services/team/FileContentResolver';
import { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import {
  CONTEXT_CHANGED,
  SSH_STATUS,
  TEAM_CHANGE,
  WINDOW_FULLSCREEN_CHANGED,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DEV_SERVER_PORT,
  getTrafficLightPositionForZoom,
  WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL,
} from '@shared/constants';
import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

import { initializeIpcHandlers, removeIpcHandlers } from './ipc/handlers';
import { showTeamNativeNotification } from './ipc/teams';
import { HttpServer } from './services/infrastructure/HttpServer';
import { TeamInboxReader } from './services/team/TeamInboxReader';
import { getProjectsBasePath, getTodosBasePath } from './utils/pathDecoder';
import {
  CliInstallerService,
  configManager,
  LocalFileSystemProvider,
  MemberStatsComputer,
  NotificationManager,
  ServiceContext,
  ServiceContextRegistry,
  SshConnectionManager,
  TaskBoundaryParser,
  TeamAgentToolsInstaller,
  TeamDataService,
  TeamMemberLogsFinder,
  TeamProvisioningService,
  UpdaterService,
} from './services';

import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('App');

// --- Team message notification tracking ---
const teamInboxReader = new TeamInboxReader();
/** Track last-seen message count per inbox file to detect new messages. */
const inboxMessageCounts = new Map<string, number>();
/** Debounce per-inbox to avoid flooding during batch writes. */
const inboxNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const INBOX_NOTIFY_DEBOUNCE_MS = 500;
/** Messages sent from our UI (user_sent) — suppress notifications for these. */
const suppressedSources = new Set(['user_sent']);

async function notifyNewInboxMessages(teamName: string, detail: string): Promise<void> {
  // detail is like "inboxes/carol.json" — extract member name
  const match = /^inboxes\/(.+)\.json$/.exec(detail);
  if (!match) return;
  const memberName = match[1];
  const key = `${teamName}:${memberName}`;

  try {
    const messages = await teamInboxReader.getMessagesFor(teamName, memberName);
    const prevCount = inboxMessageCounts.get(key) ?? 0;

    if (prevCount === 0) {
      // First load — seed count, don't notify
      inboxMessageCounts.set(key, messages.length);
      return;
    }

    if (messages.length <= prevCount) {
      inboxMessageCounts.set(key, messages.length);
      return;
    }

    // Messages are sorted newest-first, so new ones are at the beginning
    const newMessages = messages.slice(0, messages.length - prevCount);
    inboxMessageCounts.set(key, messages.length);

    // Resolve team display name
    let teamDisplayName = teamName;
    try {
      const service = teamDataService;
      if (service) {
        const summary = await service.listTeams();
        const team = summary.find((t) => t.teamName === teamName);
        if (team?.displayName) teamDisplayName = team.displayName;
      }
    } catch {
      // use teamName as fallback
    }

    for (const msg of newMessages) {
      // Skip messages sent from our own UI
      if (msg.source && suppressedSources.has(msg.source)) continue;

      const fromLabel = msg.from || 'Unknown';
      const toLabel = msg.to || memberName;
      const summary = msg.summary || msg.text.slice(0, 60);

      showTeamNativeNotification({
        title: `${teamDisplayName}`,
        subtitle: `${fromLabel} → ${toLabel}: ${summary}`,
        body: msg.text,
      });
    }
  } catch (error) {
    logger.warn(`Failed to check inbox messages for ${key}:`, error);
  }
}

// Window icon path for non-mac platforms.
const getWindowIconPath = (): string | undefined => {
  const isDev = process.env.NODE_ENV === 'development';
  const candidates = isDev
    ? [join(process.cwd(), 'resources/icon.png')]
    : [
        join(process.resourcesPath, 'resources/icon.png'),
        join(__dirname, '../../resources/icon.png'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection in main process:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in main process:', error);
});

// =============================================================================
// Application State
// =============================================================================

let mainWindow: BrowserWindow | null = null;

// Service registry and global services
let contextRegistry: ServiceContextRegistry;
let notificationManager: NotificationManager;
let updaterService: UpdaterService;
let sshConnectionManager: SshConnectionManager;
let teamDataService: TeamDataService;
let teamProvisioningService: TeamProvisioningService;
let cliInstallerService: CliInstallerService;
let httpServer: HttpServer;

// File watcher event cleanup functions
let fileChangeCleanup: (() => void) | null = null;
let todoChangeCleanup: (() => void) | null = null;
let teamChangeCleanup: (() => void) | null = null;

/**
 * Resolve production renderer index path.
 * Main bundle lives in dist-electron/main, while renderer lives in out/renderer.
 */
function getRendererIndexPath(): string {
  const candidates = [
    join(__dirname, '../../out/renderer/index.html'),
    join(__dirname, '../renderer/index.html'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Wires file watcher events from a ServiceContext to the renderer and HTTP SSE clients.
 * Cleans up previous listeners before adding new ones.
 */
function wireFileWatcherEvents(context: ServiceContext): void {
  logger.info(`Wiring FileWatcher events for context: ${context.id}`);

  // Clean up previous listeners
  if (fileChangeCleanup) {
    fileChangeCleanup();
    fileChangeCleanup = null;
  }
  if (todoChangeCleanup) {
    todoChangeCleanup();
    todoChangeCleanup = null;
  }
  if (teamChangeCleanup) {
    teamChangeCleanup();
    teamChangeCleanup = null;
  }

  // Wire file-change events to renderer and HTTP SSE
  const fileChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-change', event);
    }
    httpServer?.broadcast('file-change', event);
  };
  context.fileWatcher.on('file-change', fileChangeHandler);
  fileChangeCleanup = () => context.fileWatcher.off('file-change', fileChangeHandler);

  // Forward checklist-change events to renderer and HTTP SSE (mirrors file-change pattern above)
  const todoChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-change', event);
    }
    httpServer?.broadcast('todo-change', event);
  };
  context.fileWatcher.on('todo-change', todoChangeHandler);
  todoChangeCleanup = () => context.fileWatcher.off('todo-change', todoChangeHandler);

  // Forward team-change events to renderer and HTTP SSE
  const teamChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TEAM_CHANGE, event);
    }
    httpServer?.broadcast('team-change', event);

    // Process inbox change events — relay to lead + native OS notifications.
    try {
      if (!event || typeof event !== 'object') return;
      const row = event as { type?: unknown; teamName?: unknown; detail?: unknown };
      if (row.type !== 'inbox') return;
      if (typeof row.teamName !== 'string' || row.teamName.trim().length === 0) return;
      const teamName = row.teamName.trim();
      const detail = typeof row.detail === 'string' ? row.detail : '';

      // Auto-relay direct messages to live team lead process (no UI dependency).
      if (teamProvisioningService.isTeamAlive(teamName)) {
        void teamProvisioningService.relayLeadInboxMessages(teamName).catch(() => undefined);
      }

      // Show native OS notification for new inbox messages (debounced per inbox).
      if (detail.startsWith('inboxes/')) {
        const timerKey = `${teamName}:${detail}`;
        const existing = inboxNotifyTimers.get(timerKey);
        if (existing) clearTimeout(existing);
        inboxNotifyTimers.set(
          timerKey,
          setTimeout(() => {
            inboxNotifyTimers.delete(timerKey);
            void notifyNewInboxMessages(teamName, detail).catch(() => undefined);
          }, INBOX_NOTIFY_DEBOUNCE_MS)
        );
      }
    } catch {
      // ignore
    }
  };
  context.fileWatcher.on('team-change', teamChangeHandler);
  teamChangeCleanup = () => context.fileWatcher.off('team-change', teamChangeHandler);

  logger.info(`FileWatcher events wired for context: ${context.id}`);
}

/**
 * Handles mode switch requests from the HTTP server.
 * Switches the active context back to local when requested.
 */
async function handleModeSwitch(mode: 'local' | 'ssh'): Promise<void> {
  if (mode === 'local' && contextRegistry.getActiveContextId() !== 'local') {
    const { current } = contextRegistry.switch('local');
    onContextSwitched(current);
  }
}

/**
 * Re-wires file watcher events only. No renderer notification.
 * Used for renderer-initiated switches where the renderer already handles state.
 */
export function rewireContextEvents(context: ServiceContext): void {
  wireFileWatcherEvents(context);
}

/**
 * Full callback: re-wire + notify renderer.
 * Used for external/unexpected switches (e.g., HTTP server mode switch).
 */
function onContextSwitched(context: ServiceContext): void {
  rewireContextEvents(context);

  // Notify renderer of context change
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SSH_STATUS, sshConnectionManager.getStatus());
    mainWindow.webContents.send(CONTEXT_CHANGED, {
      id: context.id,
      type: context.type,
    });
  }
}

/**
 * Rebuilds the local ServiceContext using the current configured Claude root paths.
 * Called when general.claudeRootPath changes.
 */
function reconfigureLocalContextForClaudeRoot(): void {
  try {
    const currentLocal = contextRegistry.get('local');
    if (!currentLocal) {
      logger.error('Cannot reconfigure local context: local context not found');
      return;
    }

    const wasLocalActive = contextRegistry.getActiveContextId() === 'local';
    const projectsDir = getProjectsBasePath();
    const todosDir = getTodosBasePath();

    logger.info(`Reconfiguring local context: projectsDir=${projectsDir}, todosDir=${todosDir}`);

    if (wasLocalActive) {
      currentLocal.stopFileWatcher();
    }

    const replacementLocal = new ServiceContext({
      id: 'local',
      type: 'local',
      fsProvider: new LocalFileSystemProvider(),
      projectsDir,
      todosDir,
    });

    if (notificationManager) {
      replacementLocal.fileWatcher.setNotificationManager(notificationManager);
    }
    replacementLocal.start();

    if (!wasLocalActive) {
      replacementLocal.stopFileWatcher();
    }

    contextRegistry.replaceContext('local', replacementLocal);

    if (wasLocalActive) {
      wireFileWatcherEvents(replacementLocal);
    }
  } catch (error) {
    logger.error('Failed to reconfigure local context for Claude root change:', error);
  }
}

/**
 * Initializes all services.
 */
function initializeServices(): void {
  logger.info('Initializing services...');

  // Initialize SSH connection manager
  sshConnectionManager = new SshConnectionManager();

  // Create ServiceContextRegistry
  contextRegistry = new ServiceContextRegistry();

  const localProjectsDir = getProjectsBasePath();
  const localTodosDir = getTodosBasePath();

  // Create local context
  const localContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir: localProjectsDir,
    todosDir: localTodosDir,
  });

  // Register and start local context
  contextRegistry.registerContext(localContext);
  localContext.start();

  logger.info(`Projects directory: ${localContext.projectScanner.getProjectsDir()}`);

  // Initialize notification manager (singleton, not context-scoped)
  notificationManager = NotificationManager.getInstance();

  // Set notification manager on local context's file watcher
  localContext.fileWatcher.setNotificationManager(notificationManager);

  // Wire file watcher events for local context
  wireFileWatcherEvents(localContext);

  // Initialize updater and CLI installer services
  updaterService = new UpdaterService();
  cliInstallerService = new CliInstallerService();
  teamDataService = new TeamDataService();
  teamProvisioningService = new TeamProvisioningService();
  const teamMemberLogsFinder = new TeamMemberLogsFinder();
  const memberStatsComputer = new MemberStatsComputer(teamMemberLogsFinder);
  const taskBoundaryParser = new TaskBoundaryParser();
  const changeExtractor = new ChangeExtractorService(teamMemberLogsFinder, taskBoundaryParser);
  const gitDiffFallback = new GitDiffFallback();
  const fileContentResolver = new FileContentResolver(teamMemberLogsFinder, gitDiffFallback);
  const reviewApplier = new ReviewApplierService();

  // Fire-and-forget: warm up CLI and install teamctl.js at startup
  void teamProvisioningService.warmup();
  void new TeamAgentToolsInstaller().ensureInstalled();
  httpServer = new HttpServer();

  // Allow TeamProvisioningService to trigger team refresh events (e.g. live lead replies).
  const teamChangeEmitter = (event: TeamChangeEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TEAM_CHANGE, event);
    }
    httpServer?.broadcast('team-change', event);
  };
  teamProvisioningService.setTeamChangeEmitter(teamChangeEmitter);

  // Start periodic health checks for registered CLI processes (every 2s).
  // Dead processes get stoppedAt written to processes.json → FileWatcher picks it up.
  teamDataService.startProcessHealthPolling();

  // Initialize IPC handlers with registry
  initializeIpcHandlers(
    contextRegistry,
    updaterService,
    sshConnectionManager,
    teamDataService,
    teamProvisioningService,
    teamMemberLogsFinder,
    memberStatsComputer,
    {
      rewire: rewireContextEvents,
      full: onContextSwitched,
      onClaudeRootPathUpdated: (_claudeRootPath: string | null) => {
        reconfigureLocalContextForClaudeRoot();
      },
    },
    {
      httpServer,
      startHttpServer: () => startHttpServer(handleModeSwitch),
    },
    changeExtractor,
    fileContentResolver,
    reviewApplier,
    gitDiffFallback,
    cliInstallerService
  );

  // Forward SSH state changes to renderer and HTTP SSE clients
  sshConnectionManager.on('state-change', (status: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SSH_STATUS, status);
    }
    httpServer.broadcast('ssh:status', status);
  });

  // Forward notification events to HTTP SSE clients
  notificationManager.on('notification-new', (notification: unknown) => {
    httpServer.broadcast('notification:new', notification);
  });
  notificationManager.on('notification-updated', (data: unknown) => {
    httpServer.broadcast('notification:updated', data);
  });
  notificationManager.on('notification-clicked', (data: unknown) => {
    httpServer.broadcast('notification:clicked', data);
  });

  // Start HTTP server if enabled in config
  const appConfig = configManager.getConfig();
  if (appConfig.httpServer?.enabled) {
    void startHttpServer(handleModeSwitch);
  }

  logger.info('Services initialized successfully');
}

/**
 * Starts the HTTP sidecar server with services from the active context.
 */
async function startHttpServer(
  modeSwitchHandler: (mode: 'local' | 'ssh') => Promise<void>
): Promise<void> {
  try {
    const config = configManager.getConfig();
    const activeContext = contextRegistry.getActive();
    const port = await httpServer.start(
      {
        projectScanner: activeContext.projectScanner,
        sessionParser: activeContext.sessionParser,
        subagentResolver: activeContext.subagentResolver,
        chunkBuilder: activeContext.chunkBuilder,
        dataCache: activeContext.dataCache,
        updaterService,
        sshConnectionManager,
      },
      modeSwitchHandler,
      config.httpServer?.port ?? 3456
    );
    logger.info(`HTTP sidecar server running on port ${port}`);
  } catch (error) {
    logger.error('Failed to start HTTP server:', error);
  }
}

/**
 * Shuts down all services.
 */
function shutdownServices(): void {
  logger.info('Shutting down services...');

  // Stop HTTP server
  if (httpServer?.isRunning()) {
    void httpServer.stop();
  }

  // Clean up file watcher event listeners
  if (fileChangeCleanup) {
    fileChangeCleanup();
    fileChangeCleanup = null;
  }
  if (todoChangeCleanup) {
    todoChangeCleanup();
    todoChangeCleanup = null;
  }
  if (teamChangeCleanup) {
    teamChangeCleanup();
    teamChangeCleanup = null;
  }

  // Dispose all contexts (including local)
  if (contextRegistry) {
    contextRegistry.dispose();
  }

  // Dispose SSH connection manager
  if (sshConnectionManager) {
    sshConnectionManager.dispose();
  }

  // Remove IPC handlers
  removeIpcHandlers();

  logger.info('Services shut down successfully');
}

/**
 * Update native traffic-light position and notify renderer of the current zoom factor.
 */
function syncTrafficLightPosition(win: BrowserWindow): void {
  const zoomFactor = win.webContents.getZoomFactor();
  const position = getTrafficLightPositionForZoom(zoomFactor);
  // setWindowButtonPosition is macOS-only (traffic light buttons)
  if (process.platform === 'darwin') {
    win.setWindowButtonPosition(position);
  }
  win.webContents.send(WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, zoomFactor);
}

/**
 * Creates the main application window.
 */
function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const iconPath = isMac ? undefined : getWindowIconPath();
  const useNativeTitleBar = !isMac && configManager.getConfig().general.useNativeTitleBar;
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#1a1a1a',
    ...(useNativeTitleBar ? {} : { titleBarStyle: 'hidden' as const }),
    ...(isMac && { trafficLightPosition: getTrafficLightPositionForZoom(1) }),
    title: 'Claude Agent Teams UI',
  });

  // Load the renderer
  if (process.env.NODE_ENV === 'development') {
    void mainWindow.loadURL(`http://localhost:${DEV_SERVER_PORT}`);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(getRendererIndexPath()).catch((error: unknown) => {
      logger.error('Failed to load renderer entry HTML:', error);
    });
  }

  // Notify renderer when entering/leaving fullscreen (so traffic light padding can be removed)
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(WINDOW_FULLSCREEN_CHANGED, true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(WINDOW_FULLSCREEN_CHANGED, false);
    }
  });

  // Set traffic light position + notify renderer on first load, and auto-check for updates
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      syncTrafficLightPosition(mainWindow);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(WINDOW_FULLSCREEN_CHANGED, mainWindow.isFullScreen());
        }
      }, 0);
      setTimeout(() => updaterService.checkForUpdates(), 3000);
    }
  });

  // Log top-level renderer load failures (helps diagnose blank/black window issues in packaged apps)
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        logger.error(
          `Failed to load renderer (code=${errorCode}): ${errorDescription} - ${validatedURL}`
        );
      }
    }
  );

  // Sync traffic light position when zoom changes (Cmd+/-, Cmd+0)
  // zoom-changed event doesn't fire in Electron 40, so we detect zoom keys directly.
  // Also keeps zoom bounds within a practical readability range.
  const MIN_ZOOM_LEVEL = -3; // ~70%
  const MAX_ZOOM_LEVEL = 5;
  const ZOOM_IN_KEYS = new Set(['+', '=']);
  const ZOOM_OUT_KEYS = new Set(['-', '_']);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (input.type !== 'keyDown') return;

    // Prevent Electron's default Ctrl+R / Cmd+R page reload so the renderer
    // keyboard handler can use it as "Refresh Session" (fixes #58).
    // Also prevent Ctrl+Shift+R / Cmd+Shift+R (hard reload).
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      return;
    }

    // Prevent Cmd+N from opening new window; forward to renderer for review shortcuts
    if (input.meta && input.key.toLowerCase() === 'n') {
      event.preventDefault();
      mainWindow.webContents.send('review:cmdN');
      return;
    }

    if (!input.meta) return;

    const currentLevel = mainWindow.webContents.getZoomLevel();

    // Block zoom-out beyond minimum
    if (ZOOM_OUT_KEYS.has(input.key) && currentLevel <= MIN_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }
    // Block zoom-in beyond maximum
    if (ZOOM_IN_KEYS.has(input.key) && currentLevel >= MAX_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }

    // For zoom keys (including Cmd+0 reset), defer sync until zoom is applied
    if (ZOOM_IN_KEYS.has(input.key) || ZOOM_OUT_KEYS.has(input.key) || input.key === '0') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          syncTrafficLightPosition(mainWindow);
        }
      }, 100);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Clear main window references
    if (notificationManager) {
      notificationManager.setMainWindow(null);
    }
    if (updaterService) {
      updaterService.setMainWindow(null);
    }
    if (cliInstallerService) {
      cliInstallerService.setMainWindow(null);
    }
  });

  // Handle renderer process crashes (render-process-gone replaces deprecated 'crashed' event)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone:', details.reason, details.exitCode);
    // Could show an error dialog or attempt to reload the window
  });

  // Set main window reference for notification manager and updater
  if (notificationManager) {
    notificationManager.setMainWindow(mainWindow);
  }
  if (updaterService) {
    updaterService.setMainWindow(mainWindow);
  }
  if (cliInstallerService) {
    cliInstallerService.setMainWindow(mainWindow);
  }

  logger.info('Main window created');
}

/**
 * Application ready handler.
 */
void app.whenReady().then(() => {
  logger.info('App ready, initializing...');
  try {
    // Initialize services first
    initializeServices();

    // Apply configuration settings
    const config = configManager.getConfig();

    // Apply launch at login setting
    app.setLoginItemSettings({
      openAtLogin: config.general.launchAtLogin,
    });

    // Apply dock visibility and icon (macOS)
    if (process.platform === 'darwin') {
      if (!config.general.showDockIcon) {
        app.dock?.hide();
      }
      // macOS app icon is already provided by the signed bundle (.icns)
      // so we avoid runtime setIcon calls that can fail and block startup.
    }

    // Then create window
    createWindow();

    // Listen for notification click events
    notificationManager.on('notification-clicked', (_error) => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (error) {
    logger.error('Startup initialization failed:', error);
    if (!mainWindow) {
      createWindow();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * All windows closed handler.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Before quit handler - cleanup.
 */
app.on('before-quit', () => {
  shutdownServices();
});
