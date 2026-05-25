/**
 * FileWatcher service - Watches for changes in Claude Code project files.
 *
 * Responsibilities:
 * - Watch ~/.claude/projects/ directory for session changes
 * - Watch ~/.claude/todos/ directory for todo changes
 * - Detect new/modified/deleted files
 * - Emit events to notify renderer process
 * - Invalidate cache entries when files change
 * - Detect errors in changed session files and notify NotificationManager
 */

import { type FileChangeEvent, type ParsedMessage } from '@main/types';
import {
  countJsonlFileWithStats,
  parseJsonlFileWithStats,
  parseJsonlStream,
} from '@main/utils/jsonl';
import {
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
  getTodosBasePath,
} from '@main/utils/pathDecoder';
import { OPENCODE_TASK_LOG_ATTRIBUTION_FILE } from '@shared/constants/opencodeTaskLogAttribution';
import { createLogger } from '@shared/utils/logger';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import { projectPathResolver } from '../discovery/ProjectPathResolver';
import { errorDetector } from '../error/ErrorDetector';

import { ConfigManager } from './ConfigManager';
import {
  CrossPlatformFileChangeSource,
  type PollSnapshotResult,
} from './CrossPlatformFileChangeSource';
import { type DataCache } from './DataCache';
import { LocalFileSystemProvider } from './LocalFileSystemProvider';
import { type NotificationManager } from './NotificationManager';
import { type TeamTaskWatchKind, TeamTaskWatchRegistry } from './TeamTaskWatchRegistry';

import type { FileSystemProvider, FsDirent } from './FileSystemProvider';
import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:FileWatcher');

/** Debounce window for file change events */
const DEBOUNCE_MS = 100;
/** Retry delay when watched directories are unavailable or watcher errors occur */
const WATCHER_RETRY_MS = 2000;
/** Poll interval for team metadata and inboxes when the teams watcher hits OS watcher limits */
const TEAMS_POLL_INTERVAL_MS = 1000;
/** Poll interval for task files, which can be much larger than team metadata/inboxes */
const TASKS_POLL_INTERVAL_MS = 3000;
/** Bound each projects polling slice so fallback/SSH mode cannot rescan huge histories every tick. */
const PROJECTS_POLL_PROJECT_SLICE_BUDGET = 64;
/** Soft cap: a single large project can exceed this, but broad trees are split across ticks. */
const PROJECTS_POLL_FILE_SOFT_BUDGET = 1024;
/** Interval for periodic catch-up scan to detect missed fs.watch events */
const CATCH_UP_INTERVAL_MS = 30_000;
/** Only catch-up scan files modified within this window */
const CATCH_UP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
/** Retire quiet top-level sessions from best-effort catch-up after this long. */
const CATCH_UP_SESSION_RETENTION_MS = 20 * 60 * 1000; // 20 minutes
/** Subagent logs are much noisier; retire them sooner from catch-up tracking. */
const CATCH_UP_SUBAGENT_RETENTION_MS = 5 * 60 * 1000; // 5 minutes
/** Bound best-effort catch-up work per tick so it cannot monopolize the event loop. */
const CATCH_UP_SCAN_BUDGET = 24;
/** Retire one file from catch-up after repeated local stat timeouts. */
const CATCH_UP_STAT_TIMEOUT_RETIRE_COUNT = 3;

interface AppendedParseResult {
  messages: ParsedMessage[];
  parsedLineCount: number;
  consumedBytes: number;
}

interface ActiveSessionFile {
  projectId: string;
  sessionId: string;
  subagentId?: string;
  lastObservedAt: number;
}

type FileWatcherSourceType = 'projects' | 'todos' | 'teams' | 'tasks';

export class FileWatcher extends EventEmitter {
  private readonly changeSources: Record<FileWatcherSourceType, CrossPlatformFileChangeSource>;
  private retryTimer: NodeJS.Timeout | null = null;
  private projectsPath: string;
  private todosPath: string;
  private teamsPath: string;
  private tasksPath: string;
  private dataCache: DataCache;
  private fsProvider: FileSystemProvider;
  private notificationManager: NotificationManager | null = null;
  private isWatching: boolean = false;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  /** Track last processed line count per file for incremental error detection */
  private lastProcessedLineCount = new Map<string, number>();
  /** Track last processed file size in bytes for append-only parsing optimization */
  private lastProcessedSize = new Map<string, number>();
  /** Active session files tracked for periodic catch-up scan */
  private activeSessionFiles = new Map<string, ActiveSessionFile>();
  /** Timer for periodic catch-up scan */
  private catchUpTimer: NodeJS.Timeout | null = null;
  /** Prevent overlapping catch-up scans when a previous pass is still running. */
  private catchUpInProgress = false;
  /** Round-robin cursor so catch-up work is spread across tracked files. */
  private catchUpCursor = 0;
  /** Consecutive catch-up stat timeouts per file. */
  private catchUpStatFailures = new Map<string, number>();
  /** Cursor for chunked project polling snapshots. */
  private projectsPollCursor = 0;
  /** Whether the current project polling cycle has already been split across ticks. */
  private projectsPollCycleChunked = false;
  /** Polling interval for projects fallback and SSH mode. */
  private static readonly SSH_POLL_INTERVAL_MS = 3000;
  /** Files currently being processed (concurrency guard) */
  private processingInProgress = new Set<string>();
  /** Files that need reprocessing after current processing completes */
  private pendingReprocess = new Set<string>();
  /** Flag to prevent reuse after disposal */
  private disposed = false;
  /** Timestamp when this FileWatcher instance was created (used to distinguish old vs new files).
   * Floored to second granularity because filesystem birthtimeMs may have lower resolution
   * than Date.now() — without this, a file created in the same millisecond-window could
   * appear older than the watcher on some platforms (e.g. ext4 on Linux). */
  private readonly instanceCreatedAt = Math.floor(Date.now() / 1000) * 1000;

  constructor(
    dataCache: DataCache,
    projectsPath?: string,
    todosPath?: string,
    fsProvider?: FileSystemProvider
  ) {
    super();
    this.projectsPath = projectsPath ?? getProjectsBasePath();
    this.todosPath = todosPath ?? getTodosBasePath();
    this.teamsPath = getTeamsBasePath();
    this.tasksPath = getTasksBasePath();
    this.dataCache = dataCache;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
    this.changeSources = this.createChangeSources();
  }

  private createChangeSources(): Record<FileWatcherSourceType, CrossPlatformFileChangeSource> {
    return {
      projects: new CrossPlatformFileChangeSource({
        name: 'projects',
        pollIntervalMs: FileWatcher.SSH_POLL_INTERVAL_MS,
        createWatcher: ({ onError, onClose, isCurrent }) => {
          const watcher = fs.watch(
            this.projectsPath,
            { recursive: true },
            (eventType, filename) => {
              if (filename && isCurrent()) {
                this.handleProjectsChange(eventType, filename);
              }
            }
          );
          watcher.on('error', (error) => this.handleNativeWatcherError('projects', error, onError));
          watcher.on('close', onClose);
          logger.info(`FileWatcher: Started watching projects at ${this.projectsPath}`);
          return watcher;
        },
        collectPollSnapshot: () => this.collectProjectsPollSnapshot(),
        emitPolledChange: (eventType, relativePath) =>
          this.handleProjectsChange(eventType, relativePath),
        isOwnerActive: () => this.isWatching,
        isWatchLimitError: (error) => this.isWatchLimitError(error),
        requestRetry: () => this.scheduleWatcherRetry(),
        onWatcherStartError: (error) => logger.error('Error starting projects watcher:', error),
        onWatcherError: (error) => logger.error('FileWatcher: projects watcher error:', error),
        onPollingError: (error) =>
          logger.error('FileWatcher: Error during projects polling:', error),
      }),
      todos: new CrossPlatformFileChangeSource({
        name: 'todos',
        pollIntervalMs: FileWatcher.SSH_POLL_INTERVAL_MS,
        createWatcher: ({ onError, onClose, isCurrent }) => {
          const watcher = fs.watch(this.todosPath, (eventType, filename) => {
            if (filename && isCurrent()) {
              this.handleTodosChange(eventType, filename);
            }
          });
          watcher.on('error', (error) => this.handleNativeWatcherError('todos', error, onError));
          watcher.on('close', onClose);
          logger.info(`FileWatcher: Started watching todos at ${this.todosPath}`);
          return watcher;
        },
        collectPollSnapshot: () => this.collectTodosPollSnapshot(),
        emitPolledChange: (eventType, relativePath) =>
          this.handleTodosChange(eventType, relativePath),
        isOwnerActive: () => this.isWatching,
        isWatchLimitError: (error) => this.isWatchLimitError(error),
        requestRetry: () => this.scheduleWatcherRetry(),
        onWatcherStartError: (error) => logger.error('Error starting todos watcher:', error),
        onWatcherError: (error) => logger.error('FileWatcher: todos watcher error:', error),
        onPollingError: (error) => logger.error('FileWatcher: Error during todos polling:', error),
      }),
      teams: new CrossPlatformFileChangeSource({
        name: 'teams',
        pollIntervalMs: TEAMS_POLL_INTERVAL_MS,
        createWatcher: ({ onError, isCurrent }) =>
          this.createTeamTaskRegistry('teams', this.teamsPath, onError, isCurrent),
        collectPollSnapshot: () => this.collectTeamsPollSnapshot(),
        emitPolledChange: (eventType, relativePath) =>
          this.handleTeamsChange(eventType, relativePath),
        isOwnerActive: () => this.isWatching,
        isWatchLimitError: (error) => this.isWatchLimitError(error),
        requestRetry: () => this.scheduleWatcherRetry(),
        onWatcherStartError: (error) => logger.error('Error starting teams watcher:', error),
        onWatcherError: (error) => logger.error('FileWatcher: teams watcher error:', error),
        onPollingError: (error) => logger.error('FileWatcher: Error during teams polling:', error),
      }),
      tasks: new CrossPlatformFileChangeSource({
        name: 'tasks',
        pollIntervalMs: TASKS_POLL_INTERVAL_MS,
        createWatcher: ({ onError, isCurrent }) =>
          this.createTeamTaskRegistry('tasks', this.tasksPath, onError, isCurrent),
        collectPollSnapshot: () => this.collectTasksPollSnapshot(),
        emitPolledChange: (eventType, relativePath) =>
          this.handleTasksChange(eventType, relativePath),
        isOwnerActive: () => this.isWatching,
        isWatchLimitError: (error) => this.isWatchLimitError(error),
        requestRetry: () => this.scheduleWatcherRetry(),
        onWatcherStartError: (error) => logger.error('Error starting tasks watcher:', error),
        onWatcherError: (error) => logger.error('FileWatcher: tasks watcher error:', error),
        onPollingError: (error) => logger.error('FileWatcher: Error during tasks polling:', error),
      }),
    };
  }

  /**
   * Sets the NotificationManager for error detection integration.
   * Must be called before start() to enable error notifications.
   */
  setNotificationManager(manager: NotificationManager): void {
    this.notificationManager = manager;
  }

  /**
   * Sets the filesystem provider. Used when switching between local and SSH modes.
   */
  setFileSystemProvider(provider: FileSystemProvider): void {
    this.fsProvider = provider;
  }

  // ===========================================================================
  // Watcher Control
  // ===========================================================================

  /**
   * Starts watching the projects and todos directories.
   */
  start(): void {
    if (this.disposed) {
      logger.error('Cannot start disposed FileWatcher');
      return;
    }

    if (this.isWatching) {
      logger.warn('Already watching');
      return;
    }

    this.isWatching = true;
    if (this.fsProvider.type === 'ssh') {
      this.startPollingMode();
    } else {
      // Fire-and-forget: ensureWatchers is now async to avoid blocking the event loop
      // with synchronous fs.existsSync() calls during startup.
      void this.ensureWatchers();
    }
    this.startCatchUpTimer();
  }

  /**
   * Stops all watchers.
   */
  stop(): void {
    this.isWatching = false;
    this.catchUpInProgress = false;
    this.catchUpCursor = 0;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    for (const source of Object.values(this.changeSources)) {
      source.stop();
    }

    // Clear any pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear catch-up timer
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }

    // Clear error detection tracking
    this.lastProcessedLineCount.clear();
    this.lastProcessedSize.clear();
    this.activeSessionFiles.clear();
    this.catchUpStatFailures.clear();
    this.projectsPollCursor = 0;
    this.projectsPollCycleChunked = false;
    this.processingInProgress.clear();
    this.pendingReprocess.clear();

    logger.info('Stopped watching');
  }

  /**
   * Disposes all resources and prevents reuse.
   * Performs comprehensive cleanup of all timers, watchers, maps, and listeners.
   *
   * After calling dispose(), this FileWatcher cannot be restarted.
   * Use stop() for temporary pausing that can be resumed with start().
   */
  dispose(): void {
    if (this.disposed) {
      logger.warn('FileWatcher already disposed');
      return;
    }

    logger.info('Disposing FileWatcher');

    // 1. Stop watchers and clear timers (uses existing stop() logic)
    this.stop();

    // 2. Clear retry timer (stop() already handles this, but being explicit)
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // 3. Clear all debounce timers (stop() already handles this)
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // 4. Clear catch-up timer (stop() already handles this)
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }

    // 5. Clear all tracking maps (stop() already handles most of these)
    this.lastProcessedLineCount.clear();
    this.lastProcessedSize.clear();
    this.activeSessionFiles.clear();
    this.catchUpStatFailures.clear();
    this.processingInProgress.clear();
    this.pendingReprocess.clear();

    // 6. Remove all EventEmitter listeners (MUST be last)
    this.removeAllListeners();

    // 7. Mark as disposed
    this.disposed = true;

    logger.info('FileWatcher disposed');
  }

  /**
   * Starts the projects directory watcher.
   */
  private async startProjectsWatcher(): Promise<void> {
    if (this.changeSources.projects.isActive) {
      return;
    }

    if (!(await this.pathExists(this.projectsPath))) {
      logger.warn(`FileWatcher: Projects directory does not exist: ${this.projectsPath}`);
      this.scheduleWatcherRetry();
      return;
    }

    // Guard: stop() may have been called while awaiting pathExists
    if (!this.isWatching) return;

    await this.changeSources.projects.start();
  }

  /**
   * Starts the todos directory watcher.
   */
  private async startTodosWatcher(): Promise<void> {
    if (this.changeSources.todos.isActive) {
      return;
    }

    if (!(await this.pathExists(this.todosPath))) {
      // Todos directory may not exist yet - that's OK
      this.scheduleWatcherRetry();
      return;
    }

    // Guard: stop() may have been called while awaiting pathExists
    if (!this.isWatching) return;

    await this.changeSources.todos.start();
  }

  /**
   * Starts the teams directory watcher.
   */
  private async startTeamsWatcher(): Promise<void> {
    if (this.changeSources.teams.isActive) {
      return;
    }

    if (!(await this.pathExists(this.teamsPath))) {
      this.scheduleWatcherRetry();
      return;
    }

    // Guard: stop() may have been called while awaiting pathExists
    if (!this.isWatching) return;

    await this.changeSources.teams.start();
  }

  /**
   * Starts the tasks directory watcher.
   */
  private async startTasksWatcher(): Promise<void> {
    if (this.changeSources.tasks.isActive) {
      return;
    }

    if (!(await this.pathExists(this.tasksPath))) {
      this.scheduleWatcherRetry();
      return;
    }

    // Guard: stop() may have been called while awaiting pathExists
    if (!this.isWatching) return;

    await this.changeSources.tasks.start();
  }

  /**
   * Async check for path existence. Replaces sync fs.existsSync()
   * to avoid blocking the event loop during watcher initialization.
   */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fsp.access(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureWatchers(): Promise<void> {
    if (!this.isWatching || this.fsProvider.type === 'ssh') {
      return;
    }

    if (process.platform === 'win32') {
      // On Windows, start watchers sequentially to avoid saturating the UV
      // thread pool (4 threads by default). Recursive fs.watch() on NTFS is
      // significantly slower than on macOS/Linux and can block all threads
      // simultaneously when started in parallel, freezing the app.
      await this.startProjectsWatcher();
      await this.startTodosWatcher();
      await this.startTeamsWatcher();
      await this.startTasksWatcher();
    } else {
      // On macOS/Linux, start all watchers in parallel to minimize total startup latency
      await Promise.all([
        this.startProjectsWatcher(),
        this.startTodosWatcher(),
        this.startTeamsWatcher(),
        this.startTasksWatcher(),
      ]);
    }

    if (
      !this.isWatcherOrPollingActive('projects') ||
      !this.isWatcherOrPollingActive('todos') ||
      !this.isWatcherOrPollingActive('teams') ||
      !this.isWatcherOrPollingActive('tasks')
    ) {
      this.scheduleWatcherRetry();
    }
  }

  private scheduleWatcherRetry(): void {
    if (!this.isWatching || this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensureWatchers();
    }, WATCHER_RETRY_MS);
  }

  private handleNativeWatcherError(
    watcherType: FileWatcherSourceType,
    error: NodeJS.ErrnoException,
    onError: (error: unknown) => void
  ): void {
    // Ephemeral .lock files cause harmless ENOENT when the recursive watcher
    // tries to scandir a path that was already deleted. Log as debug and skip
    // teardown/retry - the watcher is still healthy.
    if (error.code === 'ENOENT' && error.path?.endsWith('.lock')) {
      logger.debug(`FileWatcher: ${watcherType} ignoring transient ENOENT on lock file`);
      return;
    }
    onError(error);
  }

  private async createTeamTaskRegistry(
    watcherType: TeamTaskWatchKind,
    rootPath: string,
    onError: (error: unknown) => void,
    isCurrent: () => boolean
  ): Promise<TeamTaskWatchRegistry> {
    const registry = new TeamTaskWatchRegistry({
      kind: watcherType,
      rootPath,
      onChange: (eventType, filename) => {
        if (!isCurrent()) {
          return;
        }
        if (watcherType === 'teams') {
          this.handleTeamsChange(eventType, filename);
        } else {
          this.handleTasksChange(eventType, filename);
        }
      },
      onError,
    });

    try {
      await registry.start();
    } catch (error) {
      await registry.close();
      throw error;
    }

    logger.info(`FileWatcher: Started watching ${watcherType} at ${rootPath}`);
    return registry;
  }

  private isWatcherOrPollingActive(watcherType: FileWatcherSourceType): boolean {
    return this.changeSources[watcherType].isActive;
  }

  private isWatchLimitError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return (
      code === 'EMFILE' ||
      code === 'ENOSPC' ||
      code === 'ERR_FS_WATCHER_LIMIT' ||
      code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
    );
  }

  private isNotFoundError(error: unknown): boolean {
    const code = (error as { code?: unknown } | undefined)?.code;
    return code === 'ENOENT' || code === '2' || code === 2;
  }

  private async collectTeamsPollSnapshot(): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const teamEntries = await this.readSnapshotDir(this.teamsPath);

    // Fallback polling mirrors TeamTaskWatchRegistry. Do not recurse into members,
    // runtime, .opencode-runtime, logs, or other deep trees from here.
    for (const teamEntry of teamEntries) {
      if (!teamEntry.isDirectory()) {
        continue;
      }

      const teamName = teamEntry.name;
      const teamPath = path.join(this.teamsPath, teamName);
      await this.collectPolledDirectoryFiles(
        snapshot,
        teamPath,
        teamName,
        (fileName) => fileName.endsWith('.json'),
        { missingAsEmpty: false }
      );

      await this.collectPolledDirectoryFiles(
        snapshot,
        path.join(teamPath, 'inboxes'),
        `${teamName}/inboxes`,
        (fileName) => fileName.endsWith('.json'),
        { missingAsEmpty: true }
      );
    }

    return snapshot;
  }

  private async collectTasksPollSnapshot(): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const teamEntries = await this.readSnapshotDir(this.tasksPath);

    // Keep task fallback scoped to tasks/<team>/*.json. Hidden files and nested
    // runtime directories are intentionally outside the public team-change surface.
    for (const teamEntry of teamEntries) {
      if (!teamEntry.isDirectory()) {
        continue;
      }

      const teamName = teamEntry.name;
      await this.collectPolledDirectoryFiles(
        snapshot,
        path.join(this.tasksPath, teamName),
        teamName,
        (fileName) => !fileName.startsWith('.') && fileName.endsWith('.json'),
        { missingAsEmpty: false }
      );
    }

    return snapshot;
  }

  private async collectPolledDirectoryFiles(
    snapshot: Map<string, string>,
    dirPath: string,
    relativeRoot: string,
    shouldInclude: (fileName: string) => boolean,
    options: { missingAsEmpty?: boolean } = {}
  ): Promise<void> {
    const entries = await this.readSnapshotDir(dirPath, options);
    for (const entry of entries) {
      if (!entry.isFile() || !shouldInclude(entry.name)) {
        continue;
      }
      await this.addPolledFile(
        snapshot,
        path.join(dirPath, entry.name),
        `${relativeRoot}/${entry.name}`
      );
    }
  }

  private async addPolledFile(
    snapshot: Map<string, string>,
    absolutePath: string,
    relativePath: string
  ): Promise<void> {
    const stats = await fsp.stat(absolutePath);
    if (!stats.isFile()) {
      return;
    }
    snapshot.set(
      relativePath,
      `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
    );
  }

  private async readSnapshotDir(
    dirPath: string,
    options: { missingAsEmpty?: boolean } = {}
  ): Promise<fs.Dirent[]> {
    try {
      return await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (this.isNotFoundError(error) && options.missingAsEmpty) {
        return [];
      }
      throw error;
    }
  }

  // ===========================================================================
  // SSH Polling Mode
  // ===========================================================================

  /**
   * Starts polling mode for SSH connections.
   * Polls the projects directory for file changes instead of using fs.watch().
   */
  private startPollingMode(): void {
    logger.info('FileWatcher: Starting SSH polling mode');
    this.changeSources.projects.startPolling();
  }

  private async collectProjectsPollSnapshot(): Promise<PollSnapshotResult> {
    const snapshot = new Map<string, string>();
    const projectDirs = (await this.readProviderSnapshotDir(this.projectsPath))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    if (projectDirs.length === 0) {
      this.projectsPollCursor = 0;
      this.projectsPollCycleChunked = false;
      return { files: snapshot, cycleComplete: true, deleteSafe: true };
    }

    if (this.projectsPollCursor >= projectDirs.length) {
      this.projectsPollCursor = 0;
      this.projectsPollCycleChunked = false;
    }

    let index = this.projectsPollCursor;
    let visitedProjects = 0;
    let collectedFiles = 0;

    while (visitedProjects < projectDirs.length) {
      const projectDir = projectDirs[index];
      const sizeBefore = snapshot.size;
      const projectPath = path.join(this.projectsPath, projectDir.name);
      const entries = await this.readProviderSnapshotDir(projectPath);
      for (const entry of entries) {
        const entryPath = path.join(projectPath, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          await this.addProviderPolledFile(
            snapshot,
            entryPath,
            path.join(projectDir.name, entry.name),
            entry
          );
          continue;
        }

        if (!entry.isDirectory()) {
          continue;
        }

        const subagentsPath = path.join(entryPath, 'subagents');
        const subagentEntries = await this.readProviderSnapshotDir(subagentsPath, {
          missingAsEmpty: true,
        });
        for (const subagentEntry of subagentEntries) {
          if (!subagentEntry.isFile() || !subagentEntry.name.endsWith('.jsonl')) {
            continue;
          }
          await this.addProviderPolledFile(
            snapshot,
            path.join(subagentsPath, subagentEntry.name),
            path.join(projectDir.name, entry.name, 'subagents', subagentEntry.name),
            subagentEntry
          );
        }
      }

      collectedFiles += snapshot.size - sizeBefore;
      visitedProjects += 1;
      index = (index + 1) % projectDirs.length;

      if (index === 0) {
        const deleteSafe = !this.projectsPollCycleChunked;
        this.projectsPollCursor = 0;
        this.projectsPollCycleChunked = false;
        return { files: snapshot, cycleComplete: true, deleteSafe };
      }

      if (
        visitedProjects >= PROJECTS_POLL_PROJECT_SLICE_BUDGET ||
        collectedFiles >= PROJECTS_POLL_FILE_SOFT_BUDGET
      ) {
        this.projectsPollCursor = index;
        this.projectsPollCycleChunked = true;
        return { files: snapshot, cycleComplete: false };
      }
    }

    this.projectsPollCursor = 0;
    this.projectsPollCycleChunked = false;
    return { files: snapshot, cycleComplete: true, deleteSafe: true };
  }

  private async collectTodosPollSnapshot(): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const entries = await this.readProviderSnapshotDir(this.todosPath);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      await this.addProviderPolledFile(
        snapshot,
        path.join(this.todosPath, entry.name),
        entry.name,
        entry
      );
    }

    return snapshot;
  }

  private async addProviderPolledFile(
    snapshot: Map<string, string>,
    absolutePath: string,
    relativePath: string,
    entry?: FsDirent
  ): Promise<void> {
    const stats =
      typeof entry?.size === 'number' && typeof entry.mtimeMs === 'number'
        ? entry
        : await this.fsProvider.stat(absolutePath);
    if (!stats.isFile()) {
      return;
    }
    snapshot.set(relativePath, `${stats.mtimeMs ?? 0}:${stats.size}`);
  }

  private async readProviderSnapshotDir(
    dirPath: string,
    options: { missingAsEmpty?: boolean } = {}
  ): Promise<FsDirent[]> {
    try {
      if (this.fsProvider instanceof LocalFileSystemProvider) {
        return await fsp.readdir(dirPath, { withFileTypes: true });
      }
      return await this.fsProvider.readdir(dirPath);
    } catch (error) {
      if (this.isNotFoundError(error) && options.missingAsEmpty) {
        return [];
      }
      throw error;
    }
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  /**
   * Handles file change events in the projects directory.
   */
  private handleProjectsChange(eventType: string, filename: string): void {
    try {
      // Ignore non-JSONL files
      if (!filename.endsWith('.jsonl')) {
        return;
      }

      // Debounce rapid changes to the same file
      this.debounce(filename, () => this.processProjectsChange(eventType, filename));
    } catch (error) {
      logger.error('Error handling projects change:', error);
    }
  }

  /**
   * Process a debounced projects change.
   */
  private async processProjectsChange(eventType: string, filename: string): Promise<void> {
    const fullPath = path.isAbsolute(filename)
      ? path.normalize(filename)
      : path.join(this.projectsPath, filename);
    const relativePath = path.relative(this.projectsPath, fullPath);

    // Ignore events outside of the watched projects root.
    if (relativePath.startsWith('..')) {
      return;
    }

    // Normalize separators to support platform/event source differences.
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    const projectId = parts[0];

    if (!projectId) return;
    const fileExists = await this.fsProvider.exists(fullPath);

    // Determine change type
    let changeType: FileChangeEvent['type'];
    if (eventType === 'rename') {
      changeType = fileExists ? 'add' : 'unlink';
    } else {
      changeType = 'change';
    }

    // Parse session ID and check if it's a subagent
    let sessionId: string | undefined;
    let isSubagent = false;

    // Session file at project root: projectId/sessionId.jsonl
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      sessionId = path.basename(parts[1], '.jsonl');
    }
    // Subagent file: projectId/sessionId/subagents/agent-hash.jsonl
    else if (parts.length === 4 && parts[2] === 'subagents' && parts[3].endsWith('.jsonl')) {
      sessionId = parts[1];
      isSubagent = true;
    }

    if (sessionId) {
      // Invalidate cache
      this.dataCache.invalidateSession(projectId, sessionId);
      projectPathResolver.invalidateProject(projectId);
      if (changeType === 'unlink') {
        this.clearErrorTracking(fullPath);
      }

      // Emit event
      const event: FileChangeEvent = {
        type: changeType,
        path: fullPath,
        projectId,
        sessionId,
        isSubagent,
      };

      this.emit('file-change', event);
      logger.info(
        `FileWatcher: ${changeType} ${isSubagent ? 'subagent' : 'session'} - ${relativePath}`
      );

      // Detect errors in changed session files (not deleted files)
      if (changeType !== 'unlink' && this.notificationManager) {
        if (isSubagent) {
          // Only process subagent files if config allows
          const config = ConfigManager.getInstance().getConfig();
          if (config.notifications.includeSubagentErrors) {
            const subagentFilename = path.basename(parts[3], '.jsonl');
            const subagentId = subagentFilename.replace(/^agent-/, '');
            this.rememberActiveSessionFile(fullPath, { projectId, sessionId, subagentId });
            this.detectErrorsInSessionFile(projectId, sessionId, fullPath, subagentId).catch(
              (err) => {
                logger.error('Error detecting errors in subagent file:', err);
              }
            );
          }
        } else {
          this.rememberActiveSessionFile(fullPath, { projectId, sessionId });
          this.detectErrorsInSessionFile(projectId, sessionId, fullPath).catch((err) => {
            logger.error('Error detecting errors in session file:', err);
          });
        }
      }
    }
  }

  // ===========================================================================
  // Error Detection
  // ===========================================================================

  /**
   * Detects errors in a session file and sends notifications.
   * Uses incremental processing to only check new lines since last check.
   */
  private async detectErrorsInSessionFile(
    projectId: string,
    sessionId: string,
    filePath: string,
    subagentId?: string
  ): Promise<void> {
    if (!this.notificationManager) {
      return;
    }

    // Concurrency guard: if already processing this file, mark for reprocessing
    if (this.processingInProgress.has(filePath)) {
      this.pendingReprocess.add(filePath);
      return;
    }

    this.processingInProgress.add(filePath);
    try {
      // Get the last processed line count for this file
      const lastLineCount = this.lastProcessedLineCount.get(filePath) ?? 0;
      const lastSize = this.lastProcessedSize.get(filePath) ?? 0;
      const fileStats = await this.fsProvider.stat(filePath);
      const currentSize = fileStats.size;

      // Fast path: no size change means no new data
      if (currentSize === lastSize && lastSize > 0) {
        return;
      }

      const isFirstRead = lastLineCount === 0 && lastSize === 0;
      if (isFirstRead && fileStats.birthtimeMs < this.instanceCreatedAt) {
        await this.establishPreExistingFileBaseline(filePath, currentSize);
        return;
      }

      const canUseIncrementalAppend = lastSize > 0 && currentSize > lastSize;
      let newMessages: ParsedMessage[] = [];
      let currentLineCount: number;
      let processedSize: number;

      if (canUseIncrementalAppend) {
        const appended = await this.parseAppendedMessages(filePath, lastSize);
        newMessages = appended.messages;
        currentLineCount = lastLineCount + appended.parsedLineCount;
        processedSize = lastSize + appended.consumedBytes;
      } else {
        // Fallback for first-read, truncation, or rewrite scenarios
        const parsedFile = await parseJsonlFileWithStats(filePath, this.fsProvider);
        currentLineCount = parsedFile.parsedLineCount;
        newMessages = parsedFile.messages.slice(lastLineCount);
        processedSize = parsedFile.consumedBytes;
      }

      // If no new lines, skip processing
      if (currentLineCount <= lastLineCount) {
        this.lastProcessedSize.set(filePath, processedSize);
        return;
      }

      // Detect errors in new messages
      // Note: We pass the offset-adjusted line numbers to errorDetector
      const errors = await errorDetector.detectErrors(newMessages, sessionId, projectId, filePath);

      // Adjust line numbers to account for the offset and annotate subagent errors
      for (const error of errors) {
        if (error.lineNumber !== undefined) {
          error.lineNumber = error.lineNumber + lastLineCount;
        }
        if (subagentId) {
          error.subagentId = subagentId;
        }
      }

      // Notify for each detected error
      for (const error of errors) {
        await this.notificationManager.addError(error);
      }

      // Update the last processed line count
      this.lastProcessedLineCount.set(filePath, currentLineCount);
      this.lastProcessedSize.set(filePath, processedSize);

      if (errors.length > 0) {
        logger.info(`FileWatcher: Detected ${errors.length} errors in ${filePath}`);
      }
    } catch (err) {
      logger.error(`FileWatcher: Error processing session file for errors: ${filePath}`, err);
    } finally {
      this.processingInProgress.delete(filePath);

      // If a reprocess was requested while we were processing, run again
      if (this.pendingReprocess.has(filePath)) {
        this.pendingReprocess.delete(filePath);
        this.detectErrorsInSessionFile(projectId, sessionId, filePath, subagentId).catch((e) => {
          logger.error('Error during reprocessing of session file:', e);
        });
      }
    }
  }

  private async establishPreExistingFileBaseline(
    filePath: string,
    currentSize: number
  ): Promise<void> {
    const baseline = await countJsonlFileWithStats(filePath, this.fsProvider);
    this.lastProcessedLineCount.set(filePath, baseline.parsedLineCount);
    this.lastProcessedSize.set(filePath, baseline.consumedBytes);
    logger.info(
      `FileWatcher: Baseline established for ${filePath} (${baseline.parsedLineCount} lines, ${baseline.consumedBytes}/${currentSize} bytes)`
    );
  }

  /**
   * Clears the error detection tracking for a specific file.
   * Call this when a file is deleted or to force re-processing.
   */
  clearErrorTracking(filePath: string): void {
    this.lastProcessedLineCount.delete(filePath);
    this.lastProcessedSize.delete(filePath);
    this.activeSessionFiles.delete(filePath);
    this.catchUpStatFailures.delete(filePath);
  }

  /**
   * Clears all error detection tracking.
   */
  clearAllErrorTracking(): void {
    this.lastProcessedLineCount.clear();
    this.lastProcessedSize.clear();
    this.activeSessionFiles.clear();
    this.catchUpStatFailures.clear();
    this.catchUpCursor = 0;
    this.catchUpInProgress = false;
  }

  private rememberActiveSessionFile(
    filePath: string,
    info: Omit<ActiveSessionFile, 'lastObservedAt'>
  ): void {
    this.activeSessionFiles.set(filePath, {
      ...info,
      lastObservedAt: Date.now(),
    });
  }

  private getCatchUpRetentionMs(info: ActiveSessionFile): number {
    return info.subagentId ? CATCH_UP_SUBAGENT_RETENTION_MS : CATCH_UP_SESSION_RETENTION_MS;
  }

  /**
   * Parse only newly appended JSONL lines from the given byte offset.
   */
  private async parseAppendedMessages(
    filePath: string,
    startOffset: number
  ): Promise<AppendedParseResult> {
    const stream = this.fsProvider.createReadStream(filePath, {
      start: startOffset,
    });
    const parsed = await parseJsonlStream(stream);

    return {
      messages: parsed.messages,
      parsedLineCount: parsed.parsedLineCount,
      consumedBytes: parsed.consumedBytes,
    };
  }

  /**
   * Handles file change events in the todos directory.
   */
  private handleTodosChange(eventType: string, filename: string): void {
    try {
      // Only handle JSON files
      if (!filename.endsWith('.json')) {
        return;
      }

      // Debounce rapid changes
      this.debounce(`todos/${filename}`, () => this.processTodosChange(eventType, filename));
    } catch (error) {
      logger.error('Error handling todos change:', error);
    }
  }

  /**
   * Process a debounced todos change.
   */
  private async processTodosChange(eventType: string, filename: string): Promise<void> {
    // Session ID is the filename without extension
    const sessionId = path.basename(filename, '.json');
    const fullPath = path.join(this.todosPath, filename);
    const fileExists = await this.fsProvider.exists(fullPath);

    // Determine change type
    let changeType: FileChangeEvent['type'];
    if (eventType === 'rename') {
      changeType = fileExists ? 'add' : 'unlink';
    } else {
      changeType = 'change';
    }

    // Emit event (we don't have projectId for todos)
    const event: FileChangeEvent = {
      type: changeType,
      path: fullPath,
      sessionId,
      isSubagent: false,
    };

    this.emit('todo-change', event);
    logger.info(`FileWatcher: ${changeType} todo - ${filename}`);
  }

  private handleTeamsChange(eventType: string, filename: string): void {
    try {
      this.debounce(`teams/${filename}`, () => this.processTeamsChange(eventType, filename));
    } catch (error) {
      logger.error('Error handling teams change:', error);
    }
  }

  private processTeamsChange(_eventType: string, filename: string): void {
    const normalized = filename.split(/[\\/]/).filter(Boolean);
    const teamName = normalized[0];
    if (!teamName) {
      return;
    }

    // `detail` is relative to the team root (plan examples: `inboxes/alice.json`, `config.json`)
    const relative = normalized.slice(1).join('/');
    if (!relative) {
      return;
    }

    // Keep this classifier in lockstep with TeamTaskWatchRegistry.shouldEmit().
    // If a path is emitted by the registry but ignored here, the UI will miss it.
    // If a path is added here but not emitted there, Chokidar mode will never see it.
    if (relative === 'processes.json') {
      const event: TeamChangeEvent = { type: 'process', teamName, detail: relative };
      this.emit('team-change', event);
      return;
    }

    // Classify only the paths we care about in iteration 02.
    if (normalized.includes('inboxes') || relative === 'sentMessages.json') {
      const event: TeamChangeEvent = {
        type: 'inbox',
        teamName,
        detail: relative,
      };
      this.emit('team-change', event);
      return;
    }

    if (
      relative === 'config.json' ||
      relative === 'kanban-state.json' ||
      relative === 'team.meta.json' ||
      relative === 'members.meta.json'
    ) {
      const event: TeamChangeEvent = {
        type: 'config',
        teamName,
        detail: relative,
      };
      this.emit('team-change', event);
      return;
    }

    if (relative === OPENCODE_TASK_LOG_ATTRIBUTION_FILE) {
      const event: TeamChangeEvent = {
        type: 'log-source-change',
        teamName,
        detail: relative,
      };
      this.emit('team-change', event);
    }
  }

  private handleTasksChange(eventType: string, filename: string): void {
    try {
      this.debounce(`tasks/${filename}`, () => this.processTasksChange(eventType, filename));
    } catch (error) {
      logger.error('Error handling tasks change:', error);
    }
  }

  private processTasksChange(_eventType: string, filename: string): void {
    const normalized = filename.split(/[\\/]/).filter(Boolean);
    const teamName = normalized[0];
    if (!teamName) {
      return;
    }

    // `detail` is relative to the team tasks dir (plan example: `12.json`)
    const relative = normalized.slice(1).join('/');
    if (!relative) {
      return;
    }

    // Keep this in sync with the tasks registry and fallback polling filters:
    // only tasks/<team>/*.json is a user-visible task event.
    // Ignore known non-task files in ~/.claude/tasks
    if (
      relative === '.lock' ||
      relative === '.highwatermark' ||
      relative.startsWith('.') ||
      !relative.endsWith('.json')
    ) {
      return;
    }

    const event: TeamChangeEvent = {
      type: 'task',
      teamName,
      detail: relative,
      taskId: relative.replace(/\.json$/i, ''),
    };
    this.emit('team-change', event);
  }

  // ===========================================================================
  // Catch-Up Scan
  // ===========================================================================

  /**
   * Starts the periodic catch-up timer to detect file growth missed by fs.watch.
   * FSEvents on macOS can coalesce, delay, or drop events. This timer polls
   * tracked active session files every CATCH_UP_INTERVAL_MS to detect unprocessed growth.
   */
  private startCatchUpTimer(): void {
    if (this.catchUpTimer) {
      return;
    }

    this.catchUpTimer = setInterval(() => {
      this.runCatchUpScan().catch((err) => {
        logger.error('Error during catch-up scan:', err);
      });
    }, CATCH_UP_INTERVAL_MS);
    // Catch-up scan is best-effort; don't keep process alive.
    this.catchUpTimer.unref();
  }

  /**
   * Scans active session files for unprocessed growth.
   * Only checks files modified within the last hour.
   */
  private async runCatchUpScan(): Promise<void> {
    if (!this.notificationManager || this.activeSessionFiles.size === 0 || this.catchUpInProgress) {
      return;
    }

    this.catchUpInProgress = true;
    try {
      const now = Date.now();
      const entries = [...this.activeSessionFiles.entries()];
      if (entries.length === 0) {
        return;
      }

      const budget = Math.min(CATCH_UP_SCAN_BUDGET, entries.length);
      const startIndex = this.catchUpCursor % entries.length;

      for (let offset = 0; offset < budget; offset += 1) {
        if (!this.isWatching) {
          break;
        }
        const [filePath] = entries[(startIndex + offset) % entries.length];
        const info = this.activeSessionFiles.get(filePath);
        if (!info) {
          continue;
        }
        try {
          if (now - info.lastObservedAt > this.getCatchUpRetentionMs(info)) {
            this.clearErrorTracking(filePath);
            continue;
          }

          const stats = await this.fsProvider.stat(filePath);
          this.catchUpStatFailures.delete(filePath);

          // Skip files not modified recently
          if (now - stats.mtimeMs > CATCH_UP_MAX_AGE_MS) {
            this.clearErrorTracking(filePath);
            continue;
          }

          const lastSize = this.lastProcessedSize.get(filePath) ?? 0;
          if (stats.size > lastSize) {
            logger.info(`FileWatcher: Catch-up scan detected growth in ${filePath}`);
            this.rememberActiveSessionFile(filePath, {
              projectId: info.projectId,
              sessionId: info.sessionId,
              ...(info.subagentId ? { subagentId: info.subagentId } : {}),
            });
            await this.detectErrorsInSessionFile(
              info.projectId,
              info.sessionId,
              filePath,
              info.subagentId
            );
          }
        } catch (err) {
          // File may have been deleted between iterations
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            this.clearErrorTracking(filePath);
          } else if (this.isStatTimeoutError(err)) {
            this.handleCatchUpStatTimeout(filePath);
          } else {
            logger.error(`FileWatcher: Error during catch-up stat for ${filePath}:`, err);
          }
        }
      }
      this.catchUpCursor = (startIndex + budget) % Math.max(entries.length, 1);
    } finally {
      this.catchUpInProgress = false;
    }
  }

  private isStatTimeoutError(err: unknown): boolean {
    return err instanceof Error && err.message === 'stat timeout';
  }

  private handleCatchUpStatTimeout(filePath: string): void {
    const failures = (this.catchUpStatFailures.get(filePath) ?? 0) + 1;

    if (failures >= CATCH_UP_STAT_TIMEOUT_RETIRE_COUNT) {
      logger.warn(
        `FileWatcher: Retiring ${filePath} from catch-up after ${failures} stat timeouts`
      );
      this.retireCatchUpFile(filePath);
      return;
    }

    this.catchUpStatFailures.set(filePath, failures);
    logger.debug(
      `FileWatcher: Catch-up stat timeout for ${filePath} (${failures}/${CATCH_UP_STAT_TIMEOUT_RETIRE_COUNT})`
    );
  }

  private retireCatchUpFile(filePath: string): void {
    this.activeSessionFiles.delete(filePath);
    this.catchUpStatFailures.delete(filePath);
  }

  // ===========================================================================
  // Debouncing
  // ===========================================================================

  /**
   * Debounce a function call for a specific key.
   */
  private debounce(key: string, fn: () => void): void {
    // Clear existing timer for this key
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, DEBOUNCE_MS);

    this.debounceTimers.set(key, timer);
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  /**
   * Returns whether the watcher is currently active.
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * Returns watched paths.
   */
  getWatchedPaths(): { projects: string; todos: string; teams: string; tasks: string } {
    return {
      projects: this.projectsPath,
      todos: this.todosPath,
      teams: this.teamsPath,
      tasks: this.tasksPath,
    };
  }
}
