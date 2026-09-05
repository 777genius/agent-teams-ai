import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCEMENTS_CHANNELS as channels } from '../../../src/features/announcements/contracts';

import type {
  AnnouncementsFeature,
  AnnouncementWindowContext,
} from '../../../src/features/announcements/main/composition/createAnnouncementsFeature';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  },
}));
import { registerAnnouncementsIpc } from '../../../src/features/announcements/main/adapters/input/registerAnnouncementsIpc';

const feature = {
  getSnapshot: vi.fn(),
  refresh: vi.fn(),
  prepareAuto: vi.fn(),
  claimAuto: vi.fn(),
  openManual: vi.fn(),
  loadCover: vi.fn(),
  cancelCover: vi.fn(),
  loadAsset: vi.fn(),
  cancelAsset: vi.fn(),
  dismiss: vi.fn(),
};
const context: AnnouncementWindowContext = { windowId: 1, uiGeneration: 0, isReady: () => true };
const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args);
beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('announcements IPC boundary', () => {
  it('rejects untrusted senders on every channel, including reads', () => {
    registerAnnouncementsIpc(feature as unknown as AnnouncementsFeature, () => null);
    for (const name of handlers.keys())
      expect(() => invoke(name)).toThrow('Invalid announcement request');
    expect(feature.getSnapshot).not.toHaveBeenCalled();
  });
  it('rejects malformed payloads and arbitrary paths, counters or extra arguments', () => {
    registerAnnouncementsIpc(feature as unknown as AnnouncementsFeature, () => context);
    for (const id of ['../secret', 'https://example.com', '', 'A', 'a'.repeat(81), {}, null]) {
      expect(() => invoke(channels.openManual, id)).toThrow();
      expect(() => invoke(channels.loadCover, id, 'cover_1')).toThrow();
      expect(() => invoke(channels.dismiss, id)).toThrow();
    }
    const claim = { id: 'news', revision: 'a'.repeat(64), bodySha256: 'b'.repeat(64) };
    for (const payload of [
      { ...claim, now: 0 },
      { ...claim, revision: 'x'.repeat(64) },
      { ...claim, id: '../bad' },
      [],
    ]) {
      expect(() => invoke(channels.claimAuto, payload)).toThrow();
    }
    expect(() => invoke(channels.prepareAuto, { accumulatedOpenMs: 999999 })).toThrow();
    expect(() => invoke(channels.openManual, 'news', '/tmp')).toThrow();
    for (const url of [123, '', 'https://example.com/a b.png', 'x'.repeat(2049)])
      expect(() => invoke(channels.loadAsset, url, 'request_1')).toThrow();
    for (const requestId of ['', '../bad', 'x'.repeat(65), {}]) {
      expect(() =>
        invoke(channels.loadAsset, 'https://agentteams.live/a.png', requestId)
      ).toThrow();
      expect(() => invoke(channels.loadCover, 'news', requestId)).toThrow();
      expect(() => invoke(channels.cancelCover, requestId)).toThrow();
      expect(() => invoke(channels.cancelAsset, requestId)).toThrow();
    }
    invoke(channels.claimAuto, claim);
    expect(feature.claimAuto).toHaveBeenCalledWith(claim, context);
    invoke(channels.openManual, 'news');
    expect(feature.openManual).toHaveBeenCalledWith('news', context);
    invoke(channels.loadCover, 'news', 'cover_1');
    expect(feature.loadCover).toHaveBeenCalledWith('news', 'cover_1', context);
    invoke(channels.cancelCover, 'cover_1');
    expect(feature.cancelCover).toHaveBeenCalledWith('cover_1', context);
    invoke(
      channels.loadAsset,
      'https://agentteams.live/announcements/content/news/a/assets/x.png',
      'request_1'
    );
    expect(feature.loadAsset).toHaveBeenCalledWith(
      'https://agentteams.live/announcements/content/news/a/assets/x.png',
      'request_1',
      context
    );
    invoke(channels.cancelAsset, 'request_1');
    expect(feature.cancelAsset).toHaveBeenCalledWith('request_1', context);
    invoke(channels.dismiss, 'news');
    expect(feature.dismiss).toHaveBeenCalledWith('news', context);
  });
  it('unregisters all owned handlers', () => {
    const dispose = registerAnnouncementsIpc(
      feature as unknown as AnnouncementsFeature,
      () => context
    );
    expect(handlers.size).toBe(10);
    dispose();
    expect(handlers.size).toBe(0);
  });
});
