/**
 * Main process entry point for Agent Teams AI.
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

// Keep userData stable before any integration can initialize Electron storage.
// Sentry must stay near the top to capture early errors after storage migration.
// eslint-disable-next-line simple-import-sort/imports -- userData migration must run before Sentry initializes Electron storage.
import { earlyElectronUserDataMigrationResult } from './bootstrapUserDataMigration';
import './sentry';

import {
  type CodexAccountFeatureFacade,
  createCodexAccountFeature,
  registerCodexAccountIpc,
  removeCodexAccountIpc,
} from '@features/codex-account/main';
import {
  type CodexModelCatalogFeatureFacade,
  createCodexModelCatalogFeature,
} from '@features/codex-model-catalog/main';
import {
  createMemberLogStreamFeature,
  registerMemberLogStreamIpc,
  removeMemberLogStreamIpc,
} from '@features/member-log-stream/main';
import {
  buildMemberWorkSyncRuntimeTurnSettledEnvironment,
  createMemberWorkSyncFeature,
  hasWorkSyncActiveRuntime,
  type MemberWorkSyncFeatureFacade,
  registerMemberWorkSyncIpc,
  removeMemberWorkSyncIpc,
} from '@features/member-work-sync/main';
import {
  createRecentProjectsFeature,
  type RecentProjectsFeatureFacade,
  registerRecentProjectsIpc,
  removeRecentProjectsIpc,
} from '@features/recent-projects/main';
import {
  createRuntimeProviderManagementFeature,
  registerRuntimeProviderManagementIpc,
  removeRuntimeProviderManagementIpc,
  type RuntimeProviderManagementFeatureFacade,
} from '@features/runtime-provider-management/main';
import { createWorkspaceTrustCoordinator } from '@features/workspace-trust/main';
import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '@main/services/runtime/openCodeBridgeRuntimeEnv';
import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import { applyOpenCodeAutoUpdatePolicy } from '@main/services/runtime/openCodeAutoUpdatePolicy';
import { providerConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { ScheduledTaskExecutor } from '@main/services/schedule/ScheduledTaskExecutor';
import { SchedulerService } from '@main/services/schedule/SchedulerService';
import { JsonTaskChangePresenceRepository } from '@main/services/team/cache/JsonTaskChangePresenceRepository';
import { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import { CrossTeamService } from '@main/services/team/CrossTeamService';
import { FileContentResolver } from '@main/services/team/FileContentResolver';
import { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import { isInformationalOpenCodeRuntimeDeliveryDiagnostic } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryDiagnostics';
import {
  copyOpenCodeLocalMcpLaunchEnv,
  hasOpenCodeLocalMcpLaunchEnv,
  isOpenCodeMcpHttpBridgeEnabled,
  shouldEnsureOpenCodeLocalMcpLaunchEnv,
  snapshotOpenCodeLocalMcpLaunchEnv,
} from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import {
  resolveAgentTeamsMcpLaunchSpec,
  TeamMcpConfigBuilder,
} from '@main/services/team/TeamMcpConfigBuilder';
import { TeamTranscriptProjectResolver } from '@main/services/team/TeamTranscriptProjectResolver';
import { killTrackedCliProcesses } from '@main/utils/childProcess';
import {
  APP_STARTUP_GET_STATUS,
  APP_STARTUP_PROGRESS,
  CONTEXT_CHANGED,
  SCHEDULE_CHANGE,
  SKILLS_CHANGED,
  SSH_STATUS,
  TEAM_CHANGE,
  TEAM_PROJECT_BRANCH_CHANGE,
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
import { shouldSuppressDesktopNotificationForInboxText } from '@shared/utils/idleNotificationSemantics';
import { parseInboxJson } from '@shared/utils/inboxNoise';
import { createLogger } from '@shared/utils/logger';
import { isReviewPickupEscalationMessage } from '@shared/utils/teamAutomationMessages';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';
import { createHash } from 'crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

import { cleanupEditorState, setEditorMainWindow } from './ipc/editor';
import { initializeIpcHandlers, removeIpcHandlers } from './ipc/handlers';
import { registerRendererLogHandlers } from './ipc/rendererLogs';
import { setReviewMainWindow } from './ipc/review';
import { setTmuxMainWindow } from './ipc/tmux';
import {
  ApiKeyService,
  createExtensionsRuntimeAdapter,
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
import { applyAgentTeamsIdentityEnv } from './services/identity/AgentTeamsIdentityStore';
import { startEventLoopLagMonitor } from './services/infrastructure/EventLoopLagMonitor';
import { HttpServer } from './services/infrastructure/HttpServer';
import { clearAutoResumeService } from './services/team/AutoResumeService';
import { agentTeamsMcpHttpServer } from './services/team/AgentTeamsMcpHttpServer';
import { LaunchIoGovernor } from './services/team/LaunchIoGovernor';
import { OpenCodeBridgeCommandClient } from './services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from './services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  createOpenCodeBridgeClientIdentity,
  OpenCodeBridgeCommandHandshakePort,
} from './services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { cleanupManagedOpenCodeServeProcesses } from './services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { OpenCodeStateChangingBridgeCommandService } from './services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { OpenCodeRuntimeManifestEvidenceReader } from './services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  buildTeamControlApiBaseUrl,
  clearTeamControlApiState,
  writeTeamControlApiState,
} from './services/team/TeamControlApiState';
import { getTeamDataWorkerClient } from './services/team/TeamDataWorkerClient';
import { getTeamFsWorkerClient } from './services/team/TeamFsWorkerClient';
import { TeamInboxReader } from './services/team/TeamInboxReader';
import { TeamMemberRuntimeAdvisoryService } from './services/team/TeamMemberRuntimeAdvisoryService';
import {
  createTeamReconcileDrainScheduler,
  type TeamReconcileTrigger,
} from './services/team/TeamReconcileDrainScheduler';
import { TeamSentMessagesStore } from './services/team/TeamSentMessagesStore';
import { getAppIconPath } from './utils/appIcon';
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getProjectsBasePath,
  getTeamsBasePath,
  getTodosBasePath,
} from './utils/pathDecoder';
import {
  clearRendererAvailability,
  markRendererReady,
  markRendererUnavailable,
  safeSendToRenderer,
} from './utils/safeWebContentsSend';
import { syncTelemetryFlag } from './sentry';
import { setCodexRuntimeMainWindow } from './ipc/codexRuntime';
import {
  ActiveTeamRegistry,
  BoardTaskActivityDetailService,
  BoardTaskActivityRecordSource,
  BoardTaskActivityService,
  BoardTaskExactLogDetailService,
  BoardTaskExactLogsService,
  BoardTaskLogStreamService,
  BranchStatusService,
  ClaudeBinaryResolver,
  CliInstallerService,
  configManager,
  LocalFileSystemProvider,
  MemberStatsComputer,
  NotificationManager,
  OpenCodeRuntimeInstallerService,
  OpenCodeReadinessBridge,
  OpenCodeTeamRuntimeAdapter,
  PtyTerminalService,
  ServiceContext,
  ServiceContextRegistry,
  SshConnectionManager,
  TaskBoundaryParser,
  TeamDataService,
  TeamKanbanManager,
  TeamLogSourceTracker,
  TeammateToolTracker,
  TeamMemberLogsFinder,
  TeamMembersMetaStore,
  TeamProvisioningService,
  TeamRuntimeAdapterRegistry,
  TeamTaskReader,
  TeamTaskStallJournal,
  TeamTaskStallMonitor,
  TeamTaskStallNotifier,
  TeamTaskStallPolicy,
  TeamTaskStallSnapshotSource,
  TeamTranscriptSourceLocator,
  UpdaterService,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from './services';

import type { FileChangeEvent } from '@main/types';
import type { AppStartupStatus, AppStartupStep, TeamChangeEvent } from '@shared/types';

const logger = createLogger('App');
const appStartedAtMs = Date.now();
const openCodeManagedHostInstanceId = `${process.pid}-${appStartedAtMs}`;
let openCodeLifecycleBridge: OpenCodeReadinessBridge | null = null;

function hasWarningRelayDiagnostics(diagnostics: readonly string[]): boolean {
  return diagnostics.some(
    (diagnostic) => !isInformationalOpenCodeRuntimeDeliveryDiagnostic(diagnostic)
  );
}

if (
  earlyElectronUserDataMigrationResult.migrated &&
  earlyElectronUserDataMigrationResult.legacyPath &&
  earlyElectronUserDataMigrationResult.currentPath
) {
  logger.info(
    `Migrated Electron userData from ${earlyElectronUserDataMigrationResult.legacyPath} to ${earlyElectronUserDataMigrationResult.currentPath}`
  );
} else if (
  earlyElectronUserDataMigrationResult.reason === 'legacy-reused' &&
  earlyElectronUserDataMigrationResult.legacyPath
) {
  logger.info(
    `Reusing legacy Electron userData at ${earlyElectronUserDataMigrationResult.legacyPath}`
  );
} else if (
  earlyElectronUserDataMigrationResult.fallbackToLegacy &&
  earlyElectronUserDataMigrationResult.legacyPath
) {
  logger.warn(`Electron userData migration failed, using legacy path for this run`);
}
startEventLoopLagMonitor();

// Windows: set AppUserModelId early so native notifications show the correct
// application title instead of the default "electron.app.{name}" identifier.
// Must match the appId in electron-builder config (package.json → build.appId).
if (process.platform === 'win32') {
  app.setAppUserModelId('com.agent-teams.app');
}

// --- Team message notification tracking ---
const teamInboxReader = new TeamInboxReader();
const teamInboxWriter = new TeamInboxWriter();
const sentMessagesStore = new TeamSentMessagesStore();
/** Track last-seen message count per inbox file to detect new messages. */
const inboxMessageCounts = new Map<string, number>();
/** Track last-seen message count per team sentMessages.json to detect new user-directed messages. */
const sentMessageCounts = new Map<string, number>();
/** Debounce per-inbox to avoid flooding during batch writes. */
const inboxNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const INBOX_NOTIFY_DEBOUNCE_MS = 500;
/** Messages sent from our UI (user_sent) - suppress notifications for these. */
const suppressedSources = new Set(['user_sent']);

function buildMemberWorkSyncReviewPickupEscalationMessageId(input: {
  teamName: string;
  memberName: string;
  reason: string;
  reviewRequestEventIds?: readonly string[];
  taskRefs: readonly { taskId: string; displayId?: string }[];
}): string {
  const stableKey = JSON.stringify({
    teamName: input.teamName,
    memberName: input.memberName.trim().toLowerCase(),
    reason: input.reason,
    reviewRequestEventIds: [...new Set(input.reviewRequestEventIds ?? [])].sort(),
    taskIds: [...new Set(input.taskRefs.map((taskRef) => taskRef.taskId).filter(Boolean))].sort(),
  });
  const digest = createHash('sha256').update(stableKey).digest('hex').slice(0, 20);
  return `member-work-sync-review-pickup-escalation:${digest}`;
}

function buildMemberWorkSyncReviewPickupEscalationText(input: {
  memberName: string;
  reason: string;
  diagnostics?: readonly string[];
  taskRefs: readonly { taskId: string; displayId?: string }[];
}): string {
  const taskLines = input.taskRefs.length
    ? input.taskRefs
        .map((taskRef) => `- ${taskRef.displayId ?? taskRef.taskId.slice(0, 8)}`)
        .join('\n')
    : '- No task refs recorded';
  const reasonText = describeMemberWorkSyncReviewPickupEscalationReason(input.reason);
  return [
    'Review pickup needs lead attention.',
    '',
    `Reviewer: ${input.memberName}`,
    reasonText,
    '',
    'Tasks:',
    taskLines,
    '',
    'No review_start, review_approve, or review_request_changes was recorded for the current review request.',
    'Consider reassigning the reviewer or sending a direct instruction.',
  ]
    .filter(Boolean)
    .join('\n');
}

function describeMemberWorkSyncReviewPickupEscalationReason(reason: string): string {
  if (reason.startsWith('provider_not_supported:')) {
    return 'Direct review-pickup wake is not available for this member runtime, so the lead needs to handle the stuck review.';
  }
  if (reason === 'review_pickup_already_delivered_still_stuck') {
    return 'A review-pickup reminder was delivered, but the review is still waiting for a review tool action.';
  }
  if (reason === 'review_pickup_delivery_failed_still_stuck') {
    return 'The review-pickup reminder could not be delivered reliably, and the review is still waiting.';
  }
  if (reason.includes('delivery_port_unavailable')) {
    return 'No reliable review-pickup delivery path is available for this member runtime.';
  }
  return 'The current review request is still waiting for explicit review pickup.';
}

async function resolveOpenCodeRuntimeBinaryForBridgeEnv(): Promise<string | null> {
  const resolvedBinaryPath = await resolveVerifiedOpenCodeRuntimeBinaryPath();
  if (resolvedBinaryPath) return resolvedBinaryPath;

  try {
    const status = await openCodeRuntimeInstallerService?.getStatus();
    return status?.installed === true && status.binaryPath ? status.binaryPath : null;
  } catch (error) {
    logger.warn(
      `[OpenCode] Runtime installer status unavailable while resolving bridge binary: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

async function createOpenCodeRuntimeAdapterRegistry(
  reportProgress: (phase: string, message: string) => void = () => undefined
): Promise<TeamRuntimeAdapterRegistry> {
  const binaryPath = await ClaudeBinaryResolver.resolve({
    onProgress: ({ phase, message }) => reportProgress(`runtime-${phase}`, message),
  });
  if (!binaryPath) {
    logger.warn('[OpenCode] Runtime adapter bridge disabled: orchestrator CLI binary not resolved');
    reportProgress(
      'runtime-unavailable',
      'Runtime not found. Continuing with limited launch support...'
    );
    openCodeLifecycleBridge = null;
    return new TeamRuntimeAdapterRegistry();
  }

  reportProgress('runtime-environment', 'Preparing runtime environment...');
  const bridgeEnv = applyOpenCodeAutoUpdatePolicy({ ...process.env });
  applyAgentTeamsIdentityEnv(bridgeEnv);
  bridgeEnv.CLAUDE_TEAM_APP_INSTANCE_ID = openCodeManagedHostInstanceId;
  bridgeEnv.AGENT_TEAMS_MCP_CLAUDE_DIR = getClaudeBasePath();
  const useHttpMcpBridge = isOpenCodeMcpHttpBridgeEnabled(bridgeEnv);
  const explicitLocalMcpLaunchEnv = snapshotOpenCodeLocalMcpLaunchEnv(bridgeEnv);
  delete bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL;
  const applyMcpLaunchSpecEnv = async (
    targetEnv: NodeJS.ProcessEnv,
    options: { emitProgress?: boolean } = {}
  ): Promise<void> => {
    try {
      if (options.emitProgress) {
        reportProgress('runtime-mcp', 'Resolving Agent Teams MCP server...');
      }
      const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec({
        onProgress: options.emitProgress
          ? ({ phase, message }) => reportProgress(`mcp-${phase}`, message)
          : undefined,
      });
      const mcpEntry = mcpLaunchSpec.args[0];
      if (mcpEntry) {
        targetEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = mcpLaunchSpec.command;
        targetEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntry;
        targetEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify(mcpLaunchSpec.args);
      }
    } catch (error) {
      logger.warn(
        `[OpenCode] Runtime adapter bridge MCP entrypoint unresolved: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
  const ensureOpenCodeLocalMcpLaunchEnv = async (
    targetEnv: NodeJS.ProcessEnv,
    options: { emitProgress?: boolean } = {}
  ): Promise<void> => {
    if (hasOpenCodeLocalMcpLaunchEnv(bridgeEnv)) {
      copyOpenCodeLocalMcpLaunchEnv(bridgeEnv, targetEnv);
      return;
    }
    if (explicitLocalMcpLaunchEnv) {
      copyOpenCodeLocalMcpLaunchEnv(explicitLocalMcpLaunchEnv, targetEnv);
      copyOpenCodeLocalMcpLaunchEnv(explicitLocalMcpLaunchEnv, bridgeEnv);
      return;
    }

    await applyMcpLaunchSpecEnv(targetEnv, options);
    if (hasOpenCodeLocalMcpLaunchEnv(targetEnv)) {
      copyOpenCodeLocalMcpLaunchEnv(targetEnv, bridgeEnv);
    }
  };
  const ensureOpenCodeRuntimeBinaryEnv = async (targetEnv: NodeJS.ProcessEnv): Promise<void> => {
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolveOpenCodeRuntimeBinaryForBridgeEnv,
      onWarning: (message) => logger.warn(message),
    });
  };
  await ensureOpenCodeRuntimeBinaryEnv(bridgeEnv);
  try {
    reportProgress('runtime-work-sync', 'Preparing runtime work sync hooks...');
    const turnSettledEnv = await buildMemberWorkSyncRuntimeTurnSettledEnvironment({
      teamsBasePath: getTeamsBasePath(),
      provider: 'opencode',
    });
    if (turnSettledEnv) {
      Object.assign(bridgeEnv, turnSettledEnv);
    }
  } catch (error) {
    logger.warn(
      `[OpenCode] Runtime adapter bridge turn-settled spool unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (useHttpMcpBridge) {
    try {
      reportProgress('runtime-mcp-http', 'Starting Agent Teams MCP server...');
      const mcpHttpServer = await agentTeamsMcpHttpServer.ensureStarted();
      bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = mcpHttpServer.url;
      bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH = mcpHttpServer.urlHash;
      reportProgress('runtime-mcp-http-ready', 'Agent Teams MCP server is ready...');
    } catch (error) {
      logger.warn(
        `[OpenCode] Runtime adapter bridge MCP HTTP server unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (
    shouldEnsureOpenCodeLocalMcpLaunchEnv({
      httpBridgeEnabled: useHttpMcpBridge,
      mcpUrl: bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL,
    })
  ) {
    await ensureOpenCodeLocalMcpLaunchEnv(bridgeEnv, { emitProgress: true });
  }

  reportProgress('runtime-bridge', 'Preparing OpenCode bridge...');
  const resolveBridgeCommandEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const nextEnv = { ...bridgeEnv };
    await ensureOpenCodeRuntimeBinaryEnv(nextEnv);
    if (!useHttpMcpBridge) {
      return nextEnv;
    }
    try {
      const mcpHttpServer = await agentTeamsMcpHttpServer.ensureStarted();
      bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = mcpHttpServer.url;
      bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH = mcpHttpServer.urlHash;
      nextEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = mcpHttpServer.url;
      nextEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH = mcpHttpServer.urlHash;
      await ensureOpenCodeLocalMcpLaunchEnv(nextEnv);
    } catch (error) {
      delete bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL;
      delete bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH;
      delete nextEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL;
      delete nextEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH;
      await ensureOpenCodeLocalMcpLaunchEnv(nextEnv);
      logger.warn(
        `[OpenCode] Runtime adapter bridge MCP HTTP server refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return nextEnv;
  };
  const bridgeClient = new OpenCodeBridgeCommandClient({
    binaryPath,
    tempDirectory: join(app.getPath('temp'), 'claude-team-opencode-bridge'),
    env: bridgeEnv,
    envProvider: resolveBridgeCommandEnv,
  });
  const bridgeControlDir = join(app.getPath('userData'), 'opencode-bridge');
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '1.3.0',
    gitSha: process.env.VITE_GIT_SHA ?? process.env.GIT_SHA ?? null,
    buildId: process.env.VITE_BUILD_ID ?? process.env.BUILD_ID ?? null,
  });
  const stateChangingCommands = new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: clientIdentity,
    handshakePort: new OpenCodeBridgeCommandHandshakePort({
      bridge: bridgeClient,
      clientIdentity,
    }),
    leaseStore: createOpenCodeBridgeCommandLeaseStore({
      filePath: join(bridgeControlDir, 'command-leases.json'),
    }),
    ledger: createOpenCodeBridgeCommandLedgerStore({
      filePath: join(bridgeControlDir, 'command-ledger.json'),
    }),
    bridge: bridgeClient,
    manifestReader: new OpenCodeRuntimeManifestEvidenceReader({
      teamsBasePath: getTeamsBasePath(),
    }),
  });
  const readinessBridge = new OpenCodeReadinessBridge(bridgeClient, {
    stateChangingCommands,
  });
  openCodeLifecycleBridge = readinessBridge;
  return new TeamRuntimeAdapterRegistry([new OpenCodeTeamRuntimeAdapter(readinessBridge)]);
}

async function cleanupOpenCodeHostsForLifecycle(reason: 'startup' | 'shutdown'): Promise<void> {
  let registryHostPids = new Set<number>();
  let registryCleanupAvailable = false;
  if (openCodeLifecycleBridge) {
    const result = await openCodeLifecycleBridge.cleanupOpenCodeHosts({
      reason,
      mode: reason === 'shutdown' ? 'force' : 'stale',
      staleAgeMs: reason === 'startup' ? 5 * 60_000 : null,
      leaseStaleAgeMs: reason === 'startup' ? 24 * 60 * 60_000 : null,
      preflightLeaseStaleAgeMs: reason === 'startup' ? 2 * 60_000 : null,
    });
    registryHostPids = new Set(
      result.hosts
        .filter((host) => host.action.startsWith('kept_'))
        .map((host) => host.pid)
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    );
    if (result.cleaned > 0) {
      logger.info(
        `[OpenCode] ${reason} host cleanup removed ${result.cleaned} registry host(s), ${result.remaining} remaining`
      );
    }
    for (const diagnostic of result.diagnostics) {
      logger.warn(`[OpenCode] ${reason} host cleanup: ${diagnostic}`);
    }
    registryCleanupAvailable = !result.diagnostics.some((diagnostic) =>
      diagnostic.startsWith('OpenCode host cleanup bridge failed:')
    );
  }

  if (reason === 'startup' && !registryCleanupAvailable) {
    logger.warn(
      '[OpenCode] Startup fallback cleanup skipped because host registry cleanup is unavailable'
    );
    return;
  }

  await cleanupOpenCodeHostProcessFallback(`${reason} fallback`, {
    mode: reason === 'shutdown' ? 'force' : 'orphaned',
    excludePids: reason === 'startup' ? registryHostPids : undefined,
    requiredDetailsMarkers:
      reason === 'shutdown'
        ? [`CLAUDE_TEAM_APP_INSTANCE_ID=${openCodeManagedHostInstanceId}`]
        : undefined,
    startedBeforeMs: reason === 'startup' ? appStartedAtMs : null,
  });
}

async function cleanupOpenCodeHostProcessFallback(
  label: string,
  options: Parameters<typeof cleanupManagedOpenCodeServeProcesses>[0]
): Promise<void> {
  const fallback = await cleanupManagedOpenCodeServeProcesses(options);
  if (fallback.killed > 0) {
    logger.info(`[OpenCode] ${label} cleanup killed ${fallback.killed} managed host(s)`);
  }
  for (const diagnostic of fallback.diagnostics) {
    logger.warn(`[OpenCode] ${label} cleanup: ${diagnostic}`);
  }
}

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
      // Skip app-owned private bootstrap/control prompts. They are durable runtime proof inputs,
      // not user-visible conversation messages.
      if (isTeamInternalControlMessageEnvelope(msg)) continue;
      // Skip internal review-pickup escalations. They are control-plane signals to the lead runtime,
      // not user-facing inbox messages.
      if (isReviewPickupEscalationMessage(msg)) continue;
      // Skip internal coordination noise (idle_notification, shutdown_*, etc.)
      if (shouldSuppressDesktopNotificationForInboxText(msg.text)) continue;

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
          target: isCrossTeam
            ? { kind: 'team', teamName, section: 'messages' }
            : { kind: 'member', teamName, memberName: fromLabel, focus: 'messages' },
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
      if (shouldSuppressDesktopNotificationForInboxText(msg.text)) continue;

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
          target: { kind: 'member', teamName, memberName: fromLabel, focus: 'messages' },
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
let codexAccountFeature: CodexAccountFeatureFacade | null = null;
let codexModelCatalogFeature: CodexModelCatalogFeatureFacade | null = null;
let recentProjectsFeature: RecentProjectsFeatureFacade;
let runtimeProviderManagementFeature: RuntimeProviderManagementFeatureFacade;
let memberWorkSyncFeature: MemberWorkSyncFeatureFacade | null = null;
let teamDataService: TeamDataService;
let teamProvisioningService: TeamProvisioningService;
let launchIoGovernor: LaunchIoGovernor | null = null;
let cliInstallerService: CliInstallerService;
let openCodeRuntimeInstallerService: OpenCodeRuntimeInstallerService;
let ptyTerminalService: PtyTerminalService;
let httpServer: HttpServer;
let schedulerService: SchedulerService;
let teamTaskStallMonitor: TeamTaskStallMonitor | null = null;
let skillsWatcherService: SkillsWatcherService | null = null;
let teamBackupService: TeamBackupService | null = null;
let branchStatusService: BranchStatusService | null = null;
let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let rendererRecoveryAttempts = 0;
let servicesReady = false;
let rendererDidFinishLoad = false;
let fileWatcherStartupStarted = false;
let backgroundStartupTasksStarted = false;
let appStartupHandlersRegistered = false;

// File watcher event cleanup functions
let fileChangeCleanup: (() => void) | null = null;
let todoChangeCleanup: (() => void) | null = null;
let teamChangeCleanup: (() => void) | null = null;
let shutdownPromise: Promise<void> | null = null;
let shutdownComplete = false;
const startupTimers = new Set<ReturnType<typeof setTimeout>>();

const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;
const STARTUP_RECOVERY_DELAY_MS = 10_000;
const STARTUP_RECOVERY_CONCURRENCY = 1;
const appStartupStartedAt = Date.now();
let appStartupSteps: AppStartupStep[] = [
  {
    phase: 'boot',
    message: 'Starting Agent Teams AI...',
    startedAt: appStartupStartedAt,
    updatedAt: appStartupStartedAt,
  },
];
let appStartupStatus: AppStartupStatus = {
  phase: 'boot',
  message: 'Starting Agent Teams AI...',
  ready: false,
  error: null,
  startedAt: appStartupStartedAt,
  updatedAt: appStartupStartedAt,
  steps: appStartupSteps,
};

function isShutdownStarted(): boolean {
  return shutdownComplete || shutdownPromise !== null;
}

function hasActiveTeamRuntimesForWindowClose(): boolean {
  if (!servicesReady || !teamProvisioningService) {
    return false;
  }

  try {
    return teamProvisioningService.hasActiveTeamRuntimes();
  } catch (error) {
    logger.warn(
      `Failed to check active team runtimes before closing last window: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

function scheduleStartupTask(action: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    startupTimers.delete(timer);
    if (isShutdownStarted()) {
      return;
    }
    action();
  }, delayMs);
  timer.unref?.();
  startupTimers.add(timer);
}

function registerAppStartupHandlers(): void {
  if (appStartupHandlersRegistered) {
    return;
  }
  appStartupHandlersRegistered = true;
  registerRendererLogHandlers(ipcMain);
  ipcMain.handle(APP_STARTUP_GET_STATUS, () => appStartupStatus);
}

function cloneStartupSteps(): AppStartupStep[] {
  return appStartupSteps.map((step) => ({ ...step }));
}

function updateStartupTimeline(update: Partial<AppStartupStatus>, now: number): void {
  if (!update.phase && !update.message) {
    return;
  }

  const phase = update.phase ?? appStartupStatus.phase;
  const message = update.message ?? appStartupStatus.message;
  const current = appStartupSteps[appStartupSteps.length - 1];

  if (current?.phase !== phase) {
    if (current && !current.finishedAt) {
      current.finishedAt = now;
      current.durationMs = now - current.startedAt;
      current.updatedAt = now;
    }
    appStartupSteps.push({
      phase,
      message,
      startedAt: now,
      updatedAt: now,
    });
    if (appStartupSteps.length > 32) {
      appStartupSteps = appStartupSteps.slice(-32);
    }
  } else {
    current.message = message;
    current.updatedAt = now;
  }
}

function finishCurrentStartupStep(now: number): void {
  const current = appStartupSteps[appStartupSteps.length - 1];
  if (!current || current.finishedAt) {
    return;
  }
  current.finishedAt = now;
  current.durationMs = now - current.startedAt;
  current.updatedAt = now;
}

function publishStartupStatus(update: Partial<AppStartupStatus>): void {
  const now = Date.now();
  updateStartupTimeline(update, now);
  if (update.ready === true || update.error) {
    finishCurrentStartupStep(now);
  }
  appStartupStatus = {
    ...appStartupStatus,
    ...update,
    updatedAt: now,
    steps: cloneStartupSteps(),
  };
  safeSendToRenderer(mainWindow, APP_STARTUP_PROGRESS, appStartupStatus);
}

async function runStartupJobsBounded<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += workerCount) {
      if (isShutdownStarted()) {
        return;
      }
      await run(items[index]);
    }
  });
  await Promise.allSettled(workers);
}

function clearStartupTimers(): void {
  for (const timer of startupTimers) {
    clearTimeout(timer);
  }
  startupTimers.clear();
}

function clearInboxNotifyTimers(): void {
  for (const timer of inboxNotifyTimers.values()) {
    clearTimeout(timer);
  }
  inboxNotifyTimers.clear();
}

async function runShutdownStep(
  label: string,
  action: () => void | Promise<void>,
  timeoutMs: number = SHUTDOWN_STEP_TIMEOUT_MS
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          logger.warn(`Shutdown step timed out after ${timeoutMs}ms: ${label}`);
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    logger.warn(
      `Shutdown step failed (${label}): ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

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

    safeSendToRenderer(mainWindow, 'file-change', event);
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
    safeSendToRenderer(mainWindow, 'todo-change', event);
    httpServer?.broadcast('todo-change', event);
  };
  context.fileWatcher.on('todo-change', todoChangeHandler);
  todoChangeCleanup = () => context.fileWatcher.off('todo-change', todoChangeHandler);

  const reconcileScheduler = teamDataService
    ? createTeamReconcileDrainScheduler({
        run: async (teamName: string, trigger: TeamReconcileTrigger) => {
          try {
            await teamDataService.reconcileTeamArtifacts(teamName, trigger);
          } catch (e) {
            if (trigger.source === 'task') {
              logger.warn(
                `[FileWatcher] task reconcile failed for ${teamName} detail=${trigger.detail}: ${String(e)}`
              );
            } else {
              logger.warn(
                `[FileWatcher] reconcile failed for ${teamName} source=${trigger.source} detail=${trigger.detail}: ${String(e)}`
              );
            }
            throw e;
          }
        },
      })
    : null;

  // Forward team-change events to renderer and HTTP SSE
  const teamChangeHandler = (event: unknown): void => {
    safeSendToRenderer(mainWindow, TEAM_CHANGE, event);
    httpServer?.broadcast('team-change', event);

    // Process inbox and task change events.
    try {
      if (!event || typeof event !== 'object') return;
      const row = event as { type?: unknown; teamName?: unknown; detail?: unknown };
      if (typeof row.teamName !== 'string' || row.teamName.trim().length === 0) return;
      const teamName = row.teamName.trim();
      const detail = typeof row.detail === 'string' ? row.detail : '';
      launchIoGovernor?.noteTeamChange(row as TeamChangeEvent);

      if (row.type === 'config') {
        if (detail === 'config.json') {
          TeamConfigReader.invalidateTeam(teamName);
          getTeamDataWorkerClient().invalidateTeamConfig(teamName);
          teamDataService?.invalidateTeamRuntimeAdvisories(teamName);
          getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName);
        } else if (detail === 'team.meta.json' || detail === 'members.meta.json') {
          TeamConfigReader.invalidateListTeamsCache();
          getTeamDataWorkerClient().invalidateTeamConfig(teamName);
          teamDataService?.invalidateTeamRuntimeAdvisories(teamName);
          getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName);
        }
      }

      if (row.type === 'task') {
        TeamTaskReader.invalidateAllTasksCache();
        teamDataService?.invalidateTeamRuntimeAdvisories(teamName);
        getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName);
      }

      if (row.type === 'member-advisory') {
        teamDataService?.invalidateTeamRuntimeAdvisories(teamName);
        getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName);
      }

      memberWorkSyncFeature?.noteTeamChange(row as TeamChangeEvent);

      if (
        teamDataService &&
        (row.type === 'inbox' || row.type === 'lead-message' || row.type === 'config')
      ) {
        teamDataService.invalidateMessageFeed(teamName);
        if (row.type === 'inbox' || row.type === 'lead-message') {
          getTeamDataWorkerClient().invalidateTeamMessageFeed(teamName);
        }
      }

      // --- Inbox change events: relay to lead + native OS notifications ---
      if (row.type === 'inbox') {
        if (reconcileScheduler) {
          reconcileScheduler.schedule(teamName, { source: 'inbox', detail });
        }

        // Relay inbox changes into active runtime recipients.
        if (detail.startsWith('inboxes/')) {
          const match = /^inboxes\/(.+)\.json$/.exec(detail);
          if (match) {
            const inboxName = match[1];

            void teamProvisioningService
              .relayInboxFileToLiveRecipient(teamName, inboxName)
              .then((relay) => {
                if (relay.diagnostics?.length) {
                  const message = `[FileWatcher] relay diagnostics for ${teamName}/${inboxName}: ${relay.diagnostics.join('; ')}`;
                  if (hasWarningRelayDiagnostics(relay.diagnostics)) {
                    logger.warn(message);
                  } else {
                    logger.info(message);
                  }
                }
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
          const timer = setTimeout(() => {
            inboxNotifyTimers.delete(timerKey);
            void notifyNewInboxMessages(teamName, detail).catch(() => undefined);
          }, INBOX_NOTIFY_DEBOUNCE_MS);
          timer.unref?.();
          inboxNotifyTimers.set(timerKey, timer);
        }

        // Show native OS notification for new lead → user messages (sentMessages.json).
        if (detail === 'sentMessages.json') {
          const timerKey = `${teamName}:sentMessages`;
          const existing = inboxNotifyTimers.get(timerKey);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            inboxNotifyTimers.delete(timerKey);
            void notifyNewSentMessages(teamName).catch(() => undefined);
          }, INBOX_NOTIFY_DEBOUNCE_MS);
          timer.unref?.();
          inboxNotifyTimers.set(timerKey, timer);
        }
      }

      // --- Task change events: notify lead when teammate starts a task via CLI ---
      if (row.type === 'task' && detail.endsWith('.json') && teamDataService) {
        reconcileScheduler?.schedule(teamName, { source: 'task', detail });

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
  teamChangeCleanup = () => {
    context.fileWatcher.off('team-change', teamChangeHandler);
    reconcileScheduler?.dispose();
  };

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
  safeSendToRenderer(mainWindow, SSH_STATUS, sshConnectionManager.getStatus());
  safeSendToRenderer(mainWindow, CONTEXT_CHANGED, {
    id: context.id,
    type: context.type,
  });
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
async function initializeServices(): Promise<void> {
  logger.info('Initializing services...');
  publishStartupStatus({
    phase: 'services',
    message: 'Preparing app services...',
    ready: false,
    error: null,
  });

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

  launchIoGovernor = new LaunchIoGovernor({
    logger: createLogger('Service:LaunchIoGovernor'),
  });

  // Wire file watcher events for local context
  wireFileWatcherEvents(localContext);

  // Initialize updater and CLI installer services
  updaterService = new UpdaterService();
  updaterService.setBeforeQuitAndInstall(async () => {
    try {
      await shutdownServices();
    } catch (error) {
      logger.error(
        `Shutdown before update install failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      shutdownComplete = true;
    }
  });
  cliInstallerService = new CliInstallerService();
  openCodeRuntimeInstallerService = new OpenCodeRuntimeInstallerService();
  ptyTerminalService = new PtyTerminalService();
  const teamMemberLogsFinder = new TeamMemberLogsFinder();
  const teamLogSourceTracker = new TeamLogSourceTracker(teamMemberLogsFinder);
  const taskLogConfigReader = new TeamConfigReader();
  const teamTranscriptSourceLocator = new TeamTranscriptSourceLocator(
    new TeamTranscriptProjectResolver({
      getConfig: (teamName) => taskLogConfigReader.getConfigSnapshot(teamName),
    })
  );
  teamLogSourceTracker.onLogSourceChange((teamName) => {
    teamTranscriptSourceLocator.invalidateTeam(teamName);
  });
  const boardTaskActivityRecordSource = new BoardTaskActivityRecordSource(
    teamTranscriptSourceLocator
  );
  const boardTaskActivityService = new BoardTaskActivityService(boardTaskActivityRecordSource);
  const boardTaskActivityDetailService = new BoardTaskActivityDetailService(
    boardTaskActivityRecordSource
  );
  const boardTaskExactLogsService = new BoardTaskExactLogsService(boardTaskActivityRecordSource);
  const boardTaskExactLogDetailService = new BoardTaskExactLogDetailService(
    boardTaskActivityRecordSource
  );
  const boardTaskLogStreamService = new BoardTaskLogStreamService(
    boardTaskActivityRecordSource,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    teamTranscriptSourceLocator
  );
  const memberLogStreamFeature = createMemberLogStreamFeature({
    logsFinder: teamMemberLogsFinder,
    logSourceTracker: teamLogSourceTracker,
    runtimeBridge: new ClaudeMultimodelBridgeService(),
    configReader: taskLogConfigReader,
    logger: createLogger('Feature:MemberLogStream'),
  });
  const teamMemberRuntimeAdvisoryService = new TeamMemberRuntimeAdvisoryService(
    teamMemberLogsFinder
  );
  teamDataService = new TeamDataService();
  teamDataService.setMemberRuntimeAdvisoryService(teamMemberRuntimeAdvisoryService);
  teamProvisioningService = new TeamProvisioningService();
  teamProvisioningService.setWorkspaceTrustCoordinator(
    createWorkspaceTrustCoordinator({
      claudeConfigDir: () => getClaudeBasePath(),
      globalConfigFilePath: () => {
        const claudeBasePath = getClaudeBasePath();
        return claudeBasePath !== getAutoDetectedClaudeBasePath()
          ? join(claudeBasePath, '.claude.json')
          : join(getHomeDir(), '.claude.json');
      },
    })
  );
  teamProvisioningService.setMemberRuntimeAdvisoryInvalidator((teamName, memberName) => {
    teamDataService?.invalidateMemberRuntimeAdvisory(teamName, memberName);
    getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName, memberName);
  });
  publishStartupStatus({
    phase: 'runtime',
    message: 'Resolving local runtime...',
  });
  teamProvisioningService.setRuntimeAdapterRegistry(
    await createOpenCodeRuntimeAdapterRegistry((phase, message) =>
      publishStartupStatus({ phase, message })
    )
  );
  scheduleStartupTask(() => {
    void cleanupOpenCodeHostsForLifecycle('startup').catch((error: unknown) =>
      logger.warn(`[OpenCode] Startup host cleanup failed: ${String(error)}`)
    );
  }, STARTUP_RECOVERY_DELAY_MS);
  // Startup GC: remove stale MCP config files from previous sessions (best-effort)
  void new TeamMcpConfigBuilder().gcStaleConfigs();
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

  const taskChangePresenceRepository = new JsonTaskChangePresenceRepository();
  teamTaskStallMonitor = new TeamTaskStallMonitor(
    new ActiveTeamRegistry(teamDataService, teamLogSourceTracker),
    new TeamTaskStallSnapshotSource(teamTranscriptSourceLocator),
    new TeamTaskStallPolicy(),
    new TeamTaskStallJournal(),
    new TeamTaskStallNotifier(teamDataService, teamProvisioningService)
  );
  let teammateToolTracker: TeammateToolTracker | null = null;
  branchStatusService = new BranchStatusService((event) => {
    safeSendToRenderer(mainWindow, TEAM_PROJECT_BRANCH_CHANGE, event);
  });
  const memberStatsComputer = new MemberStatsComputer(teamMemberLogsFinder);
  const taskBoundaryParser = new TaskBoundaryParser();
  const changeExtractor = new ChangeExtractorService(
    teamMemberLogsFinder,
    taskBoundaryParser,
    undefined,
    undefined,
    undefined,
    openCodeLifecycleBridge
  );
  teamDataService.setTaskChangePresenceServices(taskChangePresenceRepository, teamLogSourceTracker);
  changeExtractor.setTaskChangePresenceServices(taskChangePresenceRepository, teamLogSourceTracker);
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
  const extensionsRuntimeAdapter = createExtensionsRuntimeAdapter();
  const mcpStateService = new McpInstallationStateService(extensionsRuntimeAdapter);
  const mcpHealthDiagnosticsService = new McpHealthDiagnosticsService(extensionsRuntimeAdapter);
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
  const pluginInstallService = new PluginInstallService(
    pluginCatalogService,
    extensionsRuntimeAdapter
  );
  const mcpInstallService = new McpInstallService(mcpAggregator, extensionsRuntimeAdapter);
  const apiKeyService = new ApiKeyService();
  providerConnectionService.setApiKeyService(apiKeyService);
  publishStartupStatus({
    phase: 'settings',
    message: 'Loading secure settings...',
  });
  // warmup() and ensureInstalled() are deferred to after window creation
  // (did-finish-load handler) to avoid thread pool contention at startup.
  httpServer = new HttpServer();
  teamProvisioningService.setControlApiBaseUrlResolver(async () => {
    if (!httpServer.isRunning()) {
      await startHttpServer(handleModeSwitch);
    }

    return getTeamControlApiBaseUrl();
  });

  const forwardTeamChange = (event: TeamChangeEvent): void => {
    launchIoGovernor?.noteTeamChange(event);
    if (event.type === 'config') {
      if (event.detail === 'config.json') {
        TeamConfigReader.invalidateTeam(event.teamName);
        getTeamDataWorkerClient().invalidateTeamConfig(event.teamName);
        teamDataService?.invalidateTeamRuntimeAdvisories(event.teamName);
        getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(event.teamName);
      } else if (event.detail === 'team.meta.json' || event.detail === 'members.meta.json') {
        TeamConfigReader.invalidateListTeamsCache();
        getTeamDataWorkerClient().invalidateTeamConfig(event.teamName);
        teamDataService?.invalidateTeamRuntimeAdvisories(event.teamName);
        getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(event.teamName);
      }
    }
    if (event.type === 'task') {
      TeamTaskReader.invalidateAllTasksCache();
      teamDataService?.invalidateTeamRuntimeAdvisories(event.teamName);
      getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(event.teamName);
    }
    if (event.type === 'member-advisory') {
      teamDataService?.invalidateTeamRuntimeAdvisories(event.teamName);
      getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(event.teamName);
    }
    if (
      teamDataService &&
      (event.type === 'inbox' || event.type === 'lead-message' || event.type === 'config')
    ) {
      teamDataService.invalidateMessageFeed(event.teamName);
      if (event.type === 'inbox' || event.type === 'lead-message') {
        getTeamDataWorkerClient().invalidateTeamMessageFeed(event.teamName);
      }
    }
    safeSendToRenderer(mainWindow, TEAM_CHANGE, event);
    httpServer?.broadcast('team-change', event);
  };
  teammateToolTracker = new TeammateToolTracker(
    teamMemberLogsFinder,
    teamLogSourceTracker,
    forwardTeamChange
  );
  // Allow TeamProvisioningService to trigger team refresh events (e.g. live lead replies).
  const teamChangeEmitter = (event: TeamChangeEvent): void => {
    forwardTeamChange(event);
    teamTaskStallMonitor?.noteTeamChange(event);
    memberWorkSyncFeature?.noteTeamChange(event);
    if (event.type === 'lead-activity' && event.detail === 'offline') {
      teammateToolTracker?.handleTeamOffline(event.teamName);
    }
  };
  teamProvisioningService.setTeamChangeEmitter(teamChangeEmitter);
  teamLogSourceTracker.setEmitter(teamChangeEmitter);
  teamLogSourceTracker.onLogSourceChange((teamName) => {
    teammateToolTracker?.handleLogSourceChange(teamName);
  });
  scheduleStartupTask(() => {
    void teamDataService
      .listTeams()
      .then(async (teams) => {
        const activeTeamNames = teams
          .filter((team) => !team.deletedAt)
          .map((team) => team.teamName);
        await runStartupJobsBounded(
          activeTeamNames,
          STARTUP_RECOVERY_CONCURRENCY,
          async (teamName) => {
            await teamProvisioningService.scanOpenCodePromptDeliveryWatchdog(teamName);
          }
        );
      })
      .catch((error: unknown) =>
        logger.warn(`[Init] OpenCode prompt delivery watchdog recovery failed: ${String(error)}`)
      );
  }, STARTUP_RECOVERY_DELAY_MS);
  teamTaskStallMonitor.start();

  // Allow SchedulerService to push schedule events to renderer
  schedulerService.setChangeEmitter((event) => {
    safeSendToRenderer(mainWindow, SCHEDULE_CHANGE, event);
  });

  skillsWatcherService.setEmitter((event) => {
    safeSendToRenderer(mainWindow, SKILLS_CHANGED, event);
  });

  teamProvisioningService.setToolApprovalEventEmitter((event) => {
    safeSendToRenderer(mainWindow, TEAM_TOOL_APPROVAL_EVENT, event);
  });

  teamProvisioningService.setMainWindow(mainWindow);
  recentProjectsFeature = createRecentProjectsFeature({
    getActiveContext: () => contextRegistry.getActive(),
    getLocalContext: () => contextRegistry.get('local'),
    logger: createLogger('Feature:RecentProjects'),
  });
  runtimeProviderManagementFeature = createRuntimeProviderManagementFeature();
  const memberWorkSyncLogger = createLogger('Feature:MemberWorkSync');
  const hasMemberWorkSyncRuntimeActivity = async (teamName: string): Promise<boolean> => {
    try {
      const snapshot = await teamProvisioningService.getTeamAgentRuntimeSnapshot(teamName);
      return hasWorkSyncActiveRuntime(snapshot);
    } catch (error) {
      memberWorkSyncLogger.warn('member work sync runtime activity check failed', {
        teamName,
        error: String(error),
      });
      return false;
    }
  };
  const isTeamActiveForMemberWorkSync = async (teamName: string): Promise<boolean> => {
    if (
      teamProvisioningService.isTeamAlive(teamName) ||
      teamProvisioningService.hasProvisioningRun(teamName)
    ) {
      return true;
    }
    return hasMemberWorkSyncRuntimeActivity(teamName);
  };
  const canDispatchMemberWorkSyncNudges = async (teamName: string): Promise<boolean> => {
    if (teamProvisioningService.isTeamAlive(teamName)) {
      return true;
    }
    return hasMemberWorkSyncRuntimeActivity(teamName);
  };
  const listMemberWorkSyncLifecycleActiveTeamNames = async (): Promise<string[]> => {
    const activeTeamNames: string[] = [];
    for (const team of await teamDataService.listTeams()) {
      if (team.deletedAt) {
        continue;
      }
      if (await isTeamActiveForMemberWorkSync(team.teamName)) {
        activeTeamNames.push(team.teamName);
      }
    }
    return activeTeamNames;
  };
  memberWorkSyncFeature = createMemberWorkSyncFeature({
    teamsBasePath: getTeamsBasePath(),
    configReader: new TeamConfigReader(),
    taskReader: new TeamTaskReader(),
    kanbanManager: new TeamKanbanManager(),
    membersMetaStore: new TeamMembersMetaStore(),
    isTeamActive: isTeamActiveForMemberWorkSync,
    canDispatchNudges: canDispatchMemberWorkSyncNudges,
    listLifecycleActiveTeamNames: listMemberWorkSyncLifecycleActiveTeamNames,
    extraBusySignals: [
      {
        isBusy: (input) => teamProvisioningService.getOpenCodeMemberDeliveryBusyStatus(input),
      },
    ],
    resolveControlUrl: async () => getTeamControlApiBaseUrl(),
    proofMissingRecoveryGuard: {
      shouldDispatch: async (input) => {
        const status = await teamProvisioningService.getOpenCodeRuntimeDeliveryStatus(
          input.teamName,
          input.originalMessageId
        );
        if (!status) {
          return {
            ok: false,
            reason: 'proof_missing_recovery_record_missing',
            retryable: false,
          };
        }

        const impact = status.userVisibleImpact;
        if (impact?.reasonCode === 'protocol_proof_missing') {
          if (impact.state === 'checking') {
            return {
              ok: false,
              reason: 'proof_missing_recovery_still_in_grace',
              retryable: true,
              ...(impact.nextReviewAt ? { nextAttemptAt: impact.nextReviewAt } : {}),
            };
          }
          return { ok: true };
        }

        if (status.responsePending) {
          return {
            ok: false,
            reason: 'proof_missing_recovery_delivery_still_pending',
            retryable: true,
          };
        }

        return {
          ok: false,
          reason: 'proof_missing_recovery_suppressed',
          retryable: false,
        };
      },
    },
    nudgeDeliveryWake: {
      schedule: async (input) => {
        if (input.providerId === 'opencode') {
          teamProvisioningService.scheduleOpenCodeMemberInboxDeliveryWake({
            teamName: input.teamName,
            memberName: input.memberName,
            messageId: input.messageId,
            delayMs: input.delayMs,
          });
          return;
        }

        const leadName = await teamDataService.getLeadMemberName(input.teamName).catch(() => null);
        if (leadName?.trim().toLowerCase() !== input.memberName.trim().toLowerCase()) {
          return;
        }

        const timer = setTimeout(
          () => {
            void teamProvisioningService
              .relayLeadInboxMessages(input.teamName)
              .catch((error: unknown) =>
                logger.warn(
                  `[${input.teamName}] member-work-sync lead nudge relay wake failed: ${String(
                    error
                  )}`
                )
              );
          },
          Math.max(0, input.delayMs ?? 0)
        );
        timer.unref?.();
      },
    },
    reviewPickupDelivery: {
      canDeliver: (input) =>
        input.providerId === 'opencode'
          ? { ok: true }
          : {
              ok: false,
              reason: `provider_not_supported:${input.providerId ?? 'unknown'}`,
            },
      deliver: async (input) => {
        if (input.providerId !== 'opencode') {
          return {
            ok: false,
            reason: 'capability_absent',
            message: `provider_not_supported:${input.providerId ?? 'unknown'}`,
          };
        }

        const relay = await teamProvisioningService.relayOpenCodeMemberInboxMessages(
          input.teamName,
          input.memberName,
          {
            onlyMessageId: input.messageId,
            source: 'member-work-sync-review-pickup',
            deliveryMetadata: {
              actionMode: input.payload.actionMode,
              taskRefs: input.payload.taskRefs,
            },
          }
        );
        const lastDelivery = relay.lastDelivery;
        const diagnostics = [...(relay.diagnostics ?? []), ...(lastDelivery?.diagnostics ?? [])];
        if (lastDelivery?.accepted === true && lastDelivery.responsePending === true) {
          return {
            ok: true,
            state: 'prompt_accepted',
            messageId: input.messageId,
            diagnostics,
          };
        }
        if (lastDelivery?.delivered && lastDelivery.accepted !== false) {
          return {
            ok: true,
            state: lastDelivery.responsePending ? 'prompt_accepted' : 'response_proven',
            messageId: input.messageId,
            diagnostics,
          };
        }
        if (
          lastDelivery?.reason === 'recipient_is_not_opencode' ||
          lastDelivery?.reason === 'recipient_removed' ||
          lastDelivery?.reason === 'opencode_recipient_unavailable'
        ) {
          return {
            ok: false,
            reason: 'capability_absent',
            message: lastDelivery.reason,
            diagnostics,
          };
        }
        if (lastDelivery?.ledgerStatus === 'failed_terminal') {
          return {
            ok: false,
            reason: 'terminal_failure',
            message: lastDelivery.reason ?? 'opencode_review_pickup_delivery_failed_terminal',
            diagnostics,
          };
        }
        return {
          ok: false,
          reason: 'retryable_failure',
          message: lastDelivery?.reason ?? 'opencode_review_pickup_delivery_not_confirmed',
          diagnostics,
        };
      },
    },
    reviewPickupEscalation: {
      escalate: async (input) => {
        const leadName = (await teamDataService.getLeadMemberName(input.teamName)) ?? 'team-lead';
        const messageId = buildMemberWorkSyncReviewPickupEscalationMessageId(input);
        const existing = await teamInboxReader.getMessagesFor(input.teamName, leadName);
        if (existing.some((message) => message.messageId === messageId)) {
          return;
        }

        await teamInboxWriter.sendMessage(input.teamName, {
          member: leadName,
          from: 'system',
          to: leadName,
          messageId,
          timestamp: input.nowIso,
          summary: 'Review pickup still pending',
          text: buildMemberWorkSyncReviewPickupEscalationText(input),
          taskRefs: input.taskRefs.map((taskRef) => ({
            taskId: taskRef.taskId,
            displayId: taskRef.displayId ?? taskRef.taskId.slice(0, 8),
            teamName: taskRef.teamName ?? input.teamName,
          })),
          actionMode: 'do',
          source: 'system_notification',
        });
      },
    },
    logger: memberWorkSyncLogger,
  });
  teamProvisioningService.setRuntimeTurnSettledHookSettingsProvider((input) =>
    memberWorkSyncFeature
      ? memberWorkSyncFeature.buildRuntimeTurnSettledHookSettings(input)
      : Promise.resolve(null)
  );
  teamProvisioningService.setRuntimeTurnSettledEnvironmentProvider((input) =>
    memberWorkSyncFeature
      ? memberWorkSyncFeature.buildRuntimeTurnSettledEnvironment(input)
      : Promise.resolve(null)
  );
  teamProvisioningService.setMemberWorkSyncProofMissingRecoveryScheduler((input) =>
    memberWorkSyncFeature
      ? memberWorkSyncFeature.scheduleProofMissingRecovery(input)
      : Promise.resolve({ scheduled: false, reason: 'invalid' })
  );
  scheduleStartupTask(() => {
    void teamDataService
      .listTeams()
      .then(async (teams) => {
        const lifecycleActiveTeamNames = teams
          .filter(
            (team) =>
              !team.deletedAt &&
              (teamProvisioningService.isTeamAlive(team.teamName) ||
                teamProvisioningService.hasProvisioningRun(team.teamName))
          )
          .map((team) => team.teamName);
        await memberWorkSyncFeature?.replayPendingReports(lifecycleActiveTeamNames);
        await memberWorkSyncFeature?.enqueueStartupScan(lifecycleActiveTeamNames);
      })
      .catch((error: unknown) =>
        logger.warn(`[Init] Member work sync startup scan failed: ${String(error)}`)
      );
  }, STARTUP_RECOVERY_DELAY_MS + 2_000);
  codexAccountFeature = createCodexAccountFeature({
    logger: createLogger('Feature:CodexAccount'),
    configManager,
  });
  providerConnectionService.setCodexAccountFeature(codexAccountFeature);
  codexModelCatalogFeature = createCodexModelCatalogFeature({
    logger: createLogger('Feature:CodexModelCatalog'),
    codexAccountFeature,
  });
  providerConnectionService.setCodexModelCatalogFeature(codexModelCatalogFeature);

  // startProcessHealthPolling() is deferred to after window creation
  // (did-finish-load handler) to avoid thread pool contention at startup.

  publishStartupStatus({
    phase: 'ipc',
    message: 'Wiring app actions...',
  });

  // Initialize IPC handlers with registry
  initializeIpcHandlers(
    contextRegistry,
    updaterService,
    sshConnectionManager,
    teamDataService,
    teamProvisioningService,
    teamMemberLogsFinder,
    memberStatsComputer,
    boardTaskActivityService,
    boardTaskActivityDetailService,
    boardTaskLogStreamService,
    boardTaskExactLogsService,
    boardTaskExactLogDetailService,
    teammateToolTracker ?? undefined,
    teamLogSourceTracker,
    branchStatusService ?? undefined,
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
    openCodeRuntimeInstallerService,
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
    teamBackupService ?? undefined,
    launchIoGovernor ?? undefined
  );
  registerCodexAccountIpc(ipcMain, codexAccountFeature);
  registerRecentProjectsIpc(ipcMain, recentProjectsFeature);
  registerRuntimeProviderManagementIpc(ipcMain, runtimeProviderManagementFeature);
  registerMemberWorkSyncIpc(ipcMain, memberWorkSyncFeature);
  registerMemberLogStreamIpc(ipcMain, memberLogStreamFeature);

  // Forward SSH state changes to renderer and HTTP SSE clients
  sshConnectionManager.on('state-change', (status: unknown) => {
    safeSendToRenderer(mainWindow, SSH_STATUS, status);
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
  publishStartupStatus({
    phase: 'readying',
    message: 'Finishing startup...',
  });
}

/**
 * Starts the HTTP sidecar server with services from the active context.
 */
async function startHttpServer(
  modeSwitchHandler: (mode: 'local' | 'ssh') => Promise<void>
): Promise<void> {
  if (isShutdownStarted()) {
    return;
  }

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
        recentProjectsFeature,
        memberWorkSyncFeature: memberWorkSyncFeature ?? undefined,
        updaterService,
        sshConnectionManager,
        teamDataService,
        teamProvisioningService,
      },
      modeSwitchHandler,
      config.httpServer?.port ?? 3456
    );
    if (isShutdownStarted()) {
      await httpServer.stop().catch(() => undefined);
      await clearTeamControlApiState().catch(() => undefined);
      return;
    }
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
async function shutdownServices(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    logger.info('Shutting down services...');

    clearStartupTimers();
    clearInboxNotifyTimers();

    // Clear pending auto-resume timers before anything else. Dangling timers can
    // keep the event loop alive and fire against a torn-down provisioning service.
    clearAutoResumeService();

    // Kill all team CLI processes via SIGKILL before anything else.
    // This must happen before the OS closes stdin pipes on app exit, because
    // stdin EOF triggers CLI cleanup that can delete team files.
    if (teamProvisioningService) {
      await runShutdownStep('stop all teams', () => teamProvisioningService.stopAllTeams(), 10_000);
    }
    await runShutdownStep(
      'OpenCode host registry cleanup',
      () => cleanupOpenCodeHostsForLifecycle('shutdown'),
      10_000
    );
    await runShutdownStep('Agent Teams MCP HTTP server cleanup', () =>
      agentTeamsMcpHttpServer.stop({ preventRestart: true })
    );
    await runShutdownStep('tracked CLI subprocess cleanup', () =>
      killTrackedCliProcesses('SIGKILL')
    );
    await runShutdownStep(
      'OpenCode post-subprocess fallback cleanup',
      () =>
        cleanupOpenCodeHostProcessFallback('post-subprocess shutdown fallback', {
          mode: 'force',
          requiredDetailsMarkers: [`CLAUDE_TEAM_APP_INSTANCE_ID=${openCodeManagedHostInstanceId}`],
        }),
      5_000
    );

    await runShutdownStep('MCP config GC', () => new TeamMcpConfigBuilder().gcOwnConfigs());

    // Sync backup all team data. Files are stable after SIGKILL.
    if (teamBackupService) {
      await runShutdownStep('team backup sync', () => teamBackupService?.runShutdownBackupSync());
    }

    if (httpServer?.isRunning()) {
      await runShutdownStep('HTTP server stop', () => httpServer.stop());
    }
    await runShutdownStep('team control state cleanup', () => clearTeamControlApiState());

    await runShutdownStep('file watcher event cleanup', () => {
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
    });

    await runShutdownStep('editor cleanup', () => cleanupEditorState());

    if (contextRegistry) {
      await runShutdownStep('context registry dispose', () => contextRegistry.dispose());
    }

    if (sshConnectionManager) {
      await runShutdownStep('SSH connection manager dispose', () => sshConnectionManager.dispose());
    }

    if (teamDataService) {
      await runShutdownStep('team data polling stop', () =>
        teamDataService.stopProcessHealthPolling()
      );
    }
    if (updaterService) {
      await runShutdownStep('updater periodic check stop', () =>
        updaterService.stopPeriodicCheck()
      );
    }
    if (teamTaskStallMonitor) {
      await runShutdownStep('team task stall monitor stop', () => teamTaskStallMonitor?.stop());
      teamTaskStallMonitor = null;
    }
    await runShutdownStep('branch status dispose', () => branchStatusService?.dispose());
    branchStatusService = null;

    if (schedulerService) {
      await runShutdownStep('scheduler stop', () => schedulerService.stop());
    }

    await runShutdownStep('skills watcher stop', () => skillsWatcherService?.stopAll());
    await runShutdownStep('provider connection feature detach', () => {
      providerConnectionService.setCodexModelCatalogFeature(null);
      providerConnectionService.setCodexAccountFeature(null);
    });
    await runShutdownStep('Codex model catalog dispose', () => codexModelCatalogFeature?.dispose());
    codexModelCatalogFeature = null;
    await runShutdownStep('Codex account dispose', () => codexAccountFeature?.dispose());
    codexAccountFeature = null;
    await runShutdownStep('member work sync dispose', () => memberWorkSyncFeature?.dispose());
    memberWorkSyncFeature = null;

    if (ptyTerminalService) {
      await runShutdownStep('PTY terminals kill', () => ptyTerminalService.killAll());
    }

    await runShutdownStep('IPC handlers cleanup', () => {
      removeIpcHandlers();
      removeCodexAccountIpc(ipcMain);
      removeRecentProjectsIpc(ipcMain);
      removeRuntimeProviderManagementIpc(ipcMain);
      removeMemberWorkSyncIpc(ipcMain);
      removeMemberLogStreamIpc(ipcMain);
    });

    await runShutdownStep('team backup dispose', () => teamBackupService?.dispose());

    logger.info('Services shut down successfully');
  })();

  return shutdownPromise;
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
  safeSendToRenderer(win, WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, zoomFactor);
}

function attachMainWindowToServices(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    return;
  }

  notificationManager?.setMainWindow(win);
  updaterService?.setMainWindow(win);
  cliInstallerService?.setMainWindow(win);
  openCodeRuntimeInstallerService?.setMainWindow(win);
  setCodexRuntimeMainWindow(win);
  setTmuxMainWindow(win);
  ptyTerminalService?.setMainWindow(win);
  teamProvisioningService?.setMainWindow(win);
  codexAccountFeature?.setMainWindow(win);
  setEditorMainWindow(win);
  setReviewMainWindow(win);
}

function runPostRendererStartupTasks(): void {
  if (!servicesReady || !rendererDidFinishLoad || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!fileWatcherStartupStarted) {
    fileWatcherStartupStarted = true;
    // Start file watchers after both the visible window and main services are ready.
    const activeContext = contextRegistry.getActive();
    if (process.platform === 'win32') {
      scheduleStartupTask(() => {
        if (!fileWatcherStartupStarted || !servicesReady || !rendererDidFinishLoad) {
          return;
        }
        activeContext.startFileWatcher();
      }, 1500);
    } else if (!isShutdownStarted()) {
      activeContext.startFileWatcher();
    }
  }

  if (backgroundStartupTasksStarted) {
    return;
  }
  backgroundStartupTasksStarted = true;

  if (!isShutdownStarted()) {
    scheduleStartupTask(() => void updaterService.checkForUpdates(), 3000);
    updaterService.startPeriodicCheck(60 * 60 * 1000);
  }

  scheduleStartupTask(
    () => {
      void getTeamFsWorkerClient()
        .prewarm()
        .catch((error: unknown) =>
          logger.debug(
            `[startup] team-fs-worker prewarm skipped: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      void getTeamDataWorkerClient()
        .prewarm()
        .catch((error: unknown) =>
          logger.debug(
            `[startup] team-data-worker prewarm skipped: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
    },
    process.platform === 'win32' ? 2500 : 1000
  );

  scheduleStartupTask(() => {
    void teamProvisioningService.warmup();
    teamDataService.startProcessHealthPolling();
    void schedulerService?.start();
  }, 5000);
}

function scheduleRendererRecovery(win: BrowserWindow): void {
  if (isShutdownStarted()) {
    return;
  }
  if (rendererRecoveryTimer) {
    return;
  }
  if (rendererRecoveryAttempts >= 2) {
    logger.error('Renderer recovery limit reached; skipping automatic reload');
    return;
  }

  rendererRecoveryAttempts += 1;
  const delayMs = rendererRecoveryAttempts * 1000;
  logger.warn(`Scheduling renderer recovery attempt ${rendererRecoveryAttempts} in ${delayMs}ms`);

  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = null;
    if (isShutdownStarted()) {
      return;
    }
    if (!mainWindow || mainWindow !== win || win.isDestroyed()) {
      return;
    }

    markRendererUnavailable(win);
    try {
      win.webContents.reload();
    } catch (error) {
      logger.error(`Renderer recovery reload failed: ${String(error)}`);
    }
  }, delayMs);
  rendererRecoveryTimer.unref?.();
}

/**
 * Creates the main application window.
 */
function createWindow(): void {
  if (isShutdownStarted()) {
    return;
  }
  rendererDidFinishLoad = false;

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
    title: 'Agent Teams AI',
  });
  markRendererUnavailable(mainWindow);

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
    safeSendToRenderer(mainWindow, WINDOW_FULLSCREEN_CHANGED, true);
  });
  mainWindow.on('leave-full-screen', () => {
    safeSendToRenderer(mainWindow, WINDOW_FULLSCREEN_CHANGED, false);
  });

  mainWindow.webContents.on('did-start-loading', () => {
    if (isShutdownStarted()) {
      return;
    }
    rendererDidFinishLoad = false;
    markRendererUnavailable(mainWindow);
    branchStatusService?.resetAllTracking();
  });

  // Set traffic light position + notify renderer on first load, and auto-check for updates
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (isShutdownStarted()) {
        return;
      }
      markRendererReady(mainWindow);
      rendererRecoveryAttempts = 0;
      if (rendererRecoveryTimer) {
        clearTimeout(rendererRecoveryTimer);
        rendererRecoveryTimer = null;
      }
      logger.warn('[startup] renderer did-finish-load');
      syncTrafficLightPosition(mainWindow);
      const fullscreenSyncTimer = setTimeout(() => {
        if (!isShutdownStarted()) {
          safeSendToRenderer(mainWindow, WINDOW_FULLSCREEN_CHANGED, mainWindow?.isFullScreen());
        }
      }, 0);
      fullscreenSyncTimer.unref?.();
      rendererDidFinishLoad = true;
      runPostRendererStartupTasks();
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
      safeSendToRenderer(mainWindow, 'review:cmdN');
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
      const zoomSyncTimer = setTimeout(() => {
        if (!isShutdownStarted() && mainWindow && !mainWindow.isDestroyed()) {
          syncTrafficLightPosition(mainWindow);
        }
      }, 100);
      zoomSyncTimer.unref?.();
    }
  });

  mainWindow.on('closed', () => {
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer);
      rendererRecoveryTimer = null;
    }
    clearRendererAvailability(mainWindow);
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
    if (openCodeRuntimeInstallerService) {
      openCodeRuntimeInstallerService.setMainWindow(null);
    }
    setCodexRuntimeMainWindow(null);
    setTmuxMainWindow(null);
    if (ptyTerminalService) {
      ptyTerminalService.setMainWindow(null);
    }
    if (teamProvisioningService) {
      teamProvisioningService.setMainWindow(null);
    }
    codexAccountFeature?.setMainWindow(null);
    setEditorMainWindow(null);
    setReviewMainWindow(null);
    cleanupEditorState();
  });

  // Handle renderer process crashes (render-process-gone replaces deprecated 'crashed' event)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone:', details.reason, details.exitCode);
    if (isShutdownStarted()) {
      return;
    }
    markRendererUnavailable(mainWindow);
    rendererDidFinishLoad = false;
    fileWatcherStartupStarted = false;
    branchStatusService?.resetAllTracking();
    contextRegistry?.getActive()?.stopFileWatcher();
    if (mainWindow) {
      scheduleRendererRecovery(mainWindow);
    }
  });

  attachMainWindowToServices();

  logger.info('Main window created');
}

/**
 * Application ready handler.
 */
void app.whenReady().then(async () => {
  logger.info('App ready, initializing...');
  registerAppStartupHandlers();

  try {
    publishStartupStatus({
      phase: 'electron-ready',
      message: 'Opening window...',
    });

    const config = configManager.getConfig();

    // Sync Sentry telemetry opt-in flag from persisted config
    syncTelemetryFlag(config.general.telemetryEnabled);

    // Apply launch-at-login only where Electron can persist it without noisy OS errors.
    // Local packaged macOS smoke builds run outside /Applications and cannot set login items.
    const canSyncLaunchAtLogin =
      app.isPackaged &&
      (process.platform === 'win32' ||
        (process.platform === 'darwin' && app.isInApplicationsFolder()));
    if (canSyncLaunchAtLogin) {
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

    createWindow();

    await initializeServices();
    servicesReady = true;
    attachMainWindowToServices();
    publishStartupStatus({
      phase: 'ready',
      message: 'Ready',
      ready: true,
      error: null,
    });
    runPostRendererStartupTasks();

    // Listen for notification click events
    notificationManager.on('notification-clicked', (_error) => {
      if (isShutdownStarted()) {
        return;
      }
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (error) {
    logger.error('Startup initialization failed:', error);
    publishStartupStatus({
      phase: 'failed',
      message: 'Startup failed',
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!mainWindow) {
      createWindow();
    }
  }

  app.on('activate', () => {
    if (isShutdownStarted()) {
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * All windows closed handler.
 */
app.on('window-all-closed', () => {
  const hasActiveTeamRuntimes = hasActiveTeamRuntimesForWindowClose();
  const shouldQuitWhenAllWindowsClosed =
    hasActiveTeamRuntimes ||
    process.platform !== 'darwin' ||
    !configManager.getConfig().general.showDockIcon;

  if (shouldQuitWhenAllWindowsClosed) {
    if (hasActiveTeamRuntimes) {
      logger.info('Quitting after last window closed because active team runtimes are running');
    }
    app.quit();
  }
});

/**
 * Before quit handler - cleanup.
 */
app.on('before-quit', (event) => {
  if (shutdownComplete) {
    return;
  }

  event.preventDefault();

  notificationManager.closeActiveNativeNotifications('app-before-quit');

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.hide();
    }
  }

  void shutdownServices()
    .catch((error) => {
      logger.error(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
