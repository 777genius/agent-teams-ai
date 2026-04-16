import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetRecentProjectsClientCacheForTests,
  getRecentProjectsClientSnapshot,
  loadRecentProjectsWithClientCache,
} from '@features/recent-projects/renderer/utils/recentProjectsClientCache';

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

describe('recentProjectsClientCache', () => {
  afterEach(() => {
    __resetRecentProjectsClientCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns cached projects while the client cache is fresh', async () => {
    const loader = vi.fn().mockResolvedValue(payload('alpha'));

    await expect(loadRecentProjectsWithClientCache(loader)).resolves.toEqual(payload('alpha'));
    await expect(loadRecentProjectsWithClientCache(loader)).resolves.toEqual(payload('alpha'));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getRecentProjectsClientSnapshot()?.payload).toEqual(payload('alpha'));
  });

  it('revalidates stale cache without dropping the previous snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));

    const loader = vi
      .fn<() => Promise<DashboardRecentProjectsPayload>>()
      .mockResolvedValueOnce(payload('alpha'))
      .mockResolvedValueOnce(payload('beta'));

    await loadRecentProjectsWithClientCache(loader);
    vi.setSystemTime(new Date('2026-04-14T12:00:16.000Z'));

    expect(getRecentProjectsClientSnapshot()).toMatchObject({
      payload: payload('alpha'),
      isStale: true,
    });

    await expect(loadRecentProjectsWithClientCache(loader, { force: true })).resolves.toEqual(
      payload('beta')
    );

    expect(loader).toHaveBeenCalledTimes(2);
    expect(getRecentProjectsClientSnapshot()).toMatchObject({
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

    const first = loadRecentProjectsWithClientCache(loader, { force: true });
    const second = loadRecentProjectsWithClientCache(loader, { force: true });

    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoaderRef.current?.(payload('alpha'));

    await expect(first).resolves.toEqual(payload('alpha'));
    await expect(second).resolves.toEqual(payload('alpha'));
  });

  it('marks degraded payload snapshots stale faster than healthy payloads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));

    const loader = vi
      .fn<() => Promise<DashboardRecentProjectsPayload>>()
      .mockResolvedValueOnce(payload('alpha', { degraded: true }));

    await expect(loadRecentProjectsWithClientCache(loader)).resolves.toEqual(
      payload('alpha', { degraded: true })
    );

    vi.setSystemTime(new Date('2026-04-14T12:00:01.000Z'));
    expect(getRecentProjectsClientSnapshot()).toMatchObject({
      payload: payload('alpha', { degraded: true }),
      isStale: false,
    });

    vi.setSystemTime(new Date('2026-04-14T12:00:02.000Z'));
    expect(getRecentProjectsClientSnapshot()).toMatchObject({
      payload: payload('alpha', { degraded: true }),
      isStale: true,
    });
  });

  it('normalizes legacy array responses from the loader during mixed-version dev reloads', async () => {
    const loader = vi.fn<() => Promise<DashboardRecentProject[]>>().mockResolvedValue([project('alpha')]);

    await expect(loadRecentProjectsWithClientCache(loader)).resolves.toEqual(payload('alpha'));
    expect(getRecentProjectsClientSnapshot()?.payload).toEqual(payload('alpha'));
  });
});
