/**
 * Editor slice — manages project editor state.
 *
 * Group 1: File tree state + actions (iter-1)
 * Group 2: Tab management (iter-2)
 * Group 3: Dirty/save state (iter-2)
 * Group 4: File operations (iter-3)
 */

import { api } from '@renderer/api';
import { getLanguageFromFileName } from '@renderer/utils/codemirrorLanguages';
import { editorBridge } from '@renderer/utils/editorBridge';
import { computeDisambiguatedTabs } from '@renderer/utils/tabLabelDisambiguation';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type {
  EditorFileChangeEvent,
  EditorFileTab,
  FileTreeEntry,
  GitFileStatus,
} from '@shared/types/editor';
import type { StateCreator } from 'zustand';

const log = createLogger('Store:editor');

/** Remove a key from a record without triggering unused-variable linting. */
function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  const result = { ...record };
  delete result[key];
  return result;
}

/**
 * Cooldown map: filePath → timestamp of last successful save.
 *
 * Used to suppress watcher events that arrive after editorSaving is cleared
 * (race condition: atomic write → IPC response → clear saving flag → watcher fires).
 * macOS FSEvents can delay up to ~1s; 2s cooldown covers all platforms safely.
 *
 * Module-level (not in store state) to avoid unnecessary re-renders.
 */
const recentSaveTimestamps = new Map<string, number>();
const SAVE_COOLDOWN_MS = 2000;

/**
 * Cooldown map: filePath → timestamp of last successful move.
 * Suppresses watcher events triggered by our own move operations.
 */
const recentMoveTimestamps = new Map<string, number>();
const MOVE_COOLDOWN_MS = 2000;

// =============================================================================
// Slice Interface
// =============================================================================

export interface EditorSlice {
  // ═══════════════════════════════════════════════════════
  // Group 1: File tree state + actions
  // ═══════════════════════════════════════════════════════
  editorProjectPath: string | null;
  editorFileTree: FileTreeEntry[] | null;
  editorFileTreeLoading: boolean;
  editorFileTreeError: string | null;
  editorExpandedDirs: Record<string, boolean>;

  openEditor: (projectPath: string) => Promise<void>;
  closeEditor: () => void;
  loadFileTree: (dirPath: string) => Promise<void>;
  expandDirectory: (dirPath: string) => Promise<void>;
  collapseDirectory: (dirPath: string) => void;

  // ═══════════════════════════════════════════════════════
  // Group 2: Tab management
  // ═══════════════════════════════════════════════════════
  editorOpenTabs: EditorFileTab[];
  editorActiveTabId: string | null;

  openFile: (filePath: string) => void;
  closeEditorTab: (tabId: string) => void;
  setActiveEditorTab: (tabId: string) => void;

  // ═══════════════════════════════════════════════════════
  // Group 3: Content + Save
  // Content lives in EditorState (Map<tabId, EditorState> in useRef).
  // Store only tracks dirty flags, loading, and save status.
  // ═══════════════════════════════════════════════════════
  editorFileLoading: Record<string, boolean>;
  editorModifiedFiles: Record<string, boolean>;
  editorSaving: Record<string, boolean>;
  editorSaveError: Record<string, string>;

  markFileModified: (filePath: string) => void;
  markFileSaved: (filePath: string) => void;
  saveFile: (filePath: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  discardChanges: (filePath: string) => void;
  hasUnsavedChanges: () => boolean;

  // ═══════════════════════════════════════════════════════
  // Group 4: File operations (iter-3)
  // ═══════════════════════════════════════════════════════
  editorCreating: boolean;
  editorCreateError: string | null;

  createFileInTree: (parentDir: string, fileName: string) => Promise<string | null>;
  createDirInTree: (parentDir: string, dirName: string) => Promise<string | null>;
  deleteFileFromTree: (filePath: string) => Promise<boolean>;
  moveFileInTree: (sourcePath: string, destDir: string) => Promise<boolean>;

  // ═══════════════════════════════════════════════════════
  // Group 5: Git status + file watcher + line wrap (iter-5)
  // ═══════════════════════════════════════════════════════
  editorGitFiles: GitFileStatus[];
  editorGitBranch: string | null;
  editorIsGitRepo: boolean;
  editorGitLoading: boolean;
  editorWatcherEnabled: boolean;
  editorLineWrap: boolean;
  /** Files changed on disk while open (absolute paths) */
  editorExternalChanges: Record<string, EditorFileChangeEvent['type']>;
  /** Baseline mtime per file (for conflict detection) */
  editorFileMtimes: Record<string, number>;
  /** File path with active save conflict (null = no conflict) */
  editorConflictFile: string | null;

  /** Pending line to scroll to after file loads (1-based). Set by search result click. */
  editorPendingGoToLine: number | null;
  setPendingGoToLine: (line: number | null) => void;

  fetchGitStatus: () => Promise<void>;
  toggleWatcher: (enable: boolean) => Promise<void>;
  toggleLineWrap: () => void;
  handleExternalFileChange: (event: EditorFileChangeEvent) => void;
  clearExternalChange: (filePath: string) => void;
  setFileMtime: (filePath: string, mtimeMs: number) => void;
  forceOverwrite: (filePath: string) => Promise<void>;
  resolveConflict: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set, get) => ({
  // Group 1 initial state
  editorProjectPath: null,
  editorFileTree: null,
  editorFileTreeLoading: false,
  editorFileTreeError: null,
  editorExpandedDirs: {},

  // Group 2 initial state
  editorOpenTabs: [],
  editorActiveTabId: null,

  // Group 3 initial state
  editorFileLoading: {},
  editorModifiedFiles: {},
  editorSaving: {},
  editorSaveError: {},

  // Group 4 initial state
  editorCreating: false,
  editorCreateError: null,

  // Group 5 initial state
  editorGitFiles: [],
  editorGitBranch: null,
  editorIsGitRepo: false,
  editorGitLoading: false,
  editorWatcherEnabled: false,
  editorLineWrap: (() => {
    try {
      return localStorage.getItem('editor-line-wrap') === 'true';
    } catch {
      return false;
    }
  })(),
  editorExternalChanges: {},
  editorFileMtimes: {},
  editorConflictFile: null,
  editorPendingGoToLine: null,

  setPendingGoToLine: (line: number | null) => set({ editorPendingGoToLine: line }),

  // ═══════════════════════════════════════════════════════
  // Group 1: File tree actions
  // ═══════════════════════════════════════════════════════

  openEditor: async (projectPath: string) => {
    set({
      editorProjectPath: projectPath,
      editorFileTree: null,
      editorFileTreeLoading: true,
      editorFileTreeError: null,
      editorExpandedDirs: {},
      editorOpenTabs: [],
      editorActiveTabId: null,
      editorFileLoading: {},
      editorModifiedFiles: {},
      editorSaving: {},
      editorSaveError: {},
      editorCreating: false,
      editorCreateError: null,
      editorGitFiles: [],
      editorGitBranch: null,
      editorIsGitRepo: false,
      editorGitLoading: false,
      editorWatcherEnabled: false,
      editorExternalChanges: {},
      editorFileMtimes: {},
      editorConflictFile: null,
      editorPendingGoToLine: null,
    });

    try {
      await api.editor.open(projectPath);
      const result = await api.editor.readDir(projectPath);
      set({
        editorFileTree: result.entries,
        editorFileTreeLoading: false,
      });

      // Fetch git status in background (non-blocking)
      void get().fetchGitStatus();

      // Auto-enable file watcher (standard editor behavior)
      void get().toggleWatcher(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to open editor:', message);
      set({
        editorFileTreeLoading: false,
        editorFileTreeError: message,
      });
    }
  },

  closeEditor: () => {
    // Clear cooldown timestamps (no stale entries across editor sessions)
    recentSaveTimestamps.clear();
    recentMoveTimestamps.clear();

    // Best-effort IPC cleanup
    api.editor.close().catch((e: unknown) => {
      log.error('editor:close failed:', e);
    });

    // Cleanup bridge (destroys EditorView, clears caches)
    editorBridge.destroy();

    set({
      editorProjectPath: null,
      editorFileTree: null,
      editorFileTreeLoading: false,
      editorFileTreeError: null,
      editorExpandedDirs: {},
      editorOpenTabs: [],
      editorActiveTabId: null,
      editorFileLoading: {},
      editorModifiedFiles: {},
      editorSaving: {},
      editorSaveError: {},
      editorCreating: false,
      editorCreateError: null,
      editorGitFiles: [],
      editorGitBranch: null,
      editorIsGitRepo: false,
      editorGitLoading: false,
      editorWatcherEnabled: false,
      editorExternalChanges: {},
      editorFileMtimes: {},
      editorConflictFile: null,
      editorPendingGoToLine: null,
    });
  },

  loadFileTree: async (dirPath: string) => {
    set({ editorFileTreeLoading: true, editorFileTreeError: null });

    try {
      const result = await api.editor.readDir(dirPath);
      set({
        editorFileTree: result.entries,
        editorFileTreeLoading: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to load file tree:', message);
      set({
        editorFileTreeLoading: false,
        editorFileTreeError: message,
      });
    }
  },

  expandDirectory: async (dirPath: string) => {
    const { editorExpandedDirs, editorFileTree } = get();

    // Mark as expanded immediately for responsive UI
    set({
      editorExpandedDirs: { ...editorExpandedDirs, [dirPath]: true },
    });

    try {
      const result = await api.editor.readDir(dirPath);
      const updatedTree = mergeChildrenIntoTree(editorFileTree ?? [], dirPath, result.entries);
      set({ editorFileTree: updatedTree });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to expand directory:', message);
      const current = get().editorExpandedDirs;
      set({ editorExpandedDirs: omitKey(current, dirPath) });
    }
  },

  collapseDirectory: (dirPath: string) => {
    const { editorExpandedDirs } = get();
    set({ editorExpandedDirs: omitKey(editorExpandedDirs, dirPath) });
  },

  // ═══════════════════════════════════════════════════════
  // Group 2: Tab management
  // ═══════════════════════════════════════════════════════

  openFile: (filePath: string) => {
    const { editorOpenTabs } = get();

    // Dedup: if file already open, just activate it
    const existing = editorOpenTabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ editorActiveTabId: existing.id });
      return;
    }

    const fileName = filePath.split('/').pop() ?? 'file';
    const language = getLanguageFromFileName(fileName);

    const tab: EditorFileTab = {
      id: filePath,
      filePath,
      fileName,
      language,
    };

    const newTabs = computeDisambiguatedTabs([...editorOpenTabs, tab]);

    set({
      editorOpenTabs: newTabs,
      editorActiveTabId: tab.id,
    });
  },

  closeEditorTab: (tabId: string) => {
    const { editorOpenTabs, editorActiveTabId, editorModifiedFiles, editorSaveError } = get();
    const filtered = editorOpenTabs.filter((t) => t.id !== tabId);

    // Clean up dirty/error state for closed tab
    const restModified = omitKey(editorModifiedFiles, tabId);
    const restErrors = omitKey(editorSaveError, tabId);

    // Clear cached EditorState from bridge
    editorBridge.deleteState(tabId);

    // Clear draft from localStorage
    try {
      localStorage.removeItem(`editor-draft:${tabId}`);
    } catch {
      // localStorage may not be available
    }

    let newActiveId = editorActiveTabId;
    if (editorActiveTabId === tabId) {
      // Activate adjacent tab
      const closedIndex = editorOpenTabs.findIndex((t) => t.id === tabId);
      if (filtered.length > 0) {
        newActiveId = filtered[Math.min(closedIndex, filtered.length - 1)].id;
      } else {
        newActiveId = null;
      }
    }

    // Recompute disambiguation after removing tab
    const disambiguated = computeDisambiguatedTabs(filtered);

    set({
      editorOpenTabs: disambiguated,
      editorActiveTabId: newActiveId,
      editorModifiedFiles: restModified,
      editorSaveError: restErrors,
    });
  },

  setActiveEditorTab: (tabId: string) => {
    set({ editorActiveTabId: tabId });
  },

  // ═══════════════════════════════════════════════════════
  // Group 3: Content + Save
  // ═══════════════════════════════════════════════════════

  markFileModified: (filePath: string) => {
    const { editorModifiedFiles } = get();
    if (editorModifiedFiles[filePath]) return; // Already marked
    set({ editorModifiedFiles: { ...editorModifiedFiles, [filePath]: true } });
  },

  markFileSaved: (filePath: string) => {
    const { editorModifiedFiles } = get();
    set({ editorModifiedFiles: omitKey(editorModifiedFiles, filePath) });
  },

  saveFile: async (filePath: string) => {
    const content = editorBridge.getContent(filePath);
    if (content === null) {
      log.error('saveFile: no content available for', filePath);
      return;
    }

    set((s) => ({
      editorSaving: { ...s.editorSaving, [filePath]: true },
      editorSaveError: omitKey(s.editorSaveError, filePath),
    }));

    try {
      // Pass baseline mtime for conflict detection (if available)
      const baselineMtime = get().editorFileMtimes[filePath];
      const result = await api.editor.writeFile(filePath, content, baselineMtime);

      // Record save timestamp BEFORE clearing editorSaving (watcher race guard)
      recentSaveTimestamps.set(filePath, Date.now());

      // Update baseline mtime with the new value after successful save
      set((s) => ({
        editorModifiedFiles: omitKey(s.editorModifiedFiles, filePath),
        editorSaving: omitKey(s.editorSaving, filePath),
        editorFileMtimes: { ...s.editorFileMtimes, [filePath]: result.mtimeMs },
        editorExternalChanges: omitKey(s.editorExternalChanges, filePath),
      }));

      try {
        localStorage.removeItem(`editor-draft:${filePath}`);
      } catch {
        // localStorage may not be available
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Handle conflict errors specifically
      if (message.startsWith('CONFLICT')) {
        log.error('Save conflict detected:', filePath);
        set((s) => ({
          editorSaving: omitKey(s.editorSaving, filePath),
          editorConflictFile: filePath,
        }));
        return;
      }

      log.error('Failed to save file:', message);
      set((s) => ({
        editorSaving: omitKey(s.editorSaving, filePath),
        editorSaveError: { ...s.editorSaveError, [filePath]: message },
      }));
    }
  },

  saveAllFiles: async () => {
    const { editorModifiedFiles } = get();
    const modifiedContent = editorBridge.getAllModifiedContent(editorModifiedFiles);

    const promises: Promise<void>[] = [];
    for (const [filePath, content] of modifiedContent) {
      promises.push(
        (async () => {
          set((s) => ({
            editorSaving: { ...s.editorSaving, [filePath]: true },
          }));

          try {
            const baselineMtime = get().editorFileMtimes[filePath];
            const result = await api.editor.writeFile(filePath, content, baselineMtime);

            // Record save timestamp BEFORE clearing editorSaving (watcher race guard)
            recentSaveTimestamps.set(filePath, Date.now());

            set((s) => ({
              editorModifiedFiles: omitKey(s.editorModifiedFiles, filePath),
              editorSaving: omitKey(s.editorSaving, filePath),
              editorFileMtimes: { ...s.editorFileMtimes, [filePath]: result.mtimeMs },
              editorExternalChanges: omitKey(s.editorExternalChanges, filePath),
            }));
            try {
              localStorage.removeItem(`editor-draft:${filePath}`);
            } catch {
              // ignore
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (message.startsWith('CONFLICT')) {
              log.error('Save conflict detected:', filePath);
              set((s) => ({
                editorSaving: omitKey(s.editorSaving, filePath),
                editorConflictFile: filePath,
              }));
              return;
            }

            log.error('Failed to save file:', filePath, message);
            set((s) => ({
              editorSaving: omitKey(s.editorSaving, filePath),
              editorSaveError: { ...s.editorSaveError, [filePath]: message },
            }));
          }
        })()
      );
    }

    await Promise.allSettled(promises);
  },

  discardChanges: (filePath: string) => {
    const { editorModifiedFiles, editorSaveError } = get();
    set({
      editorModifiedFiles: omitKey(editorModifiedFiles, filePath),
      editorSaveError: omitKey(editorSaveError, filePath),
    });

    try {
      localStorage.removeItem(`editor-draft:${filePath}`);
    } catch {
      // localStorage may not be available
    }
  },

  hasUnsavedChanges: () => {
    return Object.keys(get().editorModifiedFiles).length > 0;
  },

  // ═══════════════════════════════════════════════════════
  // Group 4: File operations
  // ═══════════════════════════════════════════════════════

  createFileInTree: async (parentDir: string, fileName: string) => {
    set({ editorCreating: true, editorCreateError: null });

    try {
      const result = await api.editor.createFile(parentDir, fileName);

      // Refresh parent directory in the tree
      await refreshDirectory(get, set, parentDir);

      set({ editorCreating: false });
      return result.filePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to create file:', message);
      set({ editorCreating: false, editorCreateError: message });
      return null;
    }
  },

  createDirInTree: async (parentDir: string, dirName: string) => {
    set({ editorCreating: true, editorCreateError: null });

    try {
      const result = await api.editor.createDir(parentDir, dirName);

      // Refresh parent directory in the tree
      await refreshDirectory(get, set, parentDir);

      set({ editorCreating: false });
      return result.dirPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to create directory:', message);
      set({ editorCreating: false, editorCreateError: message });
      return null;
    }
  },

  deleteFileFromTree: async (filePath: string) => {
    try {
      await api.editor.deleteFile(filePath);

      // Close tab if the deleted file is open
      const { editorOpenTabs } = get();
      const tabsToClose = editorOpenTabs.filter(
        (t) => t.filePath === filePath || t.filePath.startsWith(filePath + '/')
      );
      for (const tab of tabsToClose) {
        get().closeEditorTab(tab.id);
      }

      // Refresh parent directory
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir) {
        await refreshDirectory(get, set, parentDir);
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to delete file:', message);
      return false;
    }
  },

  moveFileInTree: async (sourcePath: string, destDir: string) => {
    const { editorSaving } = get();

    // Guard: don't move during save
    if (editorSaving[sourcePath]) {
      log.error('moveFileInTree: blocked — file is being saved:', sourcePath);
      return false;
    }

    try {
      const result = await api.editor.moveFile(sourcePath, destDir);
      const { newPath, isDirectory } = result;
      const oldParent = sourcePath.substring(0, sourcePath.lastIndexOf('/'));

      // Record move timestamps for watcher cooldown
      recentMoveTimestamps.set(sourcePath, Date.now());
      recentMoveTimestamps.set(newPath, Date.now());

      // Atomic remap of all path-keyed state
      set((s) => {
        const tabs = s.editorOpenTabs.map((tab) => {
          const remapped = remapPath(tab.filePath, sourcePath, newPath);
          if (remapped === tab.filePath) return tab;
          const fileName = remapped.split('/').pop() ?? 'file';
          return {
            ...tab,
            id: remapped,
            filePath: remapped,
            fileName,
            language: getLanguageFromFileName(fileName),
          };
        });

        return {
          editorOpenTabs: computeDisambiguatedTabs(tabs),
          editorActiveTabId:
            remapPath(s.editorActiveTabId ?? '', sourcePath, newPath) || s.editorActiveTabId,
          editorModifiedFiles: remapRecord(s.editorModifiedFiles, sourcePath, newPath),
          editorSaving: remapRecord(s.editorSaving, sourcePath, newPath),
          editorSaveError: remapRecord(s.editorSaveError, sourcePath, newPath),
          editorFileLoading: remapRecord(s.editorFileLoading, sourcePath, newPath),
          editorExternalChanges: remapRecord(s.editorExternalChanges, sourcePath, newPath),
          editorFileMtimes: remapRecord(s.editorFileMtimes, sourcePath, newPath),
          editorExpandedDirs: remapRecord(s.editorExpandedDirs, sourcePath, newPath),
        };
      });

      // Remap bridge state for each affected tab
      const { editorOpenTabs } = get();
      for (const tab of editorOpenTabs) {
        // Check if this tab was affected by the move
        const originalPath = reverseRemapPath(tab.filePath, sourcePath, newPath);
        if (originalPath !== tab.filePath) {
          editorBridge.remapState(originalPath, tab.filePath);
        }
      }
      // Also remap for single file case (directories have no direct bridge state)
      if (!isDirectory) {
        editorBridge.remapState(sourcePath, newPath);
      }

      // Remap localStorage drafts
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('editor-draft:')) {
            const draftPath = key.slice('editor-draft:'.length);
            const remapped = remapPath(draftPath, sourcePath, newPath);
            if (remapped !== draftPath) {
              const value = localStorage.getItem(key);
              localStorage.removeItem(key);
              if (value !== null) localStorage.setItem(`editor-draft:${remapped}`, value);
            }
          }
        }
      } catch {
        // localStorage may not be available
      }

      // Remap recentSaveTimestamps
      for (const [key, ts] of [...recentSaveTimestamps.entries()]) {
        const remapped = remapPath(key, sourcePath, newPath);
        if (remapped !== key) {
          recentSaveTimestamps.delete(key);
          recentSaveTimestamps.set(remapped, ts);
        }
      }

      // Refresh directories and git status in background
      void refreshDirectory(get, set, oldParent);
      void refreshDirectory(get, set, destDir);
      void get().fetchGitStatus();

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('moveFileInTree failed:', message);
      return false;
    }
  },

  // ═══════════════════════════════════════════════════════
  // Group 5: Git status + file watcher + line wrap
  // ═══════════════════════════════════════════════════════

  fetchGitStatus: async () => {
    set({ editorGitLoading: true });
    try {
      const result = await api.editor.gitStatus();
      set({
        editorGitFiles: result.files,
        editorGitBranch: result.branch,
        editorIsGitRepo: result.isGitRepo,
        editorGitLoading: false,
      });
    } catch (error) {
      log.error('Failed to fetch git status:', error);
      set({ editorGitLoading: false });
    }
  },

  toggleWatcher: async (enable: boolean) => {
    try {
      await api.editor.watchDir(enable);
      set({ editorWatcherEnabled: enable });
    } catch (error) {
      log.error('Failed to toggle watcher:', error);
    }
  },

  toggleLineWrap: () => {
    set((s) => {
      const next = !s.editorLineWrap;
      try {
        localStorage.setItem('editor-line-wrap', String(next));
      } catch {
        // localStorage may not be available
      }
      return { editorLineWrap: next };
    });
  },

  handleExternalFileChange: (event: EditorFileChangeEvent) => {
    const { editorOpenTabs, editorProjectPath, editorSaving } = get();

    // Ignore watcher events for files we are currently saving (our own write)
    if (editorSaving[event.path]) return;

    // Ignore watcher events within cooldown after save
    // (covers race: save completes → editorSaving cleared → watcher fires late)
    const lastSaveTime = recentSaveTimestamps.get(event.path);
    if (lastSaveTime && Date.now() - lastSaveTime < SAVE_COOLDOWN_MS) return;

    // Ignore watcher events within cooldown after move
    const lastMoveTime = recentMoveTimestamps.get(event.path);
    if (lastMoveTime && Date.now() - lastMoveTime < MOVE_COOLDOWN_MS) return;

    // Track changes for open files
    const isOpenFile = editorOpenTabs.some((t) => t.filePath === event.path);
    if (isOpenFile || event.type === 'delete') {
      set((s) => ({
        editorExternalChanges: {
          ...s.editorExternalChanges,
          [event.path]: event.type,
        },
      }));
    }

    // Refresh git status on any change
    void get().fetchGitStatus();

    // Refresh parent directory in tree for create/delete
    if (event.type === 'create' || event.type === 'delete') {
      const parentDir = event.path.substring(0, event.path.lastIndexOf('/'));
      if (parentDir && editorProjectPath) {
        void refreshDirectory(get, set, parentDir);
      }
    }
  },

  clearExternalChange: (filePath: string) => {
    set((s) => ({
      editorExternalChanges: omitKey(s.editorExternalChanges, filePath),
    }));
  },

  setFileMtime: (filePath: string, mtimeMs: number) => {
    set((s) => ({
      editorFileMtimes: { ...s.editorFileMtimes, [filePath]: mtimeMs },
    }));
  },

  forceOverwrite: async (filePath: string) => {
    const content = editorBridge.getContent(filePath);
    if (content === null) {
      log.error('forceOverwrite: no content available for', filePath);
      return;
    }

    set((s) => ({
      editorSaving: { ...s.editorSaving, [filePath]: true },
      editorConflictFile: null,
    }));

    try {
      // No baselineMtimeMs → skip conflict check on backend
      const result = await api.editor.writeFile(filePath, content);

      // Record save timestamp BEFORE clearing editorSaving (watcher race guard)
      recentSaveTimestamps.set(filePath, Date.now());

      set((s) => ({
        editorModifiedFiles: omitKey(s.editorModifiedFiles, filePath),
        editorSaving: omitKey(s.editorSaving, filePath),
        editorFileMtimes: { ...s.editorFileMtimes, [filePath]: result.mtimeMs },
        editorExternalChanges: omitKey(s.editorExternalChanges, filePath),
      }));

      try {
        localStorage.removeItem(`editor-draft:${filePath}`);
      } catch {
        // localStorage may not be available
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to force overwrite:', message);
      set((s) => ({
        editorSaving: omitKey(s.editorSaving, filePath),
        editorSaveError: { ...s.editorSaveError, [filePath]: message },
      }));
    }
  },

  resolveConflict: () => {
    set({ editorConflictFile: null });
  },
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Refresh a directory's children in the file tree via IPC readDir + merge.
 */
async function refreshDirectory(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  dirPath: string
): Promise<void> {
  try {
    const result = await api.editor.readDir(dirPath);
    const currentTree = get().editorFileTree;
    if (currentTree) {
      const updatedTree = mergeChildrenIntoTree(currentTree, dirPath, result.entries);
      set({ editorFileTree: updatedTree });
    }
  } catch (error) {
    log.error('Failed to refresh directory:', error);
  }
}

/**
 * Remap a single path: if it matches oldPath exactly or is a child of oldPath,
 * replace the prefix with newPath.
 */
function remapPath(p: string, oldPath: string, newPath: string): string {
  if (p === oldPath) return newPath;
  if (p.startsWith(oldPath + '/')) {
    return newPath + p.slice(oldPath.length);
  }
  return p;
}

/**
 * Reverse remap: given a potentially-remapped path, recover the original path.
 * Used to identify which bridge caches to remap.
 */
function reverseRemapPath(p: string, oldPath: string, newPath: string): string {
  if (p === newPath) return oldPath;
  if (p.startsWith(newPath + '/')) {
    return oldPath + p.slice(newPath.length);
  }
  return p;
}

/**
 * Remap all keys in a Record that match or are children of oldPath.
 */
function remapRecord<V>(
  record: Record<string, V>,
  oldPath: string,
  newPath: string
): Record<string, V> {
  const result: Record<string, V> = {};
  let changed = false;
  for (const [key, value] of Object.entries(record)) {
    const remapped = remapPath(key, oldPath, newPath);
    if (remapped !== key) changed = true;
    result[remapped] = value;
  }
  return changed ? result : record;
}

/**
 * Recursively merge children into the tree at the matching directory path.
 */
function mergeChildrenIntoTree(
  tree: FileTreeEntry[],
  targetPath: string,
  children: FileTreeEntry[]
): FileTreeEntry[] {
  return tree.map((entry) => {
    if (entry.path === targetPath && entry.type === 'directory') {
      return { ...entry, children };
    }
    if (entry.children) {
      return {
        ...entry,
        children: mergeChildrenIntoTree(entry.children, targetPath, children),
      };
    }
    return entry;
  });
}
