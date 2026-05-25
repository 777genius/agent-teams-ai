import { describe, expect, it, vi } from 'vitest';

import {
  CrossPlatformFileChangeSource,
  type WatcherLifecycle,
} from '../../../../src/main/services/infrastructure/CrossPlatformFileChangeSource';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createSource(options: {
  active: () => boolean;
  createWatcher?: (
    lifecycle: WatcherLifecycle
  ) => Promise<{ close: () => void }> | { close: () => void };
  collectPollSnapshot?: () => Promise<Map<string, string>>;
}) {
  return new CrossPlatformFileChangeSource({
    name: 'test-source',
    pollIntervalMs: 1000,
    createWatcher: options.createWatcher,
    collectPollSnapshot: options.collectPollSnapshot ?? vi.fn().mockResolvedValue(new Map()),
    emitPolledChange: vi.fn(),
    isOwnerActive: options.active,
    isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
    requestRetry: vi.fn(),
  });
}

describe('CrossPlatformFileChangeSource', () => {
  it('coalesces concurrent watcher starts into one watcher', async () => {
    let active = true;
    let resolveWatcher: ((watcher: { close: () => void }) => void) | undefined;
    const close = vi.fn();
    const createWatcher = vi.fn(
      () =>
        new Promise<{ close: () => void }>((resolve) => {
          resolveWatcher = resolve;
        })
    );
    const source = createSource({ active: () => active, createWatcher });

    const firstStart = source.start();
    const secondStart = source.start();
    expect(createWatcher).toHaveBeenCalledTimes(1);

    resolveWatcher?.({ close });
    await Promise.all([firstStart, secondStart]);

    expect(source.isActive).toBe(true);
    source.stop();
    active = false;
  });

  it('ignores stale watcher close events after restart', async () => {
    let active = true;
    const lifecycles: WatcherLifecycle[] = [];
    const createWatcher = vi.fn((lifecycle: WatcherLifecycle) => {
      lifecycles.push(lifecycle);
      return { close: vi.fn() };
    });
    const source = createSource({ active: () => active, createWatcher });

    await source.start();
    source.stop();
    await source.start();

    lifecycles[0].onClose();

    expect(source.isActive).toBe(true);
    source.stop();
    active = false;
  });

  it('marks old watcher lifecycles stale after restart', async () => {
    let active = true;
    const lifecycles: WatcherLifecycle[] = [];
    const createWatcher = vi.fn((lifecycle: WatcherLifecycle) => {
      lifecycles.push(lifecycle);
      return { close: vi.fn() };
    });
    const source = createSource({ active: () => active, createWatcher });

    await source.start();
    expect(lifecycles[0].isCurrent()).toBe(true);

    source.stop();
    expect(lifecycles[0].isCurrent()).toBe(false);

    await source.start();
    expect(lifecycles[0].isCurrent()).toBe(false);
    expect(lifecycles[1].isCurrent()).toBe(true);

    source.stop();
    active = false;
  });

  it('does not keep a watcher that closes during startup', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const close = vi.fn();
    const requestRetry = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        lifecycle.onClose();
        return { close };
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry,
    });

    await source.start();

    expect(source.isActive).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(requestRetry).toHaveBeenCalledTimes(1);
    active = false;
  });

  it('falls back to polling when a watcher reports a limit error during startup', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const close = vi.fn();
    const requestRetry = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        lifecycle.onError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
        return { close };
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
    });

    await source.start();

    expect(source.currentPollingTimer).not.toBeNull();
    expect(lifecycle?.isCurrent()).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(requestRetry).not.toHaveBeenCalled();
    source.stop();
    active = false;
  });

  it('falls back to polling when startup closes before throwing a limit error', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const requestRetry = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        lifecycle.onClose();
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
    });

    await source.start();

    expect(source.currentPollingTimer).not.toBeNull();
    expect(lifecycle?.isCurrent()).toBe(false);
    expect(requestRetry).toHaveBeenCalledTimes(1);
    source.stop();
    active = false;
  });

  it('does not retry when startup throws after reporting a limit error', async () => {
    let active = true;
    const requestRetry = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((lifecycle: WatcherLifecycle) => {
        lifecycle.onError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
        throw Object.assign(new Error('startup failed after limit error'), { code: 'EMFILE' });
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
    });

    await source.start();

    expect(source.currentPollingTimer).not.toBeNull();
    expect(requestRetry).not.toHaveBeenCalled();
    source.stop();
    active = false;
  });

  it('retries without keeping a watcher that reports a non-limit error during startup', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const close = vi.fn();
    const requestRetry = vi.fn();
    const onWatcherError = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        lifecycle.onError(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        return { close };
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
      onWatcherError,
    });

    await source.start();

    expect(source.isActive).toBe(false);
    expect(lifecycle?.isCurrent()).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(onWatcherError).toHaveBeenCalledTimes(1);
    expect(requestRetry).toHaveBeenCalledTimes(1);
    active = false;
  });

  it('does not retry twice when startup throws after reporting a non-limit error', async () => {
    let active = true;
    const requestRetry = vi.fn();
    const onWatcherError = vi.fn();
    const onWatcherStartError = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((lifecycle: WatcherLifecycle) => {
        lifecycle.onError(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        throw Object.assign(new Error('startup failed after permission error'), { code: 'EACCES' });
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
      onWatcherError,
      onWatcherStartError,
    });

    await source.start();

    expect(source.isActive).toBe(false);
    expect(onWatcherError).toHaveBeenCalledTimes(1);
    expect(onWatcherStartError).not.toHaveBeenCalled();
    expect(requestRetry).toHaveBeenCalledTimes(1);
    active = false;
  });

  it('invalidates startup lifecycles after a direct non-limit start failure', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const requestRetry = vi.fn();
    const onWatcherError = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
      onWatcherError,
    });

    await source.start();

    expect(source.isActive).toBe(false);
    expect(lifecycle?.isCurrent()).toBe(false);
    expect(requestRetry).toHaveBeenCalledTimes(1);

    lifecycle?.onError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
    lifecycle?.onClose();

    expect(source.currentPollingTimer).toBeNull();
    expect(onWatcherError).not.toHaveBeenCalled();
    expect(requestRetry).toHaveBeenCalledTimes(1);
    active = false;
  });

  it('does not request retry twice when a watcher closes after an error', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const close = vi.fn();
    const requestRetry = vi.fn();
    const onWatcherError = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        return { close };
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry,
      onWatcherError,
    });

    await source.start();
    lifecycle?.onError(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    lifecycle?.onClose();

    expect(source.isActive).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onWatcherError).toHaveBeenCalledTimes(1);
    expect(requestRetry).toHaveBeenCalledTimes(1);
    active = false;
  });

  it('falls back to polling when a close is followed by a limit error', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const requestRetry = vi.fn();
    const onWatcherError = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        return { close: vi.fn() };
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE',
      requestRetry,
      onWatcherError,
    });

    await source.start();
    lifecycle?.onClose();
    lifecycle?.onError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

    expect(source.currentPollingTimer).not.toBeNull();
    expect(onWatcherError).not.toHaveBeenCalled();
    expect(requestRetry).toHaveBeenCalledTimes(1);
    source.stop();
    active = false;
  });

  it('does not request retry when switching an active watcher to polling', async () => {
    let active = true;
    let lifecycle: WatcherLifecycle | undefined;
    const requestRetry = vi.fn();
    const close = vi.fn(() => lifecycle?.onClose());
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn((nextLifecycle: WatcherLifecycle) => {
        lifecycle = nextLifecycle;
        return { close };
      }),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry,
    });

    await source.start();
    source.startPolling();

    expect(source.currentPollingTimer).not.toBeNull();
    expect(lifecycle?.isCurrent()).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(requestRetry).not.toHaveBeenCalled();
    source.stop();
    active = false;
  });

  it('closes a late watcher when polling starts during watcher startup', async () => {
    let active = true;
    let resolveWatcher: ((watcher: { close: () => void }) => void) | undefined;
    const close = vi.fn();
    const lifecycles: WatcherLifecycle[] = [];
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn(
        (lifecycle: WatcherLifecycle) =>
          new Promise<{ close: () => void }>((resolve) => {
            lifecycles.push(lifecycle);
            resolveWatcher = resolve;
          })
      ),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry: vi.fn(),
    });

    const start = source.start();
    expect(lifecycles).toHaveLength(1);
    expect(lifecycles[0].isCurrent()).toBe(true);

    source.startPolling();
    expect(source.currentPollingTimer).not.toBeNull();
    expect(lifecycles[0].isCurrent()).toBe(false);

    resolveWatcher?.({ close });
    await start;

    expect(close).toHaveBeenCalled();
    source.stop();
    active = false;
  });

  it('closes a stale pending watcher after stop and restart', async () => {
    let active = true;
    const resolvers: Array<(watcher: { close: () => void }) => void> = [];
    const closeOld = vi.fn();
    const closeCurrent = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn(
        () =>
          new Promise<{ close: () => void }>((resolve) => {
            resolvers.push(resolve);
          })
      ),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry: vi.fn(),
    });

    const firstStart = source.start();
    source.stop();
    const secondStart = source.start();

    resolvers[1]?.({ close: closeCurrent });
    await secondStart;
    expect(source.isActive).toBe(true);

    resolvers[0]?.({ close: closeOld });
    await firstStart;

    expect(closeOld).toHaveBeenCalledTimes(1);
    expect(closeCurrent).not.toHaveBeenCalled();
    expect(source.isActive).toBe(true);
    source.stop();
    active = false;
  });

  it('swallows synchronous watcher close failures during stale startup cleanup', async () => {
    let active = true;
    let resolveWatcher: ((watcher: { close: () => void }) => void) | undefined;
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      createWatcher: vi.fn(
        () =>
          new Promise<{ close: () => void }>((resolve) => {
            resolveWatcher = resolve;
          })
      ),
      collectPollSnapshot: vi.fn().mockResolvedValue(new Map()),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry: vi.fn(),
    });

    const start = source.start();
    source.stop();
    resolveWatcher?.({
      close: () => {
        throw new Error('close failed');
      },
    });

    await expect(start).resolves.toBeUndefined();
    expect(source.isActive).toBe(false);
    active = false;
  });

  it('ignores stale in-flight polling snapshots after stop and restart', async () => {
    let active = true;
    const snapshots: Array<() => void> = [];
    const emitted: string[] = [];
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      collectPollSnapshot: () =>
        new Promise<Map<string, string>>((resolve) => {
          snapshots.push(() => resolve(new Map([['old.json', '1']])));
        }),
      emitPolledChange: (_eventType, relativePath) => emitted.push(relativePath),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry: vi.fn(),
    });

    source.startPolling();
    expect(snapshots).toHaveLength(1);
    source.stop();
    source.startPolling();
    expect(snapshots).toHaveLength(2);

    snapshots[0]();
    await Promise.resolve();
    snapshots[1]();
    await Promise.resolve();

    expect(emitted).toEqual([]);
    source.stop();
    active = false;
  });

  it('ignores stale in-flight polling errors after stop', async () => {
    let active = true;
    const onPollingError = vi.fn();
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      collectPollSnapshot: vi.fn().mockRejectedValue(new Error('old polling failure')),
      emitPolledChange: vi.fn(),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry: vi.fn(),
      onPollingError,
    });

    const poll = source.pollOnce();
    source.stop();
    active = false;
    await poll;

    expect(onPollingError).not.toHaveBeenCalled();
  });

  it('keeps the previous polling snapshot when a poll fails', async () => {
    let active = true;
    const emitted: Array<[string, string]> = [];
    const onPollingError = vi.fn();
    const collectPollSnapshot = vi
      .fn()
      .mockResolvedValueOnce(new Map([['session.jsonl', '1']]))
      .mockRejectedValueOnce(new Error('transient polling failure'))
      .mockResolvedValueOnce(new Map([['session.jsonl', '2']]));
    const source = new CrossPlatformFileChangeSource({
      name: 'test-source',
      pollIntervalMs: 1000,
      collectPollSnapshot,
      emitPolledChange: (eventType, relativePath) => emitted.push([eventType, relativePath]),
      isOwnerActive: () => active,
      isWatchLimitError: () => false,
      requestRetry: vi.fn(),
      onPollingError,
    });

    await source.pollOnce();
    await source.pollOnce();
    await source.pollOnce();

    expect(onPollingError).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([['change', 'session.jsonl']]);
    source.stop();
    active = false;
  });
});
