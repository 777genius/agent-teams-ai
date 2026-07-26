import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type TerminalMuxTabsController,
  useTerminalMuxTabsController,
} from '@features/terminal-workspace/renderer/hooks/useTerminalMuxTabsController';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalMuxCommands } from '@features/terminal-workspace/renderer/hooks/useTerminalMuxTabLifecycle';
import type {
  TerminalMuxTab,
  TerminalWorkspaceSnapshot,
} from '@features/terminal-workspace/renderer/model/terminalTabPreferences';

vi.mock('@terminal-platform/workspace-react', () => ({
  resolveTerminalTopologyControlState: (snapshot: MockWorkspaceSnapshot) => snapshot.__controls,
}));

const TAB_ONE = createTab('tab-1', 'Build');
const TAB_TWO = createTab('tab-2', 'Tests');
const TAB_THREE = createTab('tab-3', 'Deploy');

describe('useTerminalMuxTabsController close focus', () => {
  let commands: TerminalMuxCommands;
  let controls: TerminalMuxTabsController | null;
  let host: HTMLDivElement;
  let root: Root;

  function Harness({ snapshot }: { snapshot: TerminalWorkspaceSnapshot }): React.JSX.Element {
    const nextControls = useTerminalMuxTabsController({
      commandRuns: [],
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
              aria-disabled={nextControls.busy}
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

  it('restores focus before an in-flight attach settles', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_TWO);
      await flushMicrotasks();
    });
    expect(requiredControls().busy).toBe(true);

    await render(createSnapshot([TAB_ONE], TAB_ONE));

    const remainingTab = requiredElement('tab-tab-1');
    expect(remainingTab.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(remainingTab);

    await act(async () => {
      attach.resolve();
      await closeAction;
    });
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

  it('does not restore stale close focus after the terminal command scope changes', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_TWO);
      await flushMicrotasks();
    });

    commands = createResolvedCommands();
    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).not.toBe(requiredElement('tab-tab-1'));

    await act(async () => {
      attach.resolve();
      await closeAction;
    });

    expect(document.activeElement).not.toBe(requiredElement('tab-tab-1'));
  });

  it('waits for the recorded post-close focus target across an intermediate topology', async () => {
    const focusDispatch = createDeferred<void>();
    commands.dispatchMuxCommand = vi.fn(async (_sessionId, command) => {
      if (command.kind === 'focus_tab') {
        await focusDispatch.promise;
      }
      return CHANGED_MUX_RESULT;
    }) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO, TAB_THREE], TAB_ONE));
    requiredElement('close-tab-1').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_ONE);
      await flushMicrotasks();
    });

    await render(createSnapshot([TAB_TWO, TAB_THREE], TAB_THREE));
    expect(document.activeElement).not.toBe(requiredElement('tab-tab-3'));

    await act(async () => {
      focusDispatch.resolve();
      await closeAction;
    });
    await render(createSnapshot([TAB_TWO, TAB_THREE], TAB_TWO));

    expect(document.activeElement).toBe(requiredElement('tab-tab-2'));
  });

  it('falls back to the active tab when preferred focus is rejected semantically', async () => {
    commands.dispatchMuxCommand = vi.fn(async (_sessionId, command) => ({
      changed: command.kind !== 'focus_tab',
    })) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO, TAB_THREE], TAB_ONE));
    requiredElement('close-tab-1').focus();

    await act(async () => {
      await requiredControls().requestCloseTab(TAB_ONE);
    });
    await render(createSnapshot([TAB_TWO, TAB_THREE], TAB_THREE));

    expect(document.activeElement).toBe(requiredElement('tab-tab-3'));
  });

  it('falls back before attach settles when preferred focus is rejected semantically', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    commands.dispatchMuxCommand = vi.fn(async (_sessionId, command) => ({
      changed: command.kind !== 'focus_tab',
    })) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO, TAB_THREE], TAB_ONE));
    requiredElement('close-tab-1').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_ONE);
      await flushMicrotasks();
    });
    await render(createSnapshot([TAB_TWO, TAB_THREE], TAB_THREE));

    expect(requiredControls().busy).toBe(true);
    expect(document.activeElement).toBe(requiredElement('tab-tab-3'));

    await act(async () => {
      attach.resolve();
      await closeAction;
    });
  });

  it('falls back after settlement when another visible tab wins the final topology', async () => {
    const settleFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      settleFrames.push(callback);
      return settleFrames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO, TAB_THREE], TAB_ONE));
    requiredElement('close-tab-1').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_ONE);
      await flushMicrotasks();
    });
    await render(createSnapshot([TAB_TWO, TAB_THREE], TAB_THREE));

    expect(requiredControls().busy).toBe(true);
    expect(document.activeElement).not.toBe(requiredElement('tab-tab-3'));

    await act(async () => {
      attach.resolve();
      await closeAction;
    });

    expect(requiredControls().busy).toBe(false);
    expect(document.activeElement).not.toBe(requiredElement('tab-tab-3'));

    await act(async () => {
      settleFrames.shift()?.(performance.now());
      settleFrames.shift()?.(performance.now());
      await flushMicrotasks();
    });

    expect(document.activeElement).toBe(requiredElement('tab-tab-3'));
  });

  it('falls back after a dispatched preferred focus target disappears', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO, TAB_THREE], TAB_ONE));
    requiredElement('close-tab-1').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_ONE);
      await flushMicrotasks();
    });
    expect(commands.dispatchMuxCommand).toHaveBeenCalledWith('session-a', {
      kind: 'focus_tab',
      tab_id: TAB_TWO.tab_id,
    });

    await render(createSnapshot([TAB_THREE], TAB_THREE));
    expect(requiredControls().busy).toBe(true);
    expect(document.activeElement).not.toBe(requiredElement('tab-tab-3'));

    await act(async () => {
      attach.resolve();
      await closeAction;
    });

    expect(requiredControls().busy).toBe(false);
    expect(document.activeElement).toBe(requiredElement('tab-tab-3'));
  });

  it('does not restore stale close focus after the connection reconnects', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().requestCloseTab(TAB_TWO);
      await flushMicrotasks();
    });

    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO, 'bootstrapping'));
    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).not.toBe(requiredElement('tab-tab-1'));

    await act(async () => {
      attach.resolve();
      await closeAction;
    });

    expect(document.activeElement).not.toBe(requiredElement('tab-tab-1'));
  });

  it('restores DOM focus to the active mux tab after closing a focused inactive tab', async () => {
    await render(createSnapshot([TAB_ONE, TAB_TWO, TAB_THREE], TAB_THREE));
    requiredElement('close-tab-1').focus();

    await act(async () => {
      await requiredControls().requestCloseTab(TAB_ONE);
    });
    expect(requiredControls().closeCandidate?.tab_id).toBe(TAB_ONE.tab_id);
    await act(async () => {
      await requiredControls().confirmCloseCandidate();
    });
    await render(createSnapshot([TAB_TWO, TAB_THREE], TAB_THREE));

    expect(document.activeElement).toBe(requiredElement('tab-tab-3'));
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
  activeTab: TerminalMuxTab,
  connectionState: TerminalWorkspaceSnapshot['connection']['state'] = 'ready'
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
    connection: {
      handshake: null,
      lastError: null,
      state: connectionState,
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
    dispatchMuxCommand: vi.fn().mockResolvedValue(CHANGED_MUX_RESULT),
  } as unknown as TerminalMuxCommands;
}

type MuxCommandResult = Awaited<ReturnType<TerminalMuxCommands['dispatchMuxCommand']>>;

const CHANGED_MUX_RESULT: MuxCommandResult = { changed: true };

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
