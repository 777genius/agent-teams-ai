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

// Increase UV thread pool size BEFORE any async I/O.
// Default is 4 threads which is far too few for startup:
// binary resolution stat() calls, CLI subprocess spawning, fs.watch(),
// and readFile/readdir from IPC handlers all compete for the pool.
// On Windows this saturates all threads, blocking the event loop.
process.env.UV_THREADPOOL_SIZE ??= '16';

import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { ScheduledTaskExecutor } from '@main/services/schedule/ScheduledTaskExecutor';
import { SchedulerService } from '@main/services/schedule/SchedulerService';
import { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import { CrossTeamService } from '@main/services/team/CrossTeamService';
import { FileContentResolver } from '@main/services/team/FileContentResolver';
import { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import {
  CONTEXT_CHANGED,
  SCHEDULE_CHANGE,
  SKILLS_CHANGED,
  SSH_STATUS,
  TEAM_CHANGE,
  TEAM_TOOL_APPROVAL_EVENT,
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
import { isInboxNoiseMessage, parseInboxJson } from '@shared/utils/inboxNoise';
import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

import { cleanupEditorState, setEditorMainWindow } from './ipc/editor';
import { initializeIpcHandlers, removeIpcHandlers } from './ipc/handlers';
import { setReviewMainWindow } from './ipc/review';
import {
  ApiKeyService,
  ExtensionFacadeService,
  GlamaMcpEnrichmentService,
  McpCatalogAggregator,
  McpHealthDiagnosticsService,
  McpInstallationStateService,
  McpInstallService,
  OfficialMcpRegistryService,
  PluginCatalogService,
  PluginInstallationStateService,
  PluginInstallService,
  SkillsCatalogService,
  SkillsMutationService,
  SkillsWatcherService,
} from './services/extensions';
import { startEventLoopLagMonitor } from './services/infrastructure/EventLoopLagMonitor';
import { HttpServer } from './services/infrastructure/HttpServer';
import {
  buildTeamControlApiBaseUrl,
  clearTeamControlApiState,
  writeTeamControlApiState,
} from './services/team/TeamControlApiState';
import { TeamInboxReader } from './services/team/TeamInboxReader';
import { TeamSentMessagesStore } from './services/team/TeamSentMessagesStore';
import { getAppIconPath } from './utils/appIcon';
import { getProjectsBasePath, getTeamsBasePath, getTodosBasePath } from './utils/pathDecoder';
import {
  CliInstallerService,
  configManager,
  LocalFileSystemProvider,
  MemberStatsComputer,
  NotificationManager,
  PtyTerminalService,
  ServiceContext,
  ServiceContextRegistry,
  SshConnectionManager,
  TaskBoundaryParser,
  TeamDataService,
  TeamMemberLogsFinder,
  TeamProvisioningService,
  UpdaterService,
} from './services';

import type { FileChangeEvent } from '@main/types';
import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('App');
startEventLoopLagMonitor();

// --- Team message notification tracking ---
const teamInboxReader = new TeamInboxReader();
const sentMessagesStore = new TeamSentMessagesStore();
/** Track last-seen message count per inbox file to detect new messages. */
const inboxMessageCounts = new Map<string, number>();
/** Track last-seen message count per team sentMessages.json to detect new user-directed messages. */
const sentMessageCounts = new Map<string, number>();
/** Debounce per-inbox to avoid flooding during batch writes. */
const inboxNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const INBOX_NOTIFY_DEBOUNCE_MS = 500;
/** Messages sent from our UI (user_sent) — suppress notifications for these. */
const suppressedSources = new Set(['user_sent']);

// --- Team display name cache (avoid listTeams() on every notification) ---
const TEAM_DISPLAY_NAME_TTL_MS = 30_000;
const teamDisplayNameCache = new Map<string, { value: string; expiresAt: number }>();
let teamListInFlight: Promise<Map<string, string>> | null = null;

async function refreshTeamDisplayNameCache(): Promise<Map<string, string>> {
  if (teamListInFlight) {
    return teamListInFlight;
  }

  teamListInFlight = (async () => {
    const out = new Map<string, string>();
    try {
      if (!teamDataService) return out;
      const summary = await teamDataService.listTeams();
      for (const team of summary) {
        if (team?.teamName) {
          out.set(team.teamName, team.displayName || team.teamName);
        }
      }
    } catch {
      // ignore
    } finally {
      teamListInFlight = null;
    }
    return out;
  })();

  return teamListInFlight;
}

/** Resolve human-friendly team display name, falling back to raw teamName. */
async function resolveTeamDisplayName(teamName: string): Promise<string> {
  const cached = teamDisplayNameCache.get(teamName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const map = await refreshTeamDisplayNameCache();
  const resolved = map.get(teamName) ?? teamName;
  teamDisplayNameCache.set(teamName, {
    value: resolved,
    expiresAt: Date.now() + TEAM_DISPLAY_NAME_TTL_MS,
  });
  return resolved;
}

/**
 * Extracts human-readable summary and body from an inbox message.
 * Handles both plain text and serialized JSON ({"type":"message","content":"...","summary":"..."}).
 */
function extractNotificationContent(text: string): { summary: string; body: string } {
  const parsed = parseInboxJson(text);
  if (!parsed) return { summary: text.slice(0, 80), body: text };

  const content = typeof parsed.content === 'string' ? parsed.content : null;
  const summary = typeof parsed.summary === 'string' ? parsed.summary : null;
  const message = typeof parsed.message === 'string' ? parsed.message : null;

  const bestBody = content || message || summary || text;
  const bestSummary =
    summary || (content ? content.slice(0, 80) : null) || message || text.slice(0, 80);

  return { summary: bestSummary, body: bestBody };
}

async function notifyNewInboxMessages(teamName: string, detail: string): Promise<void> {
  logger.debug(`[inbox-notify] called: team=${teamName} detail=${detail}`);
  const config = configManager.getConfig();

  // Skip orphaned team directories without config.json (e.g., "default").
  // Claude Code may write to these when its internal teamContext is lost after session resume.
  // Our stdout capture in TeamProvisioningService already persists these messages under the
  // correct team name via sentMessages.json, so inbox notifications from orphaned dirs
  // would be duplicates with a wrong team name.
  if (!existsSync(join(getTeamsBasePath(), teamName, 'config.json'))) {
    logger.debug(`[inbox-notify] skipped: no config.json for team=${teamName}`);
    return; // No config.json → orphaned team dir, skip notification
  }

  // detail is like "inboxes/carol.json" — extract member name
  const match = /^inboxes\/(.+)\.json$/.exec(detail);
  if (!match) return;
  const memberName = match[1];

  // Determine inbox type and per-type toggle state.
  // Storage is always unconditional; toggles only suppress the OS toast.
  const leadName = teamDataService ? await teamDataService.getLeadMemberName(teamName) : null;
  const isLeadInbox = leadName !== null && memberName === leadName;
  const isUserInbox = memberName === 'user';

  if (!isLeadInbox && !isUserInbox) return;

  const suppressToast =
    !config.notifications.enabled ||
    (isLeadInbox && !config.notifications.notifyOnLeadInbox) ||
    (isUserInbox && !config.notifications.notifyOnUserInbox);

  const key = `${teamName}:${memberName}`;

  try {
    const messages = await teamInboxReader.getMessagesFor(teamName, memberName);
    const isFirstLoad = !inboxMessageCounts.has(key);
    const prevCount = inboxMessageCounts.get(key) ?? 0;

    if (isFirstLoad) {
      // First load — seed count, don't notify for pre-existing messages
      logger.debug(`[inbox-notify] first load for ${key}: seeding count=${messages.length}`);
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

    logger.debug(
      `[inbox-notify] ${key}: prevCount=${prevCount} newCount=${messages.length} newMessages=${newMessages.length} suppressToast=${String(suppressToast)}`
    );

    const teamDisplayName = await resolveTeamDisplayName(teamName);

    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      // Skip messages sent from our own UI
      if (msg.source && suppressedSources.has(msg.source)) continue;
      // Skip internal coordination noise (idle_notification, shutdown_*, etc.)
      if (isInboxNoiseMessage(msg.text)) continue;

      const fromLabel = msg.from || 'Unknown';
      const extracted = extractNotificationContent(msg.text);
      const summary = msg.summary || extracted.summary;
      const msgId = msg.timestamp ?? String(prevCount + i);

      // Cross-team messages get their own event type and per-type toggle
      const isCrossTeam = msg.source === 'cross_team';
      const eventType: 'lead_inbox' | 'user_inbox' | 'cross_team_message' = isCrossTeam
        ? 'cross_team_message'
        : isLeadInbox
          ? 'lead_inbox'
          : 'user_inbox';
      const effectiveSuppressToast = isCrossTeam
        ? !config.notifications.enabled || !config.notifications.notifyOnCrossTeamMessage
        : suppressToast;

      void notificationManager
        .addTeamNotification({
          teamEventType: eventType,
          teamName,
          teamDisplayName,
          from: fromLabel,
          summary,
          body: extracted.body,
          dedupeKey: `inbox:${teamName}:${memberName}:${msgId}`,
          suppressToast: effectiveSuppressToast,
        })
        .catch(() => undefined);
    }
  } catch (error) {
    logger.warn(`Failed to check inbox messages for ${key}:`, error);
  }
}

/**
 * Notify for new messages in sentMessages.json (lead → user messages).
 * Mirrors notifyNewInboxMessages() but reads from TeamSentMessagesStore.
 */
async function notifyNewSentMessages(teamName: string): Promise<void> {
  const config = configManager.getConfig();
  const suppressToast = !config.notifications.enabled || !config.notifications.notifyOnUserInbox;

  try {
    const messages = await sentMessagesStore.readMessages(teamName);
    const isFirstLoad = !sentMessageCounts.has(teamName);
    const prevCount = sentMessageCounts.get(teamName) ?? 0;

    if (isFirstLoad) {
      sentMessageCounts.set(teamName, messages.length);
      return;
    }

    if (messages.length <= prevCount) {
      sentMessageCounts.set(teamName, messages.length);
      return;
    }

    // Messages are appended at the end, new ones are at the tail
    const newMessages = messages.slice(prevCount);
    sentMessageCounts.set(teamName, messages.length);

    const teamDisplayName = await resolveTeamDisplayName(teamName);

    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      if ((msg.to ?? '').trim() !== 'user') continue;
      // Skip messages sent from our own UI
      if (msg.source && suppressedSources.has(msg.source)) continue;
      // Skip internal coordination noise
      if (isInboxNoiseMessage(msg.text)) continue;

      const fromLabel = msg.from || 'team-lead';
      const extracted = extractNotificationContent(msg.text);
      const summary = msg.summary || extracted.summary;

      void notificationManager
        .addTeamNotification({
          teamEventType: 'user_inbox',
          teamName,
          teamDisplayName,
          from: fromLabel,
          summary,
          body: extracted.body,
          dedupeKey: `sent:${teamName}:${msg.timestamp ?? String(prevCount + i)}`,
          suppressToast,
        })
        .catch(() => undefined);
    }
  } catch (error) {
    logger.warn(`Failed to check sent messages for ${teamName}:`, error);
  }
}

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
let ptyTerminalService: PtyTerminalService;
let httpServer: HttpServer;
let schedulerService: SchedulerService;
let skillsWatcherService: SkillsWatcherService | null = null;
let teamBackupService: TeamBackupService | null = null;

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

function getTeamControlApiBaseUrl(): string | null {
  if (!httpServer?.isRunning()) {
    return null;
  }

  return buildTeamControlApiBaseUrl(httpServer.getPort());
}

async function syncTeamControlApiState(): Promise<void> {
  const baseUrl = getTeamControlApiBaseUrl();
  if (!baseUrl) {
    await clearTeamControlApiState();
    return;
  }

  await writeTeamControlApiState(baseUrl);
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
  const SCAN_CACHE_INVALIDATE_DEBOUNCE_MS = 250;
  let scanCacheInvalidateTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleScanCacheInvalidation = (): void => {
    if (scanCacheInvalidateTimer) {
      clearTimeout(scanCacheInvalidateTimer);
    }
    scanCacheInvalidateTimer = setTimeout(() => {
      scanCacheInvalidateTimer = null;
      context.projectScanner.clearScanCache();
    }, SCAN_CACHE_INVALIDATE_DEBOUNCE_MS);
  };

  const fileChangeHandler = (event: unknown): void => {
    // Avoid triggering a full project rescan on every session append.
    // The ProjectScanner already has a short TTL cache; we only invalidate for
    // structural changes (add/unlink), and we debounce bursts of events.
    try {
      if (event && typeof event === 'object') {
        const row = event as Partial<FileChangeEvent>;
        const isSubagent = row.isSubagent === true;
        const changeType = row.type;
        if (!isSubagent && (changeType === 'add' || changeType === 'unlink')) {
          scheduleScanCacheInvalidation();
        }
      } else {
        // Fallback: if we can't classify the event, invalidate (debounced).
        scheduleScanCacheInvalidation();
      }
    } catch {
      // ignore
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-change', event);
    }
    httpServer?.broadcast('file-change', event);
  };
  context.fileWatcher.on('file-change', fileChangeHandler);
  fileChangeCleanup = () => {
    context.fileWatcher.off('file-change', fileChangeHandler);
    if (scanCacheInvalidateTimer) {
      clearTimeout(scanCacheInvalidateTimer);
      scanCacheInvalidateTimer = null;
    }
  };

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

    // Process inbox and task change events.
    try {
      if (!event || typeof event !== 'object') return;
      const row = event as { type?: unknown; teamName?: unknown; detail?: unknown };
      if (typeof row.teamName !== 'string' || row.teamName.trim().length === 0) return;
      const teamName = row.teamName.trim();
      const detail = typeof row.detail === 'string' ? row.detail : '';

      // --- Inbox change events: relay to lead + native OS notifications ---
      if (row.type === 'inbox') {
        if (teamDataService) {
          void teamDataService
            .reconcileTeamArtifacts(teamName)
            .catch((e: unknown) =>
              logger.warn(`[FileWatcher] reconcile failed for ${teamName}: ${String(e)}`)
            );
        }

        // Relay inbox changes into active runtime recipients.
        if (teamProvisioningService.isTeamAlive(teamName) && detail.startsWith('inboxes/')) {
          const match = /^inboxes\/(.+)\.json$/.exec(detail);
          if (match && teamDataService) {
            const inboxName = match[1];

            // Mark member as online when their first inbox message arrives (spawn tracking).
            teamProvisioningService.markMemberOnlineFromInbox(teamName, inboxName);

            void teamDataService
              .getLeadMemberName(teamName)
              .then((leadName) => {
                if (!leadName) return;
                if (inboxName === leadName) {
                  return teamProvisioningService.relayLeadInboxMessages(teamName);
                }
                return teamProvisioningService.relayMemberInboxMessages(teamName, inboxName);
              })
              .catch((e: unknown) =>
                logger.warn(`[FileWatcher] relay failed for ${teamName}: ${String(e)}`)
              );
          }
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

        // Show native OS notification for new lead → user messages (sentMessages.json).
        if (detail === 'sentMessages.json') {
          const timerKey = `${teamName}:sentMessages`;
          const existing = inboxNotifyTimers.get(timerKey);
          if (existing) clearTimeout(existing);
          inboxNotifyTimers.set(
            timerKey,
            setTimeout(() => {
              inboxNotifyTimers.delete(timerKey);
              void notifyNewSentMessages(teamName).catch(() => undefined);
            }, INBOX_NOTIFY_DEBOUNCE_MS)
          );
        }
      }

      // --- Task change events: notify lead when teammate starts a task via CLI ---
      if (row.type === 'task' && detail.endsWith('.json') && teamDataService) {
        void teamDataService
          .reconcileTeamArtifacts(teamName)
          .catch((e: unknown) =>
            logger.warn(`[FileWatcher] task reconcile failed for ${teamName}: ${String(e)}`)
          );

        const taskId = detail.replace('.json', '');
        void teamDataService
          .notifyLeadOnTeammateTaskStart(teamName, taskId)
          .catch((e: unknown) =>
            logger.warn(
              `[FileWatcher] task start notify failed for ${teamName}#${taskId}: ${String(e)}`
            )
          );
        void teamDataService
          .notifyLeadOnTeammateTaskComment(teamName, taskId)
          .catch((e: unknown) =>
            logger.warn(
              `[FileWatcher] task comment notify failed for ${teamName}#${taskId}: ${String(e)}`
            )
          );

        // Schedule debounced backup for changed task file
        if (teamBackupService) {
          teamBackupService.scheduleTaskBackup(teamName, detail);
        }
      }

      // Backup on config changes (covers team ready, config updates)
      if (row.type === 'config' && detail === 'config.json' && teamBackupService) {
        void teamBackupService.backupTeam(teamName).catch(() => undefined);
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

  // Register context and start cache cleanup only.
  // FileWatcher is deferred to did-finish-load to avoid blocking window creation
  // with fs.watch() setup (especially slow on Windows NTFS with recursive watchers).
  contextRegistry.registerContext(localContext);
  localContext.startCacheOnly();

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
  ptyTerminalService = new PtyTerminalService();
  teamDataService = new TeamDataService();
  teamProvisioningService = new TeamProvisioningService();
  void teamDataService
    .initializeTaskCommentNotificationState()
    .catch((error: unknown) =>
      logger.warn(`[Init] task comment notification init failed: ${String(error)}`)
    );
  teamBackupService = new TeamBackupService();
  // Fire-and-forget: initializeServices() is sync, cannot await.
  // Safe because TeamBackupService.initialized flag blocks all backup/restore
  // operations until initialize() completes internally (restore → prune → set flag).
  void teamBackupService
    .initialize()
    .catch((error: unknown) =>
      logger.warn(`[Init] TeamBackupService init failed: ${String(error)}`)
    );

  // Cross-team communication service
  const crossTeamConfigReader = new TeamConfigReader();
  const crossTeamInboxWriter = new TeamInboxWriter();
  const crossTeamService = new CrossTeamService(
    crossTeamConfigReader,
    teamDataService,
    crossTeamInboxWriter,
    teamProvisioningService
  );
  teamProvisioningService.setCrossTeamSender((request) => crossTeamService.send(request));

  const teamMemberLogsFinder = new TeamMemberLogsFinder();
  const memberStatsComputer = new MemberStatsComputer(teamMemberLogsFinder);
  const taskBoundaryParser = new TaskBoundaryParser();
  const changeExtractor = new ChangeExtractorService(teamMemberLogsFinder, taskBoundaryParser);
  const gitDiffFallback = new GitDiffFallback();
  const fileContentResolver = new FileContentResolver(teamMemberLogsFinder, gitDiffFallback);
  const reviewApplier = new ReviewApplierService();

  // Create SchedulerService for cron-based task execution
  const scheduleRepository = new JsonScheduleRepository();
  const scheduledTaskExecutor = new ScheduledTaskExecutor();
  schedulerService = new SchedulerService(
    scheduleRepository,
    scheduledTaskExecutor,
    async (cwd: string) => {
      const result = await teamProvisioningService.prepareForProvisioning(cwd, {
        forceFresh: true,
      });
      return { ready: result.ready, message: result.message };
    }
  );
  // Extension Store services
  const pluginCatalogService = new PluginCatalogService();
  const pluginStateService = new PluginInstallationStateService();
  const officialMcpRegistry = new OfficialMcpRegistryService();
  const glamaMcpService = new GlamaMcpEnrichmentService();
  const mcpAggregator = new McpCatalogAggregator(officialMcpRegistry, glamaMcpService);
  const mcpStateService = new McpInstallationStateService();
  const mcpHealthDiagnosticsService = new McpHealthDiagnosticsService();
  const skillsCatalogService = new SkillsCatalogService();
  const skillsMutationService = new SkillsMutationService();
  skillsWatcherService = new SkillsWatcherService();
  const extensionFacadeService = new ExtensionFacadeService(
    pluginCatalogService,
    pluginStateService,
    mcpAggregator,
    mcpStateService
  );

  // Install services — resolve binary dynamically via ClaudeBinaryResolver
  const pluginInstallService = new PluginInstallService(pluginCatalogService);
  const mcpInstallService = new McpInstallService(mcpAggregator);
  const apiKeyService = new ApiKeyService();
  // warmup() and ensureInstalled() are deferred to after window creation
  // (did-finish-load handler) to avoid thread pool contention at startup.
  httpServer = new HttpServer();
  teamProvisioningService.setControlApiBaseUrlResolver(async () => {
    if (!httpServer.isRunning()) {
      await startHttpServer(handleModeSwitch);
    }

    return getTeamControlApiBaseUrl();
  });

  // Allow TeamProvisioningService to trigger team refresh events (e.g. live lead replies).
  const teamChangeEmitter = (event: TeamChangeEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TEAM_CHANGE, event);
    }
    httpServer?.broadcast('team-change', event);
  };
  teamProvisioningService.setTeamChangeEmitter(teamChangeEmitter);

  // Allow SchedulerService to push schedule events to renderer
  schedulerService.setChangeEmitter((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SCHEDULE_CHANGE, event);
    }
  });

  skillsWatcherService.setEmitter((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SKILLS_CHANGED, event);
    }
  });

  teamProvisioningService.setToolApprovalEventEmitter((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TEAM_TOOL_APPROVAL_EVENT, event);
    }
  });

  teamProvisioningService.setMainWindow(mainWindow);

  // startProcessHealthPolling() is deferred to after window creation
  // (did-finish-load handler) to avoid thread pool contention at startup.

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
        void schedulerService?.reloadForClaudeRootChange();
        if (httpServer?.isRunning()) {
          void syncTeamControlApiState().catch(() => undefined);
        }
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
    cliInstallerService,
    ptyTerminalService,
    schedulerService,
    extensionFacadeService,
    pluginInstallService,
    mcpInstallService,
    apiKeyService,
    mcpHealthDiagnosticsService,
    skillsCatalogService,
    skillsMutationService,
    skillsWatcherService,
    crossTeamService,
    teamBackupService ?? undefined
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
    void startHttpServer(handleModeSwitch).catch(() => undefined);
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
    if (httpServer.isRunning()) {
      await syncTeamControlApiState();
      return;
    }

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
        teamProvisioningService,
      },
      modeSwitchHandler,
      config.httpServer?.port ?? 3456
    );
    await syncTeamControlApiState();
    logger.info(`HTTP sidecar server running on port ${port}`);
  } catch (error) {
    await clearTeamControlApiState().catch(() => undefined);
    logger.error('Failed to start HTTP server:', error);
    throw error;
  }
}

/**
 * Shuts down all services.
 */
function shutdownServices(): void {
  logger.info('Shutting down services...');

  // Kill all team CLI processes via SIGKILL BEFORE anything else.
  // This must happen before the OS closes stdin pipes (on app exit),
  // because stdin EOF triggers CLI's graceful shutdown which deletes team files.
  if (teamProvisioningService) {
    teamProvisioningService.stopAllTeams();
  }

  // Sync backup all team data (files are stable after SIGKILL).
  if (teamBackupService) {
    teamBackupService.runShutdownBackupSync();
  }

  // Stop HTTP server
  if (httpServer?.isRunning()) {
    void httpServer.stop();
  }
  void clearTeamControlApiState();

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

  // Clean up editor state (watcher, git service)
  cleanupEditorState();

  // Dispose all contexts (including local)
  if (contextRegistry) {
    contextRegistry.dispose();
  }

  // Dispose SSH connection manager
  if (sshConnectionManager) {
    sshConnectionManager.dispose();
  }

  // Stop background polling timers (prevents hanging shutdown).
  if (teamDataService) {
    teamDataService.stopProcessHealthPolling();
  }

  // Stop scheduled task execution and croner jobs
  if (schedulerService) {
    void schedulerService.stop();
  }

  void skillsWatcherService?.stopAll();

  // Kill all PTY processes
  if (ptyTerminalService) {
    ptyTerminalService.killAll();
  }

  // Remove IPC handlers
  removeIpcHandlers();

  // Dispose backup service timers
  teamBackupService?.dispose();

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
  const isDev = process.env.NODE_ENV === 'development';
  const iconPath = isMac ? undefined : getAppIconPath();
  const useNativeTitleBar = !isMac && configManager.getConfig().general.useNativeTitleBar;
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // In development, use a persistent partition so that renderer-side storage
      // (localStorage, IndexedDB — used by comment read state, etc.) survives
      // app restarts. A fixed name is used instead of per-PID to keep data stable.
      ...(isDev ? { partition: 'persist:dev' } : {}),
    },
    backgroundColor: '#1a1a1a',
    ...(useNativeTitleBar ? {} : { titleBarStyle: 'hidden' as const }),
    ...(isMac && { trafficLightPosition: getTrafficLightPositionForZoom(1) }),
    title: 'Claude Agent Teams UI',
  });

  // In dev, forward selected renderer console warnings/errors to the main terminal.
  // Use the new single-argument event payload to avoid Electron deprecation warnings.
  if (isDev) {
    mainWindow.webContents.on('console-message', (details: unknown) => {
      if (!details || typeof details !== 'object') return;
      const d = details as {
        level?: unknown;
        message?: unknown;
        lineNumber?: unknown;
        sourceId?: unknown;
      };
      const level = typeof d.level === 'string' ? d.level : 'info';
      if (level !== 'warning' && level !== 'error') return;
      const message = typeof d.message === 'string' ? d.message.trim() : '';
      if (!message) return;
      const isNamespaced =
        message.startsWith('[Store:') ||
        message.startsWith('[Component:') ||
        message.startsWith('[IPC:') ||
        message.startsWith('[Service:') ||
        message.startsWith('[Perf:') ||
        message.startsWith('[startup]');
      if (!isNamespaced) return;
      const sourceId = typeof d.sourceId === 'string' ? d.sourceId : 'unknown';
      const line = typeof d.lineNumber === 'number' ? d.lineNumber : -1;
      logger.warn(`RendererConsole: ${message} (${sourceId}:${line})`);
    });
  }

  // Load the renderer
  if (isDev) {
    // electron-vite may move the dev server off 5173 if it's already taken.
    // Always prefer the URL it provides via env; fallback to the default port.
    const envUrl =
      process.env.ELECTRON_RENDERER_URL ||
      process.env.VITE_DEV_SERVER_URL ||
      process.env.ELECTRON_VITE_DEV_SERVER_URL;
    const devUrl = envUrl?.trim() || `http://localhost:${DEV_SERVER_PORT}`;
    if (!envUrl) {
      logger.warn(
        `[dev] renderer dev server URL env not set; falling back to ${devUrl}. ` +
          `If you see "Port 5173 is in use" in the terminal, the UI may appear stuck until this is fixed.`
      );
    } else {
      logger.warn(`[dev] loading renderer from ${devUrl}`);
    }
    void mainWindow.loadURL(devUrl);
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
      logger.warn('[startup] renderer did-finish-load');
      syncTrafficLightPosition(mainWindow);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(WINDOW_FULLSCREEN_CHANGED, mainWindow.isFullScreen());
        }
      }, 0);
      // Start file watchers now that the window is visible and responsive.
      // Deferred from initializeServices() to avoid blocking window creation
      // with fs.watch() setup (especially slow on Windows with recursive watchers).
      const activeContext = contextRegistry.getActive();
      if (process.platform === 'win32') {
        // On Windows, delay FileWatcher startup to let the renderer complete
        // its initial IPC calls without UV thread pool contention. Recursive
        // fs.watch() on NTFS saturates all 4 default UV threads.
        setTimeout(() => activeContext.startFileWatcher(), 1500);
      } else {
        activeContext.startFileWatcher();
      }

      setTimeout(() => updaterService.checkForUpdates(), 3000);
      updaterService.startPeriodicCheck(60 * 60 * 1000);

      // Defer non-critical startup work to avoid thread pool contention.
      // The window is now visible and responsive; these run in the background.
      setTimeout(() => {
        void teamProvisioningService.warmup();
        teamDataService.startProcessHealthPolling();
        void schedulerService?.start();
      }, 5000);
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    logger.warn('[startup] renderer dom-ready');
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

    // Cmd on macOS, Ctrl on Windows/Linux — unified modifier for cross-platform shortcuts
    const isMod = input.meta || input.control;

    // Prevent Electron's default Ctrl+R / Cmd+R page reload so the renderer
    // keyboard handler can use it as "Refresh Session" (fixes #58).
    // Also prevent Ctrl+Shift+R / Cmd+Shift+R (hard reload).
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      return;
    }

    // Prevent Cmd+N / Ctrl+N from opening new window; forward to renderer for review shortcuts
    if (isMod && input.key.toLowerCase() === 'n') {
      event.preventDefault();
      mainWindow.webContents.send('review:cmdN');
      return;
    }

    if (!isMod) return;

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
      updaterService.stopPeriodicCheck();
      updaterService.setMainWindow(null);
    }
    if (cliInstallerService) {
      cliInstallerService.setMainWindow(null);
    }
    if (ptyTerminalService) {
      ptyTerminalService.setMainWindow(null);
    }
    if (teamProvisioningService) {
      teamProvisioningService.setMainWindow(null);
    }
    setEditorMainWindow(null);
    setReviewMainWindow(null);
    cleanupEditorState();
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
  if (ptyTerminalService) {
    ptyTerminalService.setMainWindow(mainWindow);
  }
  if (teamProvisioningService) {
    teamProvisioningService.setMainWindow(mainWindow);
  }
  setEditorMainWindow(mainWindow);
  setReviewMainWindow(mainWindow);

  logger.info('Main window created');
}

/**
 * Application ready handler.
 */
void app.whenReady().then(() => {
  logger.info('App ready, initializing...');

  // Pre-warm interactive shell env cache (non-blocking).
  // On macOS, Finder-launched apps get a minimal PATH. This resolves the user's
  // full shell PATH (nvm, homebrew, .local/bin, etc.) in the background so that
  // CliInstallerService.getStatus() and other services get cached results instantly.
  void resolveInteractiveShellEnv();

  try {
    // Initialize services first
    initializeServices();

    // Apply configuration settings
    const config = configManager.getConfig();

    // Apply launch-at-login setting only in packaged builds.
    // In dev, macOS may deny this (and Electron logs a noisy error to stderr).
    // Also guard by platform: Electron only supports this on macOS/Windows.
    if (app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')) {
      app.setLoginItemSettings({
        openAtLogin: config.general.launchAtLogin,
      });
    }

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
