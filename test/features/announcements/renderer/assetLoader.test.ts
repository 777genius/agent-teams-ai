import { describe, expect, it, vi } from 'vitest';

import { AnnouncementAssetLoader } from '../../../../src/features/announcements/renderer/AnnouncementAssetLoader';

import type { AnnouncementsApi } from '../../../../src/features/announcements/contracts';

describe('announcement article asset loader', () => {
  it('deduplicates URLs, bounds concurrency and cancels active work on dispose', async () => {
    const pending = new Map<string, (value: string | null) => void>();
    const loadAsset = vi.fn(
      (_url: string, id: string) =>
        new Promise<string | null>((resolve) => {
          pending.set(id, resolve);
        })
    );
    const cancelAsset = vi.fn(async (id: string) => {
      pending.get(id)?.(null);
    });
    const loader = new AnnouncementAssetLoader({
      loadAsset,
      cancelAsset,
    } as unknown as AnnouncementsApi);

    const first = loader.load('one');
    expect(loader.load('one')).toBe(first);
    const second = loader.load('two');
    const third = loader.load('three');
    const fourth = loader.load('four');
    expect(loadAsset).toHaveBeenCalledTimes(3);

    pending.get(loadAsset.mock.calls[0][1])?.('data:image/png;base64,eA==');
    await expect(first).resolves.toBe('data:image/png;base64,eA==');
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(4));

    loader.dispose();
    await expect(Promise.all([second, third, fourth])).resolves.toEqual([null, null, null]);
    expect(cancelAsset).toHaveBeenCalledTimes(3);
  });
});
