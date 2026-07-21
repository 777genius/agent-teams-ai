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
  onCodexAccountSnapshotChanged: vi.fn<
    (callback: (event: unknown, snapshot: CodexAccountSnapshotDto) => void) => () => void
  >(() => () => undefined),
}));

type IdleCallbackForTest = (deadline: {
  didTimeout: boolean;
  timeRemaining: () => number;
}) => void;

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

function withSnapshotOverrides(
  snapshot: CodexAccountSnapshotDto,
  overrides: Partial<CodexAccountSnapshotDto>
): CodexAccountSnapshotDto {
  return {
    ...snapshot,
    ...overrides,
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
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useRealTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');
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

  it('ignores older pushed Codex snapshots after a fresher snapshot was applied', async () => {
    let snapshotListener:
      | ((event: unknown, snapshot: CodexAccountSnapshotDto) => void)
      | null = null;
    const staleSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: '2026-01-01T00:00:00.000Z',
      managedAccount: {
        type: 'chatgpt',
        email: 'stale@example.com',
        planType: 'pro',
      },
    });
    const freshSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: '2026-01-01T00:00:01.000Z',
      managedAccount: {
        type: 'chatgpt',
        email: 'fresh@example.com',
        planType: 'pro',
      },
    });
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(freshSnapshot);
    apiMocks.onCodexAccountSnapshotChanged.mockImplementation(
      (callback: (event: unknown, snapshot: CodexAccountSnapshotDto) => void) => {
        snapshotListener = callback;
        return () => undefined;
      }
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
      });

      return React.createElement('div', null, state.snapshot?.managedAccount?.email ?? 'empty');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('fresh@example.com');

    await act(async () => {
      snapshotListener?.({}, staleSnapshot);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('fresh@example.com');

    act(() => {
      root.unmount();
    });
  });

  it('can defer the initial Codex snapshot without starting interval refreshes first', async () => {
    vi.useFakeTimers();
    const snapshot = createSnapshot();
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(snapshot);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
        initialRefreshDelayMs: 30_000,
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

    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledWith({
      includeRateLimits: true,
    });
    expect(host.textContent).toContain('belief@example.com');

    act(() => {
      root.unmount();
    });
  });

  it('uses idle scheduling for deferred initial Codex snapshots when a max delay is provided', async () => {
    vi.useFakeTimers();
    const snapshot = createSnapshot();
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(snapshot);
    let idleCallback: IdleCallbackForTest = () => undefined;
    const requestIdleCallback = vi.fn((callback, options?: { timeout?: number }) => {
      idleCallback = callback;
      expect(options).toEqual({ timeout: 28_000 });
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback,
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdleCallback,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
        initialRefreshDelayMs: 2_000,
        initialRefreshMaxDelayMs: 30_000,
      });

      return React.createElement('div', null, state.snapshot?.managedAccount?.email ?? 'empty');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(requestIdleCallback).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      idleCallback({ didTimeout: false, timeRemaining: () => 10 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledWith({
      includeRateLimits: true,
    });
    expect(host.textContent).toContain('belief@example.com');

    act(() => {
      root.unmount();
    });
    expect(cancelIdleCallback).not.toHaveBeenCalled();
  });

  it('clears a deferred initial Codex snapshot timer on unmount', async () => {
    vi.useFakeTimers();
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(createSnapshot());

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
        initialRefreshDelayMs: 30_000,
      });

      return React.createElement('div', null, 'mounted');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      root.unmount();
    });

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
  });

  it('keeps retrying after a deferred initial Codex snapshot fails transiently', async () => {
    vi.useFakeTimers();
    const snapshot = createSnapshot();
    apiMocks.refreshCodexAccountSnapshot
      .mockRejectedValueOnce(new Error('temporary Codex outage'))
      .mockResolvedValueOnce(snapshot);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
        initialRefreshDelayMs: 30_000,
      });

      return React.createElement(
        'div',
        null,
        state.error ?? state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('temporary Codex outage');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('belief@example.com');

    act(() => {
      root.unmount();
    });
  });

  it('does not run the deferred initial snapshot after a manual refresh already loaded one', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden' satisfies DocumentVisibilityState,
    });
    const snapshot = createSnapshot();
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(snapshot);
    let refreshNow!: () => Promise<boolean>;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({
        enabled: true,
        includeRateLimits: true,
        initialRefreshDelayMs: 30_000,
      });
      refreshNow = () => state.refresh({ includeRateLimits: true });

      return React.createElement('div', null, state.snapshot?.managedAccount?.email ?? 'empty');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await refreshNow();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it('refreshes rate-limit snapshots more often while visible without flipping loading state during background polls', async () => {
    vi.useFakeTimers();
    const visibilityState: DocumentVisibilityState = 'visible';
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
      vi.advanceTimersByTime(60_000);
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
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(4 * 60_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledTimes(1);

    apiMocks.refreshCodexAccountSnapshot.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
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
