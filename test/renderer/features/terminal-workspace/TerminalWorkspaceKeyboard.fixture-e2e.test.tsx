import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';
import { useStore } from '@renderer/store';

let shortcutHost: HTMLDivElement | null = null;
let shortcutRoot: Root | null = null;

describe('terminal workspace keyboard fixture-e2e', () => {
  let originalStoreState: ReturnType<typeof useStore.getState>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    originalStoreState = useStore.getState();
  });

  afterEach(() => {
    if (shortcutRoot) {
      act(() => {
        shortcutRoot?.unmount();
      });
    }
    shortcutRoot = null;
    shortcutHost?.remove();
    shortcutHost = null;
    useStore.setState(originalStoreState, true);
  });

  it('does not close app tabs from terminal inputs mounted in shadow DOM', async () => {
    const closeTab = vi.fn();
    mountKeyboardShortcutHarness({ closeTab });

    const { hostElement, textarea } = createTerminalShadowTextarea();
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    await act(async () => {
      textarea.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
    hostElement.remove();
  });

  it('still closes the active app tab when Cmd/Ctrl+W starts outside editable UI', async () => {
    const closeTab = vi.fn();
    mountKeyboardShortcutHarness({ closeTab });

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(closeTab).toHaveBeenCalledWith('tab-1');
  });
});

function KeyboardShortcutHarness(): null {
  useKeyboardShortcuts();
  return null;
}

function mountKeyboardShortcutHarness({ closeTab }: { closeTab: (tabId: string) => void }): void {
  useStore.setState({
    openTabs: [
      {
        id: 'tab-1',
        type: 'dashboard',
        label: 'Dashboard',
        createdAt: 1,
      },
    ],
    activeTabId: 'tab-1',
    selectedTabIds: [],
    closeTab,
    closeAllTabs: vi.fn(),
    closeTabs: vi.fn(),
    setActiveTab: vi.fn(),
    openDashboard: vi.fn(),
    showSearch: vi.fn(),
    getActiveTab: vi.fn(() => ({
      id: 'tab-1',
      type: 'dashboard',
      label: 'Dashboard',
      createdAt: 1,
    })),
    selectedProjectId: null,
    selectedSessionId: null,
    fetchSessionDetail: vi.fn(),
    fetchSessions: vi.fn(),
    openCommandPalette: vi.fn(),
    openSettingsTab: vi.fn(),
    toggleSidebar: vi.fn(),
    paneLayout: {
      panes: [{ id: 'pane-1', tabIds: ['tab-1'], activeTabId: 'tab-1', size: 100 }],
      focusedPaneId: 'pane-1',
      orientation: 'horizontal',
    },
    focusPane: vi.fn(),
    splitPane: vi.fn(),
    closePane: vi.fn(),
    availableContexts: [],
    activeContextId: null,
    switchContext: vi.fn(),
    isContextSwitching: false,
    editorProjectPath: null,
  } as never);

  shortcutHost = document.createElement('div');
  document.body.appendChild(shortcutHost);
  shortcutRoot = createRoot(shortcutHost);
  act(() => {
    shortcutRoot?.render(React.createElement(KeyboardShortcutHarness));
  });
}

function createTerminalShadowTextarea(): {
  hostElement: HTMLElement;
  textarea: HTMLTextAreaElement;
} {
  const hostElement = document.createElement('tp-terminal-command-dock');
  const shadowRoot = hostElement.attachShadow({ mode: 'open' });
  const textarea = document.createElement('textarea');
  textarea.setAttribute('data-testid', 'tp-command-input');
  shadowRoot.appendChild(textarea);
  document.body.appendChild(hostElement);
  return { hostElement, textarea };
}
