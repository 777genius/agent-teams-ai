/**
 * IPC API type definitions for Electron preload bridge.
 *
 * These types define the interface exposed to the renderer process
 * via contextBridge. The actual implementation lives in src/preload/index.ts.
 *
 * Shared between preload and renderer processes.
 */

import type { CliArgsValidationResult } from '../utils/cliArgsParser';
import type { CliInstallerAPI } from './cliInstaller';
import type { EditorAPI, EditorFileChangeEvent, ProjectAPI } from './editor';
import type { ApiKeysAPI, McpCatalogAPI, PluginCatalogAPI, SkillsCatalogAPI } from './extensions';
import type {
  AppConfig,
  DetectedError,
  NotificationTrigger,
  TriggerTestResult,
} from './notifications';
import type {
  AgentChangeSet,
  ApplyReviewRequest,
  ApplyReviewResult,
  ChangeStats,
  ConflictCheckResult,
  FileChangeWithContent,
  HunkDecision,
  RejectResult,
  SnippetDiff,
  TaskChangeSetV2,
} from './review';
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleChangeEvent,
  ScheduleRun,
  UpdateSchedulePatch,
} from './schedule';
import type {
  AddMemberRequest,
  AddTaskCommentRequest,
  AttachmentFileData,
  CreateTaskRequest,
  CrossTeamMessage,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  GlobalTask,
  KanbanColumnId,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusesSnapshot,
  ProjectBranchChangeEvent,
  ReplaceMembersRequest,
  SendMessageRequest,
  SendMessageResult,
  TaskAttachmentMeta,
  TaskChangePresenceState,
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
  ToolApprovalFileContent,
  ToolApprovalSettings,
  UpdateKanbanPatch,
} from './team';
import type { TerminalAPI } from './terminal';
import type { WaterfallData } from './visualization';
import type {
  ConversationGroup,
  FileChangeEvent,
  PaginatedSessionsResult,
  Project,
  RepositoryGroup,
  SearchSessionsResult,
  Session,
  SessionDetail,
  SessionMetrics,
  SessionsByIdsOptions,
  SessionsPaginationOptions,
  SubagentDetail,
} from '@main/types';

// =============================================================================
// Cost Calculation Types
// =============================================================================

/**
 * Detailed cost breakdown by token type for a session or chunk
 */
export interface CostBreakdown {
  /** Cost for input tokens */
  inputCost: number;
  /** Cost for output tokens */
  outputCost: number;
  /** Cost for cache creation tokens */
  cacheCreationCost: number;
  /** Cost for cache read tokens */
  cacheReadCost: number;
  /** Total cost (sum of all components) */
  totalCost: number;
  /** Model name used for calculation */
  model: string;
  /** Source of the cost data */
  source: 'calculated' | 'precalculated' | 'unavailable';
}

// =============================================================================
// Agent Config
// =============================================================================

export interface AgentConfig {
  name: string;
  color?: string;
}

// =============================================================================
// Notifications API
// =============================================================================

/**
 * Result of notifications:get with pagination.
 */
interface NotificationsResult {
  notifications: DetectedError[];
  total: number;
  totalCount: number;
  unreadCount: number;
  hasMore: boolean;
}

/**
 * Notifications API exposed via preload.
 * Note: Event callbacks use `unknown` types because IPC data cannot be typed at the preload layer.
 * Consumers should cast to DetectedError or NotificationClickData as appropriate.
 */
export interface NotificationsAPI {
  get: (options?: { limit?: number; offset?: number }) => Promise<NotificationsResult>;
  markRead: (id: string) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
  delete: (id: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
  getUnreadCount: () => Promise<number>;
  testNotification: () => Promise<{ success: boolean; error?: string }>;
  onNew: (callback: (event: unknown, error: unknown) => void) => () => void;
  onUpdated: (
    callback: (event: unknown, payload: { total: number; unreadCount: number }) => void
  ) => () => void;
  onClicked: (callback: (event: unknown, data: unknown) => void) => () => void;
}

// =============================================================================
// Config API
// =============================================================================

/**
 * Config API exposed via preload.
 */
export interface ConfigAPI {
  get: () => Promise<AppConfig>;
  update: (section: string, data: object) => Promise<AppConfig>;
  addIgnoreRegex: (pattern: string) => Promise<AppConfig>;
  removeIgnoreRegex: (pattern: string) => Promise<AppConfig>;
  addIgnoreRepository: (repositoryId: string) => Promise<AppConfig>;
  removeIgnoreRepository: (repositoryId: string) => Promise<AppConfig>;
  snooze: (minutes: number) => Promise<AppConfig>;
  clearSnooze: () => Promise<AppConfig>;
  // Trigger management methods
  addTrigger: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<AppConfig>;
  updateTrigger: (triggerId: string, updates: Partial<NotificationTrigger>) => Promise<AppConfig>;
  removeTrigger: (triggerId: string) => Promise<AppConfig>;
  getTriggers: () => Promise<NotificationTrigger[]>;
  testTrigger: (trigger: NotificationTrigger) => Promise<TriggerTestResult>;
  /** Opens native folder selection dialog and returns selected paths */
  selectFolders: () => Promise<string[]>;
  /** Open native dialog to select local Claude root folder */
  selectClaudeRootFolder: () => Promise<ClaudeRootFolderSelection | null>;
  /** Get resolved Claude root path info for local mode */
  getClaudeRootInfo: () => Promise<ClaudeRootInfo>;
  /** Find Windows WSL Claude root candidates (UNC paths) */
  findWslClaudeRoots: () => Promise<WslClaudeRootCandidate[]>;
  /** Opens the config JSON file in an external editor */
  openInEditor: () => Promise<void>;
  /** Pin a session for a project */
  pinSession: (projectId: string, sessionId: string) => Promise<void>;
  /** Unpin a session for a project */
  unpinSession: (projectId: string, sessionId: string) => Promise<void>;
  /** Hide a session for a project */
  hideSession: (projectId: string, sessionId: string) => Promise<void>;
  /** Unhide a session for a project */
  unhideSession: (projectId: string, sessionId: string) => Promise<void>;
  /** Bulk hide sessions for a project */
  hideSessions: (projectId: string, sessionIds: string[]) => Promise<void>;
  /** Bulk unhide sessions for a project */
  unhideSessions: (projectId: string, sessionIds: string[]) => Promise<void>;
  /** Add a custom project path (persisted across restarts) */
  addCustomProjectPath: (projectPath: string) => Promise<void>;
  /** Remove a custom project path */
  removeCustomProjectPath: (projectPath: string) => Promise<void>;
}

export interface ClaudeRootInfo {
  /** Auto-detected default Claude root path for this machine */
  defaultPath: string;
  /** Effective path currently used by local context */
  resolvedPath: string;
  /** Custom override path from settings (null means auto-detect) */
  customPath: string | null;
}

export interface ClaudeRootFolderSelection {
  /** Selected directory absolute path */
  path: string;
  /** Whether the selected folder name is exactly ".claude" */
  isClaudeDirName: boolean;
  /** Whether selected folder contains a "projects" directory */
  hasProjectsDir: boolean;
}

export interface WslClaudeRootCandidate {
  /** WSL distribution name (e.g. Ubuntu) */
  distro: string;
  /** Candidate Claude root path in UNC format */
  path: string;
  /** True if this root contains "projects" directory */
  hasProjectsDir: boolean;
}

// =============================================================================
// Session API
// =============================================================================

/**
 * Session navigation API exposed via preload.
 */
export interface SessionAPI {
  scrollToLine: (sessionId: string, lineNumber: number) => Promise<void>;
}

// =============================================================================
// CLAUDE.md File Info
// =============================================================================

/**
 * CLAUDE.md file information returned from reading operations.
 */
export interface ClaudeMdFileInfo {
  path: string;
  exists: boolean;
  charCount: number;
  estimatedTokens: number;
}

// =============================================================================
// Updater API
// =============================================================================

/**
 * Status payload sent from the main process updater to the renderer.
 */
export interface UpdaterStatus {
  type: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  releaseNotes?: string;
  progress?: { percent: number; transferred: number; total: number };
  error?: string;
}

/**
 * Updater API exposed via preload.
 */
export interface UpdaterAPI {
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  onStatus: (callback: (event: unknown, status: unknown) => void) => () => void;
}

// =============================================================================
// Context API
// =============================================================================

/**
 * Context information for listing available contexts.
 */
export interface ContextInfo {
  id: string;
  type: 'local' | 'ssh';
}

// =============================================================================
// SSH API
// =============================================================================

/**
 * SSH connection state.
 */
export type SshConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * SSH authentication method.
 */
export type SshAuthMethod = 'password' | 'privateKey' | 'agent' | 'auto';

/**
 * SSH config host entry resolved from ~/.ssh/config.
 */
export interface SshConfigHostEntry {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  hasIdentityFile: boolean;
}

/**
 * SSH connection configuration sent from renderer.
 */
export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
}

/**
 * Saved SSH connection profile (no password stored).
 */
export interface SshConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
}

/**
 * SSH connection status returned from main process.
 */
export interface SshConnectionStatus {
  state: SshConnectionState;
  host: string | null;
  error: string | null;
  remoteProjectsPath: string | null;
}

/**
 * SSH API exposed via preload.
 */
/**
 * Saved SSH connection config (no password).
 */
export interface SshLastConnection {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
}

export interface SshAPI {
  connect: (config: SshConnectionConfig) => Promise<SshConnectionStatus>;
  disconnect: () => Promise<SshConnectionStatus>;
  getState: () => Promise<SshConnectionStatus>;
  test: (config: SshConnectionConfig) => Promise<{ success: boolean; error?: string }>;
  getConfigHosts: () => Promise<SshConfigHostEntry[]>;
  resolveHost: (alias: string) => Promise<SshConfigHostEntry | null>;
  saveLastConnection: (config: SshLastConnection) => Promise<void>;
  getLastConnection: () => Promise<SshLastConnection | null>;
  onStatus: (callback: (event: unknown, status: SshConnectionStatus) => void) => () => void;
}

// =============================================================================
// HTTP Server API
// =============================================================================

/**
 * HTTP server status returned from main process.
 */
export interface HttpServerStatus {
  running: boolean;
  port: number;
}

/**
 * HTTP Server API for controlling the sidecar server.
 */
export interface HttpServerAPI {
  start: () => Promise<HttpServerStatus>;
  stop: () => Promise<HttpServerStatus>;
  getStatus: () => Promise<HttpServerStatus>;
}

// =============================================================================
// Teams API
// =============================================================================

export interface TeamsAPI {
  list: () => Promise<TeamSummary[]>;
  getData: (teamName: string) => Promise<TeamData>;
  getTaskChangePresence: (teamName: string) => Promise<Record<string, TaskChangePresenceState>>;
  setChangePresenceTracking: (teamName: string, enabled: boolean) => Promise<void>;
  setToolActivityTracking: (teamName: string, enabled: boolean) => Promise<void>;
  getClaudeLogs: (teamName: string, query?: TeamClaudeLogsQuery) => Promise<TeamClaudeLogsResponse>;
  deleteTeam: (teamName: string) => Promise<void>;
  restoreTeam: (teamName: string) => Promise<void>;
  permanentlyDeleteTeam: (teamName: string) => Promise<void>;
  getSavedRequest: (teamName: string) => Promise<TeamCreateRequest | null>;
  deleteDraft: (teamName: string) => Promise<void>;
  prepareProvisioning: (
    cwd?: string,
    providerId?: TeamLaunchRequest['providerId'],
    providerIds?: TeamLaunchRequest['providerId'][]
  ) => Promise<TeamProvisioningPrepareResult>;
  createTeam: (request: TeamCreateRequest) => Promise<TeamCreateResponse>;
  getProvisioningStatus: (runId: string) => Promise<TeamProvisioningProgress>;
  cancelProvisioning: (runId: string) => Promise<void>;
  sendMessage: (teamName: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  createTask: (teamName: string, request: CreateTaskRequest) => Promise<TeamTask>;
  requestReview: (teamName: string, taskId: string) => Promise<void>;
  updateKanban: (teamName: string, taskId: string, patch: UpdateKanbanPatch) => Promise<void>;
  updateKanbanColumnOrder: (
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ) => Promise<void>;
  updateTaskStatus: (teamName: string, taskId: string, status: TeamTaskStatus) => Promise<void>;
  updateTaskOwner: (teamName: string, taskId: string, owner: string | null) => Promise<void>;
  updateTaskFields: (
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ) => Promise<void>;
  startTask: (teamName: string, taskId: string) => Promise<{ notifiedOwner: boolean }>;
  startTaskByUser: (teamName: string, taskId: string) => Promise<{ notifiedOwner: boolean }>;
  processSend: (teamName: string, message: string) => Promise<void>;
  processAlive: (teamName: string) => Promise<boolean>;
  aliveList: () => Promise<string[]>;
  stop: (teamName: string) => Promise<void>;
  createConfig: (request: TeamCreateConfigRequest) => Promise<void>;
  getMemberLogs: (teamName: string, memberName: string) => Promise<MemberLogSummary[]>;
  getLogsForTask: (
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      /** Persisted work intervals (preferred for reliable owner-log attribution). */
      intervals?: { startedAt: string; completedAt?: string }[];
      /** Back-compat: single since timestamp (deprecated). */
      since?: string;
    }
  ) => Promise<MemberLogSummary[]>;
  getMemberStats: (teamName: string, memberName: string) => Promise<MemberFullStats>;
  launchTeam: (request: TeamLaunchRequest) => Promise<TeamLaunchResponse>;
  getAllTasks: () => Promise<GlobalTask[]>;
  updateConfig: (teamName: string, updates: TeamUpdateConfigRequest) => Promise<TeamConfig>;
  addMember: (teamName: string, request: AddMemberRequest) => Promise<void>;
  replaceMembers: (teamName: string, request: ReplaceMembersRequest) => Promise<void>;
  removeMember: (teamName: string, memberName: string) => Promise<void>;
  updateMemberRole: (
    teamName: string,
    memberName: string,
    role: string | undefined
  ) => Promise<void>;
  addTaskComment: (
    teamName: string,
    taskId: string,
    request: AddTaskCommentRequest
  ) => Promise<TaskComment>;
  setTaskClarification: (
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ) => Promise<void>;
  getProjectBranch: (projectPath: string) => Promise<string | null>;
  setProjectBranchTracking: (projectPath: string, enabled: boolean) => Promise<void>;
  getAttachments: (teamName: string, messageId: string) => Promise<AttachmentFileData[]>;
  killProcess: (teamName: string, pid: number) => Promise<void>;
  getLeadActivity: (teamName: string) => Promise<LeadActivitySnapshot>;
  getLeadContext: (teamName: string) => Promise<LeadContextUsageSnapshot>;
  getMemberSpawnStatuses: (teamName: string) => Promise<MemberSpawnStatusesSnapshot>;
  softDeleteTask: (teamName: string, taskId: string) => Promise<void>;
  restoreTask: (teamName: string, taskId: string) => Promise<void>;
  getDeletedTasks: (teamName: string) => Promise<TeamTask[]>;
  showMessageNotification: (data: TeamMessageNotificationData) => Promise<void>;
  addTaskRelationship: (
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ) => Promise<void>;
  removeTaskRelationship: (
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ) => Promise<void>;
  saveTaskAttachment: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: string,
    base64Data: string
  ) => Promise<TaskAttachmentMeta>;
  getTaskAttachment: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ) => Promise<string | null>;
  deleteTaskAttachment: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ) => Promise<void>;
  onProjectBranchChange: (
    callback: (event: unknown, data: ProjectBranchChangeEvent) => void
  ) => () => void;
  onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void) => () => void;
  onProvisioningProgress: (
    callback: (event: unknown, data: TeamProvisioningProgress) => void
  ) => () => void;
  respondToToolApproval: (
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ) => Promise<void>;
  validateCliArgs: (rawArgs: string) => Promise<CliArgsValidationResult>;
  onToolApprovalEvent: (callback: (event: unknown, data: ToolApprovalEvent) => void) => () => void;
  updateToolApprovalSettings: (teamName: string, settings: ToolApprovalSettings) => Promise<void>;
  readFileForToolApproval: (filePath: string) => Promise<ToolApprovalFileContent>;
}

// =============================================================================
// Cross-Team Communication API
// =============================================================================

export interface CrossTeamAPI {
  send: (request: CrossTeamSendRequest) => Promise<CrossTeamSendResult>;
  listTargets: (excludeTeam?: string) => Promise<
    {
      teamName: string;
      displayName: string;
      description?: string;
      color?: string;
      leadName?: string;
      leadColor?: string;
      isOnline?: boolean;
    }[]
  >;
  getOutbox: (teamName: string) => Promise<CrossTeamMessage[]>;
}

// =============================================================================
// Schedule API
// =============================================================================

export interface ScheduleAPI {
  list: () => Promise<Schedule[]>;
  get: (id: string) => Promise<Schedule | null>;
  create: (input: CreateScheduleInput) => Promise<Schedule>;
  update: (id: string, patch: UpdateSchedulePatch) => Promise<Schedule>;
  delete: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  triggerNow: (id: string) => Promise<ScheduleRun>;
  getRuns: (
    scheduleId: string,
    opts?: { limit?: number; offset?: number }
  ) => Promise<ScheduleRun[]>;
  getRunLogs: (scheduleId: string, runId: string) => Promise<{ stdout: string; stderr: string }>;
  onScheduleChange: (callback: (event: unknown, data: ScheduleChangeEvent) => void) => () => void;
}

// =============================================================================
// Review API
// =============================================================================

export interface ReviewAPI {
  // Phase 1
  getAgentChanges: (teamName: string, memberName: string) => Promise<AgentChangeSet>;
  getTaskChanges: (
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      /** Persisted work intervals (preferred for reliable owner-log attribution). */
      intervals?: { startedAt: string; completedAt?: string }[];
      /** Back-compat: single since timestamp (deprecated). */
      since?: string;
      /** Derived task lifecycle bucket used for safe summary caching. */
      stateBucket?: 'approved' | 'review' | 'completed' | 'active';
      /** Lightweight response for summary UIs; skips snippets/timeline details. */
      summaryOnly?: boolean;
      /** Force a fresh recompute and overwrite any cache snapshot. */
      forceFresh?: boolean;
    }
  ) => Promise<TaskChangeSetV2>;
  invalidateTaskChangeSummaries: (teamName: string, taskIds: string[]) => Promise<void>;
  getChangeStats: (teamName: string, memberName: string) => Promise<ChangeStats>;
  getFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string,
    snippets?: SnippetDiff[]
  ) => Promise<FileChangeWithContent>;
  applyDecisions: (request: ApplyReviewRequest) => Promise<ApplyReviewResult>;
  // Phase 2
  checkConflict: (filePath: string, expectedModified: string) => Promise<ConflictCheckResult>;
  rejectHunks: (
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ) => Promise<RejectResult>;
  rejectFile: (filePath: string, original: string, modified: string) => Promise<RejectResult>;
  previewReject: (
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ) => Promise<{ preview: string; hasConflicts: boolean }>;
  // Editable diff
  saveEditedFile: (
    filePath: string,
    content: string,
    projectPath?: string
  ) => Promise<{ success: boolean }>;
  watchFiles: (projectPath: string, filePaths: string[]) => Promise<void>;
  unwatchFiles: () => Promise<void>;
  onExternalFileChange: (callback: (event: EditorFileChangeEvent) => void) => () => void;
  // Decision persistence
  loadDecisions: (
    teamName: string,
    scopeKey: string
  ) => Promise<{
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    /**
     * Optional stable hunk fingerprints persisted from the renderer.
     * filePath -> (hunkIndex -> contextHash)
     */
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null>;
  saveDecisions: (
    teamName: string,
    scopeKey: string,
    hunkDecisions: Record<string, HunkDecision>,
    fileDecisions: Record<string, HunkDecision>,
    hunkContextHashesByFile?: Record<string, Record<number, string>>
  ) => Promise<void>;
  clearDecisions: (teamName: string, scopeKey: string) => Promise<void>;
  onCmdN?: (callback: () => void) => (() => void) | undefined;
  // Phase 4
  getGitFileLog: (
    projectPath: string,
    filePath: string
  ) => Promise<{ hash: string; timestamp: string; message: string }[]>;
}

// =============================================================================
// Main Electron API
// =============================================================================

/**
 * Complete Electron API exposed to the renderer process via preload script.
 */
export interface ElectronAPI {
  getAppVersion: () => Promise<string>;
  getProjects: () => Promise<Project[]>;
  getSessions: (projectId: string) => Promise<Session[]>;
  getSessionsPaginated: (
    projectId: string,
    cursor: string | null,
    limit?: number,
    options?: SessionsPaginationOptions
  ) => Promise<PaginatedSessionsResult>;
  searchSessions: (
    projectId: string,
    query: string,
    maxResults?: number
  ) => Promise<SearchSessionsResult>;
  searchAllProjects: (query: string, maxResults?: number) => Promise<SearchSessionsResult>;
  getSessionDetail: (
    projectId: string,
    sessionId: string,
    options?: { bypassCache?: boolean }
  ) => Promise<SessionDetail | null>;
  getSessionMetrics: (projectId: string, sessionId: string) => Promise<SessionMetrics | null>;
  getWaterfallData: (projectId: string, sessionId: string) => Promise<WaterfallData | null>;
  getSubagentDetail: (
    projectId: string,
    sessionId: string,
    subagentId: string,
    options?: { bypassCache?: boolean }
  ) => Promise<SubagentDetail | null>;
  getSessionGroups: (projectId: string, sessionId: string) => Promise<ConversationGroup[]>;
  getSessionsByIds: (
    projectId: string,
    sessionIds: string[],
    options?: SessionsByIdsOptions
  ) => Promise<Session[]>;

  // Repository grouping (worktree support)
  getRepositoryGroups: () => Promise<RepositoryGroup[]>;
  getWorktreeSessions: (worktreeId: string) => Promise<Session[]>;

  // Validation methods
  validatePath: (
    relativePath: string,
    projectPath: string
  ) => Promise<{ exists: boolean; isDirectory?: boolean }>;
  validateMentions: (
    mentions: { type: 'path'; value: string }[],
    projectPath: string
  ) => Promise<Record<string, boolean>>;

  // CLAUDE.md reading methods
  readClaudeMdFiles: (projectRoot: string) => Promise<Record<string, ClaudeMdFileInfo>>;
  readDirectoryClaudeMd: (dirPath: string) => Promise<ClaudeMdFileInfo>;
  readMentionedFile: (
    absolutePath: string,
    projectRoot: string,
    maxTokens?: number
  ) => Promise<ClaudeMdFileInfo | null>;

  // Agent config reading
  readAgentConfigs: (projectRoot: string) => Promise<Record<string, AgentConfig>>;

  // Notifications API
  notifications: NotificationsAPI;

  // Config API
  config: ConfigAPI;

  // Deep link navigation
  session: SessionAPI;

  // Window zoom sync (for traffic-light-safe layout)
  getZoomFactor: () => Promise<number>;
  onZoomFactorChanged: (callback: (zoomFactor: number) => void) => () => void;

  // File change events (real-time updates)
  onFileChange: (callback: (event: FileChangeEvent) => void) => () => void;
  onTodoChange: (callback: (event: FileChangeEvent) => void) => () => void;

  // Shell operations
  openPath: (
    targetPath: string,
    projectRoot?: string,
    userSelectedFromDialog?: boolean
  ) => Promise<{ success: boolean; error?: string }>;
  showInFolder: (filePath: string) => Promise<void>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

  // Window controls (when title bar is hidden, e.g. Windows / Linux)
  windowControls: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    isFullScreen: () => Promise<boolean>;
    relaunch: () => Promise<void>;
  };

  /** Subscribe to fullscreen changes (e.g. to remove macOS traffic light padding in fullscreen) */
  onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void;

  // Updater API
  updater: UpdaterAPI;

  // SSH API
  ssh: SshAPI;

  // Context API
  context: {
    list: () => Promise<ContextInfo[]>;
    getActive: () => Promise<string>;
    switch: (contextId: string) => Promise<{ contextId: string }>;
    onChanged: (callback: (event: unknown, data: ContextInfo) => void) => () => void;
  };

  // HTTP Server API
  httpServer: HttpServerAPI;

  // Team management API
  teams: TeamsAPI;

  // Cross-Team Communication API
  crossTeam: CrossTeamAPI;

  // Review API
  review: ReviewAPI;

  // CLI Installer API
  cliInstaller: CliInstallerAPI;

  // Embedded Terminal API (xterm.js + node-pty)
  terminal: TerminalAPI;

  // Project file operations (editor-independent)
  project: ProjectAPI;

  // Project Editor API (file browser + CodeMirror)
  editor: EditorAPI;

  // Schedule API (cron-based task execution)
  schedules: ScheduleAPI;

  // Extension Store — Plugin Catalog API (Electron-only, optional)
  plugins?: PluginCatalogAPI;

  // Extension Store — MCP Registry API (Electron-only, optional)
  mcpRegistry?: McpCatalogAPI;

  // Extension Store — Skills Catalog API (Electron-only, optional)
  skills?: SkillsCatalogAPI;

  // Extension Store — API Keys Management (Electron-only, optional)
  apiKeys?: ApiKeysAPI;

  /** Get absolute file path for a File object (works in sandboxed renderers). */
  getPathForFile: (file: File) => string;
}

// =============================================================================
// Window Type Extension
// =============================================================================

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
