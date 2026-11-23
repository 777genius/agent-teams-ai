import type { AppConfig, NotificationTrigger, TriggerTestResult } from './notifications';

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
// Telemetry API
// =============================================================================

export interface SentryTelemetryContext {
  userId: string;
  tags: Record<string, string>;
}

export interface SentryTelemetryStatus {
  state: 'disabled' | 'unconfigured' | 'active' | 'failed';
  reason: 'telemetry-disabled' | 'invalid-dsn' | 'sdk-load-failed' | 'sdk-init-failed' | null;
  environment: 'production' | 'development';
  release: string | null;
}

export interface TelemetryAPI {
  getSentryContext: () => Promise<SentryTelemetryContext | null>;
  getSentryStatus: () => Promise<SentryTelemetryStatus>;
}

export interface WindowsElevationStatus {
  platform: string;
  isWindows: boolean;
  isAdministrator: boolean | null;
  checkFailed: boolean;
  error: string | null;
}
