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

  function Harness({
    settingsOpen = false,
    snapshot,
  }: Readonly<{
    settingsOpen?: boolean;
    snapshot: TerminalWorkspaceSnapshot;
  }>): React.JSX.Element {
    const nextControls = useTerminalMuxTabsController({
      commandRuns: [],
      commands,
      placement: 'console',
      settingsOpen,
      snapshot,
      teamName: 'terminal-focus-test',
    });
    controls = nextControls;

    return (
      <>
        {nextControls.viewModel.tabItems.map(({ active, id, label }) => (
          <div data-terminal-tab-id={id} key={id}>
            <button
              aria-disabled={nextControls.busy}
              aria-selected={active}
              data-testid={`tab-${id}`}
              ref={(element) => nextControls.registerTabButtonElement(id, element)}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              {label}
            </button>
            <button data-testid={`close-${id}`} type="button">
              Close
            </button>
          </div>
        ))}
        {settingsOpen ? (
          <button
            aria-selected="true"
            data-testid="settings-tab"
            ref={nextControls.settingsTabButtonRef}
            role="tab"
            tabIndex={0}
            type="button"
          >
            Settings
          </button>
        ) : null}
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

    await requestAndConfirmClose(TAB_TWO);
    expect(document.activeElement).toBe(closeButton);

    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).toBe(requiredElement('tab-tab-1'));
  });

  it('restores focus when attach fails after the close command succeeded', async () => {
    commands.attachSession = vi.fn().mockRejectedValue(new Error('attach failed')) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    await requestAndConfirmClose(TAB_TWO);
    await render(createSnapshot([TAB_ONE], TAB_ONE));

    expect(document.activeElement).toBe(requiredElement('tab-tab-1'));
  });

  it('restores focus before an in-flight attach settles', async () => {
    const attach = createDeferred<void>();
    commands.attachSession = vi.fn(() => attach.promise) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO));
    requiredElement('close-tab-2').focus();

    const { closeAction } = await beginConfirmedClose(TAB_TWO);
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

    const { closeAction } = await beginConfirmedClose(TAB_TWO);

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

    const { closeAction } = await beginConfirmedClose(TAB_TWO);

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

    const { closeAction } = await beginConfirmedClose(TAB_ONE);

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

    await requestAndConfirmClose(TAB_ONE);
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

    const { closeAction } = await beginConfirmedClose(TAB_ONE);
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

    const { closeAction } = await beginConfirmedClose(TAB_ONE);
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

    const { closeAction } = await beginConfirmedClose(TAB_ONE);
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

    const { closeAction } = await beginConfirmedClose(TAB_TWO);

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

  it('restores DOM focus to the selected settings tab after closing a terminal tab', async () => {
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO), true);
    requiredElement('close-tab-2').focus();

    await requestAndConfirmClose(TAB_TWO);
    await render(createSnapshot([TAB_ONE], TAB_ONE), true);

    const settingsTab = requiredElement('settings-tab');
    expect(settingsTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(settingsTab);
    expect(requiredElement('tab-tab-1').getAttribute('tabindex')).toBe('-1');
  });

  it('restores settings focus before a deferred terminal focus command settles', async () => {
    const focusDispatch = createDeferred<MuxCommandResult>();
    commands.dispatchMuxCommand = vi.fn((_sessionId, command) =>
      command.kind === 'focus_tab' ? focusDispatch.promise : Promise.resolve(CHANGED_MUX_RESULT)
    ) as never;
    await render(createSnapshot([TAB_ONE, TAB_TWO], TAB_TWO), true);
    requiredElement('close-tab-2').focus();

    const { closeAction } = await beginConfirmedClose(TAB_TWO);
    await render(createSnapshot([TAB_ONE], TAB_ONE), true);

    expect(requiredControls().busy).toBe(true);
    expect(document.activeElement).toBe(requiredElement('settings-tab'));

    await act(async () => {
      focusDispatch.resolve(CHANGED_MUX_RESULT);
      await closeAction;
    });
  });

  async function requestAndConfirmClose(tab: TerminalMuxTab): Promise<void> {
    await act(async () => {
      await requiredControls().requestCloseTab(tab);
    });
    await act(async () => {
      await requiredControls().confirmCloseCandidate();
    });
  }

  async function beginConfirmedClose(tab: TerminalMuxTab): Promise<{ closeAction: Promise<void> }> {
    await act(async () => {
      await requiredControls().requestCloseTab(tab);
    });

    let closeAction!: Promise<void>;
    await act(async () => {
      closeAction = requiredControls().confirmCloseCandidate();
      await flushMicrotasks();
    });
    return { closeAction };
  }

  async function render(snapshot: TerminalWorkspaceSnapshot, settingsOpen = false): Promise<void> {
    await act(async () => {
      root.render(<Harness settingsOpen={settingsOpen} snapshot={snapshot} />);
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
