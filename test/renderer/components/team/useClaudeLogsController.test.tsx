import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeLogsFilterState } from '@renderer/components/team/claudeLogsFilterState';
import type { ClaudeLogsViewerState } from '@renderer/components/team/CliLogsRichView';
import type { ClaudeLogsController } from '@renderer/components/team/useClaudeLogsController';
import type { TeamClaudeLogsResponse } from '@shared/types';

const controllerState = vi.hoisted(() => ({
  getClaudeLogs: vi.fn<() => Promise<TeamClaudeLogsResponse>>(),
  setSidebarState: vi.fn(),
}));

function createLogsResponse(text = 'lead'): TeamClaudeLogsResponse {
  return {
    lines: [`{"type":"assistant","content":[{"type":"text","text":"${text}"}]}`],
    total: 1,
    hasMore: false,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getClaudeLogs: controllerState.getClaudeLogs,
    },
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectedTeamName: 'demo-team',
      selectedTeamData: { isAlive: true },
    }),
}));

vi.mock('@renderer/components/team/sidebar/teamSidebarUiState', () => ({
  getTeamClaudeLogsSidebarUiState: () => ({
    searchQuery: '',
    filter: {
      streams: new Set(['stdout', 'stderr']),
      kinds: new Set(['output', 'thinking', 'tool']),
    } satisfies ClaudeLogsFilterState,
    filterOpen: false,
    viewerState: {} as ClaudeLogsViewerState,
  }),
  setTeamClaudeLogsSidebarUiState: controllerState.setSidebarState,
}));

import { useClaudeLogsController } from '@renderer/components/team/useClaudeLogsController';

function ControllerHarness({ enabled }: Readonly<{ enabled: boolean }>): React.JSX.Element {
  useClaudeLogsController('demo-team', { enabled });
  return React.createElement('div');
}

function ControllerCaptureHarness({
  enabled,
  onController,
}: Readonly<{
  enabled: boolean;
  onController: (controller: ClaudeLogsController) => void;
}>): React.JSX.Element {
  const controller = useClaudeLogsController('demo-team', { enabled });
  onController(controller);
  return React.createElement('div');
}

describe('useClaudeLogsController enabled option', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    controllerState.getClaudeLogs.mockResolvedValue(createLogsResponse());
    controllerState.setSidebarState.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not fetch lead logs while disabled and loads them when re-enabled', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: false }));
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).not.toHaveBeenCalled();

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);
    expect(controllerState.getClaudeLogs).toHaveBeenCalledWith('demo-team', {
      offset: 0,
      limit: 100,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('queues a fresh lead fetch when re-enabled before the previous request settles', async () => {
    const firstRequest = createDeferred<TeamClaudeLogsResponse>();
    controllerState.getClaudeLogs
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValue(createLogsResponse('fresh lead'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: true }));
      await Promise.resolve();
    });
    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: false }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: true }));
      await Promise.resolve();
    });
    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRequest.resolve(createLogsResponse('stale lead'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(2);
    expect(controllerState.getClaudeLogs).toHaveBeenLastCalledWith('demo-team', {
      offset: 0,
      limit: 100,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('queues interval-driven polls when the current request is still in flight', async () => {
    vi.useFakeTimers();
    const firstRequest = createDeferred<TeamClaudeLogsResponse>();
    controllerState.getClaudeLogs
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValue(createLogsResponse('interval fresh lead'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: true }));
      await Promise.resolve();
    });
    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRequest.resolve(createLogsResponse('stale lead'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(2);
    expect(controllerState.getClaudeLogs).toHaveBeenLastCalledWith('demo-team', {
      offset: 0,
      limit: 100,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not run a queued lead fetch after being disabled again', async () => {
    const firstRequest = createDeferred<TeamClaudeLogsResponse>();
    controllerState.getClaudeLogs
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValue(createLogsResponse('unexpected lead'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: true }));
      await Promise.resolve();
    });
    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: false }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: true }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(ControllerHarness, { enabled: false }));
      await Promise.resolve();
    });

    await act(async () => {
      firstRequest.resolve(createLogsResponse('stale lead'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not load more or apply pending lead logs while disabled', async () => {
    let latestController: ClaudeLogsController | null = null;
    const getLatestController = (): ClaudeLogsController => {
      if (!latestController) {
        throw new Error('Controller was not captured');
      }
      return latestController;
    };
    controllerState.getClaudeLogs.mockResolvedValue({
      ...createLogsResponse('lead with more'),
      hasMore: true,
      total: 150,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ControllerCaptureHarness, {
          enabled: true,
          onController: (controller) => {
            latestController = controller;
          },
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);
    expect(getLatestController().data.hasMore).toBe(true);

    await act(async () => {
      root.render(
        React.createElement(ControllerCaptureHarness, {
          enabled: false,
          onController: (controller) => {
            latestController = controller;
          },
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      const disabledController = getLatestController();
      await disabledController.loadOlderLogs();
      await disabledController.applyPending();
      await Promise.resolve();
    });

    expect(controllerState.getClaudeLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
