/**
 * IPC Handlers - Orchestrates domain-specific handler modules.
 *
 * This module initializes and registers all IPC handlers from domain modules:
 * - projects.ts: Project listing and repository groups
 * - sessions.ts: Session operations and pagination
 * - search.ts: Session search functionality
 * - subagents.ts: Subagent detail retrieval
 * - validation.ts: Path validation and scroll handling
 * - utility.ts: Shell operations and file reading
 * - notifications.ts: Notification management
 * - config.ts: App configuration
 * - ssh.ts: SSH connection management
 * - httpServer.ts: HTTP sidecar server control
 */

import { createLogger } from '@shared/utils/logger';
import { ipcMain } from 'electron';

import {
  initializeCliInstallerHandlers,
  registerCliInstallerHandlers,
  removeCliInstallerHandlers,
} from './cliInstaller';
import { initializeConfigHandlers, registerConfigHandlers, removeConfigHandlers } from './config';
import {
  initializeContextHandlers,
  registerContextHandlers,
  removeContextHandlers,
} from './context';
import {
  initializeCrossTeamHandlers,
  registerCrossTeamHandlers,
  removeCrossTeamHandlers,
} from './crossTeam';
import { initializeEditorHandlers, registerEditorHandlers, removeEditorHandlers } from './editor';
import {
  initializeExtensionHandlers,
  registerExtensionHandlers,
  removeExtensionHandlers,
} from './extensions';
import {
  initializeHttpServerHandlers,
  registerHttpServerHandlers,
  removeHttpServerHandlers,
} from './httpServer';

const logger = createLogger('IPC:handlers');
import { registerNotificationHandlers, removeNotificationHandlers } from './notifications';
import {
  initializeProjectHandlers,
  registerProjectHandlers,
  removeProjectHandlers,
} from './projects';
import { registerRendererLogHandlers, removeRendererLogHandlers } from './rendererLogs';
import { initializeReviewHandlers, registerReviewHandlers, removeReviewHandlers } from './review';
import {
  initializeScheduleHandlers,
  registerScheduleHandlers,
  removeScheduleHandlers,
} from './schedule';
import { initializeSearchHandlers, registerSearchHandlers, removeSearchHandlers } from './search';
import {
  initializeSessionHandlers,
  registerSessionHandlers,
  removeSessionHandlers,
} from './sessions';
import { initializeSkillsHandlers, registerSkillsHandlers, removeSkillsHandlers } from './skills';
import { initializeSshHandlers, registerSshHandlers, removeSshHandlers } from './ssh';
import {
  initializeSubagentHandlers,
  registerSubagentHandlers,
  removeSubagentHandlers,
} from './subagents';
import { initializeTeamHandlers, registerTeamHandlers, removeTeamHandlers } from './teams';
import {
  initializeTerminalHandlers,
  registerTerminalHandlers,
  removeTerminalHandlers,
} from './terminal';
import { registerTmuxHandlers, removeTmuxHandlers } from './tmux';
import {
  initializeUpdaterHandlers,
  registerUpdaterHandlers,
  removeUpdaterHandlers,
} from './updater';
import { registerUtilityHandlers, removeUtilityHandlers } from './utility';
import { registerValidationHandlers, removeValidationHandlers } from './validation';
import { registerWindowHandlers, removeWindowHandlers } from './window';

import type {
  BoardTaskActivityDetailService,
  BoardTaskActivityService,
  BoardTaskExactLogDetailService,
  BoardTaskExactLogsService,
  BoardTaskLogStreamService,
  BranchStatusService,
  ChangeExtractorService,
  CliInstallerService,
  FileContentResolver,
  GitDiffFallback,
  MemberStatsComputer,
  PtyTerminalService,
  ReviewApplierService,
  ServiceContext,
  ServiceContextRegistry,
  SshConnectionManager,
  TeamDataService,
  TeammateToolTracker,
  TeamMemberLogsFinder,
  TeamProvisioningService,
  UpdaterService,
} from '../services';
import type { ApiKeyService } from '../services/extensions/apikeys/ApiKeyService';
import type { ExtensionFacadeService } from '../services/extensions/ExtensionFacadeService';
import type { McpInstallService } from '../services/extensions/install/McpInstallService';
import type { PluginInstallService } from '../services/extensions/install/PluginInstallService';
import type { SkillsCatalogService } from '../services/extensions/skills/SkillsCatalogService';
import type { SkillsMutationService } from '../services/extensions/skills/SkillsMutationService';
import type { SkillsWatcherService } from '../services/extensions/skills/SkillsWatcherService';
import type { McpHealthDiagnosticsService } from '../services/extensions/state/McpHealthDiagnosticsService';
import type { HttpServer } from '../services/infrastructure/HttpServer';
import type { SchedulerService } from '../services/schedule/SchedulerService';
import type { CrossTeamService } from '../services/team/CrossTeamService';
import type { TeamBackupService } from '../services/team/TeamBackupService';

/**
 * Initializes IPC handlers with service registry.
 */
export function initializeIpcHandlers(
  registry: ServiceContextRegistry,
  updater: UpdaterService,
  sshManager: SshConnectionManager,
  teamDataService: TeamDataService,
  teamProvisioningService: TeamProvisioningService,
  teamMemberLogsFinder: TeamMemberLogsFinder,
  memberStatsComputer: MemberStatsComputer,
  boardTaskActivityService: BoardTaskActivityService,
  boardTaskActivityDetailService: BoardTaskActivityDetailService,
  boardTaskLogStreamService: BoardTaskLogStreamService,
  boardTaskExactLogsService: BoardTaskExactLogsService,
  boardTaskExactLogDetailService: BoardTaskExactLogDetailService,
  teammateToolTracker: TeammateToolTracker | undefined,
  branchStatusService: BranchStatusService | undefined,
  contextCallbacks: {
    rewire: (context: ServiceContext) => void;
    full: (context: ServiceContext) => void;
    onClaudeRootPathUpdated: (claudeRootPath: string | null) => Promise<void> | void;
  },
  httpServerDeps?: {
    httpServer: HttpServer;
    startHttpServer: () => Promise<void>;
  },
  changeExtractor?: ChangeExtractorService,
  fileContentResolver?: FileContentResolver,
  reviewApplier?: ReviewApplierService,
  gitDiffFallback?: GitDiffFallback,
  cliInstaller?: CliInstallerService,
  ptyTerminal?: PtyTerminalService,
  schedulerService?: SchedulerService,
  extensionFacade?: ExtensionFacadeService,
  pluginInstaller?: PluginInstallService,
  mcpInstaller?: McpInstallService,
  apiKeyService?: ApiKeyService,
  mcpHealthDiagnosticsService?: McpHealthDiagnosticsService,
  skillsCatalogService?: SkillsCatalogService,
  skillsMutationService?: SkillsMutationService,
  skillsWatcherService?: SkillsWatcherService,
  crossTeamService?: CrossTeamService,
  teamBackupService?: TeamBackupService
): void {
  // Initialize domain handlers with registry
  initializeProjectHandlers(registry);
  initializeSessionHandlers(registry);
  initializeSearchHandlers(registry);
  initializeSubagentHandlers(registry);
  initializeUpdaterHandlers(updater);
  initializeSshHandlers(sshManager, registry, contextCallbacks.rewire);
  initializeContextHandlers(registry, contextCallbacks.rewire);
  initializeTeamHandlers(
    teamDataService,
    teamProvisioningService,
    teamMemberLogsFinder,
    memberStatsComputer,
    teamBackupService,
    teammateToolTracker,
    branchStatusService,
    boardTaskActivityService,
    boardTaskActivityDetailService,
    boardTaskLogStreamService,
    boardTaskExactLogsService,
    boardTaskExactLogDetailService
  );
  initializeConfigHandlers({
    onClaudeRootPathUpdated: contextCallbacks.onClaudeRootPathUpdated,
    onAgentLanguageUpdated: (newLangCode) => {
      void teamProvisioningService.notifyLanguageChange(newLangCode);
    },
  });
  if (httpServerDeps) {
    initializeHttpServerHandlers(httpServerDeps.httpServer, httpServerDeps.startHttpServer);
  }
  if (cliInstaller) {
    initializeCliInstallerHandlers(cliInstaller);
  }
  if (ptyTerminal) {
    initializeTerminalHandlers(ptyTerminal);
  }
  initializeEditorHandlers();
  if (schedulerService) {
    initializeScheduleHandlers(schedulerService);
  }
  if (extensionFacade) {
    initializeExtensionHandlers(
      extensionFacade,
      pluginInstaller,
      mcpInstaller,
      apiKeyService,
      mcpHealthDiagnosticsService
    );
    initializeSkillsHandlers(skillsCatalogService, skillsMutationService, skillsWatcherService);
  }
  if (crossTeamService) {
    initializeCrossTeamHandlers(crossTeamService);
  }

  if (changeExtractor) {
    initializeReviewHandlers({
      extractor: changeExtractor,
      applier: reviewApplier ?? undefined,
      contentResolver: fileContentResolver ?? undefined,
      gitFallback: gitDiffFallback ?? undefined,
    });
  }

  // Register all handlers
  registerProjectHandlers(ipcMain);
  registerSessionHandlers(ipcMain);
  registerSearchHandlers(ipcMain);
  registerSubagentHandlers(ipcMain);
  registerValidationHandlers(ipcMain);
  registerUtilityHandlers(ipcMain);
  registerNotificationHandlers(ipcMain);
  registerConfigHandlers(ipcMain);
  registerUpdaterHandlers(ipcMain);
  registerSshHandlers(ipcMain);
  registerContextHandlers(ipcMain);
  registerTeamHandlers(ipcMain);
  registerReviewHandlers(ipcMain);
  registerEditorHandlers(ipcMain);
  registerWindowHandlers(ipcMain);
  registerRendererLogHandlers(ipcMain);
  registerScheduleHandlers(ipcMain);
  if (cliInstaller) {
    registerCliInstallerHandlers(ipcMain);
  }
  if (ptyTerminal) {
    registerTerminalHandlers(ipcMain);
  }
  registerTmuxHandlers(ipcMain);
  if (httpServerDeps) {
    registerHttpServerHandlers(ipcMain);
  }
  if (extensionFacade) {
    registerExtensionHandlers(ipcMain);
    registerSkillsHandlers(ipcMain);
  }
  if (crossTeamService) {
    registerCrossTeamHandlers(ipcMain);
  }

  logger.info('All handlers registered');
}

/**
 * Removes all IPC handlers.
 * Should be called when shutting down.
 */
export function removeIpcHandlers(): void {
  removeProjectHandlers(ipcMain);
  removeSessionHandlers(ipcMain);
  removeSearchHandlers(ipcMain);
  removeSubagentHandlers(ipcMain);
  removeValidationHandlers(ipcMain);
  removeUtilityHandlers(ipcMain);
  removeNotificationHandlers(ipcMain);
  removeConfigHandlers(ipcMain);
  removeUpdaterHandlers(ipcMain);
  removeSshHandlers(ipcMain);
  removeContextHandlers(ipcMain);
  removeTeamHandlers(ipcMain);
  removeReviewHandlers(ipcMain);
  removeEditorHandlers(ipcMain);
  removeWindowHandlers(ipcMain);
  removeRendererLogHandlers(ipcMain);
  removeScheduleHandlers(ipcMain);
  removeCliInstallerHandlers(ipcMain);
  removeTerminalHandlers(ipcMain);
  removeTmuxHandlers(ipcMain);
  removeHttpServerHandlers(ipcMain);
  removeExtensionHandlers(ipcMain);
  removeSkillsHandlers(ipcMain);
  removeCrossTeamHandlers(ipcMain);

  logger.info('All handlers removed');
}
