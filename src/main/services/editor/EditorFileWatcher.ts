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
const MAX_EMITTED_EVENTS_PER_FLUSH = 300;

// =============================================================================
// Service
// =============================================================================

export class EditorFileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string | null = null;
  private pendingEvents = new Map<string, EditorFileChangeEvent['type']>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onChangeCallback: ((event: EditorFileChangeEvent) => void) | null = null;
  // Higher debounce = fewer IPC events during large bursts (checkout/build/format).
  private readonly DEBOUNCE_MS = 350;
  private ignoreChangeUntilMs = 0;
  private watchedFilesKey = '';

  /**
   * Initialize watcher context for a project root.
   *
   * Performance: does NOT watch the entire project directory.
   * Use setWatchedFiles() to watch only open files (tabs).
   */
  start(projectRoot: string, onChange: (event: EditorFileChangeEvent) => void): void {
    this.stop();
    this.projectRoot = projectRoot;
    this.ignoreChangeUntilMs = Date.now() + STARTUP_IGNORE_CHANGE_MS;
    this.watchedFilesKey = '';

    log.info('Starting file watcher (open files only) for:', projectRoot);
    this.onChangeCallback = onChange;
  }

  /**
   * Update list of watched file paths (open tabs).
   * Rebuilds chokidar watcher when the set changes.
   */
  setWatchedFiles(filePaths: string[]): void {
    if (!this.projectRoot) {
      throw new Error('Watcher not initialized');
    }

    const normalized = filePaths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .filter((p) => isPathWithinRoot(p, this.projectRoot!));

    normalized.sort();
    const key = normalized.join('\n');
    if (key === this.watchedFilesKey) return;
    this.watchedFilesKey = key;

    // Close existing watcher first (if any)
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }

    if (normalized.length === 0) {
      return;
    }

    // Build a new watcher for the given file set.
    // disableGlobbing prevents chokidar from treating file names as patterns.
    this.watcher = watch(normalized, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
    });

    const emitSafe = (type: EditorFileChangeEvent['type'], filePath: string): void => {
      if (type === 'change' && Date.now() < this.ignoreChangeUntilMs) {
        return;
      }
      if (!isPathWithinRoot(filePath, this.projectRoot!)) {
        log.warn('Watcher event outside project root, ignoring:', filePath);
        return;
      }
      this.pendingEvents.set(filePath, type);
      this.scheduleFlush();
    };

    this.watcher.on('change', (p) => emitSafe('change', p));
    this.watcher.on('add', (p) => emitSafe('create', p));
    this.watcher.on('unlink', (p) => emitSafe('delete', p));

    this.watcher.on('error', (error) => {
      log.error('Watcher error:', error);
    });
  }

  /**
   * Stop watching. Safe to call multiple times.
   */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingEvents.clear();
    this.onChangeCallback = null;
    this.ignoreChangeUntilMs = 0;
    this.watchedFilesKey = '';
    if (this.watcher) {
      log.info('Stopping file watcher');
      void this.watcher.close();
      this.watcher = null;
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
    }, this.DEBOUNCE_MS);
  }

  /**
   * Whether the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }
}
