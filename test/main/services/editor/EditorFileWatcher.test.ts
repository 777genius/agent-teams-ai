/**
 * Tests for EditorFileWatcher — start/stop, event filtering, path security.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockAdd = vi.fn().mockReturnThis();
const mockUnwatch = vi.fn().mockReturnThis();

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: mockOn,
    close: mockClose,
    add: mockAdd,
    unwatch: mockUnwatch,
  })),
}));

vi.mock('@main/utils/pathValidation', () => ({
  isPathWithinRoot: vi.fn((filePath: string, root: string) => {
    return filePath.startsWith(root);
  }),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { watch } from 'chokidar';

import {
  EditorFileWatcher,
  identityChangeType,
} from '../../../../src/main/services/editor/EditorFileWatcher';

// =============================================================================
// Tests
// =============================================================================

describe('EditorFileWatcher', () => {
  let watcher: EditorFileWatcher;
  const FLUSH_DEBOUNCE_MS = 350;
  const STARTUP_IGNORE_CHANGE_MS = 3000;
  const WATCHER_READY_TIMEOUT_MS = 5000;
  const WATCHER_RESTART_DELAY_MS = 250;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockOn.mockReturnThis();
    mockAdd.mockReturnThis();
    mockUnwatch.mockReturnThis();
    watcher = new EditorFileWatcher();
  });

  it('treats an unreadable startup identity as a conservative change', () => {
    expect(identityChangeType({ status: 'unavailable' }, { status: 'missing' })).toBe('change');
    expect(identityChangeType({ status: 'missing' }, { status: 'unavailable' })).toBe('change');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    it('creates chokidar watcher with correct options (open files only)', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      // start() does not create a watcher until we provide watched files
      expect(watch).not.toHaveBeenCalled();

      watcher.setWatchedFiles(['/Users/test/project/src/index.ts']);

      expect(watch).toHaveBeenCalledWith(['/Users/test/project/src/index.ts'], {
        ignoreInitial: true,
        ignorePermissionErrors: true,
        followSymlinks: false,
      });
    });

    it('registers change, add, unlink, ready, and error handlers', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/src/index.ts']);

      const registeredEvents = mockOn.mock.calls.map((c) => c[0]);
      expect(registeredEvents).toContain('change');
      expect(registeredEvents).toContain('add');
      expect(registeredEvents).toContain('unlink');
      expect(registeredEvents).toContain('ready');
      expect(registeredEvents).toContain('error');
    });

    it('emits normalized events through onChange callback', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/src/index.ts']);

      // Simulate chokidar 'change' event
      const changeHandler = mockOn.mock.calls.find((c) => c[0] === 'change')?.[1];
      // Startup grace period ignores 'change' events for first 3s
      vi.advanceTimersByTime(STARTUP_IGNORE_CHANGE_MS);
      changeHandler?.('/Users/test/project/src/index.ts');
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({
        type: 'change',
        path: '/Users/test/project/src/index.ts',
      });
    });

    it('can observe a change immediately when startup suppression is disabled', () => {
      const reviewWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
      const onChange = vi.fn();
      reviewWatcher.start('/Users/test/project', onChange);
      reviewWatcher.setWatchedFiles(['/Users/test/project/src/index.ts']);

      const changeHandler = mockOn.mock.calls.find((c) => c[0] === 'change')?.[1];
      changeHandler?.('/Users/test/project/src/index.ts');
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({
        type: 'change',
        path: '/Users/test/project/src/index.ts',
      });
      reviewWatcher.stop();
    });

    it('fails closed when chokidar errors before it is ready', () => {
      const reviewWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
      const onChange = vi.fn();
      const filePath = '/Users/test/project/src/index.ts';
      reviewWatcher.start('/Users/test/project', onChange);
      reviewWatcher.setWatchedFiles([filePath]);

      const errorHandler = mockOn.mock.calls.find((call) => call[0] === 'error')?.[1];
      errorHandler?.(new Error('watch unavailable'));
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({ type: 'change', path: filePath });
      reviewWatcher.stop();
    });

    it('fails closed after ready even during startup suppression', () => {
      const onChange = vi.fn();
      const filePath = '/Users/test/project/src/index.ts';
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles([filePath]);

      const readyHandler = mockOn.mock.calls.find((call) => call[0] === 'ready')?.[1];
      const errorHandler = mockOn.mock.calls.find((call) => call[0] === 'error')?.[1];
      readyHandler?.();
      errorHandler?.(new Error('watch stopped'));
      vi.advanceTimersByTime(WATCHER_RESTART_DELAY_MS + FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({ type: 'change', path: filePath });
      expect(watch).toHaveBeenCalledTimes(2);
    });

    it('fails closed when chokidar never becomes ready', () => {
      const reviewWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
      const onChange = vi.fn();
      const filePath = '/Users/test/project/src/index.ts';
      reviewWatcher.start('/Users/test/project', onChange);
      reviewWatcher.setWatchedFiles([filePath]);

      vi.advanceTimersByTime(WATCHER_READY_TIMEOUT_MS + FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({ type: 'change', path: filePath });
      expect(watch).toHaveBeenCalledTimes(2);
      reviewWatcher.stop();
    });

    it('emits create event for add', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/new-file.ts']);

      const addHandler = mockOn.mock.calls.find((c) => c[0] === 'add')?.[1];
      addHandler?.('/Users/test/project/new-file.ts');
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({
        type: 'create',
        path: '/Users/test/project/new-file.ts',
      });
    });

    it('emits delete event for unlink', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/old-file.ts']);

      const unlinkHandler = mockOn.mock.calls.find((c) => c[0] === 'unlink')?.[1];
      unlinkHandler?.('/Users/test/project/old-file.ts');
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

      expect(onChange).toHaveBeenCalledWith({
        type: 'delete',
        path: '/Users/test/project/old-file.ts',
      });
    });

    it('ignores events outside project root (SEC-2)', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/src/index.ts']);

      const changeHandler = mockOn.mock.calls.find((c) => c[0] === 'change')?.[1];
      vi.advanceTimersByTime(STARTUP_IGNORE_CHANGE_MS);
      changeHandler?.('/etc/passwd');

      expect(onChange).not.toHaveBeenCalled();
    });

    it('stops previous watcher on re-start (idempotent)', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project1', onChange);
      watcher.setWatchedFiles(['/Users/test/project1/a.ts']);
      watcher.start('/Users/test/project2', onChange);

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(watch).toHaveBeenCalledTimes(1);
    });

    it('keeps the previous subscription until its replacement is ready', () => {
      watcher.start('/Users/test/project', vi.fn());
      watcher.setWatchedFiles(['/Users/test/project/a.ts']);

      watcher.setWatchedFiles(['/Users/test/project/a.ts', '/Users/test/project/b.ts']);

      expect(watch).toHaveBeenCalledTimes(2);
      expect(mockClose).not.toHaveBeenCalled();

      const latestReadyHandler = [...mockOn.mock.calls]
        .reverse()
        .find((call) => call[0] === 'ready')?.[1];
      latestReadyHandler?.();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: 'change',
        prepare: (filePath: string) => writeFileSync(filePath, 'before'),
        mutate: (filePath: string) => writeFileSync(filePath, 'after with another size'),
        expectedType: 'change',
      },
      {
        name: 'create',
        prepare: () => undefined,
        mutate: (filePath: string) => writeFileSync(filePath, 'created'),
        expectedType: 'create',
      },
      {
        name: 'delete',
        prepare: (filePath: string) => writeFileSync(filePath, 'before'),
        mutate: (filePath: string) => unlinkSync(filePath),
        expectedType: 'delete',
      },
    ])('recovers a $name that happens before chokidar is ready', ({ prepare, mutate, expectedType }) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'editor-watcher-ready-'));
      const filePath = join(projectRoot, 'reviewed.ts');
      const onChange = vi.fn();

      try {
        prepare(filePath);
        const reviewWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
        reviewWatcher.start(projectRoot, onChange);
        reviewWatcher.setWatchedFiles([filePath]);

        mutate(filePath);
        const readyHandler = mockOn.mock.calls.find((call) => call[0] === 'ready')?.[1];
        readyHandler?.();
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

        expect(onChange).toHaveBeenCalledWith({ type: expectedType, path: filePath });
        reviewWatcher.stop();
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('stop', () => {
    it('closes the watcher', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/a.ts']);

      watcher.stop();

      expect(mockClose).toHaveBeenCalled();
    });

    it('is safe to call multiple times', () => {
      expect(() => {
        watcher.stop();
        watcher.stop();
      }).not.toThrow();
    });
  });

  describe('setWatchedFiles before start', () => {
    it('returns silently when watcher not initialized', () => {
      // Should NOT throw — graceful no-op when projectRoot is null
      expect(() => watcher.setWatchedFiles(['/some/file.ts'])).not.toThrow();
      expect(watch).not.toHaveBeenCalled();
    });
  });

  describe('setWatchedDirs before start', () => {
    it('returns silently when watcher not initialized', () => {
      // Should NOT throw — graceful no-op when projectRoot is null
      expect(() => watcher.setWatchedDirs(['/some/dir'])).not.toThrow();
      expect(watch).not.toHaveBeenCalled();
    });
  });

  describe('isWatching', () => {
    it('returns false when not started', () => {
      expect(watcher.isWatching()).toBe(false);
    });

    it('returns true after setWatchedFiles', () => {
      watcher.start('/Users/test/project', vi.fn());
      expect(watcher.isWatching()).toBe(false);
      watcher.setWatchedFiles(['/Users/test/project/a.ts']);
      expect(watcher.isWatching()).toBe(true);
    });

    it('returns false after stop', () => {
      watcher.start('/Users/test/project', vi.fn());
      watcher.setWatchedFiles(['/Users/test/project/a.ts']);
      watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });
  });
});
