/**
 * Tests for editorSlice — openEditor, closeEditor, expandDirectory, collapseDirectory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore } from './storeTestUtils';

import type { TestStore } from './storeTestUtils';
import type { FileTreeEntry, ReadDirResult } from '../../../src/shared/types/editor';

// =============================================================================
// Mock API
// =============================================================================

const mockEditorAPI = {
  open: vi.fn(),
  close: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
};

vi.mock('@renderer/api', () => ({
  api: {
    editor: {
      open: (...args: unknown[]) => mockEditorAPI.open(...args),
      close: (...args: unknown[]) => mockEditorAPI.close(...args),
      readDir: (...args: unknown[]) => mockEditorAPI.readDir(...args),
      readFile: (...args: unknown[]) => mockEditorAPI.readFile(...args),
      writeFile: (...args: unknown[]) => mockEditorAPI.writeFile(...args),
      createFile: (...args: unknown[]) => mockEditorAPI.createFile(...args),
      createDir: (...args: unknown[]) => mockEditorAPI.createDir(...args),
      deleteFile: (...args: unknown[]) => mockEditorAPI.deleteFile(...args),
      moveFile: (...args: unknown[]) => mockEditorAPI.moveFile(...args),
    },
    // Provide stubs for other API domains if needed
    getProjects: vi.fn(),
    getSessions: vi.fn(),
  },
}));

const mockBridge = {
  getContent: vi.fn(),
  getAllModifiedContent: vi.fn(),
  destroy: vi.fn(),
  deleteState: vi.fn(),
  remapState: vi.fn(),
};

vi.mock('@renderer/utils/editorBridge', () => ({
  editorBridge: {
    getContent: (...args: unknown[]) => mockBridge.getContent(...args),
    getAllModifiedContent: (...args: unknown[]) => mockBridge.getAllModifiedContent(...args),
    destroy: (...args: unknown[]) => mockBridge.destroy(...args),
    deleteState: (...args: unknown[]) => mockBridge.deleteState(...args),
    remapState: (...args: unknown[]) => mockBridge.remapState(...args),
    register: vi.fn(),
    unregister: vi.fn(),
    isRegistered: false,
    updateView: vi.fn(),
    getView: vi.fn(),
  },
}));

vi.mock('@renderer/utils/codemirrorLanguages', () => ({
  getLanguageFromFileName: (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: 'TypeScript',
      tsx: 'TSX',
      js: 'JavaScript',
      json: 'JSON',
      md: 'Markdown',
      py: 'Python',
    };
    return map[ext ?? ''] ?? 'Plain Text';
  },
  getSyncLanguageExtension: vi.fn(),
  getAsyncLanguageDesc: vi.fn(),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// =============================================================================
// Helpers
// =============================================================================

const PROJECT_PATH = '/Users/test/my-project';

function makeEntry(name: string, type: 'file' | 'directory', absPath?: string): FileTreeEntry {
  return {
    name,
    path: absPath ?? `${PROJECT_PATH}/${name}`,
    type,
  };
}

function makeDirResult(entries: FileTreeEntry[], truncated = false): ReadDirResult {
  return { entries, truncated };
}

// =============================================================================
// Tests
// =============================================================================

describe('editorSlice', () => {
  let store: TestStore;

  beforeEach(() => {
    vi.resetAllMocks();
    store = createTestStore();
  });

  describe('initial state', () => {
    it('has null/empty defaults', () => {
      const state = store.getState();
      expect(state.editorProjectPath).toBeNull();
      expect(state.editorFileTree).toBeNull();
      expect(state.editorFileTreeLoading).toBe(false);
      expect(state.editorFileTreeError).toBeNull();
      expect(state.editorExpandedDirs).toEqual({});
    });
  });

  describe('openEditor', () => {
    it('sets loading state, calls API, and stores file tree', async () => {
      const entries = [makeEntry('src', 'directory'), makeEntry('README.md', 'file')];
      mockEditorAPI.open.mockResolvedValue(undefined);
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult(entries));

      await store.getState().openEditor(PROJECT_PATH);

      const state = store.getState();
      expect(state.editorProjectPath).toBe(PROJECT_PATH);
      expect(state.editorFileTree).toEqual(entries);
      expect(state.editorFileTreeLoading).toBe(false);
      expect(state.editorFileTreeError).toBeNull();
      expect(mockEditorAPI.open).toHaveBeenCalledWith(PROJECT_PATH);
      expect(mockEditorAPI.readDir).toHaveBeenCalledWith(PROJECT_PATH);
    });

    it('sets error state on API failure', async () => {
      mockEditorAPI.open.mockRejectedValue(new Error('Permission denied'));

      await store.getState().openEditor(PROJECT_PATH);

      const state = store.getState();
      expect(state.editorFileTreeLoading).toBe(false);
      expect(state.editorFileTreeError).toBe('Permission denied');
      expect(state.editorFileTree).toBeNull();
    });

    it('resets expanded dirs on new open', async () => {
      // Set some expanded dirs manually
      store.setState({ editorExpandedDirs: { '/old/path': true } });

      mockEditorAPI.open.mockResolvedValue(undefined);
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      await store.getState().openEditor(PROJECT_PATH);

      expect(store.getState().editorExpandedDirs).toEqual({});
    });
  });

  describe('closeEditor', () => {
    it('resets all editor state', async () => {
      // Setup non-default state
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [makeEntry('file.ts', 'file')],
        editorFileTreeLoading: true,
        editorFileTreeError: 'some error',
        editorExpandedDirs: { '/path': true },
      });

      mockEditorAPI.close.mockResolvedValue(undefined);

      store.getState().closeEditor();

      const state = store.getState();
      expect(state.editorProjectPath).toBeNull();
      expect(state.editorFileTree).toBeNull();
      expect(state.editorFileTreeLoading).toBe(false);
      expect(state.editorFileTreeError).toBeNull();
      expect(state.editorExpandedDirs).toEqual({});
    });

    it('still resets local state even if IPC close fails', async () => {
      store.setState({ editorProjectPath: PROJECT_PATH });
      mockEditorAPI.close.mockRejectedValue(new Error('IPC error'));

      store.getState().closeEditor();

      // Local state reset immediately (fire-and-forget IPC)
      expect(store.getState().editorProjectPath).toBeNull();
    });
  });

  describe('expandDirectory', () => {
    it('marks directory expanded immediately, then merges children', async () => {
      const srcDir = makeEntry('src', 'directory');
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [srcDir, makeEntry('README.md', 'file')],
      });

      const children = [makeEntry('index.ts', 'file', `${PROJECT_PATH}/src/index.ts`)];
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult(children));

      const expandPromise = store.getState().expandDirectory(srcDir.path);

      // Immediately expanded (optimistic UI)
      expect(store.getState().editorExpandedDirs[srcDir.path]).toBe(true);

      await expandPromise;

      // Children merged into tree
      const tree = store.getState().editorFileTree!;
      const srcNode = tree.find((e) => e.name === 'src');
      expect(srcNode?.children).toEqual(children);
    });

    it('reverts expansion on error', async () => {
      const srcDir = makeEntry('src', 'directory');
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [srcDir],
        editorExpandedDirs: {},
      });

      mockEditorAPI.readDir.mockRejectedValue(new Error('Network error'));

      await store.getState().expandDirectory(srcDir.path);

      // Expansion reverted
      expect(store.getState().editorExpandedDirs[srcDir.path]).toBeUndefined();
    });
  });

  describe('collapseDirectory', () => {
    it('removes directory from expandedDirs', () => {
      const dirPath = PROJECT_PATH + '/src';
      store.setState({ editorExpandedDirs: { [dirPath]: true, '/other': true } });

      store.getState().collapseDirectory(dirPath);

      expect(store.getState().editorExpandedDirs).toEqual({ '/other': true });
    });

    it('no-op when directory not expanded', () => {
      store.setState({ editorExpandedDirs: { '/other': true } });

      store.getState().collapseDirectory('/not-expanded');

      expect(store.getState().editorExpandedDirs).toEqual({ '/other': true });
    });
  });

  // ═══════════════════════════════════════════════════════
  // Group 2: Tab management
  // ═══════════════════════════════════════════════════════

  describe('openFile', () => {
    it('creates a tab and activates it', () => {
      store.getState().openFile('/project/src/index.ts');

      const state = store.getState();
      expect(state.editorOpenTabs).toHaveLength(1);
      expect(state.editorOpenTabs[0].filePath).toBe('/project/src/index.ts');
      expect(state.editorOpenTabs[0].fileName).toBe('index.ts');
      expect(state.editorOpenTabs[0].language).toBe('TypeScript');
      expect(state.editorActiveTabId).toBe('/project/src/index.ts');
    });

    it('activates existing tab instead of creating duplicate', () => {
      store.getState().openFile('/project/src/index.ts');
      store.getState().openFile('/project/src/app.tsx');
      store.getState().openFile('/project/src/index.ts');

      const state = store.getState();
      expect(state.editorOpenTabs).toHaveLength(2);
      expect(state.editorActiveTabId).toBe('/project/src/index.ts');
    });

    it('detects language from file extension', () => {
      store.getState().openFile('/project/data.json');

      expect(store.getState().editorOpenTabs[0].language).toBe('JSON');
    });

    it('uses "Plain Text" for unknown extensions', () => {
      store.getState().openFile('/project/Dockerfile');

      expect(store.getState().editorOpenTabs[0].language).toBe('Plain Text');
    });
  });

  describe('closeEditorTab', () => {
    it('removes tab and activates adjacent', () => {
      store.getState().openFile('/project/a.ts');
      store.getState().openFile('/project/b.ts');
      store.getState().openFile('/project/c.ts');

      // Active is c.ts, close it
      store.getState().closeEditorTab('/project/c.ts');

      const state = store.getState();
      expect(state.editorOpenTabs).toHaveLength(2);
      expect(state.editorActiveTabId).toBe('/project/b.ts');
    });

    it('activates first remaining tab when first is closed', () => {
      store.getState().openFile('/project/a.ts');
      store.getState().openFile('/project/b.ts');
      store.getState().setActiveEditorTab('/project/a.ts');

      store.getState().closeEditorTab('/project/a.ts');

      expect(store.getState().editorActiveTabId).toBe('/project/b.ts');
    });

    it('sets null when last tab is closed', () => {
      store.getState().openFile('/project/a.ts');
      store.getState().closeEditorTab('/project/a.ts');

      expect(store.getState().editorActiveTabId).toBeNull();
      expect(store.getState().editorOpenTabs).toHaveLength(0);
    });

    it('cleans up dirty and error state for closed tab', () => {
      store.getState().openFile('/project/a.ts');
      store.setState({
        editorModifiedFiles: { '/project/a.ts': true },
        editorSaveError: { '/project/a.ts': 'Save failed' },
      });

      store.getState().closeEditorTab('/project/a.ts');

      expect(store.getState().editorModifiedFiles).toEqual({});
      expect(store.getState().editorSaveError).toEqual({});
    });

    it('does not change activeTabId when closing non-active tab', () => {
      store.getState().openFile('/project/a.ts');
      store.getState().openFile('/project/b.ts');
      // b.ts is active

      store.getState().closeEditorTab('/project/a.ts');

      expect(store.getState().editorActiveTabId).toBe('/project/b.ts');
      expect(store.getState().editorOpenTabs).toHaveLength(1);
    });
  });

  describe('setActiveEditorTab', () => {
    it('changes the active tab', () => {
      store.getState().openFile('/project/a.ts');
      store.getState().openFile('/project/b.ts');
      // b.ts is active

      store.getState().setActiveEditorTab('/project/a.ts');

      expect(store.getState().editorActiveTabId).toBe('/project/a.ts');
    });
  });

  // ═══════════════════════════════════════════════════════
  // Group 3: Dirty/Save
  // ═══════════════════════════════════════════════════════

  describe('markFileModified', () => {
    it('sets dirty flag', () => {
      store.getState().markFileModified('/project/a.ts');

      expect(store.getState().editorModifiedFiles['/project/a.ts']).toBe(true);
    });

    it('is idempotent', () => {
      store.getState().markFileModified('/project/a.ts');
      const first = store.getState().editorModifiedFiles;

      store.getState().markFileModified('/project/a.ts');
      const second = store.getState().editorModifiedFiles;

      // Same reference (no unnecessary update)
      expect(first).toBe(second);
    });
  });

  describe('markFileSaved', () => {
    it('removes dirty flag', () => {
      store.setState({ editorModifiedFiles: { '/project/a.ts': true, '/project/b.ts': true } });

      store.getState().markFileSaved('/project/a.ts');

      expect(store.getState().editorModifiedFiles).toEqual({ '/project/b.ts': true });
    });
  });

  describe('hasUnsavedChanges', () => {
    it('returns false when no modified files', () => {
      expect(store.getState().hasUnsavedChanges()).toBe(false);
    });

    it('returns true when modified files exist', () => {
      store.setState({ editorModifiedFiles: { '/project/a.ts': true } });
      expect(store.getState().hasUnsavedChanges()).toBe(true);
    });
  });

  describe('saveFile', () => {
    it('saves file via API and clears dirty flag', async () => {
      const filePath = '/project/src/index.ts';
      mockBridge.getContent.mockReturnValue('new content');
      mockEditorAPI.writeFile.mockResolvedValue({ mtimeMs: Date.now(), size: 11 });

      store.setState({ editorModifiedFiles: { [filePath]: true } });
      await store.getState().saveFile(filePath);

      expect(mockBridge.getContent).toHaveBeenCalledWith(filePath);
      expect(mockEditorAPI.writeFile).toHaveBeenCalledWith(filePath, 'new content', undefined);
      expect(store.getState().editorModifiedFiles[filePath]).toBeUndefined();
      expect(store.getState().editorSaving[filePath]).toBeUndefined();
    });

    it('sets saving flag during save', async () => {
      const filePath = '/project/src/index.ts';
      let savingDuringCall = false;

      mockBridge.getContent.mockReturnValue('content');
      mockEditorAPI.writeFile.mockImplementation(async () => {
        savingDuringCall = !!store.getState().editorSaving[filePath];
        return { mtimeMs: Date.now(), size: 7 };
      });

      await store.getState().saveFile(filePath);

      expect(savingDuringCall).toBe(true);
      expect(store.getState().editorSaving[filePath]).toBeUndefined();
    });

    it('does nothing when bridge has no content', async () => {
      mockBridge.getContent.mockReturnValue(null);

      await store.getState().saveFile('/project/src/index.ts');

      expect(mockEditorAPI.writeFile).not.toHaveBeenCalled();
    });

    it('sets error on save failure', async () => {
      const filePath = '/project/src/index.ts';
      mockBridge.getContent.mockReturnValue('content');
      mockEditorAPI.writeFile.mockRejectedValue(new Error('Permission denied'));

      store.setState({ editorModifiedFiles: { [filePath]: true } });
      await store.getState().saveFile(filePath);

      expect(store.getState().editorSaveError[filePath]).toBe('Permission denied');
      // Dirty flag preserved on error
      expect(store.getState().editorModifiedFiles[filePath]).toBe(true);
      expect(store.getState().editorSaving[filePath]).toBeUndefined();
    });
  });

  describe('saveAllFiles', () => {
    it('saves all modified files', async () => {
      const files = new Map([
        ['/project/a.ts', 'content a'],
        ['/project/b.ts', 'content b'],
      ]);
      mockBridge.getAllModifiedContent.mockReturnValue(files);
      mockEditorAPI.writeFile.mockResolvedValue({ mtimeMs: Date.now(), size: 10 });

      store.setState({
        editorModifiedFiles: { '/project/a.ts': true, '/project/b.ts': true },
      });

      await store.getState().saveAllFiles();

      expect(mockEditorAPI.writeFile).toHaveBeenCalledTimes(2);
      expect(store.getState().editorModifiedFiles).toEqual({});
    });

    it('handles partial failures', async () => {
      const files = new Map([
        ['/project/a.ts', 'content a'],
        ['/project/b.ts', 'content b'],
      ]);
      mockBridge.getAllModifiedContent.mockReturnValue(files);
      mockEditorAPI.writeFile
        .mockResolvedValueOnce({ mtimeMs: Date.now(), size: 10 })
        .mockRejectedValueOnce(new Error('Disk full'));

      store.setState({
        editorModifiedFiles: { '/project/a.ts': true, '/project/b.ts': true },
      });

      await store.getState().saveAllFiles();

      // a.ts saved, b.ts still dirty
      expect(store.getState().editorModifiedFiles['/project/a.ts']).toBeUndefined();
      expect(store.getState().editorModifiedFiles['/project/b.ts']).toBe(true);
      expect(store.getState().editorSaveError['/project/b.ts']).toBe('Disk full');
    });
  });

  describe('discardChanges', () => {
    it('clears dirty flag and error for the file', () => {
      store.setState({
        editorModifiedFiles: { '/project/a.ts': true, '/project/b.ts': true },
        editorSaveError: { '/project/a.ts': 'Error' },
      });

      store.getState().discardChanges('/project/a.ts');

      expect(store.getState().editorModifiedFiles).toEqual({ '/project/b.ts': true });
      expect(store.getState().editorSaveError).toEqual({});
    });
  });

  describe('closeEditor resets all state including Group 2+3', () => {
    it('resets tabs, dirty, saving, errors', () => {
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorOpenTabs: [
          { id: '/a.ts', filePath: '/a.ts', fileName: 'a.ts', language: 'TypeScript' },
        ],
        editorActiveTabId: '/a.ts',
        editorModifiedFiles: { '/a.ts': true },
        editorSaving: { '/a.ts': true },
        editorSaveError: { '/a.ts': 'Error' },
      });

      mockEditorAPI.close.mockResolvedValue(undefined);
      store.getState().closeEditor();

      const state = store.getState();
      expect(state.editorOpenTabs).toEqual([]);
      expect(state.editorActiveTabId).toBeNull();
      expect(state.editorModifiedFiles).toEqual({});
      expect(state.editorSaving).toEqual({});
      expect(state.editorSaveError).toEqual({});
      expect(mockBridge.destroy).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════
  // Tab disambiguation
  // ═══════════════════════════════════════════════════════

  describe('openFile with disambiguation', () => {
    it('adds disambiguation labels when 2 files share the same name', () => {
      store.getState().openFile('/project/src/main/index.ts');
      store.getState().openFile('/project/src/renderer/index.ts');

      const tabs = store.getState().editorOpenTabs;
      expect(tabs).toHaveLength(2);
      expect(tabs[0].disambiguatedLabel).toBe('(main)');
      expect(tabs[1].disambiguatedLabel).toBe('(renderer)');
    });

    it('no labels when names are unique', () => {
      store.getState().openFile('/project/src/app.ts');
      store.getState().openFile('/project/src/index.ts');

      const tabs = store.getState().editorOpenTabs;
      expect(tabs[0].disambiguatedLabel).toBeUndefined();
      expect(tabs[1].disambiguatedLabel).toBeUndefined();
    });
  });

  describe('closeEditorTab clears disambiguation when names become unique', () => {
    it('removes label after closing duplicate', () => {
      store.getState().openFile('/project/src/main/index.ts');
      store.getState().openFile('/project/src/renderer/index.ts');

      // Both have labels
      expect(store.getState().editorOpenTabs[0].disambiguatedLabel).toBe('(main)');

      // Close one
      store.getState().closeEditorTab('/project/src/main/index.ts');

      // Remaining should lose its label
      const tabs = store.getState().editorOpenTabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].disambiguatedLabel).toBeUndefined();
    });
  });

  describe('closeEditorTab calls editorBridge.deleteState', () => {
    it('clears cached state for the closed tab', () => {
      store.getState().openFile('/project/a.ts');
      store.getState().closeEditorTab('/project/a.ts');

      expect(mockBridge.deleteState).toHaveBeenCalledWith('/project/a.ts');
    });
  });

  // ═══════════════════════════════════════════════════════
  // Group 4: File operations
  // ═══════════════════════════════════════════════════════

  describe('createFileInTree', () => {
    it('creates file, refreshes tree, and returns path', async () => {
      const createdPath = '/project/src/new-file.ts';
      mockEditorAPI.createFile.mockResolvedValue({ filePath: createdPath, mtimeMs: 123 });
      mockEditorAPI.readDir.mockResolvedValue(
        makeDirResult([makeEntry('new-file.ts', 'file', createdPath)])
      );

      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [makeEntry('src', 'directory')],
      });

      const result = await store.getState().createFileInTree('/project/src', 'new-file.ts');

      expect(result).toBe(createdPath);
      expect(mockEditorAPI.createFile).toHaveBeenCalledWith('/project/src', 'new-file.ts');
      expect(store.getState().editorCreating).toBe(false);
      expect(store.getState().editorCreateError).toBeNull();
    });

    it('sets error on failure', async () => {
      mockEditorAPI.createFile.mockRejectedValue(new Error('File already exists'));

      const result = await store.getState().createFileInTree('/project/src', 'existing.ts');

      expect(result).toBeNull();
      expect(store.getState().editorCreating).toBe(false);
      expect(store.getState().editorCreateError).toBe('File already exists');
    });
  });

  describe('createDirInTree', () => {
    it('creates directory, refreshes tree, and returns path', async () => {
      const createdPath = '/project/src/new-dir';
      mockEditorAPI.createDir.mockResolvedValue({ dirPath: createdPath });
      mockEditorAPI.readDir.mockResolvedValue(
        makeDirResult([makeEntry('new-dir', 'directory', createdPath)])
      );

      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [makeEntry('src', 'directory')],
      });

      const result = await store.getState().createDirInTree('/project/src', 'new-dir');

      expect(result).toBe(createdPath);
      expect(mockEditorAPI.createDir).toHaveBeenCalledWith('/project/src', 'new-dir');
    });
  });

  describe('deleteFileFromTree', () => {
    it('deletes file and closes its tab if open', async () => {
      mockEditorAPI.deleteFile.mockResolvedValue({ deletedPath: '/project/src/old.ts' });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.getState().openFile('/project/src/old.ts');
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [makeEntry('src', 'directory')],
      });

      const result = await store.getState().deleteFileFromTree('/project/src/old.ts');

      expect(result).toBe(true);
      expect(mockEditorAPI.deleteFile).toHaveBeenCalledWith('/project/src/old.ts');
      // Tab should be closed
      expect(store.getState().editorOpenTabs).toHaveLength(0);
    });

    it('returns false on failure', async () => {
      mockEditorAPI.deleteFile.mockRejectedValue(new Error('Permission denied'));

      const result = await store.getState().deleteFileFromTree('/project/src/file.ts');

      expect(result).toBe(false);
    });

    it('closes tabs for files inside deleted directory', async () => {
      mockEditorAPI.deleteFile.mockResolvedValue({ deletedPath: '/project/src' });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.getState().openFile('/project/src/a.ts');
      store.getState().openFile('/project/src/b.ts');
      store.getState().openFile('/project/other.ts');

      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [makeEntry('src', 'directory'), makeEntry('other.ts', 'file')],
      });

      await store.getState().deleteFileFromTree('/project/src');

      // Only other.ts should remain
      expect(store.getState().editorOpenTabs).toHaveLength(1);
      expect(store.getState().editorOpenTabs[0].filePath).toBe('/project/other.ts');
    });
  });

  // ═══════════════════════════════════════════════════════
  // moveFileInTree
  // ═══════════════════════════════════════════════════════

  describe('moveFileInTree', () => {
    const SRC_DIR = PROJECT_PATH + '/src';
    const LIB_DIR = PROJECT_PATH + '/lib';

    it('moves file, updates tabs, and returns true', async () => {
      const oldPath = SRC_DIR + '/utils.ts';
      const newPath = LIB_DIR + '/utils.ts';
      mockEditorAPI.moveFile.mockResolvedValue({ newPath, isDirectory: false });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.getState().openFile(oldPath);
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorFileTree: [makeEntry('src', 'directory'), makeEntry('lib', 'directory')],
      });

      const result = await store.getState().moveFileInTree(oldPath, LIB_DIR);

      expect(result).toBe(true);
      expect(mockEditorAPI.moveFile).toHaveBeenCalledWith(oldPath, LIB_DIR);

      // Tab should be remapped to new path
      const tabs = store.getState().editorOpenTabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].filePath).toBe(newPath);
      expect(tabs[0].id).toBe(newPath);
      expect(tabs[0].fileName).toBe('utils.ts');
    });

    it('remaps activeTabId when moved file is active', async () => {
      const oldPath = SRC_DIR + '/index.ts';
      const newPath = LIB_DIR + '/index.ts';
      mockEditorAPI.moveFile.mockResolvedValue({ newPath, isDirectory: false });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.getState().openFile(oldPath);
      store.setState({ editorProjectPath: PROJECT_PATH });

      await store.getState().moveFileInTree(oldPath, LIB_DIR);

      expect(store.getState().editorActiveTabId).toBe(newPath);
    });

    it('remaps modifiedFiles and fileMtimes', async () => {
      const oldPath = SRC_DIR + '/dirty.ts';
      const newPath = LIB_DIR + '/dirty.ts';
      mockEditorAPI.moveFile.mockResolvedValue({ newPath, isDirectory: false });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorModifiedFiles: { [oldPath]: true },
        editorFileMtimes: { [oldPath]: 123456 },
      });

      await store.getState().moveFileInTree(oldPath, LIB_DIR);

      expect(store.getState().editorModifiedFiles[newPath]).toBe(true);
      expect(store.getState().editorModifiedFiles[oldPath]).toBeUndefined();
      expect(store.getState().editorFileMtimes[newPath]).toBe(123456);
      expect(store.getState().editorFileMtimes[oldPath]).toBeUndefined();
    });

    it('handles directory move (prefix remapping of nested tabs)', async () => {
      const oldDir = SRC_DIR + '/components';
      const newDir = LIB_DIR + '/components';
      const oldFilePath = oldDir + '/Button.tsx';
      const newFilePath = newDir + '/Button.tsx';
      mockEditorAPI.moveFile.mockResolvedValue({ newPath: newDir, isDirectory: true });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.getState().openFile(oldFilePath);
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorModifiedFiles: { [oldFilePath]: true },
        editorExpandedDirs: { [oldDir]: true },
      });

      await store.getState().moveFileInTree(oldDir, LIB_DIR);

      // Tab should be remapped
      const tabs = store.getState().editorOpenTabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].filePath).toBe(newFilePath);

      // Modified files remapped
      expect(store.getState().editorModifiedFiles[newFilePath]).toBe(true);
      expect(store.getState().editorModifiedFiles[oldFilePath]).toBeUndefined();

      // Expanded dirs remapped
      expect(store.getState().editorExpandedDirs[newDir]).toBe(true);
      expect(store.getState().editorExpandedDirs[oldDir]).toBeUndefined();
    });

    it('blocks during save', async () => {
      const filePath = SRC_DIR + '/saving.ts';
      store.setState({
        editorProjectPath: PROJECT_PATH,
        editorSaving: { [filePath]: true },
      });

      const result = await store.getState().moveFileInTree(filePath, LIB_DIR);

      expect(result).toBe(false);
      expect(mockEditorAPI.moveFile).not.toHaveBeenCalled();
    });

    it('returns false on API error', async () => {
      const filePath = SRC_DIR + '/index.ts';
      mockEditorAPI.moveFile.mockRejectedValue(new Error('Permission denied'));

      store.setState({ editorProjectPath: PROJECT_PATH });

      const result = await store.getState().moveFileInTree(filePath, LIB_DIR);

      expect(result).toBe(false);
    });

    it('calls editorBridge.remapState for affected files', async () => {
      const oldPath = SRC_DIR + '/bridge.ts';
      const newPath = LIB_DIR + '/bridge.ts';
      mockEditorAPI.moveFile.mockResolvedValue({ newPath, isDirectory: false });
      mockEditorAPI.readDir.mockResolvedValue(makeDirResult([]));

      store.getState().openFile(oldPath);
      store.setState({ editorProjectPath: PROJECT_PATH });

      await store.getState().moveFileInTree(oldPath, LIB_DIR);

      expect(mockBridge.remapState).toHaveBeenCalledWith(oldPath, newPath);
    });
  });
});
