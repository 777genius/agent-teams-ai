/**
 * useEditorKeyboardShortcuts — keyboard shortcuts scoped to the project editor overlay.
 *
 * All shortcuts use stopPropagation to prevent conflicts with global useKeyboardShortcuts.
 * CM6-internal shortcuts (Cmd+Z, Cmd+Shift+Z, Cmd+A, Cmd+D) are handled by CodeMirror directly.
 */

import { useCallback, useEffect } from 'react';

import { gotoLine, openSearchPanel } from '@codemirror/search';
import { useStore } from '@renderer/store';
import { editorBridge } from '@renderer/utils/editorBridge';

import type { EditorFileTab } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface UseEditorKeyboardShortcutsOptions {
  onToggleQuickOpen: () => void;
  onToggleSearchPanel: () => void;
  onToggleSidebar: () => void;
  onClose: () => void;
}

/** Dependencies injected into the key handler for testability. */
export interface EditorKeyHandlerDeps {
  activeTabId: string | null;
  openTabs: EditorFileTab[];
  setActiveEditorTab: (id: string) => void;
  saveFile: (tabId: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  hasUnsavedChanges: () => boolean;
  onToggleQuickOpen: () => void;
  onToggleSearchPanel: () => void;
  onToggleSidebar: () => void;
  onToggleLineWrap: () => void;
  getEditorView: () => { dispatch: unknown } | null;
}

// =============================================================================
// Pure key handler (exported for testing)
// =============================================================================

/**
 * Create a keyboard event handler for editor shortcuts.
 * Extracted from the hook for unit-testability.
 */
export function createEditorKeyHandler(deps: EditorKeyHandlerDeps): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;

    // Cmd+P: Quick Open
    if (e.key === 'p' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleQuickOpen();
      return;
    }

    // Cmd+Shift+F: Search in files
    if (e.key === 'f' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleSearchPanel();
      return;
    }

    // Cmd+F: Find in current file (CM6)
    if (e.key === 'f' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const view = deps.getEditorView();
      if (view) openSearchPanel(view as Parameters<typeof openSearchPanel>[0]);
      return;
    }

    // Cmd+G: Go to line
    if (e.key === 'g' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const view = deps.getEditorView();
      if (view) gotoLine(view as Parameters<typeof gotoLine>[0]);
      return;
    }

    // Cmd+S: Save current file
    if (e.key === 's' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (deps.activeTabId) void deps.saveFile(deps.activeTabId);
      return;
    }

    // Cmd+Shift+S: Save all files
    if (e.key === 's' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (deps.hasUnsavedChanges()) void deps.saveAllFiles();
      return;
    }

    // Cmd+Shift+W: Toggle line wrap
    if (e.key === 'w' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleLineWrap();
      return;
    }

    // Cmd+W: Close current editor tab
    if (e.key === 'w' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (deps.activeTabId) {
        // Let overlay handle dirty check via onRequestCloseTab
        const closeEvent = new CustomEvent('editor-close-tab', { detail: deps.activeTabId });
        window.dispatchEvent(closeEvent);
      }
      return;
    }

    // Cmd+B: Toggle sidebar
    if (e.key === 'b') {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleSidebar();
      return;
    }

    // Cmd+Shift+]: Next tab
    if (e.key === ']' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const idx = deps.openTabs.findIndex((t) => t.id === deps.activeTabId);
      if (idx !== -1 && idx < deps.openTabs.length - 1) {
        deps.setActiveEditorTab(deps.openTabs[idx + 1].id);
      } else if (deps.openTabs.length > 0) {
        deps.setActiveEditorTab(deps.openTabs[0].id); // wrap
      }
      return;
    }

    // Cmd+Shift+[: Previous tab
    if (e.key === '[' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const idx = deps.openTabs.findIndex((t) => t.id === deps.activeTabId);
      if (idx > 0) {
        deps.setActiveEditorTab(deps.openTabs[idx - 1].id);
      } else if (deps.openTabs.length > 0) {
        deps.setActiveEditorTab(deps.openTabs[deps.openTabs.length - 1].id); // wrap
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: Tab cycling
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const idx = deps.openTabs.findIndex((t) => t.id === deps.activeTabId);
      if (e.shiftKey) {
        const prev = idx > 0 ? idx - 1 : deps.openTabs.length - 1;
        if (deps.openTabs[prev]) deps.setActiveEditorTab(deps.openTabs[prev].id);
      } else {
        const next = idx < deps.openTabs.length - 1 ? idx + 1 : 0;
        if (deps.openTabs[next]) deps.setActiveEditorTab(deps.openTabs[next].id);
      }
    }

    // Escape: Close editor (handled separately in overlay with dialog guards)
  };
}

// =============================================================================
// Hook
// =============================================================================

export function useEditorKeyboardShortcuts({
  onToggleQuickOpen,
  onToggleSearchPanel,
  onToggleSidebar,
  onClose: _onClose,
}: UseEditorKeyboardShortcutsOptions): void {
  const openTabs = useStore((s) => s.editorOpenTabs);
  const activeTabId = useStore((s) => s.editorActiveTabId);
  const setActiveEditorTab = useStore((s) => s.setActiveEditorTab);
  const saveFile = useStore((s) => s.saveFile);
  const saveAllFiles = useStore((s) => s.saveAllFiles);
  const hasUnsavedChanges = useStore((s) => s.hasUnsavedChanges);
  const toggleLineWrap = useStore((s) => s.toggleLineWrap);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const handler = createEditorKeyHandler({
        activeTabId,
        openTabs,
        setActiveEditorTab,
        saveFile,
        saveAllFiles,
        hasUnsavedChanges,
        onToggleQuickOpen,
        onToggleSearchPanel,
        onToggleSidebar,
        onToggleLineWrap: toggleLineWrap,
        getEditorView: () => editorBridge.getView(),
      });
      handler(e);
    },
    [
      activeTabId,
      openTabs,
      setActiveEditorTab,
      saveFile,
      saveAllFiles,
      hasUnsavedChanges,
      onToggleQuickOpen,
      onToggleSearchPanel,
      onToggleSidebar,
      toggleLineWrap,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);
}
