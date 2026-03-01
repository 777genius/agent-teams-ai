/**
 * Tests for EditorFileWatcher — start/stop, event filtering, path security.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  beforeEach(() => {
    vi.resetAllMocks();
    mockOn.mockReturnThis();
    watcher = new EditorFileWatcher();
  });

  describe('start', () => {
    it('creates chokidar watcher with correct options', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      expect(watch).toHaveBeenCalledWith('/Users/test/project', {
        ignored: expect.any(RegExp),
        ignoreInitial: true,
        followSymlinks: false,
        depth: 20,
      });
    });

    it('registers change, add, unlink, and error handlers', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      const registeredEvents = mockOn.mock.calls.map((c) => c[0]);
      expect(registeredEvents).toContain('change');
      expect(registeredEvents).toContain('add');
      expect(registeredEvents).toContain('unlink');
      expect(registeredEvents).toContain('error');
    });

    it('emits normalized events through onChange callback', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      // Simulate chokidar 'change' event
      const changeHandler = mockOn.mock.calls.find((c) => c[0] === 'change')?.[1];
      changeHandler?.('/Users/test/project/src/index.ts');

      expect(onChange).toHaveBeenCalledWith({
        type: 'change',
        path: '/Users/test/project/src/index.ts',
      });
    });

    it('emits create event for add', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      const addHandler = mockOn.mock.calls.find((c) => c[0] === 'add')?.[1];
      addHandler?.('/Users/test/project/new-file.ts');

      expect(onChange).toHaveBeenCalledWith({
        type: 'create',
        path: '/Users/test/project/new-file.ts',
      });
    });

    it('emits delete event for unlink', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      const unlinkHandler = mockOn.mock.calls.find((c) => c[0] === 'unlink')?.[1];
      unlinkHandler?.('/Users/test/project/old-file.ts');

      expect(onChange).toHaveBeenCalledWith({
        type: 'delete',
        path: '/Users/test/project/old-file.ts',
      });
    });

    it('ignores events outside project root (SEC-2)', () => {
      vi.mocked(isPathWithinRoot).mockReturnValueOnce(false);

      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      const changeHandler = mockOn.mock.calls.find((c) => c[0] === 'change')?.[1];
      changeHandler?.('/etc/passwd');

      expect(onChange).not.toHaveBeenCalled();
    });

    it('stops previous watcher on re-start (idempotent)', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project1', onChange);
      watcher.start('/Users/test/project2', onChange);

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(watch).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop', () => {
    it('closes the watcher', () => {
      const onChange = vi.fn();
      watcher.start('/Users/test/project', onChange);

      watcher.stop();

      expect(mockClose).toHaveBeenCalled();
    });

    it('is safe to call multiple times', () => {
      watcher.stop();
      watcher.stop();
      // No error thrown
    });
  });

  describe('isWatching', () => {
    it('returns false when not started', () => {
      expect(watcher.isWatching()).toBe(false);
    });

    it('returns true after start', () => {
      watcher.start('/Users/test/project', vi.fn());
      expect(watcher.isWatching()).toBe(true);
    });

    it('returns false after stop', () => {
      watcher.start('/Users/test/project', vi.fn());
      watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });
  });
});
