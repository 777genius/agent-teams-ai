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

/** Directories to ignore (regex for chokidar's `ignored` option) */
const IGNORED_PATTERN =
  /(node_modules|\.git|dist|__pycache__|\.cache|\.next|\.venv|\.tox|vendor|\.DS_Store)/;

const MAX_DEPTH = 20;

// =============================================================================
// Service
// =============================================================================

export class EditorFileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string | null = null;
  private pendingEvents = new Map<string, EditorFileChangeEvent['type']>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onChangeCallback: ((event: EditorFileChangeEvent) => void) | null = null;
  private readonly DEBOUNCE_MS = 150;

  /**
   * Start watching a project directory.
   * Idempotent: stops any existing watcher first.
   */
  start(projectRoot: string, onChange: (event: EditorFileChangeEvent) => void): void {
    this.stop();
    this.projectRoot = projectRoot;

    log.info('Starting file watcher for:', projectRoot);

    this.watcher = watch(projectRoot, {
      ignored: IGNORED_PATTERN,
      ignoreInitial: true,
      followSymlinks: false,
      depth: MAX_DEPTH,
    });

    this.onChangeCallback = onChange;

    const emitSafe = (type: EditorFileChangeEvent['type'], filePath: string): void => {
      // SEC-2: validate path is within project root before sending to renderer
      if (!isPathWithinRoot(filePath, projectRoot)) {
        log.warn('Watcher event outside project root, ignoring:', filePath);
        return;
      }
      // Aggregate rapid events — only the last event type per path is kept
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
      for (const [filePath, type] of events) {
        this.onChangeCallback({ type, path: filePath });
      }
    }, this.DEBOUNCE_MS);
  }

  /**
   * Whether the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }
}
