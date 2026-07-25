import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  useTerminalMuxTabsController,
  type TerminalMuxTabsController,
} from '@features/terminal-workspace/renderer/hooks/useTerminalMuxTabsController';
import type { TerminalMuxCommands } from '@features/terminal-workspace/renderer/hooks/useTerminalMuxTabLifecycle';
import type {
  TerminalMuxTab,
  TerminalWorkspaceSnapshot,
} from '@features/terminal-workspace/renderer/model/terminalTabPreferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@terminal-platform/workspace-react', () => ({
  resolveTerminalTopologyControlState: (snapshot: MockWorkspaceSnapshot) => snapshot.__controls,
}));

const TAB_ONE = createTab('tab-1', 'Build');
const TAB_TWO = createTab('tab-2', 'Tests');

describe('useTerminalMuxTabsController close focus', () => {
  let commands: TerminalMuxCommands;
  let controls: TerminalMuxTabsController | null;
  let host: HTMLDivElement;
  let root: Root;

  function Harness({ snapshot }: { snapshot: TerminalWorkspaceSnapshot }): React.JSX.Element {
    const nextControls = useTerminalMuxTabsController({
      commands,
      placement: 'console',
      settingsOpen: false,
      snapshot,
      teamName: 'terminal-focus-test',
    });
    controls = nextControls;

    return (
      <>
        {nextControls.viewModel.tabItems.map(({ id, label }) => (
          <div data-terminal-tab-id={id} key={id}>
            <button
              data-testid={`tab-${id}`}
              ref={(element) => nextControls.registerTabButtonElement(id, element)}
              type="button"
            >
              {label}
            </button>
            <button data-testid={`close-${id}`} type="button">
              Close
            </button>
          </div>
        ))}
        <button data-testid="external-focus-target" type="button">
          External
        </button>
      </>
    );
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    commands = createResolvedCommands();
    controls = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('focuses the preferred remaining tab after the closed tab leaves the DOM', async () => {
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    const closeButton = requiredElement('close-tab-2');
    closeButton.focus();

    await act(async () => {
      await requiredControls().requestCloseTab(TAB_TWO);
    });
    expect(document.activeElement).toBe(closeButton);

    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).toBe(requiredElement('tab-tab-1'));
  });

  it('restores focus when attach fails after the close command succeeded', async () => {
    commands.attachSession = vi.fn().mockRejectedValue(new Error('attach failed')) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    await act(async () => {
      await requiredControls().requestCloseTab(TAB_TWO);
    });
    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).toBe(requiredElement('tab-tab-1'));
  });

  it('does not steal focus when the user moves to another control during close', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_TWO);
      await flushMicrotasks();
    });

    const externalFocusTarget = requiredElement('external-focus-target');
    externalFocusTarget.focus();
    await act(async () => {
      attach.resolve();
      await closeAction;
    });
    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).toBe(externalFocusTarget);
  });

  async function render(snapshot: TerminalWorkspaceSnapshot): Promise<void> {
    await act(async () => {
      root.render(<Harness snapshot={snapshot} />);
      await flushMicrotasks();
    });
  }

  function requiredControls(): TerminalMuxTabsController {
    if (!controls) {
      throw new Error('Terminal mux tabs controller was not rendered');
    }
    return controls;
  }

  function requiredElement(testId: string): HTMLElement {
    const element = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!element) {
      throw new Error(`Missing test element: ${testId}`);
    }
    return element;
  }
});

interface MockWorkspaceSnapshot extends TerminalWorkspaceSnapshot {
  __controls: {
    activeSessionId: string;
    activeTab: TerminalMuxTab | null;
    canCloseTab: boolean;
    canCreateTab: boolean;
    canFocusTab: boolean;
    canRenameTab: boolean;
  };
}

function createSnapshot(
  tabs: readonly TerminalMuxTab[],
  activeTab: TerminalMuxTab
): TerminalWorkspaceSnapshot {
  return {
    __controls: {
      activeSessionId: 'session-a',
      activeTab,
      canCloseTab: true,
      canCreateTab: false,
      canFocusTab: true,
      canRenameTab: true,
    },
    attachedSession: {
      focused_screen: {
        pane_id: `pane-${activeTab.tab_id}`,
        surface: {
          lines: [],
        },
      },
      session: {
        session_id: 'session-a',
      },
      session_id: 'session-a',
      topology: {
        focused_tab: activeTab.tab_id,
        tabs,
      },
    },
    historicalPanes: {
      [`pane-${activeTab.tab_id}`]: {
        fromEventSeq: BigInt(1),
        hasGaps: false,
        hasMoreSegments: false,
        lines: [],
        nextEventSeq: null,
        paneId: `pane-${activeTab.tab_id}`,
        sessionId: 'session-a',
      },
    },
  } as unknown as MockWorkspaceSnapshot;
}

function createResolvedCommands(): TerminalMuxCommands {
  return {
    attachSession: vi.fn().mockResolvedValue(undefined),
    dispatchMuxCommand: vi.fn().mockResolvedValue(undefined),
  } as unknown as TerminalMuxCommands;
}

function createTab(tabId: string, title: string): TerminalMuxTab {
  return {
    active: false,
    focused_pane: `pane-${tabId}`,
    root: {
      cwd: '/fixtures/terminal-mux-tabs-controller',
      kind: 'leaf',
      pane_id: `pane-${tabId}`,
      title,
    },
    tab_id: tabId,
    title,
  } as TerminalMuxTab;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
