import {
  __resetRecentProjectsClientCacheForTests,
  getRecentProjectsClientSnapshot,
  loadRecentProjectsWithClientCache,
} from '@features/recent-projects/renderer/utils/recentProjectsClientCache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DashboardRecentProject,
  DashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';

const project = (id: string): DashboardRecentProject => ({
  id,
  name: id,
  primaryPath: `/tmp/${id}`,
  associatedPaths: [`/tmp/${id}`],
  mostRecentActivity: Date.parse('2026-04-14T12:00:00.000Z'),
  providerIds: ['anthropic'],
  source: 'claude',
  openTarget: {
    type: 'synthetic-path',
    path: `/tmp/${id}`,
  },
});

const payload = (
  id: string,
  overrides: Partial<DashboardRecentProjectsPayload> = {}
): DashboardRecentProjectsPayload => ({
  projects: [project(id)],
  degraded: false,
  ...overrides,
});
const LOCAL_CACHE_KEY = 'local';
const SSH_CACHE_KEY = 'ssh-dev';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('recentProjectsClientCache', () => {
  afterEach(() => {
    __resetRecentProjectsClientCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns cached projects while the client cache is fresh', async () => {
    const loader = vi.fn().mockResolvedValue(payload('alpha'));

    await expect(loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader)).resolves.toEqual(
      payload('alpha')
    );
    await expect(loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader)).resolves.toEqual(
      payload('alpha')
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)?.payload).toEqual(payload('alpha'));
  });

  it('revalidates stale cache without dropping the previous snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));

    const loader = vi
      .fn<() => Promise<DashboardRecentProjectsPayload>>()
      .mockResolvedValueOnce(payload('alpha'))
      .mockResolvedValueOnce(payload('beta'));

    await loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader);
    vi.setSystemTime(new Date('2026-04-14T12:00:16.000Z'));

    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toMatchObject({
      payload: payload('alpha'),
      isStale: true,
    });

    await expect(
      loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader, { force: true })
    ).resolves.toEqual(payload('beta'));

    expect(loader).toHaveBeenCalledTimes(2);
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toMatchObject({
      payload: payload('beta'),
      isStale: false,
    });
  });

  it('deduplicates concurrent client refreshes', async () => {
    const resolveLoaderRef: {
      current: ((payload: DashboardRecentProjectsPayload) => void) | null;
    } = {
      current: null,
    };
    const loader = vi.fn(
      () =>
        new Promise<DashboardRecentProjectsPayload>((resolve) => {
          resolveLoaderRef.current = resolve;
        })
    );

    const first = loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader, { force: true });
    const second = loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader, { force: true });

    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoaderRef.current?.(payload('alpha'));

    await expect(first).resolves.toEqual(payload('alpha'));
    await expect(second).resolves.toEqual(payload('alpha'));
  });

  it('keeps degraded payload snapshots fresh long enough to avoid hot retry loops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));

    const loader = vi
      .fn<() => Promise<DashboardRecentProjectsPayload>>()
      .mockResolvedValueOnce(payload('alpha', { degraded: true }));

    await expect(loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader)).resolves.toEqual(
      payload('alpha', { degraded: true })
    );

    vi.setSystemTime(new Date('2026-04-14T12:00:01.000Z'));
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toMatchObject({
      payload: payload('alpha', { degraded: true }),
      isStale: false,
    });

    vi.setSystemTime(new Date('2026-04-14T12:00:20.000Z'));
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toMatchObject({
      payload: payload('alpha', { degraded: true }),
      isStale: false,
    });

    vi.setSystemTime(new Date('2026-04-14T12:00:31.000Z'));
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toMatchObject({
      payload: payload('alpha', { degraded: true }),
      isStale: true,
    });
  });

  it('normalizes legacy array responses from the loader during mixed-version dev reloads', async () => {
    const loader = vi
      .fn<() => Promise<DashboardRecentProject[]>>()
      .mockResolvedValue([project('alpha')]);

    await expect(loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader)).resolves.toEqual(
      payload('alpha')
    );
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)?.payload).toEqual(payload('alpha'));
  });

  it('does not serve a cached payload across active context keys', async () => {
    const loader = vi
      .fn<() => Promise<DashboardRecentProjectsPayload>>()
      .mockResolvedValueOnce(payload('local-alpha'))
      .mockResolvedValueOnce(payload('ssh-beta'));

    await expect(loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader)).resolves.toEqual(
      payload('local-alpha')
    );

    expect(getRecentProjectsClientSnapshot(SSH_CACHE_KEY)).toBeNull();
    await expect(loadRecentProjectsWithClientCache(SSH_CACHE_KEY, loader)).resolves.toEqual(
      payload('ssh-beta')
    );

    expect(loader).toHaveBeenCalledTimes(2);
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toBeNull();
    expect(getRecentProjectsClientSnapshot(SSH_CACHE_KEY)?.payload).toEqual(payload('ssh-beta'));
  });

  it('does not reuse or cache an in-flight payload for a different context key', async () => {
    const localRequest = deferred<DashboardRecentProjectsPayload>();
    const sshRequest = deferred<DashboardRecentProjectsPayload>();
    const loader = vi
      .fn<() => Promise<DashboardRecentProjectsPayload>>()
      .mockReturnValueOnce(localRequest.promise)
      .mockReturnValueOnce(sshRequest.promise);

    const localLoad = loadRecentProjectsWithClientCache(LOCAL_CACHE_KEY, loader, { force: true });
    const sshLoad = loadRecentProjectsWithClientCache(SSH_CACHE_KEY, loader, { force: true });

    expect(loader).toHaveBeenCalledTimes(2);

    sshRequest.resolve(payload('ssh-beta'));
    await expect(sshLoad).resolves.toEqual(payload('ssh-beta'));
    expect(getRecentProjectsClientSnapshot(SSH_CACHE_KEY)?.payload).toEqual(payload('ssh-beta'));

    localRequest.resolve(payload('local-alpha'));
    await expect(localLoad).resolves.toEqual(payload('local-alpha'));
    expect(getRecentProjectsClientSnapshot(LOCAL_CACHE_KEY)).toBeNull();
    expect(getRecentProjectsClientSnapshot(SSH_CACHE_KEY)?.payload).toEqual(payload('ssh-beta'));
  });
});
