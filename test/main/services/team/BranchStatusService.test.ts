import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BranchStatusService } from '@main/services/team/BranchStatusService';

import type { ProjectBranchChangeEvent } from '@shared/types';

const REPO = path.normalize('/repo');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('BranchStatusService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits initial branch and only pushes later when the branch actually changes', async () => {
    vi.useFakeTimers();

    const getBranch = vi
      .fn()
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('feature/refactor');
    const events: ProjectBranchChangeEvent[] = [];
    const service = new BranchStatusService((event) => events.push(event), { getBranch });

    await service.setTracking(REPO, true);
    expect(events).toEqual([{ projectPath: REPO, branch: 'main' }]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toEqual([
      { projectPath: REPO, branch: 'main' },
      { projectPath: REPO, branch: 'feature/refactor' },
    ]);

    service.dispose();
  });

  it('stops polling once the last subscriber unsubscribes', async () => {
    vi.useFakeTimers();

    const getBranch = vi.fn().mockResolvedValue('main');
    const service = new BranchStatusService(() => undefined, { getBranch });

    await service.setTracking(REPO, true);
    await service.setTracking(REPO, true);
    expect(getBranch).toHaveBeenCalledTimes(1);

    await service.setTracking(REPO, false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getBranch).toHaveBeenCalledTimes(2);

    await service.setTracking(REPO, false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getBranch).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it('drops stale in-flight branch results after disable and re-enable', async () => {
    const first = createDeferred<string | null>();
    const second = createDeferred<string | null>();
    const getBranch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const events: ProjectBranchChangeEvent[] = [];
    const service = new BranchStatusService((event) => events.push(event), { getBranch });

    const firstEnable = service.setTracking(REPO, true);
    await Promise.resolve();

    await service.setTracking(REPO, false);
    const secondEnable = service.setTracking(REPO, true);
    await Promise.resolve();

    first.resolve('main');
    await firstEnable;
    expect(events).toEqual([]);

    second.resolve('feature/refactor');
    await secondEnable;
    expect(events).toEqual([{ projectPath: REPO, branch: 'feature/refactor' }]);

    service.dispose();
  });
});
