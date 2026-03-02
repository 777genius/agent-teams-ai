/**
 * Tests for editor IPC handlers — validation, security, module-level state.
 */

import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp') },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
}));

// Mock isbinaryfile
vi.mock('isbinaryfile', () => ({
  isBinaryFile: vi.fn(),
}));

// Mock IPC channels
vi.mock('@preload/constants/ipcChannels', () => ({
  EDITOR_OPEN: 'editor:open',
  EDITOR_CLOSE: 'editor:close',
  EDITOR_READ_DIR: 'editor:readDir',
  EDITOR_READ_FILE: 'editor:readFile',
  EDITOR_WRITE_FILE: 'editor:writeFile',
  EDITOR_CREATE_FILE: 'editor:createFile',
  EDITOR_CREATE_DIR: 'editor:createDir',
  EDITOR_DELETE_FILE: 'editor:deleteFile',
  EDITOR_MOVE_FILE: 'editor:moveFile',
  EDITOR_RENAME_FILE: 'editor:renameFile',
  EDITOR_SEARCH_IN_FILES: 'editor:searchInFiles',
  EDITOR_LIST_FILES: 'editor:listFiles',
  EDITOR_READ_BINARY_PREVIEW: 'editor:readBinaryPreview',
  EDITOR_GIT_STATUS: 'editor:gitStatus',
  EDITOR_WATCH_DIR: 'editor:watchDir',
  EDITOR_SET_WATCHED_FILES: 'editor:setWatchedFiles',
  EDITOR_SET_WATCHED_DIRS: 'editor:setWatchedDirs',
  EDITOR_CHANGE: 'editor:change',
  PROJECT_LIST_FILES: 'project:listFiles',
}));

// Mock atomicWrite used by ProjectFileService
vi.mock('@main/utils/atomicWrite', () => ({
  atomicWriteAsync: vi.fn(),
}));

// Mock simple-git (used by GitStatusService)
vi.mock('simple-git', () => {
  const mockGit = {
    status: vi.fn(),
    revparse: vi.fn(),
    env: vi.fn().mockReturnThis(),
  };
  return { simpleGit: vi.fn(() => mockGit) };
});

// Mock chokidar (used by EditorFileWatcher)
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock logger
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock pathDecoder
vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => path.join(os.homedir(), '.claude'),
}));

import * as fs from 'fs/promises';

import {
  cleanupEditorState,
  initializeEditorHandlers,
  registerEditorHandlers,
  removeEditorHandlers,
} from '../../../src/main/ipc/editor';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

// =============================================================================
// Helpers
// =============================================================================

function createMockIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler({} as IpcMainInvokeEvent, ...args);
    },
    _handlers: handlers,
  };
}

function createStats(
  overrides: Partial<Record<string, unknown>> = {}
): Awaited<ReturnType<typeof fs.stat>> {
  return {
    isFile: () => overrides.isFile ?? false,
    isDirectory: () => overrides.isDirectory ?? true,
    isSymbolicLink: () => overrides.isSymbolicLink ?? false,
    size: overrides.size ?? 1024,
    mtimeMs: overrides.mtimeMs ?? Date.now(),
  } as Awaited<ReturnType<typeof fs.stat>>;
}

// =============================================================================
// Tests
// =============================================================================

describe('Editor IPC handlers', () => {
  let mockIpc: ReturnType<typeof createMockIpcMain>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockIpc = createMockIpcMain();
    initializeEditorHandlers();
    registerEditorHandlers(mockIpc as unknown as IpcMain);
    // Always start with clean state
    cleanupEditorState();
  });

  describe('registration', () => {
    it('registers all 18 editor channels', () => {
      expect(mockIpc.handle).toHaveBeenCalledTimes(18);
      expect(mockIpc._handlers.has('editor:open')).toBe(true);
      expect(mockIpc._handlers.has('editor:close')).toBe(true);
      expect(mockIpc._handlers.has('editor:readDir')).toBe(true);
      expect(mockIpc._handlers.has('editor:readFile')).toBe(true);
      expect(mockIpc._handlers.has('editor:writeFile')).toBe(true);
      expect(mockIpc._handlers.has('editor:createFile')).toBe(true);
      expect(mockIpc._handlers.has('editor:createDir')).toBe(true);
      expect(mockIpc._handlers.has('editor:deleteFile')).toBe(true);
      expect(mockIpc._handlers.has('editor:moveFile')).toBe(true);
      expect(mockIpc._handlers.has('editor:renameFile')).toBe(true);
      expect(mockIpc._handlers.has('editor:searchInFiles')).toBe(true);
      expect(mockIpc._handlers.has('editor:listFiles')).toBe(true);
      expect(mockIpc._handlers.has('editor:readBinaryPreview')).toBe(true);
      expect(mockIpc._handlers.has('editor:gitStatus')).toBe(true);
      expect(mockIpc._handlers.has('editor:watchDir')).toBe(true);
      expect(mockIpc._handlers.has('editor:setWatchedFiles')).toBe(true);
      expect(mockIpc._handlers.has('editor:setWatchedDirs')).toBe(true);
      expect(mockIpc._handlers.has('project:listFiles')).toBe(true);
    });

    it('removeEditorHandlers clears all channels', () => {
      removeEditorHandlers(mockIpc as unknown as IpcMain);
      expect(mockIpc.removeHandler).toHaveBeenCalledTimes(18);
    });
  });

  describe('editor:open', () => {
    it('accepts valid absolute directory path', async () => {
      const projectPath = '/Users/test/my-project';
      vi.mocked(fs.stat).mockResolvedValue(createStats({ isDirectory: true }));

      const result = await mockIpc.invoke('editor:open', projectPath);

      expect(result).toEqual({ success: true, data: undefined });
    });

    it('rejects empty path', async () => {
      const result = await mockIpc.invoke('editor:open', '');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Invalid project path'),
      });
    });

    it('rejects relative path', async () => {
      const result = await mockIpc.invoke('editor:open', 'relative/path');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('must be absolute'),
      });
    });

    it('rejects filesystem root (SEC-15)', async () => {
      const result = await mockIpc.invoke('editor:open', '/');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('filesystem root'),
      });
    });

    it('rejects ~/.claude directory (SEC-15)', async () => {
      const claudeDir = path.join(os.homedir(), '.claude');
      const result = await mockIpc.invoke('editor:open', claudeDir);

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Claude data directory'),
      });
    });

    it('rejects path to a file (not directory)', async () => {
      vi.mocked(fs.stat).mockResolvedValue(createStats({ isDirectory: false, isFile: true }));

      const result = await mockIpc.invoke('editor:open', '/Users/test/file.ts');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not a directory'),
      });
    });

    it('rejects non-existent path', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

      const result = await mockIpc.invoke('editor:open', '/nonexistent/path');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('ENOENT'),
      });
    });
  });

  describe('editor:close', () => {
    it('resets state successfully', async () => {
      // Open first
      vi.mocked(fs.stat).mockResolvedValue(createStats({ isDirectory: true }));
      await mockIpc.invoke('editor:open', '/Users/test/project');

      const result = await mockIpc.invoke('editor:close');

      expect(result).toEqual({ success: true, data: undefined });
    });
  });

  describe('editor:readDir', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:readDir', '/some/path');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });

    it('works after editor:open', async () => {
      // Open project
      vi.mocked(fs.stat).mockResolvedValue(createStats({ isDirectory: true }));
      await mockIpc.invoke('editor:open', '/Users/test/project');

      // Mock readDir
      vi.mocked(fs.lstat).mockResolvedValue(createStats({ isDirectory: true }) as never);
      vi.mocked(fs.readdir).mockResolvedValue([] as never);

      const result = await mockIpc.invoke('editor:readDir', '/Users/test/project');

      expect(result).toEqual({
        success: true,
        data: { entries: [], truncated: false },
      });
    });
  });

  describe('editor:readFile', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:readFile', '/some/file.ts');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:createFile', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:createFile', '/some/path', 'file.ts');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:createDir', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:createDir', '/some/path', 'new-dir');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:deleteFile', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:deleteFile', '/some/file.ts');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:moveFile', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:moveFile', '/some/file.ts', '/other/dir');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:searchInFiles', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:searchInFiles', { query: 'test' });

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:gitStatus', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:gitStatus');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('editor:watchDir', () => {
    it('rejects if editor not initialized', async () => {
      const result = await mockIpc.invoke('editor:watchDir', true);

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });

  describe('cleanupEditorState', () => {
    it('resets state so readDir fails with not initialized', async () => {
      // Open project
      vi.mocked(fs.stat).mockResolvedValue(createStats({ isDirectory: true }));
      await mockIpc.invoke('editor:open', '/Users/test/project');

      // Cleanup
      cleanupEditorState();

      // Now readDir should fail
      const result = await mockIpc.invoke('editor:readDir', '/Users/test/project');
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not initialized'),
      });
    });
  });
});
