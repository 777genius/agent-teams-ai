import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isCodexAccountSnapshotPending,
  useCodexAccountSnapshot,
} from '../../../../src/features/codex-account/renderer/hooks/useCodexAccountSnapshot';

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

type IdleCallbackForTest = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void;

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
    apiMocks.onCodexAccountSnapshotChanged.mockImplementation(() => () => undefined);
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

  it('keeps stale negative snapshots pending during revalidation but preserves useful states', () => {
    const runtimeMissingSnapshot = withSnapshotOverrides(createSnapshot(), {
      launchAllowed: false,
      launchReadinessState: 'runtime_missing',
      appServerState: 'runtime-missing',
    });
    const loginPendingSnapshot = withSnapshotOverrides(runtimeMissingSnapshot, {
      login: {
        status: 'pending',
        error: null,
        startedAt: '2026-07-21T10:00:00.000Z',
      },
    });

    expect(isCodexAccountSnapshotPending(true, null)).toBe(true);
    expect(isCodexAccountSnapshotPending(true, runtimeMissingSnapshot)).toBe(true);
    expect(isCodexAccountSnapshotPending(true, createSnapshot())).toBe(false);
    expect(isCodexAccountSnapshotPending(true, loginPendingSnapshot)).toBe(false);
    expect(isCodexAccountSnapshotPending(false, runtimeMissingSnapshot)).toBe(false);
  });

  it('reports loading on the first render before an immediate initial request starts', async () => {
    const snapshot = createSnapshot();
    const snapshotDeferred = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot.mockReturnValue(snapshotDeferred.promise);
    const observedLoadingStates: boolean[] = [];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled: true });
      observedLoadingStates.push(state.loading);
      return React.createElement('div', null, state.loading ? 'checking' : 'settled');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(observedLoadingStates[0]).toBe(true);
    expect(host.textContent).toBe('checking');

    await act(async () => {
      snapshotDeferred.resolve(snapshot);
      await snapshotDeferred.promise;
      await Promise.resolve();
    });

    expect(host.textContent).toBe('settled');

    act(() => {
      root.unmount();
    });
  });

  it('clears loading when disabled during the initial request and ignores its stale result', async () => {
    const snapshot = createSnapshot();
    const snapshotDeferred = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot.mockReturnValue(snapshotDeferred.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness({ enabled }: { enabled: boolean }): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled });
      return React.createElement(
        'div',
        { 'data-loading': state.loading ? 'true' : 'false' },
        state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: false }));
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');

    await act(async () => {
      snapshotDeferred.resolve(snapshot);
      await snapshotDeferred.promise;
      await Promise.resolve();
    });
    expect(host.textContent).toContain('empty');
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');

    act(() => {
      root.unmount();
    });
  });

  it('restores first-render loading when re-enabled after an initial failure', async () => {
    const retrySnapshot = createSnapshot();
    const retryDeferred = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot
      .mockRejectedValueOnce(new Error('temporary Codex outage'))
      .mockReturnValueOnce(retryDeferred.promise);
    const observations: Array<{ enabled: boolean; loading: boolean }> = [];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness({ enabled }: { enabled: boolean }): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled });
      observations.push({ enabled, loading: state.loading });
      return React.createElement(
        'div',
        { 'data-loading': state.loading ? 'true' : 'false' },
        state.error ?? state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('temporary Codex outage');
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: false }));
      await Promise.resolve();
    });

    const reenableObservationIndex = observations.length;
    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
    });

    expect(observations[reenableObservationIndex]).toEqual({ enabled: true, loading: true });
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      retryDeferred.resolve(retrySnapshot);
      await retryDeferred.promise;
      await Promise.resolve();
    });
    expect(host.textContent).toContain('belief@example.com');
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');

    act(() => {
      root.unmount();
    });
  });

  it('drops a cached snapshot and revalidates immediately after being re-enabled', async () => {
    const firstSnapshot = withSnapshotOverrides(createSnapshot(), {
      managedAccount: {
        type: 'chatgpt',
        email: 'old-account@example.com',
        planType: 'pro',
      },
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    const secondSnapshot = withSnapshotOverrides(createSnapshot(), {
      managedAccount: {
        type: 'chatgpt',
        email: 'current-account@example.com',
        planType: 'pro',
      },
      updatedAt: '2026-07-21T10:00:01.000Z',
    });
    const secondRequest = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot
      .mockResolvedValueOnce(firstSnapshot)
      .mockReturnValueOnce(secondRequest.promise);
    const observations: Array<{ enabled: boolean; loading: boolean; email: string | null }> = [];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness({ enabled }: { enabled: boolean }): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled });
      observations.push({
        enabled,
        loading: state.loading,
        email: state.snapshot?.managedAccount?.email ?? null,
      });
      return React.createElement(
        'div',
        { 'data-loading': state.loading ? 'true' : 'false' },
        state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('old-account@example.com');

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: false }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('empty');

    const reenableObservationIndex = observations.length;
    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
    });

    expect(observations[reenableObservationIndex]).toEqual({
      enabled: true,
      loading: true,
      email: null,
    });
    expect(apiMocks.getCodexAccountSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRequest.resolve(secondSnapshot);
      await secondRequest.promise;
      await Promise.resolve();
    });
    expect(host.textContent).toContain('current-account@example.com');

    act(() => {
      root.unmount();
    });
  });

  it('does not surface an older initial failure after a newer pushed snapshot', async () => {
    const initialRequest = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot.mockReturnValue(initialRequest.promise);
    let snapshotListener: ((event: unknown, snapshot: CodexAccountSnapshotDto) => void) | null =
      null;
    apiMocks.onCodexAccountSnapshotChanged.mockImplementation((callback) => {
      snapshotListener = callback;
      return () => undefined;
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled: true });
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
      snapshotListener?.({}, createSnapshot());
      await Promise.resolve();
    });
    expect(host.textContent).toContain('belief@example.com');

    await act(async () => {
      initialRequest.reject(new Error('stale initial failure'));
      await initialRequest.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('belief@example.com');
    expect(host.textContent).not.toContain('stale initial failure');

    act(() => {
      root.unmount();
    });
  });

  it('keeps loading active until overlapping refresh and account action both settle', async () => {
    const initialSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    const refreshedSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: '2026-07-21T10:00:01.000Z',
    });
    const loggedOutSnapshot = withSnapshotOverrides(createSnapshot(), {
      managedAccount: null,
      updatedAt: '2026-07-21T10:00:02.000Z',
    });
    const refreshRequest = createDeferred<CodexAccountSnapshotDto>();
    const logoutRequest = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(initialSnapshot);
    apiMocks.refreshCodexAccountSnapshot.mockReturnValue(refreshRequest.promise);
    apiMocks.logoutCodexAccount.mockReturnValue(logoutRequest.promise);
    let refreshNow!: () => Promise<boolean>;
    let logoutNow!: () => Promise<boolean>;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled: true });
      refreshNow = () => state.refresh();
      logoutNow = state.logout;
      return React.createElement('div', {
        'data-loading': state.loading ? 'true' : 'false',
      });
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    let refreshPromise!: Promise<boolean>;
    let logoutPromise!: Promise<boolean>;
    await act(async () => {
      refreshPromise = refreshNow();
      logoutPromise = logoutNow();
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      refreshRequest.resolve(refreshedSnapshot);
      await refreshPromise;
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      logoutRequest.resolve(loggedOutSnapshot);
      await logoutPromise;
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');

    act(() => {
      root.unmount();
    });
  });

  it('shows the latest action error even when an older background refresh succeeds first', async () => {
    const initialSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    const refreshedSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: '2026-07-21T10:00:01.000Z',
    });
    const backgroundRefresh = createDeferred<CodexAccountSnapshotDto>();
    const logoutRequest = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(initialSnapshot);
    apiMocks.refreshCodexAccountSnapshot.mockReturnValue(backgroundRefresh.promise);
    apiMocks.logoutCodexAccount.mockReturnValue(logoutRequest.promise);
    let refreshSilently!: () => Promise<boolean>;
    let logoutNow!: () => Promise<boolean>;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled: true });
      refreshSilently = () => state.refresh({ silent: true });
      logoutNow = state.logout;
      return React.createElement('div', null, state.error ?? 'no-error');
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    let backgroundPromise!: Promise<boolean>;
    let logoutPromise!: Promise<boolean>;
    await act(async () => {
      backgroundPromise = refreshSilently();
      logoutPromise = logoutNow();
      await Promise.resolve();
    });

    await act(async () => {
      backgroundRefresh.resolve(refreshedSnapshot);
      await backgroundPromise;
      logoutRequest.reject(new Error('logout failed'));
      await logoutPromise;
    });

    expect(host.textContent).toContain('logout failed');

    act(() => {
      root.unmount();
    });
  });

  it('does not invoke captured account callbacks after the hook is disabled', async () => {
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(createSnapshot());
    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(createSnapshot());
    apiMocks.logoutCodexAccount.mockResolvedValue(createSnapshot());
    let capturedRefresh!: () => Promise<boolean>;
    let capturedLogout!: () => Promise<boolean>;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness({ enabled }: { enabled: boolean }): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled });
      if (enabled) {
        capturedRefresh = state.refresh;
        capturedLogout = state.logout;
      }
      return React.createElement('div', null, enabled ? 'enabled' : 'disabled');
    }

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
    });
    apiMocks.refreshCodexAccountSnapshot.mockClear();
    apiMocks.logoutCodexAccount.mockClear();

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: false }));
      await Promise.resolve();
    });

    await expect(capturedRefresh()).resolves.toBe(false);
    await expect(capturedLogout()).resolves.toBe(false);
    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(apiMocks.logoutCodexAccount).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it('turns a synchronous initial API failure into settled hook error state', async () => {
    apiMocks.getCodexAccountSnapshot.mockImplementation(() => {
      throw new Error('synchronous bridge failure');
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled: true });
      return React.createElement(
        'div',
        { 'data-loading': state.loading ? 'true' : 'false' },
        state.error ?? 'no-error'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(host.textContent).toContain('synchronous bridge failure');

    act(() => {
      root.unmount();
    });
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
    let snapshotListener: ((event: unknown, snapshot: CodexAccountSnapshotDto) => void) | null =
      null;
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

  it('still runs the deferred rate-limit refresh after a pushed snapshot without limits', async () => {
    vi.useFakeTimers();
    const updatedAtMs = Date.now();
    const pushedSnapshot = withSnapshotOverrides(createSnapshot(), {
      rateLimits: null,
      updatedAt: new Date(updatedAtMs).toISOString(),
    });
    const refreshedSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: new Date(updatedAtMs + 1).toISOString(),
    });
    const refreshDeferred = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.refreshCodexAccountSnapshot.mockReturnValue(refreshDeferred.promise);
    let snapshotListener: ((event: unknown, snapshot: CodexAccountSnapshotDto) => void) | null =
      null;
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
        includeRateLimits: true,
        initialRefreshDelayMs: 30_000,
      });

      return React.createElement(
        'div',
        {
          'data-loading': state.loading ? 'true' : 'false',
          'data-rate-limits-loading': state.rateLimitsLoading ? 'true' : 'false',
        },
        state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      snapshotListener?.({}, pushedSnapshot);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('belief@example.com');
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(host.firstElementChild?.getAttribute('data-rate-limits-loading')).toBe('true');
    expect(apiMocks.refreshCodexAccountSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledWith({
      includeRateLimits: true,
    });

    await act(async () => {
      refreshDeferred.resolve(refreshedSnapshot);
      await refreshDeferred.promise;
      await Promise.resolve();
    });

    expect(host.firstElementChild?.getAttribute('data-rate-limits-loading')).toBe('false');

    act(() => {
      root.unmount();
    });
  });

  it('starts rate-limit loading on the first render after includeRateLimits is enabled', async () => {
    const updatedAtMs = Date.now();
    const accountSnapshot = withSnapshotOverrides(createSnapshot(), {
      rateLimits: null,
      updatedAt: new Date(updatedAtMs).toISOString(),
    });
    const rateLimitSnapshot = withSnapshotOverrides(createSnapshot(), {
      updatedAt: new Date(updatedAtMs + 1).toISOString(),
    });
    const refreshDeferred = createDeferred<CodexAccountSnapshotDto>();
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(accountSnapshot);
    apiMocks.refreshCodexAccountSnapshot.mockReturnValue(refreshDeferred.promise);
    const rateLoadingObservations: boolean[] = [];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness({ includeRateLimits }: { includeRateLimits: boolean }): React.ReactElement {
      const state = useCodexAccountSnapshot({ enabled: true, includeRateLimits });
      rateLoadingObservations.push(state.rateLimitsLoading);
      return React.createElement(
        'div',
        { 'data-rate-limits-loading': state.rateLimitsLoading ? 'true' : 'false' },
        state.snapshot?.managedAccount?.email ?? 'empty'
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness, { includeRateLimits: false }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('belief@example.com');
    expect(host.firstElementChild?.getAttribute('data-rate-limits-loading')).toBe('false');

    const firstEnabledObservation = rateLoadingObservations.length;
    await act(async () => {
      root.render(React.createElement(Harness, { includeRateLimits: true }));
      await Promise.resolve();
    });

    expect(rateLoadingObservations[firstEnabledObservation]).toBe(true);
    expect(host.firstElementChild?.getAttribute('data-rate-limits-loading')).toBe('true');
    expect(apiMocks.refreshCodexAccountSnapshot).toHaveBeenCalledWith({
      includeRateLimits: true,
    });

    await act(async () => {
      refreshDeferred.resolve(rateLimitSnapshot);
      await refreshDeferred.promise;
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-rate-limits-loading')).toBe('false');

    act(() => {
      root.unmount();
    });
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

  it('re-reads document visibility when re-enabled after being unsubscribed', async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });

    apiMocks.refreshCodexAccountSnapshot.mockResolvedValue(createSnapshot());
    apiMocks.getCodexAccountSnapshot.mockResolvedValue(createSnapshot());

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness({ enabled }: { enabled: boolean }): React.ReactElement {
      useCodexAccountSnapshot({ enabled, includeRateLimits: true });
      return React.createElement('div', null, enabled ? 'enabled' : 'disabled');
    }

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: false }));
      visibilityState = 'hidden';
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(Harness, { enabled: true }));
      await Promise.resolve();
    });
    apiMocks.refreshCodexAccountSnapshot.mockClear();

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
