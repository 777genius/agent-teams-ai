// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternalMock = vi.fn<(url: string) => Promise<void>>();

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => openExternalMock(url),
  },
}));

import { CodexLoginSessionManager } from '@features/codex-account/main/infrastructure/CodexLoginSessionManager';

import type { CodexAppServerSession } from '@main/services/infrastructure/codexAppServer';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createSession(overrides?: {
  request?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
}) {
  const listeners = new Set<(method: string, params: unknown) => void>();
  const request =
    overrides?.request ??
    vi.fn().mockResolvedValue({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/auth',
    });
  const close = overrides?.close ?? vi.fn().mockResolvedValue(undefined);

  const session = {
    initializeResponse: {
      userAgent: 'codex-test',
      codexHome: '/Users/tester/.codex',
      platformFamily: 'darwin',
      platformOs: 'macos',
    },
    request,
    notify: vi.fn().mockResolvedValue(undefined),
    onNotification: vi.fn((listener: (method: string, params: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close,
  } satisfies CodexAppServerSession;

  return {
    session,
    request,
    close,
    emitNotification(method: string, params: unknown) {
      for (const listener of listeners) {
        listener(method, params);
      }
    },
  };
}

describe('CodexLoginSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openExternalMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores duplicate start requests while the first login session is still starting', async () => {
    const deferredSession = createDeferred<CodexAppServerSession>();
    const sessionFactory = {
      openSession: vi.fn(() => deferredSession.promise),
    };
    const manager = new CodexLoginSessionManager(sessionFactory as never, {
      warn: vi.fn(),
    });

    const firstStart = manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
    });
    const secondStart = manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
    });

    expect(sessionFactory.openSession).toHaveBeenCalledTimes(1);

    const fakeSession = createSession();
    deferredSession.resolve(fakeSession.session);

    await Promise.all([firstStart, secondStart]);

    expect(fakeSession.request).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(manager.getState().status).toBe('pending');
  });

  it('cancels a login cleanly while the app-server session is still starting', async () => {
    const deferredSession = createDeferred<CodexAppServerSession>();
    const sessionFactory = {
      openSession: vi.fn(() => deferredSession.promise),
    };
    const settledListener = vi.fn();
    const manager = new CodexLoginSessionManager(sessionFactory as never, {
      warn: vi.fn(),
    });
    manager.onSettled(settledListener);

    const startPromise = manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
    });

    await manager.cancel();

    const fakeSession = createSession();
    deferredSession.resolve(fakeSession.session);
    await startPromise;

    expect(fakeSession.request).not.toHaveBeenCalled();
    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(settledListener).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toEqual({
      status: 'cancelled',
      error: null,
      startedAt: null,
    });
  });

  it('returns to idle after a successful login completion notification', async () => {
    const fakeSession = createSession();
    const sessionFactory = {
      openSession: vi.fn().mockResolvedValue(fakeSession.session),
    };
    const settledListener = vi.fn();
    const manager = new CodexLoginSessionManager(sessionFactory as never, {
      warn: vi.fn(),
    });
    manager.onSettled(settledListener);

    await manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
    });

    expect(manager.getState().status).toBe('pending');

    fakeSession.emitNotification('account/login/completed', {
      loginId: 'login-1',
      success: true,
      error: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(settledListener).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toEqual({
      status: 'idle',
      error: null,
      startedAt: null,
    });
  });

  it('marks the login as failed when the pending login times out', async () => {
    vi.useFakeTimers();

    const fakeSession = createSession();
    const sessionFactory = {
      openSession: vi.fn().mockResolvedValue(fakeSession.session),
    };
    const settledListener = vi.fn();
    const manager = new CodexLoginSessionManager(sessionFactory as never, {
      warn: vi.fn(),
    });
    manager.onSettled(settledListener);

    await manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(settledListener).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toMatchObject({
      status: 'failed',
      error: 'Timed out while waiting for ChatGPT account login to finish.',
    });
  });

  it('surfaces failed login completion notifications as a failed state', async () => {
    const fakeSession = createSession();
    const sessionFactory = {
      openSession: vi.fn().mockResolvedValue(fakeSession.session),
    };
    const settledListener = vi.fn();
    const manager = new CodexLoginSessionManager(sessionFactory as never, {
      warn: vi.fn(),
    });
    manager.onSettled(settledListener);

    await manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
    });

    fakeSession.emitNotification('account/login/completed', {
      loginId: 'login-1',
      success: false,
      error: 'ChatGPT login was denied.',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(settledListener).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toMatchObject({
      status: 'failed',
      error: 'ChatGPT login was denied.',
    });
  });
});
