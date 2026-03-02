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
import { invalidateQuickOpenCache } from '@renderer/utils/quickOpenCache';
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

/** Remove a key from a record. Returns the same reference if key doesn't exist. */
function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (!(key in record)) return record;
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
 * Throttle timers for watcher-driven updates.
 * Keeping these module-level avoids store re-renders during bursts.
 */
let gitStatusThrottleTimer: ReturnType<typeof setTimeout> | null = null;
const GIT_STATUS_THROTTLE_MS = 1500;
const dirRefreshDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIR_REFRESH_DEBOUNCE_MS = 350;

// Watcher event logging can be extremely expensive during bursts.
// Keep a lightweight aggregate counter instead of logging per event.
let watcherEventLogTimer: ReturnType<typeof setTimeout> | null = null;
let watcherEventCounts: Record<EditorFileChangeEvent['type'], number> = {
  change: 0,
  create: 0,
  delete: 0,
};

let watchedFilesSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastWatchedFilesKey = '';
let watchedDirsSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastWatchedDirsKey = '';
const WATCHED_DIRS_DEBOUNCE_MS = 250;
const MAX_WATCHED_DIRS = 120;

function scheduleSyncWatchedFiles(get: () => AppState): void {
  // Editor watcher is Electron-only. In browser mode, api.editor exists but throws.
  if (!window.electronAPI?.editor) return;
  const state = get();
  if (!state.editorWatcherEnabled) return;
  const projectPath = state.editorProjectPath;
  if (!projectPath) return;

  const filePaths = state.editorOpenTabs.map((t) => t.filePath).filter(Boolean);
  filePaths.sort((a, b) => a.localeCompare(b));
  const key = `${projectPath}\n${filePaths.join('\n')}`;
  if (key === lastWatchedFilesKey) return;
  lastWatchedFilesKey = key;

  if (watchedFilesSyncTimer) clearTimeout(watchedFilesSyncTimer);
  watchedFilesSyncTimer = setTimeout(() => {
    watchedFilesSyncTimer = null;
    void window.electronAPI.editor.setWatchedFiles(filePaths);
  }, 150);
}

function scheduleSyncWatchedDirs(get: () => AppState): void {
  if (!window.electronAPI?.editor) return;
  const state = get();
  if (!state.editorWatcherEnabled) return;
  const projectPath = state.editorProjectPath;
  if (!projectPath) return;

  const expanded = Object.entries(state.editorExpandedDirs)
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  // Always include root (depth=0), plus expanded folders (depth=0).
  // Cap to protect chokidar from too many watched paths if user expands a lot.
  const dirs = [projectPath, ...expanded].slice(0, MAX_WATCHED_DIRS);
  dirs.sort((a, b) => a.localeCompare(b));
  const key = `${projectPath}\n${dirs.join('\n')}`;
  if (key === lastWatchedDirsKey) return;
  lastWatchedDirsKey = key;

  if (watchedDirsSyncTimer) clearTimeout(watchedDirsSyncTimer);
  watchedDirsSyncTimer = setTimeout(() => {
    watchedDirsSyncTimer = null;
    void window.electronAPI.editor.setWatchedDirs(dirs);
  }, WATCHED_DIRS_DEBOUNCE_MS);
}

/**
 * Open request sequence for editor initialization.
 * Cancels stale async work (notably React 18 StrictMode dev effect mount/unmount).
 */
let editorOpenSeq = 0;

/**
 * Cooldown map: filePath → timestamp of last successful move.
 * Suppresses watcher events triggered by our own move operations.
 */
const recentMoveTimestamps = new Map<string, number>();
const MOVE_COOLDOWN_MS = 2000;

function scheduleIdleWork(cb: () => void): void {
  // Prefer requestIdleCallback when available; fall back to a short timeout.
  // This keeps editor open responsive for large repos.
  // timeout ensures the callback fires within 2s even if the event loop is busy
  // (without it, requestIdleCallback can be delayed indefinitely).
  try {
    const ric = (
      window as unknown as {
        requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(cb, { timeout: 2000 });
      return;
    }
  } catch {
    // ignore
  }
  setTimeout(cb, 150);
}

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
  closeOtherEditorTabs: (keepTabId: string) => void;
  closeEditorTabsToLeft: (tabId: string) => void;
  closeEditorTabsToRight: (tabId: string) => void;
  closeAllEditorTabs: () => void;
  setActiveEditorTab: (tabId: string) => void;
  reorderEditorTabs: (activeId: string, overId: string) => void;

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
  renameFileInTree: (sourcePath: string, newName: string) => Promise<boolean>;

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

  /** File path to reveal in editor (opens editor, expands dirs, opens tab, focuses in tree). */
  editorPendingRevealFile: string | null;
  /** Request to reveal a file in the editor. Opens editor overlay if needed. */
  revealFileInEditor: (filePath: string) => void;
  /** Process the pending reveal: expand parent dirs and open the file tab. */
  revealAndOpenFile: (filePath: string) => Promise<void>;
  clearPendingRevealFile: () => void;

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
  editorPendingRevealFile: null,

  setPendingGoToLine: (line: number | null) => set({ editorPendingGoToLine: line }),

  revealFileInEditor: (filePath: string) => {
    set({ editorPendingRevealFile: filePath });
  },

  clearPendingRevealFile: () => {
    set({ editorPendingRevealFile: null });
  },

  revealAndOpenFile: async (filePath: string) => {
    const { editorProjectPath, editorFileTree, expandDirectory, openFile } = get();
    if (!editorProjectPath) return;

    // Guard: file tree must be loaded before we can reveal.
    // If it's still null, bail out WITHOUT clearing pendingRevealFile
    // so the caller effect can retry after the tree loads.
    if (!editorFileTree) {
      log.info('revealAndOpenFile: tree not loaded yet, deferring reveal');
      return;
    }

    // Compute parent directories from projectRoot to the file.
    // Normalize: strip trailing slash from project path to avoid double-slash.
    const normalizedRoot = editorProjectPath.endsWith('/')
      ? editorProjectPath.slice(0, -1)
      : editorProjectPath;
    const relative = filePath.startsWith(normalizedRoot + '/')
      ? filePath.slice(normalizedRoot.length + 1)
      : null;

    if (relative) {
      const segments = relative.split('/');
      // Expand each parent directory sequentially (root → child → grandchild).
      // Skip the last segment (the file name itself).
      // Each expandDirectory call is awaited so that its children are merged
      // into the tree before the next level is expanded.
      let currentDir = normalizedRoot;
      for (let i = 0; i < segments.length - 1; i++) {
        currentDir = `${currentDir}/${segments[i]}`;
        await expandDirectory(currentDir);
      }
    }

    // Open the file as a tab
    openFile(filePath);
    // Clear reveal state
    set({ editorPendingRevealFile: null });
  },

  // ═══════════════════════════════════════════════════════
  // Group 1: File tree actions
  // ═══════════════════════════════════════════════════════

  openEditor: async (projectPath: string) => {
    const openSeq = ++editorOpenSeq;
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
      const tOpen = performance.now();
      await api.editor.open(projectPath);
      const openMs = performance.now() - tOpen;

      // Cancel stale opens (e.g. StrictMode effect cleanup, or rapid project switching)
      if (editorOpenSeq !== openSeq || get().editorProjectPath !== projectPath) {
        return;
      }

      // Load file tree first so UI becomes interactive quickly.
      // Git status and file watching can be expensive on large projects, so they are NOT awaited here.
      const tReadDir = performance.now();
      const result = await api.editor.readDir(projectPath);
      const readDirMs = performance.now() - tReadDir;

      if (editorOpenSeq !== openSeq || get().editorProjectPath !== projectPath) {
        return;
      }

      const tSet = performance.now();
      set({
        editorFileTree: result.entries,
        editorFileTreeLoading: false,
      });
      const setMs = performance.now() - tSet;

      log.info(
        `[perf] openEditor: open=${openMs.toFixed(1)}ms, readDir=${readDirMs.toFixed(1)}ms, set=${setMs.toFixed(1)}ms, entries=${result.entries.length}`
      );

      // Enable watcher by default (like most editors), but defer startup until idle so open stays fast.
      // Allow users to persistently disable it via localStorage toggle.
      const watcherDesired = (() => {
        try {
          return localStorage.getItem('editor-watcher-enabled') !== 'false';
        } catch {
          return true;
        }
      })();

      scheduleIdleWork(() => {
        if (editorOpenSeq !== openSeq || get().editorProjectPath !== projectPath) return;
        if (watcherDesired) void get().toggleWatcher(true);
        // Defer initial git status a bit more — it can be expensive on large repos.
        setTimeout(() => {
          if (editorOpenSeq !== openSeq || get().editorProjectPath !== projectPath) return;
          void get().fetchGitStatus();
        }, 1200);
      });
    } catch (error) {
      // Ignore errors from stale opens (e.g. StrictMode cleanup during dev)
      if (editorOpenSeq !== openSeq || get().editorProjectPath !== projectPath) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to open editor:', message);
      set({
        editorFileTreeLoading: false,
        editorFileTreeError: message,
      });
    }
  },

  closeEditor: () => {
    // Cancel any in-flight openEditor async work
    editorOpenSeq++;
    // Cancel any pending watcher sync (avoid calling into main after close)
    if (watchedFilesSyncTimer) {
      clearTimeout(watchedFilesSyncTimer);
      watchedFilesSyncTimer = null;
    }
    if (watchedDirsSyncTimer) {
      clearTimeout(watchedDirsSyncTimer);
      watchedDirsSyncTimer = null;
    }
    lastWatchedFilesKey = '';
    lastWatchedDirsKey = '';

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
      const t0 = performance.now();
      const result = await api.editor.readDir(dirPath);
      const ipcMs = performance.now() - t0;
      const t1 = performance.now();
      set({
        editorFileTree: result.entries,
        editorFileTreeLoading: false,
      });
      const setMs = performance.now() - t1;
      log.info(
        `[perf] loadFileTree: IPC=${ipcMs.toFixed(1)}ms, set=${setMs.toFixed(1)}ms, entries=${result.entries.length}`
      );
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
    const { editorExpandedDirs } = get();

    // Skip set() if already expanded — prevents unnecessary re-render
    const wasExpanded = !!editorExpandedDirs[dirPath];
    if (!wasExpanded) {
      set({
        editorExpandedDirs: { ...editorExpandedDirs, [dirPath]: true },
      });
      scheduleSyncWatchedDirs(get);
    }

    try {
      const t0 = performance.now();
      const result = await api.editor.readDir(dirPath);
      const ipcMs = performance.now() - t0;
      // Use fresh tree from store after await to avoid overwriting concurrent updates
      const currentTree = get().editorFileTree;
      const t1 = performance.now();
      const updatedTree = mergeChildrenIntoTree(currentTree ?? [], dirPath, result.entries);
      const mergeMs = performance.now() - t1;
      const t2 = performance.now();
      set({ editorFileTree: updatedTree });
      const setMs = performance.now() - t2;
      log.info(
        `[perf] expandDirectory: IPC=${ipcMs.toFixed(1)}ms, merge=${mergeMs.toFixed(1)}ms, set=${setMs.toFixed(1)}ms, entries=${result.entries.length}, wasExpanded=${wasExpanded}`
      );
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
    scheduleSyncWatchedDirs(get);
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

    scheduleSyncWatchedFiles(get);
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

    scheduleSyncWatchedFiles(get);
  },

  closeOtherEditorTabs: (keepTabId: string) => {
    const { editorOpenTabs } = get();
    const toClose = editorOpenTabs.filter((t) => t.id !== keepTabId);
    for (const tab of toClose) get().closeEditorTab(tab.id);
  },

  closeEditorTabsToLeft: (tabId: string) => {
    const { editorOpenTabs } = get();
    const idx = editorOpenTabs.findIndex((t) => t.id === tabId);
    if (idx <= 0) return;
    const toClose = editorOpenTabs.slice(0, idx);
    for (const tab of toClose) get().closeEditorTab(tab.id);
  },

  closeEditorTabsToRight: (tabId: string) => {
    const { editorOpenTabs } = get();
    const idx = editorOpenTabs.findIndex((t) => t.id === tabId);
    if (idx < 0 || idx >= editorOpenTabs.length - 1) return;
    const toClose = editorOpenTabs.slice(idx + 1);
    for (const tab of toClose) get().closeEditorTab(tab.id);
  },

  closeAllEditorTabs: () => {
    const { editorOpenTabs } = get();
    for (const tab of [...editorOpenTabs]) get().closeEditorTab(tab.id);
  },

  setActiveEditorTab: (tabId: string) => {
    set({ editorActiveTabId: tabId });
  },

  reorderEditorTabs: (activeId: string, overId: string) => {
    if (activeId === overId) return;
    const { editorOpenTabs } = get();
    const oldIndex = editorOpenTabs.findIndex((t) => t.id === activeId);
    const newIndex = editorOpenTabs.findIndex((t) => t.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;

    const updated = [...editorOpenTabs];
    const [moved] = updated.splice(oldIndex, 1);
    updated.splice(newIndex, 0, moved);
    set({ editorOpenTabs: updated });
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

      // Keep open-files-only watcher in sync with remapped tab paths
      scheduleSyncWatchedFiles(get);

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

  renameFileInTree: async (sourcePath: string, newName: string) => {
    const { editorSaving } = get();

    if (editorSaving[sourcePath]) {
      log.error('renameFileInTree: blocked — file is being saved:', sourcePath);
      return false;
    }

    try {
      const result = await api.editor.renameFile(sourcePath, newName);
      const { newPath, isDirectory } = result;
      const parentDir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));

      recentMoveTimestamps.set(sourcePath, Date.now());
      recentMoveTimestamps.set(newPath, Date.now());

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

      // Keep open-files-only watcher in sync with remapped tab paths
      scheduleSyncWatchedFiles(get);

      // Remap bridge state
      const { editorOpenTabs } = get();
      for (const tab of editorOpenTabs) {
        const originalPath = reverseRemapPath(tab.filePath, sourcePath, newPath);
        if (originalPath !== tab.filePath) {
          editorBridge.remapState(originalPath, tab.filePath);
        }
      }
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

      for (const [key, ts] of [...recentSaveTimestamps.entries()]) {
        const remapped = remapPath(key, sourcePath, newPath);
        if (remapped !== key) {
          recentSaveTimestamps.delete(key);
          recentSaveTimestamps.set(remapped, ts);
        }
      }

      void refreshDirectory(get, set, parentDir);
      void get().fetchGitStatus();

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('renameFileInTree failed:', message);
      return false;
    }
  },

  // ═══════════════════════════════════════════════════════
  // Group 5: Git status + file watcher + line wrap
  // ═══════════════════════════════════════════════════════

  fetchGitStatus: async () => {
    set({ editorGitLoading: true });
    try {
      const t0 = performance.now();
      const result = await api.editor.gitStatus();
      const ipcMs = performance.now() - t0;
      const t1 = performance.now();
      set({
        editorGitFiles: result.files,
        editorGitBranch: result.branch,
        editorIsGitRepo: result.isGitRepo,
        editorGitLoading: false,
      });
      const setMs = performance.now() - t1;
      log.info(
        `[perf] fetchGitStatus: IPC=${ipcMs.toFixed(1)}ms, set=${setMs.toFixed(1)}ms, files=${result.files.length}`
      );
    } catch (error) {
      log.error('Failed to fetch git status:', error);
      set({ editorGitLoading: false });
    }
  },

  toggleWatcher: async (enable: boolean) => {
    try {
      await api.editor.watchDir(enable);
      set({ editorWatcherEnabled: enable });
      try {
        localStorage.setItem('editor-watcher-enabled', String(enable));
      } catch {
        // localStorage may not be available
      }
      if (enable) {
        scheduleSyncWatchedFiles(get);
        scheduleSyncWatchedDirs(get);
      } else {
        // Ensure main process stops watching files promptly.
        lastWatchedFilesKey = '';
        lastWatchedDirsKey = '';
        void api.editor.setWatchedFiles([]);
        void api.editor.setWatchedDirs([]);
      }
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
    // Avoid per-event logging (can freeze renderer during bursts on large repos).
    watcherEventCounts[event.type] = (watcherEventCounts[event.type] ?? 0) + 1;
    if (!watcherEventLogTimer) {
      watcherEventLogTimer = setTimeout(() => {
        watcherEventLogTimer = null;
        const counts = watcherEventCounts;
        watcherEventCounts = { change: 0, create: 0, delete: 0 };
        // Keep a single lightweight summary line.
        log.info(
          `[perf] editor watcher events (2s): change=${counts.change}, create=${counts.create}, delete=${counts.delete}`
        );
      }, 2000);
    }
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

    // Refresh git status on change — throttled to avoid expensive work during bursts.
    // Main process already caches git status for 5s, but IPC + store updates still cost.
    if (!gitStatusThrottleTimer) {
      gitStatusThrottleTimer = setTimeout(() => {
        gitStatusThrottleTimer = null;
        void get().fetchGitStatus();
      }, GIT_STATUS_THROTTLE_MS);
    }

    // Refresh parent directory in tree for create/delete
    if (event.type === 'create' || event.type === 'delete') {
      invalidateQuickOpenCache();
      const parentDir = event.path.substring(0, event.path.lastIndexOf('/'));
      if (parentDir && editorProjectPath) {
        const existing = dirRefreshDebounceTimers.get(parentDir);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          dirRefreshDebounceTimers.delete(parentDir);
          void refreshDirectory(get, set, parentDir);
        }, DIR_REFRESH_DEBOUNCE_MS);
        dirRefreshDebounceTimers.set(parentDir, timer);
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
    const t0 = performance.now();
    const result = await api.editor.readDir(dirPath);
    log.info(
      `[perf] refreshDirectory: IPC=${(performance.now() - t0).toFixed(1)}ms, entries=${result.entries.length}, dir=${dirPath.split('/').pop() ?? ''}`
    );
    const currentTree = get().editorFileTree;
    if (!currentTree) return;

    const projectPath = get().editorProjectPath;
    if (dirPath === projectPath) {
      // Root refresh — tree IS the root's children, so preserve expanded subtrees
      // by merging new entries with existing children data
      const existingByPath = new Map<string, FileTreeEntry>();
      for (const entry of currentTree) {
        existingByPath.set(entry.path, entry);
      }
      const merged = result.entries.map((entry) => {
        const existing = existingByPath.get(entry.path);
        // Preserve expanded subtree children for directories that still exist
        if (existing?.children && entry.type === 'directory') {
          return { ...entry, children: existing.children };
        }
        return entry;
      });
      set({ editorFileTree: merged });
    } else {
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
 * Returns the same array reference if nothing changed — preserves React.memo equality.
 */
function mergeChildrenIntoTree(
  tree: FileTreeEntry[],
  targetPath: string,
  children: FileTreeEntry[]
): FileTreeEntry[] {
  let changed = false;
  const result = tree.map((entry) => {
    if (entry.path === targetPath && entry.type === 'directory') {
      changed = true;
      return { ...entry, children };
    }
    if (entry.children) {
      const updated = mergeChildrenIntoTree(entry.children, targetPath, children);
      if (updated !== entry.children) {
        changed = true;
        return { ...entry, children: updated };
      }
    }
    return entry;
  });
  return changed ? result : tree;
}
