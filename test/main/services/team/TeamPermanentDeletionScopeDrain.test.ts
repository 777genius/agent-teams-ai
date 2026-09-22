import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamPermanentDeletionLock } from '@main/services/team/permanent-deletion/TeamPermanentDeletionLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/utils/pathDecoder', () => ({ getBackupsBasePath: () => state.root }));

describe('lifecycle physical scope drain', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'work-sync-lifecycle-drain-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(state.root, { recursive: true, force: true });
  });

  it('holds another owner behind pending work after heartbeat failure and lease expiry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const firstOwner = new TeamPermanentDeletionLock();
    const secondOwner = new TeamPermanentDeletionLock();
    const heartbeat = vi
      .spyOn(
        firstOwner as unknown as {
          heartbeatPermanentDeletionLock(lock: unknown): Promise<void>;
        },
        'heartbeatPermanentDeletionLock'
      )
      .mockRejectedValue(new Error('test heartbeat EIO'));
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = firstOwner
      .withLock('team:sandbox', async () => {
        entered();
        await physical;
      })
      .catch((error: unknown) => error);
    await inside;
    await vi.advanceTimersByTimeAsync(5_001);
    expect(heartbeat).toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    let deletionEntered = false;
    const deletion = secondOwner.withLock('team:sandbox', async () => {
      deletionEntered = true;
    });
    try {
      expect(await secondOwner.withLock('team:healthy', async () => 'progress')).toBe('progress');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deletionEntered).toBe(false);
    } finally {
      release();
      await Promise.all([first, deletion]);
    }
    expect(await first).toBeInstanceOf(Error);
    expect(deletionEntered).toBe(true);
  });
});
