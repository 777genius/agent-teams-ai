/**
 * Tests for EditorFileWatcher — start/stop, event filtering, path security.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: mockOn,
    close: mockClose,
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

import { isPathWithinRoot } from '../../../../src/main/utils/pathValidation';
import { EditorFileWatcher } from '../../../../src/main/services/editor/EditorFileWatcher';

// =============================================================================
// Tests
// =============================================================================

describe('EditorFileWatcher', () => {
  let watcher: EditorFileWatcher;
  const FLUSH_DEBOUNCE_MS = 350;
  const STARTUP_IGNORE_CHANGE_MS = 3000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockOn.mockReturnThis();
    watcher = new EditorFileWatcher();
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

    it('registers change, add, unlink, and error handlers', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);
      watcher.setWatchedFiles(['/Users/test/project/src/index.ts']);

      const registeredEvents = mockOn.mock.calls.map((c) => c[0]);
      expect(registeredEvents).toContain('change');
      expect(registeredEvents).toContain('add');
      expect(registeredEvents).toContain('unlink');
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
      watcher.stop();
      watcher.stop();
      // No error thrown
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
