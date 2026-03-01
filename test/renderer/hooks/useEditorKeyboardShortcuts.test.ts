/**
 * Tests for createEditorKeyHandler — the pure keyboard dispatch logic
 * extracted from useEditorKeyboardShortcuts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @codemirror/search — handler calls openSearchPanel/gotoLine when view exists
vi.mock('@codemirror/search', () => ({
  openSearchPanel: vi.fn(),
  gotoLine: vi.fn(),
}));

import { gotoLine, openSearchPanel } from '@codemirror/search';
import { createEditorKeyHandler } from '@renderer/hooks/useEditorKeyboardShortcuts';

import type { EditorKeyHandlerDeps } from '@renderer/hooks/useEditorKeyboardShortcuts';
import type { EditorFileTab } from '@shared/types/editor';

// =============================================================================
// Helpers
// =============================================================================

function createMockDeps(overrides: Partial<EditorKeyHandlerDeps> = {}): EditorKeyHandlerDeps {
  return {
    activeTabId: '/project/file1.ts',
    openTabs: [
      {
        id: '/project/file1.ts',
        filePath: '/project/file1.ts',
        fileName: 'file1.ts',
        language: 'typescript',
      },
      {
        id: '/project/file2.ts',
        filePath: '/project/file2.ts',
        fileName: 'file2.ts',
        language: 'typescript',
      },
      {
        id: '/project/file3.ts',
        filePath: '/project/file3.ts',
        fileName: 'file3.ts',
        language: 'typescript',
      },
    ] as EditorFileTab[],
    setActiveEditorTab: vi.fn(),
    saveFile: vi.fn().mockResolvedValue(undefined),
    saveAllFiles: vi.fn().mockResolvedValue(undefined),
    hasUnsavedChanges: vi.fn().mockReturnValue(false),
    onToggleQuickOpen: vi.fn(),
    onToggleSearchPanel: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleLineWrap: vi.fn(),
    getEditorView: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function createKeyEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    metaKey: opts.metaKey ?? true,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('createEditorKeyHandler', () => {
  let deps: EditorKeyHandlerDeps;

  beforeEach(() => {
    vi.resetAllMocks();
    deps = createMockDeps();
  });

  it('ignores events without modifier key', () => {
    const handler = createEditorKeyHandler(deps);
    const event = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
    handler(event);
    expect(deps.onToggleQuickOpen).not.toHaveBeenCalled();
  });

  describe('Cmd+P — Quick Open', () => {
    it('calls onToggleQuickOpen', () => {
      const handler = createEditorKeyHandler(deps);
      const event = createKeyEvent('p');
      handler(event);
      expect(deps.onToggleQuickOpen).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    });

    it('does not trigger with Shift', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('p', { shiftKey: true }));
      expect(deps.onToggleQuickOpen).not.toHaveBeenCalled();
    });
  });

  describe('Cmd+Shift+F — Search in Files', () => {
    it('calls onToggleSearchPanel', () => {
      const handler = createEditorKeyHandler(deps);
      const event = createKeyEvent('f', { shiftKey: true });
      handler(event);
      expect(deps.onToggleSearchPanel).toHaveBeenCalledOnce();
    });
  });

  describe('Cmd+F — Find in File (CM6)', () => {
    it('calls openSearchPanel when editor view exists', () => {
      const mockView = { dispatch: vi.fn() };
      deps = createMockDeps({ getEditorView: vi.fn().mockReturnValue(mockView) });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('f'));
      expect(openSearchPanel).toHaveBeenCalledWith(mockView);
    });

    it('does nothing when no editor view', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('f'));
      expect(openSearchPanel).not.toHaveBeenCalled();
    });
  });

  describe('Cmd+G — Go to Line', () => {
    it('calls gotoLine when editor view exists', () => {
      const mockView = { dispatch: vi.fn() };
      deps = createMockDeps({ getEditorView: vi.fn().mockReturnValue(mockView) });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('g'));
      expect(gotoLine).toHaveBeenCalledWith(mockView);
    });
  });

  describe('Cmd+S — Save', () => {
    it('calls saveFile with active tab id', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('s'));
      expect(deps.saveFile).toHaveBeenCalledWith('/project/file1.ts');
    });

    it('does nothing when no active tab', () => {
      deps = createMockDeps({ activeTabId: null });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('s'));
      expect(deps.saveFile).not.toHaveBeenCalled();
    });
  });

  describe('Cmd+Shift+S — Save All', () => {
    it('calls saveAllFiles when unsaved changes exist', () => {
      deps = createMockDeps({ hasUnsavedChanges: vi.fn().mockReturnValue(true) });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('s', { shiftKey: true }));
      expect(deps.saveAllFiles).toHaveBeenCalledOnce();
    });

    it('does nothing when no unsaved changes', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('s', { shiftKey: true }));
      expect(deps.saveAllFiles).not.toHaveBeenCalled();
    });
  });

  describe('Cmd+Shift+W — Toggle Line Wrap', () => {
    it('calls onToggleLineWrap', () => {
      const handler = createEditorKeyHandler(deps);
      const event = createKeyEvent('w', { shiftKey: true });
      handler(event);
      expect(deps.onToggleLineWrap).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('Cmd+W — Close Tab', () => {
    it('dispatches editor-close-tab CustomEvent with active tab id', () => {
      const handler = createEditorKeyHandler(deps);
      const eventSpy = vi.fn();
      window.addEventListener('editor-close-tab', eventSpy);

      handler(createKeyEvent('w'));

      expect(eventSpy).toHaveBeenCalledOnce();
      const detail = (eventSpy.mock.calls[0][0] as CustomEvent).detail;
      expect(detail).toBe('/project/file1.ts');

      window.removeEventListener('editor-close-tab', eventSpy);
    });

    it('does nothing with Alt modifier', () => {
      const handler = createEditorKeyHandler(deps);
      const eventSpy = vi.fn();
      window.addEventListener('editor-close-tab', eventSpy);

      handler(createKeyEvent('w', { altKey: true }));
      expect(eventSpy).not.toHaveBeenCalled();

      window.removeEventListener('editor-close-tab', eventSpy);
    });
  });

  describe('Cmd+B — Toggle Sidebar', () => {
    it('calls onToggleSidebar', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('b'));
      expect(deps.onToggleSidebar).toHaveBeenCalledOnce();
    });
  });

  describe('Cmd+Shift+] / [ — Tab Navigation', () => {
    it('moves to next tab with Cmd+Shift+]', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent(']', { shiftKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file2.ts');
    });

    it('wraps to first tab when on last', () => {
      deps = createMockDeps({ activeTabId: '/project/file3.ts' });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent(']', { shiftKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file1.ts');
    });

    it('moves to previous tab with Cmd+Shift+[', () => {
      deps = createMockDeps({ activeTabId: '/project/file2.ts' });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('[', { shiftKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file1.ts');
    });

    it('wraps to last tab when on first with Cmd+Shift+[', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('[', { shiftKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file3.ts');
    });
  });

  describe('Ctrl+Tab — Tab Cycling', () => {
    it('moves to next tab', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('Tab', { metaKey: false, ctrlKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file2.ts');
    });

    it('moves to previous tab with Shift', () => {
      deps = createMockDeps({ activeTabId: '/project/file2.ts' });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('Tab', { metaKey: false, ctrlKey: true, shiftKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file1.ts');
    });

    it('wraps forward on last tab', () => {
      deps = createMockDeps({ activeTabId: '/project/file3.ts' });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('Tab', { metaKey: false, ctrlKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file1.ts');
    });

    it('wraps backward on first tab', () => {
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent('Tab', { metaKey: false, ctrlKey: true, shiftKey: true }));
      expect(deps.setActiveEditorTab).toHaveBeenCalledWith('/project/file3.ts');
    });
  });

  describe('edge cases', () => {
    it('does nothing when openTabs is empty', () => {
      deps = createMockDeps({ openTabs: [], activeTabId: null });
      const handler = createEditorKeyHandler(deps);
      handler(createKeyEvent(']', { shiftKey: true }));
      expect(deps.setActiveEditorTab).not.toHaveBeenCalled();
    });

    it('stopPropagation is called on handled shortcuts', () => {
      const handler = createEditorKeyHandler(deps);
      const event = createKeyEvent('p');
      const spy = vi.spyOn(event, 'stopPropagation');
      handler(event);
      expect(spy).toHaveBeenCalledOnce();
    });
  });
});
