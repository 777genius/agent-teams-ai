import { WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL } from '@shared/constants';
import { contextBridge, ipcRenderer } from 'electron';

import {
  APP_RELAUNCH,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INSTALL,
  CLI_INSTALLER_PROGRESS,
  CONTEXT_CHANGED,
  CONTEXT_GET_ACTIVE,
  CONTEXT_LIST,
  CONTEXT_SWITCH,
  CROSS_TEAM_GET_OUTBOX,
  CROSS_TEAM_LIST_TARGETS,
  CROSS_TEAM_SEND,
  EDITOR_CHANGE,
  EDITOR_CLOSE,
  EDITOR_CREATE_DIR,
  EDITOR_CREATE_FILE,
  EDITOR_DELETE_FILE,
  EDITOR_GIT_STATUS,
  EDITOR_LIST_FILES,
  EDITOR_MOVE_FILE,
  EDITOR_OPEN,
  EDITOR_READ_BINARY_PREVIEW,
  EDITOR_READ_DIR,
  EDITOR_READ_FILE,
  EDITOR_RENAME_FILE,
  EDITOR_SEARCH_IN_FILES,
  EDITOR_SET_WATCHED_DIRS,
  EDITOR_SET_WATCHED_FILES,
  EDITOR_WATCH_DIR,
  EDITOR_WRITE_FILE,
  HTTP_SERVER_GET_STATUS,
  HTTP_SERVER_START,
  HTTP_SERVER_STOP,
  PROJECT_LIST_FILES,
  RENDERER_BOOT,
  RENDERER_HEARTBEAT,
  RENDERER_LOG,
  SCHEDULE_CHANGE,
  SCHEDULE_CREATE,
  SCHEDULE_DELETE,
  SCHEDULE_GET,
  SCHEDULE_GET_RUN_LOGS,
  SCHEDULE_GET_RUNS,
  SCHEDULE_LIST,
  SCHEDULE_PAUSE,
  SCHEDULE_RESUME,
  SCHEDULE_TRIGGER_NOW,
  SCHEDULE_UPDATE,
  REVIEW_APPLY_DECISIONS,
  REVIEW_CHECK_CONFLICT,
  REVIEW_CLEAR_DECISIONS,
  REVIEW_GET_AGENT_CHANGES,
  REVIEW_GET_CHANGE_STATS,
  REVIEW_GET_FILE_CONTENT,
  REVIEW_GET_GIT_FILE_LOG,
  REVIEW_GET_TASK_CHANGES,
  REVIEW_LOAD_DECISIONS,
  REVIEW_PREVIEW_REJECT,
  REVIEW_REJECT_FILE,
  REVIEW_REJECT_HUNKS,
  REVIEW_SAVE_DECISIONS,
  REVIEW_SAVE_EDITED_FILE,
  SSH_CONNECT,
  SSH_DISCONNECT,
  SSH_GET_CONFIG_HOSTS,
  SSH_GET_LAST_CONNECTION,
  SSH_GET_STATE,
  SSH_RESOLVE_HOST,
  SSH_SAVE_LAST_CONNECTION,
  SSH_STATUS,
  SSH_TEST,
  TEAM_ADD_MEMBER,
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CHANGE,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_DELETE_TEAM,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_DATA,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_LIST,
  TEAM_PERMANENTLY_DELETE,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_PROGRESS,
  TEAM_PROVISIONING_STATUS,
  TEAM_REMOVE_MEMBER,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REPLACE_MEMBERS,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE,
  TEAM_RESTORE_TASK,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_SEND_MESSAGE,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_STOP,
  TEAM_TOOL_APPROVAL_EVENT,
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_SETTINGS,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
  TEAM_VALIDATE_CLI_ARGS,
  TERMINAL_DATA,
  TERMINAL_EXIT,
  TERMINAL_KILL,
  TERMINAL_RESIZE,
  TERMINAL_SPAWN,
  TERMINAL_WRITE,
  UPDATER_CHECK,
  UPDATER_DOWNLOAD,
  UPDATER_INSTALL,
  UPDATER_STATUS,
  WINDOW_CLOSE,
  WINDOW_FULLSCREEN_CHANGED,
  WINDOW_IS_FULLSCREEN,
  WINDOW_IS_MAXIMIZED,
  WINDOW_MAXIMIZE,
  WINDOW_MINIMIZE,
  PLUGIN_GET_ALL,
  PLUGIN_GET_README,
  PLUGIN_INSTALL,
  PLUGIN_UNINSTALL,
  MCP_REGISTRY_SEARCH,
  MCP_REGISTRY_BROWSE,
  MCP_REGISTRY_GET_BY_ID,
  MCP_REGISTRY_GET_INSTALLED,
  MCP_REGISTRY_INSTALL,
  MCP_REGISTRY_UNINSTALL,
} from './constants/ipcChannels';
import {
  CONFIG_ADD_CUSTOM_PROJECT_PATH,
  CONFIG_ADD_IGNORE_REGEX,
  CONFIG_ADD_IGNORE_REPOSITORY,
  CONFIG_ADD_TRIGGER,
  CONFIG_CLEAR_SNOOZE,
  CONFIG_FIND_WSL_CLAUDE_ROOTS,
  CONFIG_GET,
  CONFIG_GET_CLAUDE_ROOT_INFO,
  CONFIG_GET_TRIGGERS,
  CONFIG_HIDE_SESSION,
  CONFIG_HIDE_SESSIONS,
  CONFIG_OPEN_IN_EDITOR,
  CONFIG_PIN_SESSION,
  CONFIG_REMOVE_CUSTOM_PROJECT_PATH,
  CONFIG_REMOVE_IGNORE_REGEX,
  CONFIG_REMOVE_IGNORE_REPOSITORY,
  CONFIG_REMOVE_TRIGGER,
  CONFIG_SELECT_CLAUDE_ROOT_FOLDER,
  CONFIG_SELECT_FOLDERS,
  CONFIG_SNOOZE,
  CONFIG_TEST_TRIGGER,
  CONFIG_UNHIDE_SESSION,
  CONFIG_UNHIDE_SESSIONS,
  CONFIG_UNPIN_SESSION,
  CONFIG_UPDATE,
  CONFIG_UPDATE_TRIGGER,
} from './constants/ipcChannels';

import type {
  AddMemberRequest,
  AgentChangeSet,
  AppConfig,
  ApplyReviewRequest,
  ApplyReviewResult,
  AttachmentFileData,
  ChangeStats,
  ClaudeRootFolderSelection,
  ClaudeRootInfo,
  CliInstallationStatus,
  CliInstallerProgress,
  CommentAttachmentPayload,
  ConflictCheckResult,
  ContextInfo,
  CreateScheduleInput,
  CreateTaskRequest,
  CrossTeamMessage,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  ElectronAPI,
  FileChangeWithContent,
  GlobalTask,
  HttpServerStatus,
  HunkDecision,
  IpcResult,
  KanbanColumnId,
  LeadContextUsage,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusEntry,
  NotificationTrigger,
  RejectResult,
  ReplaceMembersRequest,
  Schedule,
  ScheduleChangeEvent,
  ScheduleRun,
  SendMessageRequest,
  SendMessageResult,
  SessionsByIdsOptions,
  SessionsPaginationOptions,
  SnippetDiff,
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionStatus,
  SshLastConnection,
  TaskAttachmentMeta,
  TaskChangeSetV2,
  TaskComment,
  TeamChangeEvent,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamData,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMessageNotificationData,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamUpdateConfigRequest,
  ToolApprovalEvent,
  ToolApprovalSettings,
  TriggerTestResult,
  UpdateKanbanPatch,
  UpdateSchedulePatch,
  WslClaudeRootCandidate,
} from '@shared/types';
import type {
  EnrichedPlugin,
  InstalledMcpEntry,
  McpCatalogItem,
  McpInstallRequest,
  McpSearchResult,
  OperationResult,
  PluginInstallRequest,
} from '@shared/types/extensions';
import type {
  BinaryPreviewResult,
  CreateDirResponse,
  CreateFileResponse,
  DeleteFileResponse,
  EditorFileChangeEvent,
  GitStatusResult,
  MoveFileResponse,
  QuickOpenFile,
  ReadDirResult,
  ReadFileResult,
  SearchInFilesOptions,
  SearchInFilesResult,
  WriteFileResponse,
} from '@shared/types/editor';
import type { PtySpawnOptions } from '@shared/types/terminal';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

// =============================================================================
// IPC Result Types and Helpers
// =============================================================================

interface IpcFileChangePayload {
  type: 'add' | 'change' | 'unlink';
  path: string;
  projectId?: string;
  sessionId?: string;
  isSubagent: boolean;
}

/**
 * Type-safe IPC invoker for operations that return IpcResult<T>.
 * Throws an Error if the IPC call fails, otherwise returns the typed data.
 */
async function invokeIpcWithResult<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.success) {
    throw new Error(result.error ?? 'Unknown error');
  }
  return result.data as T;
}

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function shouldForwardConsoleText(text: string): boolean {
  return (
    text.startsWith('[Store:') ||
    text.startsWith('[Component:') ||
    text.startsWith('[IPC:') ||
    text.startsWith('[Service:') ||
    text.startsWith('[Perf:')
  );
}

function installRendererLogForwarding(): void {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]): void => {
    originalWarn(...args);
    try {
      const text = args.map(formatConsoleArg).join(' ').trim();
      if (!text || !shouldForwardConsoleText(text)) return;
      ipcRenderer.send(RENDERER_LOG, { level: 'warn', message: text });
    } catch {
      // ignore
    }
  };

  console.error = (...args: unknown[]): void => {
    originalError(...args);
    try {
      const text = args.map(formatConsoleArg).join(' ').trim();
      if (!text || !shouldForwardConsoleText(text)) return;
      ipcRenderer.send(RENDERER_LOG, { level: 'error', message: text });
    } catch {
      // ignore
    }
  };
}

installRendererLogForwarding();

// Signal that preload executed (helps diagnose "UI stuck" with no logs).
ipcRenderer.send(RENDERER_BOOT);

// Heartbeat to detect renderer thread stalls.
setInterval(() => {
  ipcRenderer.send(RENDERER_HEARTBEAT, Date.now());
}, 1000);

// Keep latest zoom factor cached even before renderer UI subscribes.
let currentZoomFactor = 1;
ipcRenderer.on(
  WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL,
  (_event: Electron.IpcRendererEvent, zoomFactor: unknown) => {
    if (typeof zoomFactor === 'number' && Number.isFinite(zoomFactor)) {
      currentZoomFactor = zoomFactor;
    }
  }
);

// =============================================================================
// Electron API Implementation
// =============================================================================

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const electronAPI: ElectronAPI = {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  getSessions: (projectId: string) => ipcRenderer.invoke('get-sessions', projectId),
  getSessionsPaginated: (
    projectId: string,
    cursor: string | null,
    limit?: number,
    options?: SessionsPaginationOptions
  ) => ipcRenderer.invoke('get-sessions-paginated', projectId, cursor, limit, options),
  searchSessions: (projectId: string, query: string, maxResults?: number) =>
    ipcRenderer.invoke('search-sessions', projectId, query, maxResults),
  searchAllProjects: (query: string, maxResults?: number) =>
    ipcRenderer.invoke('search-all-projects', query, maxResults),
  getSessionDetail: (projectId: string, sessionId: string, options?: { bypassCache?: boolean }) =>
    ipcRenderer.invoke('get-session-detail', projectId, sessionId, options),
  getSessionMetrics: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('get-session-metrics', projectId, sessionId),
  getWaterfallData: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('get-waterfall-data', projectId, sessionId),
  getSubagentDetail: (
    projectId: string,
    sessionId: string,
    subagentId: string,
    options?: { bypassCache?: boolean }
  ) => ipcRenderer.invoke('get-subagent-detail', projectId, sessionId, subagentId, options),
  getSessionGroups: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('get-session-groups', projectId, sessionId),
  getSessionsByIds: (projectId: string, sessionIds: string[], options?: SessionsByIdsOptions) =>
    ipcRenderer.invoke('get-sessions-by-ids', projectId, sessionIds, options),

  // Repository grouping (worktree support)
  getRepositoryGroups: () => ipcRenderer.invoke('get-repository-groups'),
  getWorktreeSessions: (worktreeId: string) =>
    ipcRenderer.invoke('get-worktree-sessions', worktreeId),

  // Validation methods
  validatePath: (relativePath: string, projectPath: string) =>
    ipcRenderer.invoke('validate-path', relativePath, projectPath),
  validateMentions: (mentions: { type: 'path'; value: string }[], projectPath: string) =>
    ipcRenderer.invoke('validate-mentions', mentions, projectPath),

  // CLAUDE.md reading methods
  readClaudeMdFiles: (projectRoot: string) =>
    ipcRenderer.invoke('read-claude-md-files', projectRoot),
  readDirectoryClaudeMd: (dirPath: string) =>
    ipcRenderer.invoke('read-directory-claude-md', dirPath),
  readMentionedFile: (absolutePath: string, projectRoot: string, maxTokens?: number) =>
    ipcRenderer.invoke('read-mentioned-file', absolutePath, projectRoot, maxTokens),

  // Agent config reading
  readAgentConfigs: (projectRoot: string) => ipcRenderer.invoke('read-agent-configs', projectRoot),

  // Notifications API
  notifications: {
    get: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('notifications:get', options),
    markRead: (id: string) => ipcRenderer.invoke('notifications:markRead', id),
    markAllRead: () => ipcRenderer.invoke('notifications:markAllRead'),
    delete: (id: string) => ipcRenderer.invoke('notifications:delete', id),
    clear: () => ipcRenderer.invoke('notifications:clear'),
    getUnreadCount: () => ipcRenderer.invoke('notifications:getUnreadCount'),
    onNew: (callback: (event: unknown, error: unknown) => void): (() => void) => {
      ipcRenderer.on(
        'notification:new',
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          'notification:new',
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
    onUpdated: (
      callback: (event: unknown, payload: { total: number; unreadCount: number }) => void
    ): (() => void) => {
      ipcRenderer.on(
        'notification:updated',
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          'notification:updated',
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
    onClicked: (callback: (event: unknown, data: unknown) => void): (() => void) => {
      ipcRenderer.on(
        'notification:clicked',
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          'notification:clicked',
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  },

  // Config API - uses typed helper to unwrap { success, data, error } responses
  config: {
    get: async (): Promise<AppConfig> => {
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    update: async (section: string, data: object): Promise<AppConfig> => {
      return invokeIpcWithResult<AppConfig>(CONFIG_UPDATE, section, data);
    },
    addIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_ADD_IGNORE_REGEX, pattern);
      // Re-fetch config after mutation
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    removeIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_REMOVE_IGNORE_REGEX, pattern);
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    addIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_ADD_IGNORE_REPOSITORY, repositoryId);
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    removeIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_REMOVE_IGNORE_REPOSITORY, repositoryId);
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    snooze: async (minutes: number): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_SNOOZE, minutes);
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    clearSnooze: async (): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_CLEAR_SNOOZE);
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    addTrigger: async (trigger: Omit<NotificationTrigger, 'isBuiltin'>): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_ADD_TRIGGER, trigger);
      // Return updated config
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    updateTrigger: async (
      triggerId: string,
      updates: Partial<NotificationTrigger>
    ): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_UPDATE_TRIGGER, triggerId, updates);
      // Return updated config
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    removeTrigger: async (triggerId: string): Promise<AppConfig> => {
      await invokeIpcWithResult<void>(CONFIG_REMOVE_TRIGGER, triggerId);
      // Return updated config
      return invokeIpcWithResult<AppConfig>(CONFIG_GET);
    },
    getTriggers: async (): Promise<NotificationTrigger[]> => {
      return invokeIpcWithResult<NotificationTrigger[]>(CONFIG_GET_TRIGGERS);
    },
    testTrigger: async (trigger: NotificationTrigger): Promise<TriggerTestResult> => {
      return invokeIpcWithResult<TriggerTestResult>(CONFIG_TEST_TRIGGER, trigger);
    },
    selectFolders: async (): Promise<string[]> => {
      return invokeIpcWithResult<string[]>(CONFIG_SELECT_FOLDERS);
    },
    selectClaudeRootFolder: async (): Promise<ClaudeRootFolderSelection | null> => {
      return invokeIpcWithResult<ClaudeRootFolderSelection | null>(
        CONFIG_SELECT_CLAUDE_ROOT_FOLDER
      );
    },
    getClaudeRootInfo: async (): Promise<ClaudeRootInfo> => {
      return invokeIpcWithResult<ClaudeRootInfo>(CONFIG_GET_CLAUDE_ROOT_INFO);
    },
    findWslClaudeRoots: async (): Promise<WslClaudeRootCandidate[]> => {
      return invokeIpcWithResult<WslClaudeRootCandidate[]>(CONFIG_FIND_WSL_CLAUDE_ROOTS);
    },
    openInEditor: async (): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_OPEN_IN_EDITOR);
    },
    pinSession: async (projectId: string, sessionId: string): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_PIN_SESSION, projectId, sessionId);
    },
    unpinSession: async (projectId: string, sessionId: string): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_UNPIN_SESSION, projectId, sessionId);
    },
    hideSession: async (projectId: string, sessionId: string): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_HIDE_SESSION, projectId, sessionId);
    },
    unhideSession: async (projectId: string, sessionId: string): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_UNHIDE_SESSION, projectId, sessionId);
    },
    hideSessions: async (projectId: string, sessionIds: string[]): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_HIDE_SESSIONS, projectId, sessionIds);
    },
    unhideSessions: async (projectId: string, sessionIds: string[]): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_UNHIDE_SESSIONS, projectId, sessionIds);
    },
    addCustomProjectPath: async (projectPath: string): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_ADD_CUSTOM_PROJECT_PATH, projectPath);
    },
    removeCustomProjectPath: async (projectPath: string): Promise<void> => {
      return invokeIpcWithResult<void>(CONFIG_REMOVE_CUSTOM_PROJECT_PATH, projectPath);
    },
  },

  // Deep link navigation
  session: {
    scrollToLine: (sessionId: string, lineNumber: number) =>
      ipcRenderer.invoke('session:scrollToLine', sessionId, lineNumber),
  },

  // Zoom factor sync (used for traffic-light-safe layout)
  getZoomFactor: async (): Promise<number> => currentZoomFactor,
  onZoomFactorChanged: (callback: (zoomFactor: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, zoomFactor: unknown): void => {
      if (typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor)) return;
      currentZoomFactor = zoomFactor;
      callback(zoomFactor);
    };
    ipcRenderer.on(WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, listener);
    return (): void => {
      ipcRenderer.removeListener(WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, listener);
    };
  },

  // File change events (real-time updates)
  onFileChange: (callback: (event: IpcFileChangePayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: IpcFileChangePayload): void =>
      callback(data);
    ipcRenderer.on('file-change', listener);
    return (): void => {
      ipcRenderer.removeListener('file-change', listener);
    };
  },

  // Shell operations
  openPath: (targetPath: string, projectRoot?: string, userSelectedFromDialog?: boolean) =>
    ipcRenderer.invoke('shell:openPath', targetPath, projectRoot, userSelectedFromDialog),
  showInFolder: (filePath: string) => ipcRenderer.invoke('shell:showInFolder', filePath),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Window controls (when title bar is hidden, e.g. Windows / Linux)
  windowControls: {
    minimize: () => ipcRenderer.invoke(WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(WINDOW_IS_MAXIMIZED) as Promise<boolean>,
    isFullScreen: () => ipcRenderer.invoke(WINDOW_IS_FULLSCREEN) as Promise<boolean>,
    relaunch: () => ipcRenderer.invoke(APP_RELAUNCH),
  },

  onFullScreenChange: (callback: (isFullScreen: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean): void =>
      callback(isFullScreen);
    ipcRenderer.on(WINDOW_FULLSCREEN_CHANGED, listener);
    return (): void => {
      ipcRenderer.removeListener(WINDOW_FULLSCREEN_CHANGED, listener);
    };
  },

  onTodoChange: (callback: (event: IpcFileChangePayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: IpcFileChangePayload): void =>
      callback(data);
    ipcRenderer.on('todo-change', listener);
    return (): void => {
      ipcRenderer.removeListener('todo-change', listener);
    };
  },

  // Updater API
  updater: {
    check: () => ipcRenderer.invoke(UPDATER_CHECK),
    download: () => ipcRenderer.invoke(UPDATER_DOWNLOAD),
    install: () => ipcRenderer.invoke(UPDATER_INSTALL),
    onStatus: (callback: (event: unknown, status: unknown) => void): (() => void) => {
      ipcRenderer.on(
        UPDATER_STATUS,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          UPDATER_STATUS,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  },

  // SSH API
  ssh: {
    connect: async (config: SshConnectionConfig): Promise<SshConnectionStatus> => {
      return invokeIpcWithResult<SshConnectionStatus>(SSH_CONNECT, config);
    },
    disconnect: async (): Promise<SshConnectionStatus> => {
      return invokeIpcWithResult<SshConnectionStatus>(SSH_DISCONNECT);
    },
    getState: async (): Promise<SshConnectionStatus> => {
      return invokeIpcWithResult<SshConnectionStatus>(SSH_GET_STATE);
    },
    test: async (config: SshConnectionConfig): Promise<{ success: boolean; error?: string }> => {
      return invokeIpcWithResult<{ success: boolean; error?: string }>(SSH_TEST, config);
    },
    getConfigHosts: async (): Promise<SshConfigHostEntry[]> => {
      return invokeIpcWithResult<SshConfigHostEntry[]>(SSH_GET_CONFIG_HOSTS);
    },
    resolveHost: async (alias: string): Promise<SshConfigHostEntry | null> => {
      return invokeIpcWithResult<SshConfigHostEntry | null>(SSH_RESOLVE_HOST, alias);
    },
    saveLastConnection: async (config: SshLastConnection): Promise<void> => {
      return invokeIpcWithResult<void>(SSH_SAVE_LAST_CONNECTION, config);
    },
    getLastConnection: async (): Promise<SshLastConnection | null> => {
      return invokeIpcWithResult<SshLastConnection | null>(SSH_GET_LAST_CONNECTION);
    },
    onStatus: (callback: (event: unknown, status: SshConnectionStatus) => void): (() => void) => {
      ipcRenderer.on(
        SSH_STATUS,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          SSH_STATUS,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  },

  // Context API
  context: {
    list: async (): Promise<ContextInfo[]> => {
      return invokeIpcWithResult<ContextInfo[]>(CONTEXT_LIST);
    },
    getActive: async (): Promise<string> => {
      return invokeIpcWithResult<string>(CONTEXT_GET_ACTIVE);
    },
    switch: async (contextId: string): Promise<{ contextId: string }> => {
      return invokeIpcWithResult<{ contextId: string }>(CONTEXT_SWITCH, contextId);
    },
    onChanged: (callback: (event: unknown, data: ContextInfo) => void): (() => void) => {
      ipcRenderer.on(
        CONTEXT_CHANGED,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          CONTEXT_CHANGED,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  },

  // HTTP Server API
  httpServer: {
    start: async (): Promise<HttpServerStatus> => {
      return invokeIpcWithResult<HttpServerStatus>(HTTP_SERVER_START);
    },
    stop: async (): Promise<HttpServerStatus> => {
      return invokeIpcWithResult<HttpServerStatus>(HTTP_SERVER_STOP);
    },
    getStatus: async (): Promise<HttpServerStatus> => {
      return invokeIpcWithResult<HttpServerStatus>(HTTP_SERVER_GET_STATUS);
    },
  },

  teams: {
    list: async () => {
      return invokeIpcWithResult<TeamSummary[]>(TEAM_LIST);
    },
    getData: async (teamName: string) => {
      return invokeIpcWithResult<TeamData>(TEAM_GET_DATA, teamName);
    },
    getClaudeLogs: async (teamName: string, query?: TeamClaudeLogsQuery) => {
      return invokeIpcWithResult<TeamClaudeLogsResponse>(TEAM_GET_CLAUDE_LOGS, teamName, query);
    },
    deleteTeam: async (teamName: string) => {
      return invokeIpcWithResult<void>(TEAM_DELETE_TEAM, teamName);
    },
    restoreTeam: async (teamName: string) => {
      return invokeIpcWithResult<void>(TEAM_RESTORE, teamName);
    },
    permanentlyDeleteTeam: async (teamName: string) => {
      return invokeIpcWithResult<void>(TEAM_PERMANENTLY_DELETE, teamName);
    },
    prepareProvisioning: async (cwd?: string) => {
      return invokeIpcWithResult<TeamProvisioningPrepareResult>(TEAM_PREPARE_PROVISIONING, cwd);
    },
    createTeam: async (request: TeamCreateRequest) => {
      return invokeIpcWithResult<TeamCreateResponse>(TEAM_CREATE, request);
    },
    launchTeam: async (request: TeamLaunchRequest) => {
      return invokeIpcWithResult<TeamLaunchResponse>(TEAM_LAUNCH, request);
    },
    getProvisioningStatus: async (runId: string) => {
      return invokeIpcWithResult<TeamProvisioningProgress>(TEAM_PROVISIONING_STATUS, runId);
    },
    cancelProvisioning: async (runId: string) => {
      return invokeIpcWithResult<void>(TEAM_CANCEL_PROVISIONING, runId);
    },
    sendMessage: async (teamName: string, request: SendMessageRequest) => {
      return invokeIpcWithResult<SendMessageResult>(TEAM_SEND_MESSAGE, teamName, request);
    },
    createTask: async (teamName: string, request: CreateTaskRequest) => {
      return invokeIpcWithResult<TeamTask>(TEAM_CREATE_TASK, teamName, request);
    },
    requestReview: async (teamName: string, taskId: string) => {
      return invokeIpcWithResult<void>(TEAM_REQUEST_REVIEW, teamName, taskId);
    },
    updateKanban: async (teamName: string, taskId: string, patch: UpdateKanbanPatch) => {
      return invokeIpcWithResult<void>(TEAM_UPDATE_KANBAN, teamName, taskId, patch);
    },
    updateKanbanColumnOrder: async (
      teamName: string,
      columnId: KanbanColumnId,
      orderedTaskIds: string[]
    ) => {
      return invokeIpcWithResult<void>(
        TEAM_UPDATE_KANBAN_COLUMN_ORDER,
        teamName,
        columnId,
        orderedTaskIds
      );
    },
    updateTaskStatus: async (teamName: string, taskId: string, status: TeamTaskStatus) => {
      return invokeIpcWithResult<void>(TEAM_UPDATE_TASK_STATUS, teamName, taskId, status);
    },
    updateTaskOwner: async (teamName: string, taskId: string, owner: string | null) => {
      return invokeIpcWithResult<void>(TEAM_UPDATE_TASK_OWNER, teamName, taskId, owner);
    },
    updateTaskFields: async (
      teamName: string,
      taskId: string,
      fields: { subject?: string; description?: string }
    ) => {
      return invokeIpcWithResult<void>(TEAM_UPDATE_TASK_FIELDS, teamName, taskId, fields);
    },
    startTask: async (teamName: string, taskId: string) => {
      return invokeIpcWithResult<{ notifiedOwner: boolean }>(TEAM_START_TASK, teamName, taskId);
    },
    processSend: async (teamName: string, message: string) => {
      return invokeIpcWithResult<void>(TEAM_PROCESS_SEND, teamName, message);
    },
    processAlive: async (teamName: string) => {
      return invokeIpcWithResult<boolean>(TEAM_PROCESS_ALIVE, teamName);
    },
    aliveList: async () => {
      return invokeIpcWithResult<string[]>(TEAM_ALIVE_LIST);
    },
    stop: async (teamName: string) => {
      return invokeIpcWithResult<void>(TEAM_STOP, teamName);
    },
    createConfig: async (request: TeamCreateConfigRequest) => {
      return invokeIpcWithResult<void>(TEAM_CREATE_CONFIG, request);
    },
    getMemberLogs: async (teamName: string, memberName: string) => {
      return invokeIpcWithResult<MemberLogSummary[]>(TEAM_GET_MEMBER_LOGS, teamName, memberName);
    },
    getLogsForTask: async (
      teamName: string,
      taskId: string,
      options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
      }
    ) => {
      return invokeIpcWithResult<MemberLogSummary[]>(
        TEAM_GET_LOGS_FOR_TASK,
        teamName,
        taskId,
        options
      );
    },
    getMemberStats: async (teamName: string, memberName: string) => {
      return invokeIpcWithResult<MemberFullStats>(TEAM_GET_MEMBER_STATS, teamName, memberName);
    },
    getAllTasks: async () => {
      return invokeIpcWithResult<GlobalTask[]>(TEAM_GET_ALL_TASKS);
    },
    updateConfig: async (teamName: string, updates: TeamUpdateConfigRequest) => {
      return invokeIpcWithResult<TeamConfig>(TEAM_UPDATE_CONFIG, teamName, updates);
    },
    addTaskComment: async (
      teamName: string,
      taskId: string,
      text: string,
      attachments?: CommentAttachmentPayload[]
    ) => {
      return invokeIpcWithResult<TaskComment>(
        TEAM_ADD_TASK_COMMENT,
        teamName,
        taskId,
        text,
        attachments
      );
    },
    addMember: async (teamName: string, request: AddMemberRequest) => {
      return invokeIpcWithResult<void>(TEAM_ADD_MEMBER, teamName, request);
    },
    replaceMembers: async (teamName: string, request: ReplaceMembersRequest) => {
      return invokeIpcWithResult<void>(TEAM_REPLACE_MEMBERS, teamName, request);
    },
    removeMember: async (teamName: string, memberName: string) => {
      return invokeIpcWithResult<void>(TEAM_REMOVE_MEMBER, teamName, memberName);
    },
    updateMemberRole: async (teamName: string, memberName: string, role: string | undefined) => {
      return invokeIpcWithResult<void>(TEAM_UPDATE_MEMBER_ROLE, teamName, memberName, role);
    },
    getProjectBranch: async (projectPath: string) => {
      return invokeIpcWithResult<string | null>(TEAM_GET_PROJECT_BRANCH, projectPath);
    },
    getAttachments: async (teamName: string, messageId: string) => {
      return invokeIpcWithResult<AttachmentFileData[]>(TEAM_GET_ATTACHMENTS, teamName, messageId);
    },
    killProcess: async (teamName: string, pid: number) => {
      return invokeIpcWithResult<void>(TEAM_KILL_PROCESS, teamName, pid);
    },
    getLeadActivity: async (teamName: string) => {
      const result = await invokeIpcWithResult<string>(TEAM_LEAD_ACTIVITY, teamName);
      return result as 'active' | 'idle' | 'offline';
    },
    getLeadContext: async (teamName: string) => {
      return invokeIpcWithResult<LeadContextUsage | null>(TEAM_LEAD_CONTEXT, teamName);
    },
    getMemberSpawnStatuses: async (teamName: string) => {
      return invokeIpcWithResult<Record<string, MemberSpawnStatusEntry>>(
        TEAM_MEMBER_SPAWN_STATUSES,
        teamName
      );
    },
    softDeleteTask: async (teamName: string, taskId: string) => {
      return invokeIpcWithResult<void>(TEAM_SOFT_DELETE_TASK, teamName, taskId);
    },
    restoreTask: async (teamName: string, taskId: string) => {
      return invokeIpcWithResult<void>(TEAM_RESTORE_TASK, teamName, taskId);
    },
    getDeletedTasks: async (teamName: string) => {
      return invokeIpcWithResult<TeamTask[]>(TEAM_GET_DELETED_TASKS, teamName);
    },
    setTaskClarification: async (
      teamName: string,
      taskId: string,
      value: 'lead' | 'user' | null
    ) => {
      return invokeIpcWithResult<void>(TEAM_SET_TASK_CLARIFICATION, teamName, taskId, value);
    },
    showMessageNotification: async (data: TeamMessageNotificationData) => {
      return invokeIpcWithResult<void>(TEAM_SHOW_MESSAGE_NOTIFICATION, data);
    },
    addTaskRelationship: async (
      teamName: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ) => {
      return invokeIpcWithResult<void>(
        TEAM_ADD_TASK_RELATIONSHIP,
        teamName,
        taskId,
        targetId,
        type
      );
    },
    removeTaskRelationship: async (
      teamName: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ) => {
      return invokeIpcWithResult<void>(
        TEAM_REMOVE_TASK_RELATIONSHIP,
        teamName,
        taskId,
        targetId,
        type
      );
    },
    saveTaskAttachment: async (
      teamName: string,
      taskId: string,
      attachmentId: string,
      filename: string,
      mimeType: string,
      base64Data: string
    ) => {
      return invokeIpcWithResult<TaskAttachmentMeta>(
        TEAM_SAVE_TASK_ATTACHMENT,
        teamName,
        taskId,
        attachmentId,
        filename,
        mimeType,
        base64Data
      );
    },
    getTaskAttachment: async (
      teamName: string,
      taskId: string,
      attachmentId: string,
      mimeType: string
    ) => {
      return invokeIpcWithResult<string | null>(
        TEAM_GET_TASK_ATTACHMENT,
        teamName,
        taskId,
        attachmentId,
        mimeType
      );
    },
    deleteTaskAttachment: async (
      teamName: string,
      taskId: string,
      attachmentId: string,
      mimeType: string
    ) => {
      return invokeIpcWithResult<void>(
        TEAM_DELETE_TASK_ATTACHMENT,
        teamName,
        taskId,
        attachmentId,
        mimeType
      );
    },
    onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void): (() => void) => {
      ipcRenderer.on(
        TEAM_CHANGE,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          TEAM_CHANGE,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
    onProvisioningProgress: (
      callback: (event: unknown, data: TeamProvisioningProgress) => void
    ): (() => void) => {
      ipcRenderer.on(
        TEAM_PROVISIONING_PROGRESS,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          TEAM_PROVISIONING_PROGRESS,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
    respondToToolApproval: async (
      teamName: string,
      runId: string,
      requestId: string,
      allow: boolean,
      message?: string
    ) => {
      return invokeIpcWithResult<void>(
        TEAM_TOOL_APPROVAL_RESPOND,
        teamName,
        runId,
        requestId,
        allow,
        message
      );
    },
    validateCliArgs: async (rawArgs: string) => {
      return invokeIpcWithResult<CliArgsValidationResult>(TEAM_VALIDATE_CLI_ARGS, rawArgs);
    },
    onToolApprovalEvent: (
      callback: (event: unknown, data: ToolApprovalEvent) => void
    ): (() => void) => {
      ipcRenderer.on(
        TEAM_TOOL_APPROVAL_EVENT,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          TEAM_TOOL_APPROVAL_EVENT,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
    updateToolApprovalSettings: async (settings: ToolApprovalSettings) => {
      return invokeIpcWithResult<void>(TEAM_TOOL_APPROVAL_SETTINGS, settings);
    },
  },
  crossTeam: {
    send: async (request: CrossTeamSendRequest) => {
      return invokeIpcWithResult<CrossTeamSendResult>(CROSS_TEAM_SEND, request);
    },
    listTargets: async (excludeTeam?: string) => {
      return invokeIpcWithResult<
        {
          teamName: string;
          displayName: string;
          description?: string;
          color?: string;
          leadName?: string;
          leadColor?: string;
        }[]
      >(CROSS_TEAM_LIST_TARGETS, excludeTeam);
    },
    getOutbox: async (teamName: string) => {
      return invokeIpcWithResult<CrossTeamMessage[]>(CROSS_TEAM_GET_OUTBOX, teamName);
    },
  },
  review: {
    getAgentChanges: async (teamName: string, memberName: string) => {
      return invokeIpcWithResult<AgentChangeSet>(REVIEW_GET_AGENT_CHANGES, teamName, memberName);
    },
    getTaskChanges: async (
      teamName: string,
      taskId: string,
      options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
      }
    ) => {
      return invokeIpcWithResult<TaskChangeSetV2>(
        REVIEW_GET_TASK_CHANGES,
        teamName,
        taskId,
        options
      );
    },
    getChangeStats: async (teamName: string, memberName: string) => {
      return invokeIpcWithResult<ChangeStats>(REVIEW_GET_CHANGE_STATS, teamName, memberName);
    },
    getFileContent: async (
      teamName: string,
      memberName: string | undefined,
      filePath: string,
      snippets: SnippetDiff[] = []
    ) => {
      return invokeIpcWithResult<FileChangeWithContent>(
        REVIEW_GET_FILE_CONTENT,
        teamName,
        memberName ?? '',
        filePath,
        snippets
      );
    },
    applyDecisions: async (request: ApplyReviewRequest) => {
      return invokeIpcWithResult<ApplyReviewResult>(REVIEW_APPLY_DECISIONS, request);
    },
    // Phase 2
    checkConflict: async (filePath: string, expectedModified: string) => {
      return invokeIpcWithResult<ConflictCheckResult>(
        REVIEW_CHECK_CONFLICT,
        filePath,
        expectedModified
      );
    },
    rejectHunks: async (
      filePath: string,
      original: string,
      modified: string,
      hunkIndices: number[],
      snippets: SnippetDiff[]
    ) => {
      return invokeIpcWithResult<RejectResult>(
        REVIEW_REJECT_HUNKS,
        filePath,
        original,
        modified,
        hunkIndices,
        snippets
      );
    },
    rejectFile: async (filePath: string, original: string, modified: string) => {
      return invokeIpcWithResult<RejectResult>(REVIEW_REJECT_FILE, filePath, original, modified);
    },
    previewReject: async (
      filePath: string,
      original: string,
      modified: string,
      hunkIndices: number[],
      snippets: SnippetDiff[]
    ) => {
      return invokeIpcWithResult<{ preview: string; hasConflicts: boolean }>(
        REVIEW_PREVIEW_REJECT,
        filePath,
        original,
        modified,
        hunkIndices,
        snippets
      );
    },
    // Editable diff
    saveEditedFile: async (filePath: string, content: string, projectPath?: string) => {
      return invokeIpcWithResult<{ success: boolean }>(
        REVIEW_SAVE_EDITED_FILE,
        filePath,
        content,
        projectPath
      );
    },
    // Decision persistence
    loadDecisions: async (teamName: string, scopeKey: string) => {
      return invokeIpcWithResult<{
        hunkDecisions: Record<string, HunkDecision>;
        fileDecisions: Record<string, HunkDecision>;
        hunkContextHashesByFile?: Record<string, Record<number, string>>;
      } | null>(REVIEW_LOAD_DECISIONS, teamName, scopeKey);
    },
    saveDecisions: async (
      teamName: string,
      scopeKey: string,
      hunkDecisions: Record<string, HunkDecision>,
      fileDecisions: Record<string, HunkDecision>,
      hunkContextHashesByFile?: Record<string, Record<number, string>>
    ) => {
      return invokeIpcWithResult<void>(
        REVIEW_SAVE_DECISIONS,
        teamName,
        scopeKey,
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile ?? null
      );
    },
    clearDecisions: async (teamName: string, scopeKey: string) => {
      return invokeIpcWithResult<void>(REVIEW_CLEAR_DECISIONS, teamName, scopeKey);
    },
    onCmdN: (callback: () => void): (() => void) => {
      const handler = (): void => callback();
      ipcRenderer.on('review:cmdN', handler);
      return (): void => {
        ipcRenderer.removeListener('review:cmdN', handler);
      };
    },
    // Phase 4
    getGitFileLog: async (projectPath: string, filePath: string) => {
      return invokeIpcWithResult<{ hash: string; timestamp: string; message: string }[]>(
        REVIEW_GET_GIT_FILE_LOG,
        projectPath,
        filePath
      );
    },
  },

  // ===== CLI Installer API =====
  cliInstaller: {
    getStatus: async (): Promise<CliInstallationStatus> => {
      return invokeIpcWithResult<CliInstallationStatus>(CLI_INSTALLER_GET_STATUS);
    },
    install: async (): Promise<void> => {
      return invokeIpcWithResult<void>(CLI_INSTALLER_INSTALL);
    },
    onProgress: (callback: (event: unknown, data: CliInstallerProgress) => void): (() => void) => {
      ipcRenderer.on(
        CLI_INSTALLER_PROGRESS,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          CLI_INSTALLER_PROGRESS,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  },

  // ===== Terminal API =====
  terminal: {
    spawn: (options?: PtySpawnOptions) => invokeIpcWithResult<string>(TERMINAL_SPAWN, options),
    write: (ptyId: string, data: string) => ipcRenderer.send(TERMINAL_WRITE, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number) =>
      ipcRenderer.send(TERMINAL_RESIZE, ptyId, cols, rows),
    kill: (ptyId: string) => ipcRenderer.send(TERMINAL_KILL, ptyId),
    onData: (cb: (event: unknown, ptyId: string, data: string) => void): (() => void) => {
      ipcRenderer.on(
        TERMINAL_DATA,
        cb as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          TERMINAL_DATA,
          cb as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
    onExit: (cb: (event: unknown, ptyId: string, exitCode: number) => void): (() => void) => {
      ipcRenderer.on(
        TERMINAL_EXIT,
        cb as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          TERMINAL_EXIT,
          cb as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  },

  // ===== Project API (editor-independent) =====
  project: {
    listFiles: (projectPath: string) =>
      invokeIpcWithResult<QuickOpenFile[]>(PROJECT_LIST_FILES, projectPath),
  },

  // ===== Editor API =====
  editor: {
    open: (projectPath: string) => invokeIpcWithResult<void>(EDITOR_OPEN, projectPath),
    close: () => invokeIpcWithResult<void>(EDITOR_CLOSE),
    readDir: (dirPath: string, maxEntries?: number) =>
      invokeIpcWithResult<ReadDirResult>(EDITOR_READ_DIR, dirPath, maxEntries),
    readFile: (filePath: string) => invokeIpcWithResult<ReadFileResult>(EDITOR_READ_FILE, filePath),
    writeFile: (filePath: string, content: string, baselineMtimeMs?: number) =>
      invokeIpcWithResult<WriteFileResponse>(EDITOR_WRITE_FILE, filePath, content, baselineMtimeMs),
    createFile: (parentDir: string, fileName: string) =>
      invokeIpcWithResult<CreateFileResponse>(EDITOR_CREATE_FILE, parentDir, fileName),
    createDir: (parentDir: string, dirName: string) =>
      invokeIpcWithResult<CreateDirResponse>(EDITOR_CREATE_DIR, parentDir, dirName),
    deleteFile: (filePath: string) =>
      invokeIpcWithResult<DeleteFileResponse>(EDITOR_DELETE_FILE, filePath),
    moveFile: (sourcePath: string, destDir: string) =>
      invokeIpcWithResult<MoveFileResponse>(EDITOR_MOVE_FILE, sourcePath, destDir),
    renameFile: (sourcePath: string, newName: string) =>
      invokeIpcWithResult<MoveFileResponse>(EDITOR_RENAME_FILE, sourcePath, newName),
    searchInFiles: (options: SearchInFilesOptions) =>
      invokeIpcWithResult<SearchInFilesResult>(EDITOR_SEARCH_IN_FILES, options),
    listFiles: () => invokeIpcWithResult<QuickOpenFile[]>(EDITOR_LIST_FILES),
    readBinaryPreview: (filePath: string) =>
      invokeIpcWithResult<BinaryPreviewResult>(EDITOR_READ_BINARY_PREVIEW, filePath),
    gitStatus: () => invokeIpcWithResult<GitStatusResult>(EDITOR_GIT_STATUS),
    watchDir: (enable: boolean) => invokeIpcWithResult<void>(EDITOR_WATCH_DIR, enable),
    setWatchedFiles: (filePaths: string[]) =>
      invokeIpcWithResult<void>(EDITOR_SET_WATCHED_FILES, filePaths),
    setWatchedDirs: (dirPaths: string[]) =>
      invokeIpcWithResult<void>(EDITOR_SET_WATCHED_DIRS, dirPaths),
    onEditorChange: (callback: (event: EditorFileChangeEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: EditorFileChangeEvent): void =>
        callback(data);
      ipcRenderer.on(EDITOR_CHANGE, listener);
      return (): void => {
        ipcRenderer.removeListener(EDITOR_CHANGE, listener);
      };
    },
  },

  schedules: {
    list: () => invokeIpcWithResult<Schedule[]>(SCHEDULE_LIST),
    get: (id: string) => invokeIpcWithResult<Schedule | null>(SCHEDULE_GET, id),
    create: (input: CreateScheduleInput) => invokeIpcWithResult<Schedule>(SCHEDULE_CREATE, input),
    update: (id: string, patch: UpdateSchedulePatch) =>
      invokeIpcWithResult<Schedule>(SCHEDULE_UPDATE, id, patch),
    delete: (id: string) => invokeIpcWithResult<void>(SCHEDULE_DELETE, id),
    pause: (id: string) => invokeIpcWithResult<void>(SCHEDULE_PAUSE, id),
    resume: (id: string) => invokeIpcWithResult<void>(SCHEDULE_RESUME, id),
    triggerNow: (id: string) => invokeIpcWithResult<ScheduleRun>(SCHEDULE_TRIGGER_NOW, id),
    getRuns: (scheduleId: string, opts?: { limit?: number; offset?: number }) =>
      invokeIpcWithResult<ScheduleRun[]>(SCHEDULE_GET_RUNS, scheduleId, opts),
    getRunLogs: (scheduleId: string, runId: string) =>
      invokeIpcWithResult<{ stdout: string; stderr: string }>(
        SCHEDULE_GET_RUN_LOGS,
        scheduleId,
        runId
      ),
    onScheduleChange: (
      callback: (event: unknown, data: ScheduleChangeEvent) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: ScheduleChangeEvent): void =>
        callback(null, data);
      ipcRenderer.on(SCHEDULE_CHANGE, listener);
      return (): void => {
        ipcRenderer.removeListener(SCHEDULE_CHANGE, listener);
      };
    },
  },

  // ===== Plugin Catalog API (Electron-only) =====
  plugins: {
    getAll: (projectPath?: string, forceRefresh?: boolean) =>
      invokeIpcWithResult<EnrichedPlugin[]>(PLUGIN_GET_ALL, projectPath, forceRefresh),
    getReadme: (pluginId: string) =>
      invokeIpcWithResult<string | null>(PLUGIN_GET_README, pluginId),
    install: (request: PluginInstallRequest) =>
      invokeIpcWithResult<OperationResult>(PLUGIN_INSTALL, request),
    uninstall: (pluginId: string, scope?: string, projectPath?: string) =>
      invokeIpcWithResult<OperationResult>(PLUGIN_UNINSTALL, pluginId, scope, projectPath),
  },

  // ===== MCP Registry API (Electron-only) =====
  mcpRegistry: {
    search: (query: string, limit?: number) =>
      invokeIpcWithResult<McpSearchResult>(MCP_REGISTRY_SEARCH, query, limit),
    browse: (cursor?: string, limit?: number) =>
      invokeIpcWithResult<{ servers: McpCatalogItem[]; nextCursor?: string }>(
        MCP_REGISTRY_BROWSE,
        cursor,
        limit
      ),
    getById: (registryId: string) =>
      invokeIpcWithResult<McpCatalogItem | null>(MCP_REGISTRY_GET_BY_ID, registryId),
    getInstalled: (projectPath?: string) =>
      invokeIpcWithResult<InstalledMcpEntry[]>(MCP_REGISTRY_GET_INSTALLED, projectPath),
    install: (request: McpInstallRequest) =>
      invokeIpcWithResult<OperationResult>(MCP_REGISTRY_INSTALL, request),
    uninstall: (name: string, scope?: string, projectPath?: string) =>
      invokeIpcWithResult<OperationResult>(MCP_REGISTRY_UNINSTALL, name, scope, projectPath),
  },
};

// Use contextBridge to securely expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
