import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useTerminalCommandRuns } from '@features/terminal-workspace/renderer/hooks/useTerminalCommandRuns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TerminalCommandRunPresentation,
  TerminalCommandScreenLine,
} from '@features/terminal-workspace/renderer/model/terminalCommandRuns';

interface HarnessProps {
  activePaneId: string | null;
  activeSessionId: string | null;
  eventSource: EventTarget | null;
  onCommandStarted: () => void;
  onCommandSubmitted: () => void;
  renderGate?: RenderGate;
  screenLines: readonly TerminalCommandScreenLine[];
  screenSequence: unknown;
  teamName: string;
}

interface RenderGate {
  read: () => void;
  resolve: () => void;
}

type HookResult = ReturnType<typeof useTerminalCommandRuns>;

const TEAM_NAME = 'terminal-command-runs-hook-fixture';

describe('useTerminalCommandRuns', () => {
  let host: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let result: HookResult | null;

  function Harness(props: HarnessProps): null {
    result = useTerminalCommandRuns(props);
    props.renderGate?.read();
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;
    result = null;
  });

  afterEach(async () => {
    if (mounted) {
      await unmountHarness();
    }
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('tracks lifecycle events and calls the matching presentation callbacks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const eventSource = new EventTarget();
    const onCommandStarted = vi.fn();
    const onCommandSubmitted = vi.fn();
    const props = createProps({ eventSource, onCommandStarted, onCommandSubmitted });
    const detail = createEventDetail({ startedAtMs: 1_750 });

    await renderHarness(props);
    await dispatchCommandEvent(eventSource, 'tp-terminal-command-started', detail);

    expect(onCommandStarted).toHaveBeenCalledOnce();
    expect(requireResult().commandRuns).toEqual([
      expect.objectContaining({
        clientEventId: detail.clientEventId,
        command: detail.command,
        status: 'running',
      }),
    ]);

    await dispatchCommandEvent(eventSource, 'tp-terminal-command-submitted', detail);
    expect(onCommandSubmitted).toHaveBeenCalledOnce();

    await dispatchCommandEvent(eventSource, 'tp-terminal-command-failed', detail);
    expect(requireResult().commandRuns[0]).toMatchObject({
      clientEventId: detail.clientEventId,
      durationMs: 250,
      status: 'failed',
    });
  });

  it('cleans listeners and its interval when the event source changes or unmounts', async () => {
    vi.useFakeTimers();
    const firstSource = new EventTarget();
    const secondSource = new EventTarget();
    const firstAdd = vi.spyOn(firstSource, 'addEventListener');
    const firstRemove = vi.spyOn(firstSource, 'removeEventListener');
    const secondAdd = vi.spyOn(secondSource, 'addEventListener');
    const secondRemove = vi.spyOn(secondSource, 'removeEventListener');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const onCommandStarted = vi.fn();
    const props = createProps({ eventSource: firstSource, onCommandStarted });

    await renderHarness(props);
    expect(firstAdd).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);

    await renderHarness({ ...props, eventSource: secondSource });
    expect(firstRemove).toHaveBeenCalledTimes(4);
    expect(secondAdd).toHaveBeenCalledTimes(4);

    await dispatchCommandEvent(firstSource, 'tp-terminal-command-started', createEventDetail());
    expect(onCommandStarted).not.toHaveBeenCalled();
    expect(requireResult().commandRuns).toEqual([]);

    await dispatchCommandEvent(
      secondSource,
      'tp-terminal-command-started',
      createEventDetail({ clientEventId: 'active-source-run' })
    );
    expect(onCommandStarted).toHaveBeenCalledOnce();
    expect(requireResult().commandRuns).toHaveLength(1);

    await unmountHarness();
    expect(secondRemove).toHaveBeenCalledTimes(4);
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    secondSource.dispatchEvent(
      createCommandEvent(
        'tp-terminal-command-started',
        createEventDetail({ clientEventId: 'post-unmount-run' })
      )
    );
    vi.advanceTimersByTime(1_800);
    expect(onCommandStarted).toHaveBeenCalledOnce();
    expect(requireResult().commandRuns).toHaveLength(1);
  });

  it('uses the latest pane, session, screen, and callbacks without rebinding listeners', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_100);
    const eventSource = new EventTarget();
    const addEventListener = vi.spyOn(eventSource, 'addEventListener');
    const removeEventListener = vi.spyOn(eventSource, 'removeEventListener');
    const firstSubmitted = vi.fn();
    const latestSubmitted = vi.fn();
    const props = createProps({
      activePaneId: 'pane-1',
      activeSessionId: 'session-1',
      eventSource,
      onCommandSubmitted: firstSubmitted,
    });

    await renderHarness(props);
    await dispatchCommandEvent(
      eventSource,
      'tp-terminal-command-started',
      createEventDetail({ command: 'true', startedAtMs: 1_000 })
    );

    await renderHarness({
      ...props,
      activePaneId: 'pane-2',
      activeSessionId: 'session-2',
      onCommandSubmitted: latestSubmitted,
      screenLines: ['shell % true', 'shell %'],
      screenSequence: 2,
    });
    expect(addEventListener).toHaveBeenCalledTimes(4);
    expect(removeEventListener).not.toHaveBeenCalled();

    await advanceTimers(900);
    expect(requireResult().commandRuns[0]?.status).toBe('running');

    await dispatchCommandEvent(eventSource, 'tp-terminal-paste-submitted');
    expect(firstSubmitted).not.toHaveBeenCalled();
    expect(latestSubmitted).toHaveBeenCalledOnce();

    await renderHarness({
      ...props,
      onCommandSubmitted: latestSubmitted,
      screenLines: ['shell % true', 'shell %'],
      screenSequence: 3,
    });
    expect(addEventListener).toHaveBeenCalledTimes(4);
    expect(removeEventListener).not.toHaveBeenCalled();

    await advanceTimers(900);
    expect(requireResult().commandRuns[0]).toMatchObject({
      command: 'true',
      status: 'unknown',
    });
  });

  it('publishes listener context only after a render commits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_100);
    const eventSource = new EventTarget();
    const addEventListener = vi.spyOn(eventSource, 'addEventListener');
    const removeEventListener = vi.spyOn(eventSource, 'removeEventListener');
    const committedStarted = vi.fn();
    const pendingStarted = vi.fn();
    const committedProps = createProps({
      eventSource,
      onCommandStarted: committedStarted,
      screenLines: ['shell % true', 'completed', 'shell %'],
    });

    await renderHarness(committedProps);
    await dispatchCommandEvent(
      eventSource,
      'tp-terminal-command-started',
      createEventDetail({ clientEventId: 'first-run', command: 'true', startedAtMs: 1_000 })
    );

    const renderGate = createRenderGate();
    act(() => {
      React.startTransition(() => {
        renderHarnessTree({
          ...committedProps,
          onCommandStarted: pendingStarted,
          renderGate,
          screenLines: ['shell % true'],
          screenSequence: 2,
        });
      });
    });
    expect(addEventListener).toHaveBeenCalledTimes(4);
    expect(removeEventListener).not.toHaveBeenCalled();

    await dispatchCommandEvent(
      eventSource,
      'tp-terminal-command-started',
      createEventDetail({ clientEventId: 'second-run', command: 'true', startedAtMs: 2_000 })
    );
    expect(committedStarted).toHaveBeenCalledTimes(2);
    expect(pendingStarted).not.toHaveBeenCalled();
    expect(requireResult().commandRuns[0]).toMatchObject({
      clientEventId: 'first-run',
      status: 'succeeded',
    });

    await act(async () => {
      renderGate.resolve();
      await Promise.resolve();
    });
    expect(addEventListener).toHaveBeenCalledTimes(4);
    expect(removeEventListener).not.toHaveBeenCalled();

    await dispatchCommandEvent(
      eventSource,
      'tp-terminal-command-started',
      createEventDetail({ clientEventId: 'third-run', command: 'true', startedAtMs: 2_100 })
    );
    expect(committedStarted).toHaveBeenCalledTimes(2);
    expect(pendingStarted).toHaveBeenCalledOnce();
    expect(requireResult().commandRuns[1]).toMatchObject({
      clientEventId: 'second-run',
      status: 'unknown',
    });
  });

  it('does not persist runs from the previous team during a direct team switch', async () => {
    const firstTeamName = 'terminal-command-runs-team-a';
    const secondTeamName = 'terminal-command-runs-team-b';
    const firstTeamKey = storageKey(firstTeamName);
    const secondTeamKey = storageKey(secondTeamName);
    const firstTeamRun = createEventDetail({
      clientEventId: 'team-a-run',
      command: 'echo team-a',
      status: 'succeeded',
    });
    const secondTeamRun = createEventDetail({
      clientEventId: 'team-b-run',
      command: 'echo team-b',
      status: 'succeeded',
    });
    window.localStorage.setItem(firstTeamKey, JSON.stringify([firstTeamRun]));
    window.localStorage.setItem(secondTeamKey, JSON.stringify([secondTeamRun]));
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const firstTeamProps = createProps({ teamName: firstTeamName });

    await renderHarness(firstTeamProps);
    expect(requireResult().commandRuns).toEqual([firstTeamRun]);
    setItem.mockClear();

    await renderHarness({ ...firstTeamProps, teamName: secondTeamName });

    expect(requireResult().commandRuns).toEqual([secondTeamRun]);
    const secondTeamWrites = setItem.mock.calls
      .filter(([key]) => key === secondTeamKey)
      .map(([, value]) => JSON.parse(String(value)) as TerminalCommandRunPresentation[]);
    expect(secondTeamWrites).not.toHaveLength(0);
    expect(
      secondTeamWrites.every(
        (runs) => runs.length === 1 && runs[0]?.clientEventId === secondTeamRun.clientEventId
      )
    ).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(firstTeamKey) ?? 'null')).toEqual([firstTeamRun]);
    expect(JSON.parse(window.localStorage.getItem(secondTeamKey) ?? 'null')).toEqual([
      secondTeamRun,
    ]);
  });

  function createProps(overrides: Partial<HarnessProps> = {}): HarnessProps {
    return {
      activePaneId: 'pane-1',
      activeSessionId: 'session-1',
      eventSource: new EventTarget(),
      onCommandStarted: vi.fn(),
      onCommandSubmitted: vi.fn(),
      screenLines: [],
      screenSequence: 1,
      teamName: TEAM_NAME,
      ...overrides,
    };
  }

  async function renderHarness(props: HarnessProps): Promise<void> {
    await act(async () => {
      renderHarnessTree(props);
      await Promise.resolve();
    });
  }

  function renderHarnessTree(props: HarnessProps): void {
    root.render(
      <React.Suspense fallback={null}>
        <Harness {...props} />
      </React.Suspense>
    );
  }

  async function unmountHarness(): Promise<void> {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    mounted = false;
  }

  async function dispatchCommandEvent(
    eventSource: EventTarget,
    type: string,
    detail?: ReturnType<typeof createEventDetail>
  ): Promise<void> {
    await act(async () => {
      eventSource.dispatchEvent(createCommandEvent(type, detail));
      await Promise.resolve();
    });
  }

  async function advanceTimers(durationMs: number): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(durationMs);
      await Promise.resolve();
    });
  }

  function requireResult(): HookResult {
    if (!result) {
      throw new Error('Expected the hook harness to render');
    }
    return result;
  }
});

function createCommandEvent(
  type: string,
  detail?: ReturnType<typeof createEventDetail>
): CustomEvent<unknown> {
  return new CustomEvent(type, { detail });
}

function createEventDetail(
  overrides: Partial<TerminalCommandRunPresentation> = {}
): TerminalCommandRunPresentation {
  return {
    clientEventId: 'command-run-1',
    command: 'pnpm test',
    paneId: 'pane-1',
    sessionId: 'session-1',
    startedAtMs: 1_000,
    status: 'running',
    ...overrides,
  };
}

function createRenderGate(): RenderGate {
  let isResolved = false;
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    read: () => {
      if (!isResolved) {
        throw promise;
      }
    },
    resolve: () => {
      isResolved = true;
      resolvePromise?.();
    },
  };
}

function storageKey(teamName: string): string {
  return `agent-teams:terminal-workspace:${teamName}:command-runs`;
}
