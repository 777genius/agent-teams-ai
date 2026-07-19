/**
 * File watcher for the project editor using chokidar v4.
 *
 * Watches project directory for external file changes and emits
 * normalized events. chokidar handles platform differences (FSEvents on macOS,
 * inotify on Linux), recursive watching, and ENOSPC fallback.
 *
 * Security: paths emitted in events are validated against project root
 * before being sent to renderer (SEC-2).
 */

import { lstatSync } from 'node:fs';

import { isPathWithinRoot } from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import { watch } from 'chokidar';

import type { EditorFileChangeEvent } from '@shared/types/editor';
import type { FSWatcher } from 'chokidar';

const log = createLogger('EditorFileWatcher');

// =============================================================================
// Constants
// =============================================================================

const STARTUP_IGNORE_CHANGE_MS = 3000;
const WATCHER_READY_TIMEOUT_MS = 5000;
const WATCHER_RESTART_DELAY_MS = 250;
const MAX_EMITTED_EVENTS_PER_FLUSH = 300;

export type FileIdentity =
  | { status: 'missing' }
  | { status: 'unavailable' }
  | {
      status: 'present';
      device: bigint;
      inode: bigint;
      size: bigint;
      modifiedAtNs: bigint;
      changedAtNs: bigint;
    };

function readFileIdentity(filePath: string): FileIdentity {
  try {
    const stat = lstatSync(filePath, { bigint: true });
    return {
      status: 'present',
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedAtNs: stat.mtimeNs,
      changedAtNs: stat.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'unavailable' };
  }
}

export function identityChangeType(
  before: FileIdentity,
  after: FileIdentity
): EditorFileChangeEvent['type'] | null {
  // Uncertainty must fail closed for review: silently treating an unreadable
  // identity as unchanged can permit a destructive action on stale bytes.
  if (before.status === 'unavailable' || after.status === 'unavailable') return 'change';
  if (before.status === 'missing') return after.status === 'present' ? 'create' : null;
  if (after.status === 'missing') return 'delete';
  return before.device !== after.device ||
    before.inode !== after.inode ||
    before.size !== after.size ||
    before.modifiedAtNs !== after.modifiedAtNs ||
    before.changedAtNs !== after.changedAtNs
    ? 'change'
    : null;
}

export interface EditorFileWatcherOptions {
  /**
   * The editor opens files before it starts watching them, so its initial change
   * noise can be ignored. Review starts from an already-visible snapshot and must
   * observe every subsequent write, including one immediately after subscription.
   */
  ignoreStartupChanges?: boolean;
}

// =============================================================================
// Service
// =============================================================================

export class EditorFileWatcher {
  private watcher: FSWatcher | null = null;
  private retiringWatchers = new Set<FSWatcher>();
  private lastReadyWatcher: FSWatcher | null = null;
  private watcherReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherNeedsRestart = false;
  private dirWatcher: FSWatcher | null = null;
  private projectRoot: string | null = null;
  private pendingEvents = new Map<string, EditorFileChangeEvent['type']>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onChangeCallback: ((event: EditorFileChangeEvent) => void) | null = null;
  // Higher debounce = fewer IPC events during large bursts (checkout/build/format).
  private readonly debounceMs = 350;
  private ignoreChangeUntilMs = 0;
  private watchedFiles = new Set<string>();
  private watchedDirsKey = '';
  private readonly ignoreStartupChanges: boolean;

  constructor(options: EditorFileWatcherOptions = {}) {
    this.ignoreStartupChanges = options.ignoreStartupChanges ?? true;
  }

  /**
   * Initialize watcher context for a project root.
   *
   * Performance: does NOT watch the entire project directory.
   * Use setWatchedFiles() to watch only open files (tabs).
   */
  start(projectRoot: string, onChange: (event: EditorFileChangeEvent) => void): void {
    this.stop();
    this.projectRoot = projectRoot;
    this.ignoreChangeUntilMs = this.ignoreStartupChanges
      ? Date.now() + STARTUP_IGNORE_CHANGE_MS
      : 0;
    this.watchedFiles.clear();
    this.watchedDirsKey = '';

    log.info('Starting file watcher (open files only) for:', projectRoot);
    this.onChangeCallback = onChange;
  }

  /**
   * Update list of watched file paths (open tabs).
   * Rebuilds chokidar watcher when the set changes while retaining the previous
   * subscription until the replacement is ready. A before/ready identity check
   * recovers changes that happen while chokidar is arming its native watchers.
   */
  setWatchedFiles(filePaths: string[]): void {
    if (!this.projectRoot) {
      return; // Watcher not initialized yet — will sync when start() is called
    }

    const normalized = filePaths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .filter((p) => isPathWithinRoot(p, this.projectRoot!));

    normalized.sort((a, b) => a.localeCompare(b));
    const nextWatchedFiles = new Set(normalized);
    if (this.watcher) {
      const added = normalized.filter((filePath) => !this.watchedFiles.has(filePath));
      const removed = [...this.watchedFiles].filter((filePath) => !nextWatchedFiles.has(filePath));
      if (added.length === 0 && removed.length === 0 && !this.watcherNeedsRestart) return;
    }

    if (normalized.length === 0) {
      this.watchedFiles.clear();
      this.clearWatcherReadyTimer();
      this.clearWatcherRestartTimer();
      if (this.watcher) {
        void this.watcher.close();
        this.watcher = null;
      }
      this.closeRetiringWatchers();
      this.lastReadyWatcher = null;
      this.watcherNeedsRestart = false;
      return;
    }

    const startupIdentities = new Map(
      normalized.map((filePath) => [filePath, readFileIdentity(filePath)] as const)
    );
    const startupObservedPaths = new Set<string>();
    let isReady = false;

    // Build a new watcher for the given file set.
    // disableGlobbing prevents chokidar from treating file names as patterns.
    const previousWatcher = this.watcher;
    this.clearWatcherReadyTimer();
    this.clearWatcherRestartTimer();
    this.watcherNeedsRestart = false;
    const nextWatcher = watch(normalized, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
    });
    this.watcher = nextWatcher;
    this.watchedFiles = nextWatchedFiles;
    if (previousWatcher) this.retiringWatchers.add(previousWatcher);

    const emitSafe = (
      type: EditorFileChangeEvent['type'],
      filePath: string,
      forceConservativeChange = false
    ): void => {
      if (!isReady) startupObservedPaths.add(filePath);
      if (!this.watchedFiles.has(filePath)) return;
      if (
        type === 'change' &&
        !forceConservativeChange &&
        Date.now() < this.ignoreChangeUntilMs
      ) {
        return;
      }
      if (!isPathWithinRoot(filePath, this.projectRoot!)) {
        log.warn('Watcher event outside project root, ignoring:', filePath);
        return;
      }
      this.pendingEvents.set(filePath, type);
      this.scheduleFlush();
    };

    nextWatcher.on('change', (p) => emitSafe('change', p));
    nextWatcher.on('add', (p) => emitSafe('create', p));
    nextWatcher.on('unlink', (p) => emitSafe('delete', p));

    let failedClosed = false;
    const failClosed = (reason: string): void => {
      if (failedClosed || this.watcher !== nextWatcher) return;
      failedClosed = true;
      this.watcherNeedsRestart = true;
      this.clearWatcherReadyTimer();
      if (this.lastReadyWatcher === nextWatcher) this.lastReadyWatcher = null;
      log.error(reason);
      for (const filePath of startupIdentities.keys()) {
        if (this.watchedFiles.has(filePath)) emitSafe('change', filePath, true);
      }
      // Keep the latest known-ready watcher for unchanged paths, but bound
      // abandoned replacement watchers when chokidar never reaches `ready`.
      if (!isReady) this.closeRetiringWatchers(this.lastReadyWatcher);
      this.watcherRestartTimer = setTimeout(() => {
        this.watcherRestartTimer = null;
        if (this.watcher !== nextWatcher || !this.projectRoot || !this.watcherNeedsRestart) return;
        this.setWatchedFiles([...this.watchedFiles]);
      }, WATCHER_RESTART_DELAY_MS);
    };

    this.watcherReadyTimer = setTimeout(() => {
      failClosed('Watcher did not become ready; review files require revalidation');
    }, WATCHER_READY_TIMEOUT_MS);

    nextWatcher.on('ready', () => {
      isReady = true;
      if (this.watcher !== nextWatcher || failedClosed) return;
      this.clearWatcherReadyTimer();
      this.clearWatcherRestartTimer();
      this.watcherNeedsRestart = false;

      for (const [filePath, before] of startupIdentities) {
        if (startupObservedPaths.has(filePath) || !this.watchedFiles.has(filePath)) continue;
        const changeType = identityChangeType(before, readFileIdentity(filePath));
        if (changeType) emitSafe(changeType, filePath);
      }

      this.closeRetiringWatchers();
      this.lastReadyWatcher = nextWatcher;
    });

    nextWatcher.on('error', (error) => {
      log.error('Watcher error:', error);
      failClosed('Watcher failed; review files require revalidation');
    });
  }

  /**
   * Update list of watched directory paths (shallow: depth=0).
   * Watches only immediate children changes (create/delete/rename) in those folders.
   */
  setWatchedDirs(dirPaths: string[]): void {
    if (!this.projectRoot) {
      return; // Watcher not initialized yet — will sync when start() is called
    }

    const normalized = dirPaths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .filter((p) => isPathWithinRoot(p, this.projectRoot!));

    normalized.sort((a, b) => a.localeCompare(b));
    const key = normalized.join('\n');
    if (key === this.watchedDirsKey) return;
    this.watchedDirsKey = key;

    if (this.dirWatcher) {
      void this.dirWatcher.close();
      this.dirWatcher = null;
    }

    if (normalized.length === 0) {
      return;
    }

    this.dirWatcher = watch(normalized, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 0,
    });

    const emitSafe = (type: EditorFileChangeEvent['type'], filePath: string): void => {
      if (!isPathWithinRoot(filePath, this.projectRoot!)) {
        log.warn('Watcher event outside project root, ignoring:', filePath);
        return;
      }
      this.pendingEvents.set(filePath, type);
      this.scheduleFlush();
    };

    // For directories, we only care about structural changes.
    this.dirWatcher.on('add', (p) => emitSafe('create', p));
    this.dirWatcher.on('unlink', (p) => emitSafe('delete', p));
    this.dirWatcher.on('addDir', (p) => emitSafe('create', p));
    this.dirWatcher.on('unlinkDir', (p) => emitSafe('delete', p));

    this.dirWatcher.on('error', (error) => {
      log.error('Dir watcher error:', error);
    });
  }

  /**
   * Stop watching. Safe to call multiple times.
   */
  stop(): void {
    this.clearWatcherReadyTimer();
    this.clearWatcherRestartTimer();
    this.watcherNeedsRestart = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingEvents.clear();
    this.onChangeCallback = null;
    this.ignoreChangeUntilMs = 0;
    this.watchedFiles.clear();
    this.watchedDirsKey = '';
    if (this.watcher) {
      log.info('Stopping file watcher');
      void this.watcher.close();
      this.watcher = null;
    }
    this.closeRetiringWatchers();
    this.lastReadyWatcher = null;
    if (this.dirWatcher) {
      log.info('Stopping directory watcher');
      void this.dirWatcher.close();
      this.dirWatcher = null;
    }
    this.projectRoot = null;
  }

  /**
   * Flush pending events — debounced to aggregate rapid FS changes
   * (e.g. git checkout, bulk format). Fires once after 150ms of quiet.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const events = new Map(this.pendingEvents);
      this.pendingEvents.clear();
      if (!this.onChangeCallback) return;
      // Cap emitted events per flush to protect renderer from floods.
      // Prefer create/delete events over change events.
      let emitted = 0;

      if (events.size > MAX_EMITTED_EVENTS_PER_FLUSH) {
        log.warn(
          `Watcher burst: ${events.size} events pending, capping to ${MAX_EMITTED_EVENTS_PER_FLUSH}`
        );
      }

      const emit = (type: EditorFileChangeEvent['type']): void => {
        for (const [filePath, t] of events) {
          if (t !== type) continue;
          this.onChangeCallback?.({ type: t, path: filePath });
          emitted++;
          if (emitted >= MAX_EMITTED_EVENTS_PER_FLUSH) return;
        }
      };

      emit('delete');
      if (emitted < MAX_EMITTED_EVENTS_PER_FLUSH) emit('create');
      if (emitted < MAX_EMITTED_EVENTS_PER_FLUSH) emit('change');
    }, this.debounceMs);
  }

  /**
   * Whether the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }

  private clearWatcherReadyTimer(): void {
    if (!this.watcherReadyTimer) return;
    clearTimeout(this.watcherReadyTimer);
    this.watcherReadyTimer = null;
  }

  private clearWatcherRestartTimer(): void {
    if (!this.watcherRestartTimer) return;
    clearTimeout(this.watcherRestartTimer);
    this.watcherRestartTimer = null;
  }

  private closeRetiringWatchers(except: FSWatcher | null = null): void {
    for (const watcher of this.retiringWatchers) {
      if (watcher === except) continue;
      void watcher.close();
      this.retiringWatchers.delete(watcher);
    }
  }
}
