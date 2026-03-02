/**
 * useEditorKeyboardShortcuts — keyboard shortcuts scoped to the project editor overlay.
 *
 * All shortcuts use stopPropagation to prevent conflicts with global useKeyboardShortcuts.
 * CM6-internal shortcuts (Cmd+Z, Cmd+Shift+Z, Cmd+A, Cmd+D) are handled by CodeMirror directly.
 */

import { useCallback, useEffect, useRef } from 'react';

import { openSearchPanel } from '@codemirror/search';
import { useStore } from '@renderer/store';
import { editorBridge } from '@renderer/utils/editorBridge';
import { physicalKey } from '@renderer/utils/keyboardUtils';
import { useShallow } from 'zustand/react/shallow';

import type { EditorFileTab } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface UseEditorKeyboardShortcutsOptions {
  onToggleQuickOpen: () => void;
  onToggleSearchPanel: () => void;
  onToggleGoToLine: () => void;
  onToggleSidebar: () => void;
  onClose: () => void;
  onToggleMdSplit?: () => void;
  onToggleMdPreview?: () => void;
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
  onToggleGoToLine: () => void;
  onToggleSidebar: () => void;
  onToggleLineWrap: () => void;
  onToggleMdSplit?: () => void;
  onToggleMdPreview?: () => void;
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

    // Layout-independent key (uses event.code for letters/symbols)
    const key = physicalKey(e);

    // Cmd+P: Quick Open
    if (key === 'p' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleQuickOpen();
      return;
    }

    // Cmd+Shift+F: Search in files
    if (key === 'f' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleSearchPanel();
      return;
    }

    // Cmd+F: Find in current file (CM6)
    if (key === 'f' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const view = deps.getEditorView();
      if (view) openSearchPanel(view as Parameters<typeof openSearchPanel>[0]);
      return;
    }

    // Cmd+G: Go to line
    if (key === 'g' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleGoToLine();
      return;
    }

    // Cmd+S: Save current file
    if (key === 's' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (deps.activeTabId) void deps.saveFile(deps.activeTabId);
      return;
    }

    // Cmd+Shift+S: Save all files
    if (key === 's' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (deps.hasUnsavedChanges()) void deps.saveAllFiles();
      return;
    }

    // Cmd+Shift+M: Toggle markdown split preview
    if (key === 'm' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleMdSplit?.();
      return;
    }

    // Cmd+Shift+V: Toggle markdown full preview
    if (key === 'v' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleMdPreview?.();
      return;
    }

    // Cmd+Shift+W: Toggle line wrap
    if (key === 'w' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleLineWrap();
      return;
    }

    // Cmd+W: Close current editor tab
    if (key === 'w' && !e.shiftKey && !e.altKey) {
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
    if (key === 'b') {
      e.preventDefault();
      e.stopPropagation();
      deps.onToggleSidebar();
      return;
    }

    // Cmd+Shift+]: Next tab
    if (key === ']' && e.shiftKey) {
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
    if (key === '[' && e.shiftKey) {
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
    if (e.ctrlKey && key === 'Tab') {
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
  onToggleGoToLine,
  onToggleSidebar,
  onClose: _onClose,
  onToggleMdSplit,
  onToggleMdPreview,
}: UseEditorKeyboardShortcutsOptions): void {
  const { openTabs, activeTabId } = useStore(
    useShallow((s) => ({
      openTabs: s.editorOpenTabs,
      activeTabId: s.editorActiveTabId,
    }))
  );
  const setActiveEditorTab = useStore((s) => s.setActiveEditorTab);
  const saveFile = useStore((s) => s.saveFile);
  const saveAllFiles = useStore((s) => s.saveAllFiles);
  const hasUnsavedChanges = useStore((s) => s.hasUnsavedChanges);
  const toggleLineWrap = useStore((s) => s.toggleLineWrap);

  // Store all deps in a ref so the keydown handler has a stable identity
  const depsRef = useRef<EditorKeyHandlerDeps>(null!);
  // eslint-disable-next-line react-hooks/refs -- sync ref with deps for stable keydown handler
  depsRef.current = {
    activeTabId,
    openTabs,
    setActiveEditorTab,
    saveFile,
    saveAllFiles,
    hasUnsavedChanges,
    onToggleQuickOpen,
    onToggleSearchPanel,
    onToggleGoToLine,
    onToggleSidebar,
    onToggleLineWrap: toggleLineWrap,
    onToggleMdSplit,
    onToggleMdPreview,
    getEditorView: () => editorBridge.getView(),
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const handler = createEditorKeyHandler(depsRef.current);
    handler(e);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);
}
