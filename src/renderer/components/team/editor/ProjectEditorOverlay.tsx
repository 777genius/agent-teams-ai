/**
 * Full-screen project editor overlay.
 *
 * Pattern: follows ChangeReviewDialog.tsx — raw <div> with fixed inset-0, not Radix Dialog.
 * macOS traffic light padding, inert on background, Escape to close.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useEditorKeyboardShortcuts } from '@renderer/hooks/useEditorKeyboardShortcuts';
import { useStore } from '@renderer/store';
import { buildFileAction, buildSelectionAction } from '@renderer/utils/buildSelectionAction';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import {
  AlertTriangle,
  HelpCircle,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CodeMirrorEditor } from './CodeMirrorEditor';
import { EditorBinaryState } from './EditorBinaryState';
import { EditorEmptyState } from './EditorEmptyState';
import { EditorErrorBoundary } from './EditorErrorBoundary';
import { EditorErrorState } from './EditorErrorState';
import { EditorFileTree } from './EditorFileTree';
import { EditorSelectionMenu } from './EditorSelectionMenu';
import { EditorShortcutsHelp } from './EditorShortcutsHelp';
import { EditorStatusBar } from './EditorStatusBar';
import { EditorTabBar } from './EditorTabBar';
import { EditorToolbar } from './EditorToolbar';
import { GoToLineDialog } from './GoToLineDialog';
import { MarkdownSplitView } from './MarkdownSplitView';
import { QuickOpenDialog } from './QuickOpenDialog';
import { SearchInFilesPanel } from './SearchInFilesPanel';

import type { MdPreviewMode } from './EditorToolbar';
import type {
  EditorSelectionAction,
  EditorSelectionInfo,
  ReadFileResult,
} from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface ProjectEditorOverlayProps {
  projectPath: string;
  onClose: () => void;
  /** Called when user triggers an action from the selection menu */
  onEditorAction?: (action: EditorSelectionAction) => void;
}

// =============================================================================
// Component
// =============================================================================

export const ProjectEditorOverlay = ({
  projectPath,
  onClose,
  onEditorAction,
}: ProjectEditorOverlayProps): React.ReactElement => {
  // Data selectors — grouped with useShallow to prevent unnecessary re-renders
  const { activeTabId, openTabs, modifiedFiles, saveErrors, externalChanges, conflictFile } =
    useStore(
      useShallow((s) => ({
        activeTabId: s.editorActiveTabId,
        openTabs: s.editorOpenTabs,
        modifiedFiles: s.editorModifiedFiles,
        saveErrors: s.editorSaveError,
        externalChanges: s.editorExternalChanges,
        conflictFile: s.editorConflictFile,
      }))
    );

  // Actions — stable references in Zustand, no grouping needed
  const openEditor = useStore((s) => s.openEditor);
  const closeEditor = useStore((s) => s.closeEditor);
  const openFile = useStore((s) => s.openFile);
  const closeEditorTab = useStore((s) => s.closeEditorTab);
  const saveFile = useStore((s) => s.saveFile);
  const hasUnsavedChanges = useStore((s) => s.hasUnsavedChanges);
  const saveAllFiles = useStore((s) => s.saveAllFiles);
  const discardChanges = useStore((s) => s.discardChanges);
  const clearExternalChange = useStore((s) => s.clearExternalChange);
  const forceOverwrite = useStore((s) => s.forceOverwrite);
  const resolveConflict = useStore((s) => s.resolveConflict);
  const setFileMtime = useStore((s) => s.setFileMtime);
  const fetchGitStatus = useStore((s) => s.fetchGitStatus);

  const [fileContent, setFileContent] = useState<ReadFileResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);

  // Unsaved changes confirmation (overlay close)
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  // Unsaved changes confirmation (single tab close)
  const [confirmCloseTabId, setConfirmCloseTabId] = useState<string | null>(null);
  // Draft recovery banner
  const [draftRecoveredFile, setDraftRecoveredFile] = useState<string | null>(null);
  // Bumped on draft discard to force CodeMirrorEditor remount (fresh state cache)
  const [editorResetKey, setEditorResetKey] = useState(0);
  // Selection action menu
  const [selectionInfo, setSelectionInfo] = useState<EditorSelectionInfo | null>(null);
  const editorContentRef = useRef<HTMLDivElement>(null);
  const [containerRect, setContainerRect] = useState<DOMRect>(() => new DOMRect());

  // Markdown preview state
  const [mdPreviewMode, setMdPreviewMode] = useState<MdPreviewMode>('off');
  const [liveContent, setLiveContent] = useState('');
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const stored = localStorage.getItem('editor:mdSplitRatio');
      return stored ? Math.max(0.2, Math.min(0.8, Number(stored))) : 0.5;
    } catch {
      return 0.5;
    }
  });

  // Iter-4: New state
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [searchPanelVisible, setSearchPanelVisible] = useState(false);
  const [goToLineVisible, setGoToLineVisible] = useState(false);
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = useState(false);
  const [sidebarVisible, setSidebarVisibleRaw] = useState(() => {
    try {
      return localStorage.getItem('editor-sidebar-visible') !== 'false';
    } catch {
      return true;
    }
  });

  const overlayRef = useRef<HTMLDivElement>(null);

  // IPC deduplication: reuse in-flight readFile promise for same path
  const pendingReads = useRef(new Map<string, Promise<ReadFileResult>>());

  // Active tab metadata
  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;
  const isMarkdown = activeTab?.language === 'Markdown';

  // Auto-enable split preview for markdown tabs, reset for non-markdown
  useEffect(() => {
    if (isMarkdown) {
      setMdPreviewMode((m) => (m === 'off' ? 'split' : m));
    } else {
      setMdPreviewMode('off');
    }
  }, [isMarkdown, activeTabId]);

  // Persist split ratio
  const handleSplitRatioChange = useCallback((ratio: number) => {
    setSplitRatio(ratio);
    try {
      localStorage.setItem('editor:mdSplitRatio', String(ratio));
    } catch {
      // localStorage unavailable
    }
  }, []);

  const handleLiveContent = useCallback((content: string) => {
    setLiveContent(content);
  }, []);

  const toggleMdSplit = useCallback(() => {
    setMdPreviewMode((m) => (m === 'split' ? 'off' : 'split'));
  }, []);

  const toggleMdPreview = useCallback(() => {
    setMdPreviewMode((m) => (m === 'preview' ? 'off' : 'preview'));
  }, []);

  // Initialize live content when entering preview mode or switching files
  useEffect(() => {
    if (mdPreviewMode !== 'off' && fileContent?.content) {
      setLiveContent(fileContent.content);
    }
  }, [mdPreviewMode, fileContent?.content]);

  // Content for preview: use live content when available, fallback to file content
  const previewContent = liveContent || fileContent?.content || '';

  const loadFileContent = useCallback(
    async (filePath: string) => {
      setFileLoading(true);
      setFileError(null);
      setFileContent(null);

      try {
        const t0 = performance.now();
        let promise = pendingReads.current.get(filePath);
        const wasCached = !!promise;
        if (!promise) {
          promise = window.electronAPI.editor.readFile(filePath);
          pendingReads.current.set(filePath, promise);
          void promise.finally(() => pendingReads.current.delete(filePath));
        }
        const result = await promise;
        const ipcMs = performance.now() - t0;
        console.debug(
          `[perf] loadFileContent: IPC=${ipcMs.toFixed(1)}ms, size=${result.size}, truncated=${result.truncated}, cached=${wasCached}, file=${filePath.split('/').pop() ?? ''}`
        );
        setFileContent(result);

        // Track baseline mtime for conflict detection
        if (result.mtimeMs) {
          setFileMtime(filePath, result.mtimeMs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileLoading(false);
      }
    },
    [setFileMtime]
  );

  // Active tab save error
  const activeSaveError = activeTabId ? (saveErrors[activeTabId] ?? null) : null;

  const pendingRevealFile = useStore((s) => s.editorPendingRevealFile);
  const revealAndOpenFile = useStore((s) => s.revealAndOpenFile);

  // Initialize editor on mount
  useEffect(() => {
    void openEditor(projectPath);
    return () => {
      closeEditor();
    };
  }, [projectPath, openEditor, closeEditor]);

  // Process pending file reveal after editor initializes.
  // Guard: wait until the file tree is actually loaded (not null) and not loading.
  // Without the fileTree check, the effect fires on mount when fileTreeLoading is
  // still at its initial `false` value — before openEditor sets it to `true`.
  const fileTreeLoading = useStore((s) => s.editorFileTreeLoading);
  const fileTreeLoaded = useStore((s) => s.editorFileTree !== null);
  useEffect(() => {
    if (pendingRevealFile && !fileTreeLoading && fileTreeLoaded) {
      void revealAndOpenFile(pendingRevealFile);
    }
  }, [pendingRevealFile, fileTreeLoading, fileTreeLoaded, revealAndOpenFile]);

  // Keep container rect fresh for selection menu positioning (resize, sidebar toggle)
  useEffect(() => {
    const el = editorContentRef.current;
    if (!el) return;
    const updateRect = (): void => setContainerRect(el.getBoundingClientRect());
    updateRect();
    const observer = new ResizeObserver(updateRect);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Escape to close + F5 to refresh (with dialog guard)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Skip if another handler already consumed this Escape
        // (e.g. CodeMirror search panel close, or React search input onKeyDown)
        if (e.defaultPrevented) return;
        // Don't close overlay if a dialog is open — dialog handles its own Escape
        if (quickOpenVisible || searchPanelVisible || shortcutsHelpVisible) return;
        if (showConfirmClose || confirmCloseTabId) return;
        if (conflictFile) return;

        e.preventDefault();
        handleCloseRequest();
      }

      // F5: Manual refresh (git status + file tree)
      if (e.key === 'F5') {
        e.preventDefault();
        handleManualRefresh();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleCloseRequest and handleManualRefresh are stable callbacks; listing dialog visibility guards as deps is sufficient
  }, [
    quickOpenVisible,
    searchPanelVisible,
    shortcutsHelpVisible,
    showConfirmClose,
    confirmCloseTabId,
    conflictFile,
  ]);

  // Focus trap — focus overlay on mount
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  // Load file content when active tab changes
  useEffect(() => {
    // Clear selection menu from previous tab
    setSelectionInfo(null);

    if (!activeTabId) {
      setFileContent(null);
      setFileLoading(false);
      setFileError(null);
      return;
    }

    void loadFileContent(activeTabId);
  }, [activeTabId, loadFileContent]);

  // Clear draft recovery banner when switching tabs
  useEffect(() => {
    if (activeTabId !== draftRecoveredFile) {
      setDraftRecoveredFile(null);
    }
  }, [activeTabId, draftRecoveredFile]);

  const handleFileSelect = useCallback(
    (filePath: string) => {
      openFile(filePath);
    },
    [openFile]
  );

  const handleRetry = useCallback(() => {
    if (activeTabId) {
      void loadFileContent(activeTabId);
    }
  }, [activeTabId, loadFileContent]);

  const handleCursorChange = useCallback((line: number, col: number) => {
    setCursorLine(line);
    setCursorCol(col);
  }, []);

  // --- Overlay close handlers ---

  const handleCloseRequest = useCallback(() => {
    if (hasUnsavedChanges()) {
      setShowConfirmClose(true);
    } else {
      onClose();
    }
  }, [onClose, hasUnsavedChanges]);

  const handleSaveAndClose = useCallback(async () => {
    await saveAllFiles();
    setShowConfirmClose(false);
    onClose();
  }, [saveAllFiles, onClose]);

  const handleDiscardAndClose = useCallback(() => {
    setShowConfirmClose(false);
    onClose();
  }, [onClose]);

  const handleCancelClose = useCallback(() => {
    setShowConfirmClose(false);
  }, []);

  // --- Tab close handlers (with dirty check) ---

  const handleRequestCloseTab = useCallback(
    (tabId: string) => {
      if (modifiedFiles[tabId]) {
        setConfirmCloseTabId(tabId);
      } else {
        closeEditorTab(tabId);
      }
    },
    [modifiedFiles, closeEditorTab]
  );

  // Listen for editor-close-tab custom events from keyboard shortcut hook
  useEffect(() => {
    const handler = (e: Event) => {
      const tabId = (e as CustomEvent).detail as string;
      handleRequestCloseTab(tabId);
    };
    window.addEventListener('editor-close-tab', handler);
    return () => window.removeEventListener('editor-close-tab', handler);
  }, [handleRequestCloseTab]);

  const handleSaveAndCloseTab = useCallback(async () => {
    if (!confirmCloseTabId) return;
    await saveFile(confirmCloseTabId);
    closeEditorTab(confirmCloseTabId);
    setConfirmCloseTabId(null);
  }, [confirmCloseTabId, saveFile, closeEditorTab]);

  const handleDiscardAndCloseTab = useCallback(() => {
    if (!confirmCloseTabId) return;
    closeEditorTab(confirmCloseTabId);
    setConfirmCloseTabId(null);
  }, [confirmCloseTabId, closeEditorTab]);

  const handleCancelCloseTab = useCallback(() => {
    setConfirmCloseTabId(null);
  }, []);

  // --- Draft recovery handlers ---

  const handleDraftRecovered = useCallback((filePath: string) => {
    setDraftRecoveredFile(filePath);
  }, []);

  const handleDiscardDraft = useCallback(() => {
    if (!draftRecoveredFile || !activeTabId) return;
    discardChanges(draftRecoveredFile);
    setDraftRecoveredFile(null);
    setFileContent(null);
    setEditorResetKey((k) => k + 1);
    void loadFileContent(activeTabId);
  }, [draftRecoveredFile, activeTabId, discardChanges, loadFileContent]);

  const handleDismissDraftBanner = useCallback(() => {
    setDraftRecoveredFile(null);
  }, []);

  // --- Iter-5: Conflict handlers ---

  const handleForceOverwrite = useCallback(() => {
    if (!conflictFile) return;
    void forceOverwrite(conflictFile);
  }, [conflictFile, forceOverwrite]);

  const handleCancelConflict = useCallback(() => {
    resolveConflict();
  }, [resolveConflict]);

  // --- Iter-5: External change handlers ---

  const handleReloadExternalChange = useCallback(() => {
    if (!activeTabId) return;
    clearExternalChange(activeTabId);
    discardChanges(activeTabId);
    setFileContent(null);
    setEditorResetKey((k) => k + 1);
    void loadFileContent(activeTabId);
  }, [activeTabId, clearExternalChange, discardChanges, loadFileContent]);

  const handleKeepMine = useCallback(() => {
    if (!activeTabId) return;
    clearExternalChange(activeTabId);
  }, [activeTabId, clearExternalChange]);

  // --- Iter-5: Watcher toggle ---

  // --- Iter-5: Manual refresh (F5) ---

  const handleManualRefresh = useCallback(() => {
    void fetchGitStatus();
  }, [fetchGitStatus]);

  // --- Iter-4: Toggle handlers ---

  const toggleQuickOpen = useCallback(() => {
    setQuickOpenVisible((v) => !v);
  }, []);

  const toggleSearchPanel = useCallback(() => {
    setSearchPanelVisible((v) => !v);
  }, []);

  const toggleGoToLine = useCallback(() => {
    setGoToLineVisible((v) => !v);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarVisibleRaw((v) => {
      const next = !v;
      try {
        localStorage.setItem('editor-sidebar-visible', String(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  // --- Iter-4: Search result selection ---

  const setPendingGoToLine = useStore((s) => s.setPendingGoToLine);

  const handleSearchSelectMatch = useCallback(
    (filePath: string, line: number) => {
      setPendingGoToLine(line);
      openFile(filePath);
    },
    [openFile, setPendingGoToLine]
  );

  // --- Keyboard shortcuts ---

  useEditorKeyboardShortcuts({
    onToggleQuickOpen: toggleQuickOpen,
    onToggleSearchPanel: toggleSearchPanel,
    onToggleGoToLine: toggleGoToLine,
    onToggleSidebar: toggleSidebar,
    onClose: handleCloseRequest,
    onToggleMdSplit: isMarkdown ? toggleMdSplit : undefined,
    onToggleMdPreview: isMarkdown ? toggleMdPreview : undefined,
  });

  const projectName = projectPath.split('/').pop() ?? projectPath;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex flex-col bg-surface"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Project Editor"
    >
      {/* Header */}
      <div
        className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3"
        style={{ paddingLeft: 'var(--macos-traffic-light-padding-left, 72px)' }}
      >
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <span className="font-medium text-text">{projectName}</span>
          <span className="text-text-muted">{projectPath}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-text-muted"
                onClick={handleManualRefresh}
                aria-label="Refresh (F5)"
              >
                <RefreshCw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh git status (F5)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-text-muted"
                onClick={() => setShortcutsHelpVisible(true)}
                aria-label="Keyboard shortcuts"
              >
                <HelpCircle className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Keyboard shortcuts</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-text-muted"
                onClick={handleCloseRequest}
                aria-label="Close editor"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close editor (Esc)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Search in files panel (replaces sidebar when visible) */}
        {searchPanelVisible && (
          <div className="w-72 shrink-0">
            <SearchInFilesPanel
              projectPath={projectPath}
              onClose={() => setSearchPanelVisible(false)}
              onSelectMatch={handleSearchSelectMatch}
            />
          </div>
        )}

        {/* File tree sidebar */}
        {sidebarVisible && !searchPanelVisible && (
          <div className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-sidebar">
            <div className="flex items-center justify-between border-b border-border px-2 py-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
                Explorer
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-text-muted"
                    onClick={toggleSidebar}
                    aria-label="Hide sidebar"
                  >
                    <PanelLeftClose className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Hide sidebar ({shortcutLabel('⌘ B', 'Ctrl+B')})
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex-1 overflow-hidden">
              <EditorFileTree
                selectedFilePath={activeTabId}
                onFileSelect={handleFileSelect}
                onCreateTask={
                  onEditorAction
                    ? (filePath: string) =>
                        onEditorAction(buildFileAction('createTask', filePath, projectPath))
                    : undefined
                }
                onSendMessage={
                  onEditorAction
                    ? (filePath: string) =>
                        onEditorAction(buildFileAction('sendMessage', filePath, projectPath))
                    : undefined
                }
              />
            </div>
          </div>
        )}

        {/* Sidebar toggle (when hidden) */}
        {!sidebarVisible && !searchPanelVisible && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="flex h-full w-6 shrink-0 items-start justify-center rounded-none border-r border-border bg-surface-sidebar pt-2 text-text-muted"
                onClick={toggleSidebar}
                aria-label="Show sidebar"
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              Show sidebar ({shortcutLabel('⌘ B', 'Ctrl+B')})
            </TooltipContent>
          </Tooltip>
        )}

        {/* Editor area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Tab bar */}
          <EditorTabBar onRequestCloseTab={handleRequestCloseTab} />

          {/* Toolbar */}
          <EditorToolbar
            isMarkdown={isMarkdown}
            mdPreviewMode={mdPreviewMode}
            onToggleSplit={toggleMdSplit}
            onToggleFullPreview={toggleMdPreview}
          />

          {/* Draft recovery banner */}
          {draftRecoveredFile && activeTabId === draftRecoveredFile && (
            <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
              <RotateCcw className="size-3.5 shrink-0" />
              <span>Recovered unsaved changes from a previous session.</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-auto px-2 py-0.5"
                onClick={handleDismissDraftBanner}
              >
                Keep
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-auto px-2 py-0.5"
                onClick={handleDiscardDraft}
              >
                Discard
              </Button>
            </div>
          )}

          {/* Save error banner */}
          {activeSaveError && (
            <div className="flex shrink-0 items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="truncate">Save failed: {activeSaveError}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-auto shrink-0 px-2 py-0.5"
                onClick={() => activeTabId && void saveFile(activeTabId)}
              >
                Retry
              </Button>
            </div>
          )}

          {/* External change banner */}
          {activeTabId && externalChanges[activeTabId] && (
            <div className="flex shrink-0 items-center gap-2 border-b border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-300">
              <RefreshCw className="size-3.5 shrink-0" />
              <span>
                {externalChanges[activeTabId] === 'delete'
                  ? 'File no longer exists on disk.'
                  : 'File changed on disk.'}
              </span>
              {externalChanges[activeTabId] === 'delete' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-auto px-2 py-0.5"
                  onClick={() => closeEditorTab(activeTabId)}
                >
                  Close tab
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-auto px-2 py-0.5"
                    onClick={handleReloadExternalChange}
                  >
                    Reload
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-0.5"
                    onClick={handleKeepMine}
                  >
                    Keep mine
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Editor content */}
          <div ref={editorContentRef} className="relative flex-1 overflow-hidden">
            {fileLoading && (
              <div className="flex h-full items-center justify-center text-text-muted">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )}

            {fileError && <EditorErrorState error={fileError} onRetry={handleRetry} />}

            {fileContent?.isBinary && activeTabId && (
              <EditorBinaryState filePath={activeTabId} size={fileContent.size} />
            )}

            {fileContent && !fileContent.isBinary && activeTabId && (
              <div className="flex h-full">
                {/* Code editor — always mounted, hidden via display:none in preview mode */}
                <div
                  className="h-full overflow-hidden"
                  style={{
                    display: mdPreviewMode === 'preview' ? 'none' : 'block',
                    width: mdPreviewMode === 'split' ? `${splitRatio * 100}%` : '100%',
                  }}
                >
                  <EditorErrorBoundary filePath={activeTabId} onRetry={handleRetry}>
                    <CodeMirrorEditor
                      key={`${activeTabId}-${editorResetKey}`}
                      filePath={activeTabId}
                      content={fileContent.content}
                      fileName={activeTabId.split('/').pop() ?? 'file'}
                      mtimeMs={fileContent.mtimeMs}
                      onCursorChange={handleCursorChange}
                      onDraftRecovered={handleDraftRecovered}
                      onSelectionChange={setSelectionInfo}
                      onDocChange={mdPreviewMode !== 'off' ? handleLiveContent : undefined}
                    />
                  </EditorErrorBoundary>
                </div>

                {/* Resize handle + Preview pane */}
                {mdPreviewMode !== 'off' && (
                  <MarkdownSplitView
                    content={previewContent}
                    mode={mdPreviewMode}
                    splitRatio={splitRatio}
                    onSplitRatioChange={handleSplitRatioChange}
                    viewKey={activeTabId}
                    baseDir={activeTabId?.substring(0, activeTabId.lastIndexOf('/'))}
                  />
                )}
              </div>
            )}

            {!fileLoading && !fileError && !fileContent && !activeTabId && <EditorEmptyState />}

            {/* Selection action menu */}
            {selectionInfo && onEditorAction && (
              <EditorSelectionMenu
                info={selectionInfo}
                containerRect={containerRect}
                onSendMessage={() => {
                  onEditorAction(buildSelectionAction('sendMessage', selectionInfo));
                  setSelectionInfo(null);
                }}
                onCreateTask={() => {
                  onEditorAction(buildSelectionAction('createTask', selectionInfo));
                  setSelectionInfo(null);
                }}
              />
            )}
          </div>

          {/* Status bar */}
          {activeTab && (
            <EditorStatusBar line={cursorLine} col={cursorCol} language={activeTab.language} />
          )}
        </div>
      </div>

      {/* Quick Open dialog */}
      {quickOpenVisible && (
        <QuickOpenDialog
          onClose={() => setQuickOpenVisible(false)}
          onSelectFile={handleFileSelect}
        />
      )}

      {/* Go to Line dialog */}
      {goToLineVisible && <GoToLineDialog onClose={() => setGoToLineVisible(false)} />}

      {/* Shortcuts help modal */}
      {shortcutsHelpVisible && (
        <EditorShortcutsHelp onClose={() => setShortcutsHelpVisible(false)} />
      )}

      {/* Unsaved changes confirmation dialog — overlay close */}
      <Dialog open={showConfirmClose} onOpenChange={(open) => !open && handleCancelClose()}>
        <DialogContent className="w-96 max-w-96">
          <DialogHeader>
            <DialogTitle className="text-sm">Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. What would you like to do?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleCancelClose}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDiscardAndClose}>
              Discard & Close
            </Button>
            <Button size="sm" onClick={() => void handleSaveAndClose()}>
              Save All & Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save conflict dialog */}
      <Dialog open={!!conflictFile} onOpenChange={(open) => !open && handleCancelConflict()}>
        <DialogContent className="w-96 max-w-96">
          <DialogHeader>
            <DialogTitle className="text-sm">Save Conflict</DialogTitle>
            <DialogDescription>
              The file has been modified externally since you opened it. Overwrite with your
              changes?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleCancelConflict}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleForceOverwrite}>
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved changes confirmation dialog — single tab close */}
      <Dialog open={!!confirmCloseTabId} onOpenChange={(open) => !open && handleCancelCloseTab()}>
        <DialogContent className="w-96 max-w-96">
          <DialogHeader>
            <DialogTitle className="text-sm">Unsaved Changes</DialogTitle>
            <DialogDescription>
              This file has unsaved changes. What would you like to do?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleCancelCloseTab}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDiscardAndCloseTab}>
              Discard
            </Button>
            <Button size="sm" onClick={() => void handleSaveAndCloseTab()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
