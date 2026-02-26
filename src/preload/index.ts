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
  HTTP_SERVER_GET_STATUS,
  HTTP_SERVER_START,
  HTTP_SERVER_STOP,
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
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CHANGE,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TEAM,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_DATA,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
  TEAM_LEAD_ACTIVITY,
  TEAM_LIST,
  TEAM_PERMANENTLY_DELETE,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_PROGRESS,
  TEAM_PROVISIONING_STATUS,
  TEAM_REMOVE_MEMBER,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE,
  TEAM_RESTORE_TASK,
  TEAM_SEND_MESSAGE,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_STOP,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
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
} from './constants/ipcChannels';
import {
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
  ConflictCheckResult,
  ContextInfo,
  CreateTaskRequest,
  ElectronAPI,
  FileChangeWithContent,
  GlobalTask,
  HttpServerStatus,
  HunkDecision,
  IpcResult,
  KanbanColumnId,
  MemberFullStats,
  MemberLogSummary,
  NotificationTrigger,
  RejectResult,
  SendMessageRequest,
  SendMessageResult,
  SessionsByIdsOptions,
  SessionsPaginationOptions,
  SnippetDiff,
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionStatus,
  SshLastConnection,
  TaskChangeSetV2,
  TaskComment,
  TeamChangeEvent,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamData,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamUpdateConfigRequest,
  TriggerTestResult,
  UpdateKanbanPatch,
  WslClaudeRootCandidate,
} from '@shared/types';

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
  getSessionDetail: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('get-session-detail', projectId, sessionId),
  getSessionMetrics: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('get-session-metrics', projectId, sessionId),
  getWaterfallData: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('get-waterfall-data', projectId, sessionId),
  getSubagentDetail: (projectId: string, sessionId: string, subagentId: string) =>
    ipcRenderer.invoke('get-subagent-detail', projectId, sessionId, subagentId),
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
      options?: { owner?: string; status?: string }
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
    addTaskComment: async (teamName: string, taskId: string, text: string) => {
      return invokeIpcWithResult<TaskComment>(TEAM_ADD_TASK_COMMENT, teamName, taskId, text);
    },
    addMember: async (teamName: string, request: AddMemberRequest) => {
      return invokeIpcWithResult<void>(TEAM_ADD_MEMBER, teamName, request);
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
  },

  // ===== Review API =====
  review: {
    getAgentChanges: async (teamName: string, memberName: string) => {
      return invokeIpcWithResult<AgentChangeSet>(REVIEW_GET_AGENT_CHANGES, teamName, memberName);
    },
    getTaskChanges: async (teamName: string, taskId: string) => {
      return invokeIpcWithResult<TaskChangeSetV2>(REVIEW_GET_TASK_CHANGES, teamName, taskId);
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
    saveEditedFile: async (filePath: string, content: string) => {
      return invokeIpcWithResult<{ success: boolean }>(REVIEW_SAVE_EDITED_FILE, filePath, content);
    },
    // Decision persistence
    loadDecisions: async (teamName: string, scopeKey: string) => {
      return invokeIpcWithResult<{
        hunkDecisions: Record<string, HunkDecision>;
        fileDecisions: Record<string, HunkDecision>;
      } | null>(REVIEW_LOAD_DECISIONS, teamName, scopeKey);
    },
    saveDecisions: async (
      teamName: string,
      scopeKey: string,
      hunkDecisions: Record<string, HunkDecision>,
      fileDecisions: Record<string, HunkDecision>
    ) => {
      return invokeIpcWithResult<void>(
        REVIEW_SAVE_DECISIONS,
        teamName,
        scopeKey,
        hunkDecisions,
        fileDecisions
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
};

// Use contextBridge to securely expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
