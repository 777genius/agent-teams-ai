/**
 * HTTP-based implementation of ElectronAPI for browser mode.
 *
 * Replaces Electron IPC with fetch() for request/response and
 * EventSource (SSE) for real-time events. Allows the renderer
 * to run in a regular browser connected to an HTTP server.
 */

import type {
  AppConfig,
  AttachmentFileData,
  ClaudeMdFileInfo,
  ClaudeRootFolderSelection,
  ClaudeRootInfo,
  CliInstallerAPI,
  ConfigAPI,
  ContextInfo,
  ConversationGroup,
  CreateTaskRequest,
  CrossTeamAPI,
  ElectronAPI,
  FileChangeEvent,
  GlobalTask,
  HttpServerAPI,
  HttpServerStatus,
  KanbanColumnId,
  NotificationsAPI,
  NotificationTrigger,
  PaginatedSessionsResult,
  Project,
  RepositoryGroup,
  Schedule,
  ScheduleRun,
  SearchSessionsResult,
  SendMessageRequest,
  SendMessageResult,
  Session,
  SessionAPI,
  SessionDetail,
  SessionMetrics,
  SessionsByIdsOptions,
  SessionsPaginationOptions,
  SnippetDiff,
  SshAPI,
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionStatus,
  SshLastConnection,
  SubagentDetail,
  TeamChangeEvent,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamData,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamsAPI,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TriggerTestResult,
  UpdateKanbanPatch,
  UpdaterAPI,
  WaterfallData,
  WslClaudeRootCandidate,
} from '@shared/types';
import type { AgentConfig } from '@shared/types/api';
import type { EditorAPI, ProjectAPI } from '@shared/types/editor';
import type { TerminalAPI } from '@shared/types/terminal';

export class HttpAPIClient implements ElectronAPI {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event callbacks have varying signatures
  private eventListeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.initEventSource();
  }

  // ---------------------------------------------------------------------------
  // SSE event infrastructure
  // ---------------------------------------------------------------------------

  private initEventSource(): void {
    this.eventSource = new EventSource(`${this.baseUrl}/api/events`);
    this.eventSource.onopen = () => console.log('[HttpAPIClient] SSE connected');
    this.eventSource.onerror = () => {
      // Auto-reconnect is built into EventSource
      console.warn('[HttpAPIClient] SSE connection error, will reconnect...');
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event callbacks have varying signatures
  private addEventListener(channel: string, callback: (...args: any[]) => void): () => void {
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
      // Register SSE listener for this channel once
      this.eventSource?.addEventListener(channel, ((event: MessageEvent) => {
        const data: unknown = JSON.parse(event.data as string);
        const listeners = this.eventListeners.get(channel);
        listeners?.forEach((cb) => cb(data));
      }) as EventListener);
    }
    this.eventListeners.get(channel)!.add(callback);

    return () => {
      this.eventListeners.get(channel)?.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /**
   * JSON reviver that converts ISO 8601 date strings back to Date objects.
   * Electron IPC preserves Date instances via structured clone, but HTTP JSON
   * serialization turns them into strings. This restores them so that
   * `.getTime()` and other Date methods work in the renderer.
   */
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern with bounded quantifier; no backtracking risk
  private static readonly ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?$/;

  private static reviveDates(_key: string, value: unknown): unknown {
    if (typeof value === 'string' && HttpAPIClient.ISO_DATE_RE.test(value)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d;
    }
    return value;
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      const parsed = JSON.parse(text) as { error?: string };
      throw new Error(parsed.error ?? `HTTP ${res.status}`);
    }
    return JSON.parse(text, (key, value) => HttpAPIClient.reviveDates(key, value)) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async del<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async put<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------------------------------------------------------------------------
  // Core session/project APIs
  // ---------------------------------------------------------------------------

  getAppVersion = (): Promise<string> => this.get<string>('/api/version');

  getProjects = (): Promise<Project[]> => this.get<Project[]>('/api/projects');

  getSessions = (projectId: string): Promise<Session[]> =>
    this.get<Session[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);

  getSessionsPaginated = (
    projectId: string,
    cursor: string | null,
    limit?: number,
    options?: SessionsPaginationOptions
  ): Promise<PaginatedSessionsResult> => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    if (options?.includeTotalCount === false) params.set('includeTotalCount', 'false');
    if (options?.prefilterAll === false) params.set('prefilterAll', 'false');
    if (options?.metadataLevel) params.set('metadataLevel', options.metadataLevel);
    const qs = params.toString();
    const encodedId = encodeURIComponent(projectId);
    const path = `/api/projects/${encodedId}/sessions-paginated`;
    return this.get<PaginatedSessionsResult>(qs ? `${path}?${qs}` : path);
  };

  searchSessions = (
    projectId: string,
    query: string,
    maxResults?: number
  ): Promise<SearchSessionsResult> => {
    const params = new URLSearchParams({ q: query });
    if (maxResults) params.set('maxResults', String(maxResults));
    return this.get<SearchSessionsResult>(
      `/api/projects/${encodeURIComponent(projectId)}/search?${params}`
    );
  };

  searchAllProjects = (query: string, maxResults?: number): Promise<SearchSessionsResult> => {
    const params = new URLSearchParams({ q: query });
    if (maxResults) params.set('maxResults', String(maxResults));
    return this.get<SearchSessionsResult>(`/api/search?${params}`);
  };

  getSessionDetail = (
    projectId: string,
    sessionId: string,
    options?: { bypassCache?: boolean }
  ): Promise<SessionDetail | null> => {
    const params = new URLSearchParams();
    if (options?.bypassCache) params.set('bypassCache', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.get<SessionDetail | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`
    );
  };

  getSessionMetrics = (projectId: string, sessionId: string): Promise<SessionMetrics | null> =>
    this.get<SessionMetrics | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/metrics`
    );

  getWaterfallData = (projectId: string, sessionId: string): Promise<WaterfallData | null> =>
    this.get<WaterfallData | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/waterfall`
    );

  getSubagentDetail = (
    projectId: string,
    sessionId: string,
    subagentId: string,
    options?: { bypassCache?: boolean }
  ): Promise<SubagentDetail | null> => {
    const params = new URLSearchParams();
    if (options?.bypassCache) params.set('bypassCache', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.get<SubagentDetail | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}${suffix}`
    );
  };

  getSessionGroups = (projectId: string, sessionId: string): Promise<ConversationGroup[]> =>
    this.get<ConversationGroup[]>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/groups`
    );

  getSessionsByIds = (
    projectId: string,
    sessionIds: string[],
    options?: SessionsByIdsOptions
  ): Promise<Session[]> =>
    this.post<Session[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions-by-ids`, {
      sessionIds,
      metadataLevel: options?.metadataLevel,
    });

  // ---------------------------------------------------------------------------
  // Repository grouping
  // ---------------------------------------------------------------------------

  getRepositoryGroups = (): Promise<RepositoryGroup[]> =>
    this.get<RepositoryGroup[]>('/api/repository-groups');

  getWorktreeSessions = (worktreeId: string): Promise<Session[]> =>
    this.get<Session[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/sessions`);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  validatePath = (
    relativePath: string,
    projectPath: string
  ): Promise<{ exists: boolean; isDirectory?: boolean }> =>
    this.post<{ exists: boolean; isDirectory?: boolean }>('/api/validate/path', {
      relativePath,
      projectPath,
    });

  validateMentions = (
    mentions: { type: 'path'; value: string }[],
    projectPath: string
  ): Promise<Record<string, boolean>> =>
    this.post<Record<string, boolean>>('/api/validate/mentions', { mentions, projectPath });

  // ---------------------------------------------------------------------------
  // CLAUDE.md reading
  // ---------------------------------------------------------------------------

  readClaudeMdFiles = (projectRoot: string): Promise<Record<string, ClaudeMdFileInfo>> =>
    this.post<Record<string, ClaudeMdFileInfo>>('/api/read-claude-md', { projectRoot });

  readDirectoryClaudeMd = (dirPath: string): Promise<ClaudeMdFileInfo> =>
    this.post<ClaudeMdFileInfo>('/api/read-directory-claude-md', { dirPath });

  readMentionedFile = (
    absolutePath: string,
    projectRoot: string,
    maxTokens?: number
  ): Promise<ClaudeMdFileInfo | null> =>
    this.post<ClaudeMdFileInfo | null>('/api/read-mentioned-file', {
      absolutePath,
      projectRoot,
      maxTokens,
    });

  // ---------------------------------------------------------------------------
  // Agent config reading
  // ---------------------------------------------------------------------------

  readAgentConfigs = (projectRoot: string): Promise<Record<string, AgentConfig>> =>
    this.post<Record<string, AgentConfig>>('/api/read-agent-configs', { projectRoot });

  // ---------------------------------------------------------------------------
  // Notifications (nested API)
  // ---------------------------------------------------------------------------

  notifications: NotificationsAPI = {
    get: (options) =>
      this.get(
        `/api/notifications?${new URLSearchParams(
          options
            ? {
                limit: String(options.limit ?? 20),
                offset: String(options.offset ?? 0),
              }
            : {}
        )}`
      ),
    markRead: (id) => this.post(`/api/notifications/${encodeURIComponent(id)}/read`),
    markAllRead: () => this.post('/api/notifications/read-all'),
    delete: (id) => this.del(`/api/notifications/${encodeURIComponent(id)}`),
    clear: () => this.del('/api/notifications'),
    getUnreadCount: () => this.get('/api/notifications/unread-count'),
    testNotification: async () => ({
      success: false,
      error: 'Test notifications require Electron (not available in browser mode)',
    }),
    // IPC signature: (event: unknown, error: unknown) => void
    onNew: (callback) =>
      this.addEventListener('notification:new', (data: unknown) => callback(null, data)),
    // IPC signature: (event: unknown, payload: { total; unreadCount }) => void
    onUpdated: (callback) =>
      this.addEventListener('notification:updated', (data: unknown) =>
        callback(null, data as { total: number; unreadCount: number })
      ),
    // IPC signature: (event: unknown, data: unknown) => void
    onClicked: (callback) =>
      this.addEventListener('notification:clicked', (data: unknown) => callback(null, data)),
  };

  // ---------------------------------------------------------------------------
  // Config (nested API)
  // ---------------------------------------------------------------------------

  config: ConfigAPI = {
    get: async (): Promise<AppConfig> => {
      const result = await this.get<{ success: boolean; data?: AppConfig; error?: string }>(
        '/api/config'
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to get config');
      return result.data!;
    },
    update: async (section: string, data: object): Promise<AppConfig> => {
      const result = await this.post<{ success: boolean; data?: AppConfig; error?: string }>(
        '/api/config/update',
        { section, data }
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to update config');
      return result.data!;
    },
    addIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await this.post('/api/config/ignore-regex', { pattern });
      return this.config.get();
    },
    removeIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await this.del('/api/config/ignore-regex', { pattern });
      return this.config.get();
    },
    addIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await this.post('/api/config/ignore-repository', { repositoryId });
      return this.config.get();
    },
    removeIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await this.del('/api/config/ignore-repository', { repositoryId });
      return this.config.get();
    },
    snooze: async (minutes: number): Promise<AppConfig> => {
      await this.post('/api/config/snooze', { minutes });
      return this.config.get();
    },
    clearSnooze: async (): Promise<AppConfig> => {
      await this.post('/api/config/clear-snooze');
      return this.config.get();
    },
    addTrigger: async (trigger): Promise<AppConfig> => {
      await this.post('/api/config/triggers', trigger);
      return this.config.get();
    },
    updateTrigger: async (triggerId: string, updates): Promise<AppConfig> => {
      await this.put(`/api/config/triggers/${encodeURIComponent(triggerId)}`, updates);
      return this.config.get();
    },
    removeTrigger: async (triggerId: string): Promise<AppConfig> => {
      await this.del(`/api/config/triggers/${encodeURIComponent(triggerId)}`);
      return this.config.get();
    },
    getTriggers: async (): Promise<NotificationTrigger[]> => {
      const result = await this.get<{ success: boolean; data?: NotificationTrigger[] }>(
        '/api/config/triggers'
      );
      return result.data ?? [];
    },
    testTrigger: async (trigger: NotificationTrigger): Promise<TriggerTestResult> => {
      const result = await this.post<{
        success: boolean;
        data?: TriggerTestResult;
        error?: string;
      }>(`/api/config/triggers/${encodeURIComponent(trigger.id)}/test`, trigger);
      if (!result.success) throw new Error(result.error ?? 'Failed to test trigger');
      return result.data!;
    },
    selectFolders: async (): Promise<string[]> => {
      console.warn('[HttpAPIClient] selectFolders is not available in browser mode');
      return [];
    },
    selectClaudeRootFolder: async (): Promise<ClaudeRootFolderSelection | null> => {
      console.warn('[HttpAPIClient] selectClaudeRootFolder is not available in browser mode');
      return null;
    },
    getClaudeRootInfo: async (): Promise<ClaudeRootInfo> => {
      const config = await this.config.get();
      const fallbackPath = config.general.claudeRootPath ?? '~/.claude';
      return {
        defaultPath: fallbackPath,
        resolvedPath: fallbackPath,
        customPath: config.general.claudeRootPath,
      };
    },
    findWslClaudeRoots: async (): Promise<WslClaudeRootCandidate[]> => {
      console.warn('[HttpAPIClient] findWslClaudeRoots is not available in browser mode');
      return [];
    },
    openInEditor: async (): Promise<void> => {
      console.warn('[HttpAPIClient] openInEditor is not available in browser mode');
    },
    pinSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/pin-session', { projectId, sessionId }),
    unpinSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/unpin-session', { projectId, sessionId }),
    hideSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/hide-session', { projectId, sessionId }),
    unhideSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/unhide-session', { projectId, sessionId }),
    hideSessions: (projectId: string, sessionIds: string[]): Promise<void> =>
      this.post('/api/config/hide-sessions', { projectId, sessionIds }),
    unhideSessions: (projectId: string, sessionIds: string[]): Promise<void> =>
      this.post('/api/config/unhide-sessions', { projectId, sessionIds }),
    addCustomProjectPath: (projectPath: string): Promise<void> =>
      this.post('/api/config/add-custom-project-path', { projectPath }),
    removeCustomProjectPath: (projectPath: string): Promise<void> =>
      this.post('/api/config/remove-custom-project-path', { projectPath }),
  };

  // ---------------------------------------------------------------------------
  // Session navigation
  // ---------------------------------------------------------------------------

  session: SessionAPI = {
    scrollToLine: (sessionId: string, lineNumber: number): Promise<void> =>
      this.post('/api/session/scroll-to-line', { sessionId, lineNumber }),
  };

  // ---------------------------------------------------------------------------
  // Zoom (browser fallbacks)
  // ---------------------------------------------------------------------------

  getZoomFactor = async (): Promise<number> => 1.0;

  onZoomFactorChanged = (_callback: (zoomFactor: number) => void): (() => void) => {
    // No-op in browser mode — zoom is managed by the browser itself
    return () => {};
  };

  // ---------------------------------------------------------------------------
  // File change events (via SSE)
  // ---------------------------------------------------------------------------

  onFileChange = (callback: (event: FileChangeEvent) => void): (() => void) =>
    this.addEventListener('file-change', callback);

  onTodoChange = (callback: (event: FileChangeEvent) => void): (() => void) =>
    this.addEventListener('todo-change', callback);

  // ---------------------------------------------------------------------------
  // Shell operations (browser fallbacks)
  // ---------------------------------------------------------------------------

  openPath = async (
    _targetPath: string,
    _projectRoot?: string
  ): Promise<{ success: boolean; error?: string }> => {
    console.warn('[HttpAPIClient] openPath is not available in browser mode');
    return { success: false, error: 'Not available in browser mode' };
  };

  showInFolder = async (_filePath: string): Promise<void> => {
    console.warn('[HttpAPIClient] showInFolder is not available in browser mode');
  };

  openExternal = async (url: string): Promise<{ success: boolean; error?: string }> => {
    window.open(url, '_blank');
    return { success: true };
  };

  windowControls = {
    minimize: async (): Promise<void> => {},
    maximize: async (): Promise<void> => {},
    close: async (): Promise<void> => {},
    isMaximized: async (): Promise<boolean> => false,
    isFullScreen: async (): Promise<boolean> => false,
    relaunch: async (): Promise<void> => {},
  };

  onFullScreenChange =
    (_callback: (isFullScreen: boolean) => void): (() => void) =>
    () => {};

  // ---------------------------------------------------------------------------
  // Updater (browser no-ops)
  // ---------------------------------------------------------------------------

  updater: UpdaterAPI = {
    check: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    download: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    install: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    onStatus: (_callback): (() => void) => {
      return () => {};
    },
  };

  // ---------------------------------------------------------------------------
  // SSH
  // ---------------------------------------------------------------------------

  ssh: SshAPI = {
    connect: (config: SshConnectionConfig): Promise<SshConnectionStatus> =>
      this.post('/api/ssh/connect', config),
    disconnect: (): Promise<SshConnectionStatus> => this.post('/api/ssh/disconnect'),
    getState: (): Promise<SshConnectionStatus> => this.get('/api/ssh/state'),
    test: (config: SshConnectionConfig): Promise<{ success: boolean; error?: string }> =>
      this.post('/api/ssh/test', config),
    getConfigHosts: async (): Promise<SshConfigHostEntry[]> => {
      const result = await this.get<{ success: boolean; data?: SshConfigHostEntry[] }>(
        '/api/ssh/config-hosts'
      );
      return result.data ?? [];
    },
    resolveHost: async (alias: string): Promise<SshConfigHostEntry | null> => {
      const result = await this.post<{
        success: boolean;
        data?: SshConfigHostEntry | null;
      }>('/api/ssh/resolve-host', { alias });
      return result.data ?? null;
    },
    saveLastConnection: (config: SshLastConnection): Promise<void> =>
      this.post('/api/ssh/save-last-connection', config),
    getLastConnection: async (): Promise<SshLastConnection | null> => {
      const result = await this.get<{ success: boolean; data?: SshLastConnection | null }>(
        '/api/ssh/last-connection'
      );
      return result.data ?? null;
    },
    // IPC signature: (event: unknown, status: SshConnectionStatus) => void
    onStatus: (callback): (() => void) =>
      this.addEventListener('ssh:status', (data: unknown) =>
        callback(null, data as SshConnectionStatus)
      ),
  };

  // ---------------------------------------------------------------------------
  // Context API
  // ---------------------------------------------------------------------------

  context = {
    list: (): Promise<ContextInfo[]> => this.get<ContextInfo[]>('/api/contexts'),
    getActive: (): Promise<string> => this.get<string>('/api/contexts/active'),
    switch: (contextId: string): Promise<{ contextId: string }> =>
      this.post<{ contextId: string }>('/api/contexts/switch', { contextId }),
    onChanged: (callback: (event: unknown, data: ContextInfo) => void): (() => void) =>
      this.addEventListener('context:changed', (data: unknown) =>
        callback(null, data as ContextInfo)
      ),
  };

  // HTTP Server API — in browser mode, server is already running (we're using it)
  httpServer: HttpServerAPI = {
    start: (): Promise<HttpServerStatus> =>
      Promise.resolve({ running: true, port: parseInt(new URL(this.baseUrl).port, 10) }),
    stop: (): Promise<HttpServerStatus> => {
      console.warn('[HttpAPIClient] Cannot stop HTTP server from browser mode');
      return Promise.resolve({ running: true, port: parseInt(new URL(this.baseUrl).port, 10) });
    },
    getStatus: (): Promise<HttpServerStatus> =>
      Promise.resolve({ running: true, port: parseInt(new URL(this.baseUrl).port, 10) }),
  };

  teams: TeamsAPI = {
    list: async (): Promise<TeamSummary[]> => {
      console.warn('[HttpAPIClient] teams API is not available in browser mode');
      return [];
    },
    getData: async (_teamName: string): Promise<TeamData> => {
      throw new Error('Teams detail is not available in browser mode');
    },
    getTaskChangePresence: async (): Promise<
      Record<string, 'has_changes' | 'no_changes' | 'unknown'>
    > => {
      return {};
    },
    setChangePresenceTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    setToolActivityTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    getClaudeLogs: async (
      _teamName: string,
      _query?: TeamClaudeLogsQuery
    ): Promise<TeamClaudeLogsResponse> => {
      console.warn('[HttpAPIClient] getClaudeLogs is not available in browser mode');
      return { lines: [], total: 0, hasMore: false };
    },
    deleteTeam: async (_teamName: string): Promise<void> => {
      throw new Error('Team deletion is not available in browser mode');
    },
    restoreTeam: async (_teamName: string): Promise<void> => {
      throw new Error('Team restore is not available in browser mode');
    },
    permanentlyDeleteTeam: async (_teamName: string): Promise<void> => {
      throw new Error('Permanent team deletion is not available in browser mode');
    },
    getSavedRequest: async (_teamName: string): Promise<TeamCreateRequest | null> => {
      console.warn('[HttpAPIClient] getSavedRequest is not available in browser mode');
      return null;
    },
    deleteDraft: async (_teamName: string): Promise<void> => {
      throw new Error('Draft team deletion is not available in browser mode');
    },
    prepareProvisioning: async (_cwd?: string): Promise<TeamProvisioningPrepareResult> => {
      throw new Error('Team provisioning is not available in browser mode');
    },
    createTeam: async (_request: TeamCreateRequest): Promise<TeamCreateResponse> => {
      throw new Error('Team provisioning is not available in browser mode');
    },
    launchTeam: async (_request: TeamLaunchRequest): Promise<TeamLaunchResponse> => {
      throw new Error('Team launch is not available in browser mode');
    },
    getProvisioningStatus: async (_runId: string): Promise<TeamProvisioningProgress> => {
      throw new Error('Team provisioning is not available in browser mode');
    },
    cancelProvisioning: async (_runId: string): Promise<void> => {
      throw new Error('Team provisioning is not available in browser mode');
    },
    sendMessage: async (
      _teamName: string,
      _request: SendMessageRequest
    ): Promise<SendMessageResult> => {
      throw new Error('Team messaging is not available in browser mode');
    },
    getMessagesPage: async () => {
      return { messages: [], nextCursor: null, hasMore: false };
    },
    createTask: async (_teamName: string, _request: CreateTaskRequest): Promise<TeamTask> => {
      throw new Error('Team task creation is not available in browser mode');
    },
    requestReview: async (_teamName: string, _taskId: string): Promise<void> => {
      throw new Error('Team review is not available in browser mode');
    },
    updateKanban: async (
      _teamName: string,
      _taskId: string,
      _patch: UpdateKanbanPatch
    ): Promise<void> => {
      throw new Error('Team kanban is not available in browser mode');
    },
    updateKanbanColumnOrder: async (
      _teamName: string,
      _columnId: KanbanColumnId,
      _orderedTaskIds: string[]
    ): Promise<void> => {
      throw new Error('Team kanban column order is not available in browser mode');
    },
    updateTaskStatus: async (
      _teamName: string,
      _taskId: string,
      _status: TeamTaskStatus
    ): Promise<void> => {
      throw new Error('Team task status update is not available in browser mode');
    },
    updateTaskOwner: async (
      _teamName: string,
      _taskId: string,
      _owner: string | null
    ): Promise<void> => {
      throw new Error('Team task owner update is not available in browser mode');
    },
    updateTaskFields: async (
      _teamName: string,
      _taskId: string,
      _fields: { subject?: string; description?: string }
    ): Promise<void> => {
      throw new Error('Team task fields update is not available in browser mode');
    },
    startTask: async (_teamName: string, _taskId: string): Promise<{ notifiedOwner: boolean }> => {
      throw new Error('Team start task is not available in browser mode');
    },
    startTaskByUser: async (
      _teamName: string,
      _taskId: string
    ): Promise<{ notifiedOwner: boolean }> => {
      throw new Error('Team start task by user is not available in browser mode');
    },
    processSend: async (_teamName: string, _message: string): Promise<void> => {
      throw new Error('Team process communication is not available in browser mode');
    },
    processAlive: async (_teamName: string): Promise<boolean> => {
      return false;
    },
    aliveList: async (): Promise<string[]> => {
      return [];
    },
    stop: async (): Promise<void> => {
      throw new Error('Team stop is not available in browser mode');
    },
    createConfig: async (): Promise<void> => {
      throw new Error('Team config creation is not available in browser mode');
    },
    getMemberLogs: async () => {
      console.warn('[HttpAPIClient] getMemberLogs is not available in browser mode');
      return [];
    },
    getLogsForTask: async () => {
      return [];
    },
    getMemberStats: async () => {
      console.warn('[HttpAPIClient] getMemberStats is not available in browser mode');
      return {
        linesAdded: 0,
        linesRemoved: 0,
        filesTouched: [],
        fileStats: {},
        toolUsage: {},
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        tasksCompleted: 0,
        messageCount: 0,
        totalDurationMs: 0,
        sessionCount: 0,
        computedAt: new Date().toISOString(),
      };
    },
    getAllTasks: async (): Promise<GlobalTask[]> => {
      console.warn('[HttpAPIClient] getAllTasks is not available in browser mode');
      return [];
    },
    updateConfig: async () => {
      throw new Error('Team config update is not available in browser mode');
    },
    addTaskComment: async () => {
      throw new Error('Task comments are not available in browser mode');
    },
    addMember: async (): Promise<void> => {
      throw new Error('Team member management is not available in browser mode');
    },
    replaceMembers: async (): Promise<void> => {
      throw new Error('Team member management is not available in browser mode');
    },
    removeMember: async (): Promise<void> => {
      throw new Error('Team member management is not available in browser mode');
    },
    updateMemberRole: async (): Promise<void> => {
      throw new Error('Team member management is not available in browser mode');
    },
    getProjectBranch: async (_projectPath: string): Promise<string | null> => {
      return null;
    },
    setProjectBranchTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    getAttachments: async (
      _teamName: string,
      _messageId: string
    ): Promise<AttachmentFileData[]> => {
      return [];
    },
    killProcess: async (_teamName: string, _pid: number): Promise<void> => {
      // Not available via HTTP client — no-op
    },
    getLeadActivity: async (_teamName: string) => {
      return { state: 'offline' as const, runId: null };
    },
    getLeadContext: async () => {
      return { usage: null, runId: null };
    },
    getMemberSpawnStatuses: async () => {
      return { statuses: {}, runId: null };
    },
    softDeleteTask: async (_teamName: string, _taskId: string): Promise<void> => {
      // Not available via HTTP client — no-op
    },
    restoreTask: async (_teamName: string, _taskId: string): Promise<void> => {
      // Not available via HTTP client — no-op
    },
    getDeletedTasks: async (_teamName: string): Promise<TeamTask[]> => {
      return [];
    },
    setTaskClarification: async (
      _teamName: string,
      _taskId: string,
      _value: 'lead' | 'user' | null
    ): Promise<void> => {
      // Not available via HTTP client — no-op
    },
    showMessageNotification: async (): Promise<void> => {
      // Not available via HTTP client — native notifications require Electron
    },
    addTaskRelationship: async (
      _teamName: string,
      _taskId: string,
      _targetId: string,
      _type: 'blockedBy' | 'blocks' | 'related'
    ): Promise<void> => {
      throw new Error('Task relationships are not available in browser mode');
    },
    removeTaskRelationship: async (
      _teamName: string,
      _taskId: string,
      _targetId: string,
      _type: 'blockedBy' | 'blocks' | 'related'
    ): Promise<void> => {
      throw new Error('Task relationships are not available in browser mode');
    },
    saveTaskAttachment: async (
      _teamName: string,
      _taskId: string,
      _attachmentId: string,
      _filename: string,
      _mimeType: string,
      _base64Data: string
    ): Promise<never> => {
      throw new Error('Task attachments are not available in browser mode');
    },
    getTaskAttachment: async (
      _teamName: string,
      _taskId: string,
      _attachmentId: string,
      _mimeType: string
    ): Promise<string | null> => {
      return null;
    },
    deleteTaskAttachment: async (
      _teamName: string,
      _taskId: string,
      _attachmentId: string,
      _mimeType: string
    ): Promise<void> => {
      throw new Error('Task attachments are not available in browser mode');
    },
    onProjectBranchChange: (): (() => void) => {
      return () => {};
    },
    onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void): (() => void) => {
      return this.addEventListener('team-change', (data: unknown) =>
        callback(null, data as TeamChangeEvent)
      );
    },
    onProvisioningProgress: (
      _callback: (event: unknown, data: TeamProvisioningProgress) => void
    ): (() => void) => {
      return () => {};
    },
    respondToToolApproval: async (): Promise<void> => {
      throw new Error('Tool approval not available in browser mode');
    },
    validateCliArgs: async (): Promise<never> => {
      throw new Error('CLI args validation not available in browser mode');
    },
    onToolApprovalEvent: (): (() => void) => {
      return () => {};
    },
    updateToolApprovalSettings: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updateToolApprovalSettings is not available in browser mode');
    },
    readFileForToolApproval: async () => {
      throw new Error('Tool approval file read not available in browser mode');
    },
  };

  // Cross-team communication API stubs
  crossTeam: CrossTeamAPI = {
    send: async () => {
      throw new Error('Cross-team communication is not available in browser mode');
    },
    listTargets: async () => {
      console.warn('[HttpAPIClient] crossTeam.listTargets is not available in browser mode');
      return [];
    },
    getOutbox: async () => {
      console.warn('[HttpAPIClient] crossTeam.getOutbox is not available in browser mode');
      return [];
    },
  };

  // Review API stubs
  review = {
    getAgentChanges: async (_teamName: string, _memberName: string): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getTaskChanges: async (
      _teamName: string,
      _taskId: string,
      _options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
        stateBucket?: 'approved' | 'review' | 'completed' | 'active';
        summaryOnly?: boolean;
        forceFresh?: boolean;
      }
    ): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    invalidateTaskChangeSummaries: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getChangeStats: async (_teamName: string, _memberName: string): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getFileContent: async (
      _teamName: string,
      _memberName: string | undefined,
      _filePath: string,
      _snippets: SnippetDiff[] = []
    ): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    applyDecisions: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    // Phase 2 stubs
    checkConflict: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    rejectHunks: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    rejectFile: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    previewReject: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    // Editable diff stubs
    saveEditedFile: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    watchFiles: async (): Promise<never> => {
      throw new Error('Review file watching is not available in browser mode');
    },
    unwatchFiles: async (): Promise<never> => {
      throw new Error('Review file watching is not available in browser mode');
    },
    onExternalFileChange: (): (() => void) => {
      return () => {};
    },
    // Decision persistence stubs
    loadDecisions: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    saveDecisions: async (
      _teamName: string,
      _scopeKey: string,
      _hunkDecisions: Record<string, unknown>,
      _fileDecisions: Record<string, unknown>,
      _hunkContextHashesByFile?: Record<string, Record<number, string>>
    ): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    clearDecisions: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    // Phase 4 stubs
    getGitFileLog: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
  };

  // ---------------------------------------------------------------------------
  // CLI Installer (not available in browser mode)
  // ---------------------------------------------------------------------------

  cliInstaller: CliInstallerAPI = {
    getStatus: async () => ({
      installed: false,
      installedVersion: null,
      binaryPath: null,
      latestVersion: null,
      updateAvailable: false,
      authLoggedIn: false,
      authMethod: null,
    }),
    install: async (): Promise<void> => {
      console.warn('[HttpAPIClient] CLI installer not available in browser mode');
    },
    invalidateStatus: async (): Promise<void> => {},
    onProgress: (): (() => void) => {
      return () => {};
    },
  };

  // ---------------------------------------------------------------------------
  // Terminal (not available in browser mode)
  // ---------------------------------------------------------------------------

  terminal: TerminalAPI = {
    spawn: async (): Promise<string> => {
      throw new Error('Terminal not available in browser mode');
    },
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (): (() => void) => () => {},
    onExit: (): (() => void) => () => {},
  };

  // ---------------------------------------------------------------------------
  // Project (not available in browser mode)
  // ---------------------------------------------------------------------------

  project: ProjectAPI = {
    listFiles: async () => {
      throw new Error('Project API not available in browser mode');
    },
  };

  // ---------------------------------------------------------------------------
  // Editor (not available in browser mode)
  // ---------------------------------------------------------------------------

  editor: EditorAPI = {
    open: async () => {
      throw new Error('Editor not available in browser mode');
    },
    close: async () => {
      throw new Error('Editor not available in browser mode');
    },
    readDir: async () => {
      throw new Error('Editor not available in browser mode');
    },
    readFile: async () => {
      throw new Error('Editor not available in browser mode');
    },
    writeFile: async () => {
      throw new Error('Editor not available in browser mode');
    },
    createFile: async () => {
      throw new Error('Editor not available in browser mode');
    },
    createDir: async () => {
      throw new Error('Editor not available in browser mode');
    },
    deleteFile: async () => {
      throw new Error('Editor not available in browser mode');
    },
    moveFile: async () => {
      throw new Error('Editor not available in browser mode');
    },
    renameFile: async () => {
      throw new Error('Editor not available in browser mode');
    },
    searchInFiles: async () => {
      throw new Error('Editor not available in browser mode');
    },
    listFiles: async () => {
      throw new Error('Editor not available in browser mode');
    },
    readBinaryPreview: async () => {
      throw new Error('Editor not available in browser mode');
    },
    gitStatus: async () => {
      throw new Error('Editor not available in browser mode');
    },
    watchDir: async () => {
      throw new Error('Editor not available in browser mode');
    },
    setWatchedFiles: async () => {
      throw new Error('Editor not available in browser mode');
    },
    setWatchedDirs: async () => {
      throw new Error('Editor not available in browser mode');
    },
    onEditorChange: () => {
      return () => {};
    },
  };

  schedules = {
    list: async () => {
      console.warn('Schedules not available in browser mode');
      return [] as Schedule[];
    },
    get: async () => {
      console.warn('Schedules not available in browser mode');
      return null;
    },
    create: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    update: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    delete: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    pause: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    resume: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    triggerNow: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    getRuns: async () => {
      console.warn('Schedules not available in browser mode');
      return [] as ScheduleRun[];
    },
    getRunLogs: async () => {
      console.warn('Schedules not available in browser mode');
      return { stdout: '', stderr: '' };
    },
    onScheduleChange: () => {
      return () => {};
    },
  };

  getPathForFile = (_file: File): string => '';
}
