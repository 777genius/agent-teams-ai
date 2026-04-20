import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCodexAccountSnapshot } from '../../../../src/features/codex-account/renderer/hooks/useCodexAccountSnapshot';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

const apiMocks = vi.hoisted(() => ({
  getCodexAccountSnapshot: vi.fn(),
  refreshCodexAccountSnapshot: vi.fn(),
  startCodexChatgptLogin: vi.fn(),
  cancelCodexChatgptLogin: vi.fn(),
  logoutCodexAccount: vi.fn(),
  onCodexAccountSnapshotChanged: vi.fn(() => () => undefined),
}));

vi.mock('@renderer/api', () => ({
  api: apiMocks,
  isElectronMode: () => true,
}));

function createSnapshot(): CodexAccountSnapshotDto {
  return {
    preferredAuthMode: 'chatgpt',
    effectiveAuthMode: 'chatgpt',
    launchAllowed: true,
    launchIssueMessage: null,
    launchReadinessState: 'ready_chatgpt',
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount: {
      type: 'chatgpt',
      email: 'belief@example.com',
      planType: 'pro',
    },
    apiKey: {
      available: false,
      source: null,
      sourceLabel: null,
    },
    requiresOpenaiAuth: false,
    login: {
      status: 'idle',
      error: null,
      startedAt: null,
    },
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: {
        usedPercent: 77,
        windowDurationMins: 300,
        resetsAt: 1_776_678_034,
      },
      secondary: null,
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: '0',
      },
      planType: 'pro',
    },
    updatedAt: new Date().toISOString(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('useCodexAccountSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.useRealTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads the initial Codex snapshot through refresh when rate limits are requested', async () => {
    const snapshot = createSnapshot();
    const refreshDeferred = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.refreshCodexAccountSnapshot.mockReturnValue(refreshDeferred.promise);
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(snapshot);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
      });

      return React.createElement('div', null, state.snapshot?.managedAccount?.email ?? 'empty');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      refreshDeferred.resolve(snapshot);
      await refreshDeferred.promise;
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledWith({
      includeRateLimits: true,
    });
    expect(apiMocks.getCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(host.textContent).toContain('belief@example.com');

    act(() => {
      root.unmount();
    });
  });

  it('refreshes rate-limit snapshots more often while visible without flipping loading state during background polls', async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });

    const snapshot = createSnapshot();
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(snapshot);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
      });

      return React.createElement(
        'div',
        { 'data-loading': state.loading ? 'true' : 'false' },
        state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);

    apiMocks.refreshCodexAccountSnapshot.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');

    act(() => {
      root.unmount();
    });
  });

  it('slows background refreshes while hidden and refreshes immediately when the tab becomes visible again after staleness', async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });

    const snapshot = createSnapshot();
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(snapshot);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
      });

      return React.createElement('div', null, 'hook-mounted');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    apiMocks.refreshCodexAccountSnapshot.mockClear();

    await act(async () => {
      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(50_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);

    apiMocks.refreshCodexAccountSnapshot.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
