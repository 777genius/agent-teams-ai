import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type TerminalMuxCommands,
  useTerminalMuxTabLifecycle,
} from '@features/terminal-workspace/renderer/hooks/useTerminalMuxTabLifecycle';
import {
  PREWARMED_TERMINAL_TAB_TITLE,
  type TerminalMuxTab,
  type TerminalWorkspaceSnapshot,
} from '@features/terminal-workspace/renderer/model/terminalTabPreferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LifecycleOptions = Parameters<typeof useTerminalMuxTabLifecycle>[0];
type LifecycleControls = ReturnType<typeof useTerminalMuxTabLifecycle>;

const TAB_ONE = createTab('tab-1', 'Build');
const TAB_TWO = createTab('tab-2', 'Tests');
const TAB_THREE = createTab('tab-3', 'Logs');
const VISIBLE_TABS = [TAB_ONE, TAB_TWO, TAB_THREE];

describe('useTerminalMuxTabLifecycle', () => {
  let host: HTMLDivElement;
  let root: Root;
  let controls: LifecycleControls | null;
  let options: LifecycleOptions;
  let renderSuspension: Promise<void> | null;

  function Harness(props: LifecycleOptions): null {
    const nextControls = useTerminalMuxTabLifecycle(props);
    if (renderSuspension) {
      throw renderSuspension;
    }
    controls = nextControls;
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    controls = null;
    renderSuspension = null;
    options = createOptions(createResolvedCommands());
  });

  afterEach(async () => {
    if (host.isConnected) {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      host.remove();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves mux command order and attaches only after the complete foreground plan', async () => {
    const events: string[] = [];
    const commands = createResolvedCommands({
      onAttach: (sessionId) => events.push(`attach:${sessionId}`),
      onDispatch: (sessionId, command) =>
        events.push(`dispatch:${sessionId}:${command.kind}:${getCommandTabId(command)}`),
    });
    await render({ commands });

    await act(async () => {
      await requiredControls().requestCloseTab(TAB_ONE);
    });

    expect(events).toEqual([
      'dispatch:session-a:close_tab:tab-1',
      'dispatch:session-a:focus_tab:tab-2',
      'attach:session-a',
    ]);
    expect(requiredControls().pendingAction).toBeNull();
  });

  it('uses a synchronous foreground mutex to reject a second action in the same render', async () => {
    const firstDispatch = createDeferred<void>();
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn(() => firstDispatch.promise) as never;
    await render({ commands });

    let firstAction!: Promise<void>;
    let secondAction!: Promise<void>;
    await act(async () => {
      firstAction = requiredControls().focusTab('tab-2');
      secondAction = requiredControls().focusTab('tab-3');
      await flushMicrotasks();
    });

    expect(commands.dispatchMuxCommand).toHaveBeenCalledOnce();
    expect(requiredControls().pendingAction).toBe('focus-tab:tab-2');

    await act(async () => {
      firstDispatch.resolve();
      await Promise.all([firstAction, secondAction]);
    });

    expect(commands.attachSession).toHaveBeenCalledOnce();
    expect(requiredControls().busy).toBe(false);
  });

  it('clears a failed foreground token so the action can be retried', async () => {
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('mux unavailable'))
      .mockResolvedValueOnce(undefined) as never;
    await render({ commands });

    await act(async () => {
      await requiredControls().focusTab('tab-2');
    });
    expect(requiredControls().error).toBe('mux unavailable');
    expect(requiredControls().busy).toBe(false);

    await act(async () => {
      await requiredControls().focusTab('tab-2');
    });
    expect(commands.dispatchMuxCommand).toHaveBeenCalledTimes(2);
    expect(commands.attachSession).toHaveBeenCalledOnce();
    expect(requiredControls().error).toBeNull();
  });

  it('cancels deferred session A work when the lifecycle scope switches to session B', async () => {
    const deferredA = createDeferred<void>();
    const pendingChanges = vi.fn();
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn((sessionId: string) =>
      sessionId === 'session-a' ? deferredA.promise : Promise.resolve()
    ) as never;
    await render({ commands, onTabContentPendingChange: pendingChanges });

    let sessionAAction!: Promise<void>;
    await act(async () => {
      sessionAAction = requiredControls().focusTab('tab-2');
      await flushMicrotasks();
    });
    await render({
      activeSessionId: 'session-b',
      commands,
      onTabContentPendingChange: pendingChanges,
    });

    expect(requiredControls().pendingAction).toBeNull();
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true, false]);

    await act(async () => {
      deferredA.resolve();
      await sessionAAction;
    });

    expect(commands.attachSession).not.toHaveBeenCalledWith('session-a');
    await act(async () => {
      await requiredControls().focusTab('tab-3');
    });
    expect(commands.attachSession).toHaveBeenCalledWith('session-b');
  });

  it('prevents stale session A finally from clearing session B pending state', async () => {
    const deferredA = createDeferred<void>();
    const deferredB = createDeferred<void>();
    const pendingChanges = vi.fn();
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn((sessionId: string) =>
      sessionId === 'session-a' ? deferredA.promise : deferredB.promise
    ) as never;
    await render({ commands, onTabContentPendingChange: pendingChanges });

    let sessionAAction!: Promise<void>;
    await act(async () => {
      sessionAAction = requiredControls().focusTab('tab-2');
      await flushMicrotasks();
    });
    await render({
      activeSessionId: 'session-b',
      commands,
      onTabContentPendingChange: pendingChanges,
    });

    let sessionBAction!: Promise<void>;
    await act(async () => {
      sessionBAction = requiredControls().focusTab('tab-3');
      await flushMicrotasks();
    });
    expect(requiredControls().pendingAction).toBe('focus-tab:tab-3');

    await act(async () => {
      deferredA.resolve();
      await sessionAAction;
    });
    expect(requiredControls().pendingAction).toBe('focus-tab:tab-3');
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true, false, true]);

    await act(async () => {
      deferredB.resolve();
      await sessionBAction;
    });
    expect(requiredControls().pendingAction).toBeNull();
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('invalidates an in-flight prewarm before running an explicit focus action', async () => {
    const prewarmDispatch = createDeferred<void>();
    const dispatchedKinds: string[] = [];
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn((_sessionId: string, command) => {
      dispatchedKinds.push(command.kind);
      return command.kind === 'new_tab' ? prewarmDispatch.promise : Promise.resolve();
    }) as never;

    await render({
      canCreateTab: true,
      commands,
      tabsCount: 1,
      visibleTabs: [TAB_ONE],
      orderedVisibleTabs: [TAB_ONE],
    });
    expect(dispatchedKinds).toEqual(['new_tab']);

    await act(async () => {
      await requiredControls().focusTab('tab-2');
    });
    expect(dispatchedKinds).toEqual(['new_tab', 'focus_tab']);
    expect(commands.attachSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      prewarmDispatch.resolve();
      await flushMicrotasks();
    });
    expect(dispatchedKinds).toEqual(['new_tab', 'focus_tab']);
    expect(commands.attachSession).toHaveBeenCalledTimes(1);
  });

  it('clears close, rename, error, and pending UI state on scope changes', async () => {
    const commandsA = createResolvedCommands();
    await render({
      commands: commandsA,
      snapshot: createSnapshotWithHistory(TAB_ONE),
    });

    await act(async () => {
      requiredControls().startRenameTab(TAB_TWO, 'Tests');
      await requiredControls().requestCloseTab(TAB_ONE);
    });
    expect(requiredControls().editingTabId).toBe('tab-2');
    expect(requiredControls().closeCandidate?.tab_id).toBe('tab-1');

    await render({
      activeSessionId: 'session-b',
      commands: commandsA,
      snapshot: createSnapshotWithHistory(TAB_ONE),
    });
    expect(requiredControls().editingTabId).toBeNull();
    expect(requiredControls().editingTitle).toBe('');
    expect(requiredControls().closeCandidate).toBeNull();

    const commandsB = createResolvedCommands();
    commandsB.dispatchMuxCommand = vi.fn().mockRejectedValue(new Error('scope-b-error')) as never;
    await render({ activeSessionId: 'session-b', commands: commandsB });
    await act(async () => {
      await requiredControls().focusTab('tab-2');
    });
    expect(requiredControls().error).toBe('scope-b-error');

    const pendingDispatch = createDeferred<void>();
    const pendingChanges = vi.fn();
    const commandsC = createResolvedCommands();
    commandsC.dispatchMuxCommand = vi.fn(() => pendingDispatch.promise) as never;
    await render({
      activeSessionId: 'session-c',
      commands: commandsC,
      onTabContentPendingChange: pendingChanges,
    });
    let pendingAction!: Promise<void>;
    await act(async () => {
      pendingAction = requiredControls().focusTab('tab-2');
      await flushMicrotasks();
    });
    expect(requiredControls().pendingAction).toBe('focus-tab:tab-2');

    await render({
      activeSessionId: 'session-d',
      commands: commandsC,
      onTabContentPendingChange: pendingChanges,
    });
    expect(requiredControls().error).toBeNull();
    expect(requiredControls().pendingAction).toBeNull();
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true, false]);

    await act(async () => {
      pendingDispatch.resolve();
      await pendingAction;
    });
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true, false]);
  });

  it('releases a pending callback exactly once on unmount and ignores late completion', async () => {
    const dispatch = createDeferred<void>();
    const pendingChanges = vi.fn();
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn(() => dispatch.promise) as never;
    await render({ commands, onTabContentPendingChange: pendingChanges });

    let action!: Promise<void>;
    await act(async () => {
      action = requiredControls().focusTab('tab-2');
      await flushMicrotasks();
    });
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    host.remove();
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true, false]);

    dispatch.resolve();
    await action;
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([true, false]);
    expect(commands.attachSession).not.toHaveBeenCalled();
  });

  it('contains restore rejection instead of leaking an unhandled promise', async () => {
    const unhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener('unhandledrejection', unhandledRejection);
    const prewarmedTab = createTab('tab-prewarmed', PREWARMED_TERMINAL_TAB_TITLE);
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn().mockRejectedValue(new Error('restore failed')) as never;

    await render({
      activeTabId: prewarmedTab.tab_id,
      activeVisibleTabId: TAB_ONE.tab_id,
      commands,
      prewarmedTab,
      tabsCount: 2,
      visibleTabs: [TAB_ONE],
      orderedVisibleTabs: [TAB_ONE],
    });
    await flushInAct();

    expect(commands.dispatchMuxCommand).toHaveBeenCalledWith('session-a', {
      kind: 'focus_tab',
      tab_id: 'tab-1',
    });
    expect(commands.attachSession).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandledRejection);
  });

  it('invalidates old work when the narrow commands port is replaced', async () => {
    const deferredOldPort = createDeferred<void>();
    const pendingChanges = vi.fn();
    const oldCommands = createResolvedCommands();
    oldCommands.dispatchMuxCommand = vi.fn(() => deferredOldPort.promise) as never;
    const newCommands = createResolvedCommands();
    await render({ commands: oldCommands, onTabContentPendingChange: pendingChanges });

    let oldAction!: Promise<void>;
    await act(async () => {
      oldAction = requiredControls().focusTab('tab-2');
      await flushMicrotasks();
    });
    await render({ commands: newCommands, onTabContentPendingChange: pendingChanges });

    await act(async () => {
      await requiredControls().focusTab('tab-3');
    });
    expect(newCommands.dispatchMuxCommand).toHaveBeenCalledWith('session-a', {
      kind: 'focus_tab',
      tab_id: 'tab-3',
    });
    expect(newCommands.attachSession).toHaveBeenCalledWith('session-a');

    await act(async () => {
      deferredOldPort.resolve();
      await oldAction;
    });
    expect(oldCommands.attachSession).not.toHaveBeenCalled();
    expect(pendingChanges.mock.calls.map(([pending]) => pending)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('does not cancel committed work from an abandoned concurrent scope render', async () => {
    const sessionADispatch = createDeferred<void>();
    const abandonedRender = createDeferred<void>();
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn(() => sessionADispatch.promise) as never;
    await render({ commands });

    let sessionAAction!: Promise<void>;
    await act(async () => {
      sessionAAction = requiredControls().focusTab('tab-2');
      await flushMicrotasks();
    });

    options = { ...options, activeSessionId: 'session-b' };
    renderSuspension = abandonedRender.promise;
    await act(async () => {
      React.startTransition(() => {
        root.render(
          <React.Suspense fallback={null}>
            <Harness {...options} />
          </React.Suspense>
        );
      });
      await flushMicrotasks();
    });

    await act(async () => {
      sessionADispatch.resolve();
      await sessionAAction;
    });
    expect(commands.attachSession).toHaveBeenCalledWith('session-a');

    renderSuspension = null;
    await act(async () => {
      abandonedRender.resolve();
      await flushMicrotasks();
    });
  });

  it('remembers prewarm failures per topology key and retries only after the key changes', async () => {
    const commands = createResolvedCommands();
    commands.dispatchMuxCommand = vi.fn().mockRejectedValue(new Error('prewarm failed')) as never;
    const prewarmOptions = {
      canCreateTab: true,
      commands,
      orderedVisibleTabs: [TAB_ONE],
      tabsCount: 1,
      visibleTabs: [TAB_ONE],
    };

    await render({ ...prewarmOptions, canCreateTab: false });
    await render(prewarmOptions);
    await flushInAct();
    expect(commands.dispatchMuxCommand).toHaveBeenCalledTimes(1);

    await render(prewarmOptions);
    await flushInAct();
    expect(commands.dispatchMuxCommand).toHaveBeenCalledTimes(1);

    await render({ ...prewarmOptions, tabsCount: 2 });
    await flushInAct();
    expect(commands.dispatchMuxCommand).toHaveBeenCalledTimes(2);
  });

  async function render(overrides: Partial<LifecycleOptions> = {}): Promise<void> {
    options = { ...options, ...overrides };
    await act(async () => {
      root.render(
        <React.Suspense fallback={null}>
          <Harness {...options} />
        </React.Suspense>
      );
      await flushMicrotasks();
    });
  }

  function requiredControls(): LifecycleControls {
    if (!controls) {
      throw new Error('Lifecycle controls were not rendered');
    }
    return controls;
  }
});

function createOptions(commands: TerminalMuxCommands): LifecycleOptions {
  return {
    activeSessionId: 'session-a',
    activeTabId: 'tab-1',
    activeVisibleTabId: 'tab-1',
    canCloseVisibleTabs: true,
    canCreateTab: false,
    canFocusTab: true,
    canRenameTab: true,
    commands,
    orderedVisibleTabs: VISIBLE_TABS,
    prewarmedTab: null,
    snapshot: {} as TerminalWorkspaceSnapshot,
    tabsCount: VISIBLE_TABS.length,
    visibleTabs: VISIBLE_TABS,
  };
}

function createResolvedCommands({
  onAttach,
  onDispatch,
}: {
  onAttach?: (sessionId: string) => void;
  onDispatch?: (
    sessionId: string,
    command: Parameters<TerminalMuxCommands['dispatchMuxCommand']>[1]
  ) => void;
} = {}): TerminalMuxCommands {
  return {
    attachSession: vi.fn(async (sessionId: string) => {
      onAttach?.(sessionId);
    }),
    dispatchMuxCommand: vi.fn(async (sessionId: string, command) => {
      onDispatch?.(sessionId, command);
    }),
  } as unknown as TerminalMuxCommands;
}

function createTab(tabId: string, title: string): TerminalMuxTab {
  return {
    active: false,
    focused_pane: `pane-${tabId}`,
    root: {
      cwd: '/fixtures/terminal-mux-lifecycle',
      kind: 'leaf',
      pane_id: `pane-${tabId}`,
      title,
    },
    tab_id: tabId,
    title,
  } as TerminalMuxTab;
}

function createSnapshotWithHistory(tab: TerminalMuxTab): TerminalWorkspaceSnapshot {
  return {
    historicalPanes: {
      [`pane-${tab.tab_id}`]: {
        capturedAtMs: BigInt(1),
        lines: ['terminal output'],
      },
    },
  } as unknown as TerminalWorkspaceSnapshot;
}

function getCommandTabId(
  command: Parameters<TerminalMuxCommands['dispatchMuxCommand']>[1]
): string {
  return 'tab_id' in command ? String(command.tab_id) : '';
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushInAct(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}
