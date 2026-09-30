import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCEMENTS_CHANNELS as channels } from '../../src/features/announcements/contracts';
import { createElectronAnnouncementsBridge } from '../../src/preload/createElectronAnnouncementsBridge';

import type { IpcRenderer, IpcRendererEvent } from 'electron';

const ipcRenderer = {
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe('Electron announcements preload bridge', () => {
  it('forwards invoke arguments unchanged', () => {
    const bridge = createElectronAnnouncementsBridge(ipcRenderer as unknown as IpcRenderer);
    const claim = { id: 'news', revision: 'a'.repeat(64), bodySha256: 'b'.repeat(64) };
    void bridge.claimAuto(claim);
    void bridge.loadCover('news', 'cover_1');
    void bridge.loadAsset('https://agentteams.live/a.png', 'asset_1');

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [channels.claimAuto, claim],
      [channels.loadCover, 'news', 'cover_1'],
      [channels.loadAsset, 'https://agentteams.live/a.png', 'asset_1'],
    ]);
  });

  it('strips events and independently removes exactly each subscriber wrapper', () => {
    const bridge = createElectronAnnouncementsBridge(ipcRenderer as unknown as IpcRenderer);
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = bridge.onStateChanged(first);
    const removeSecond = bridge.onStateChanged(second);
    const firstWrapper = ipcRenderer.on.mock.calls[0][1] as (
      event: IpcRendererEvent,
      snapshot: unknown
    ) => void;
    const secondWrapper = ipcRenderer.on.mock.calls[1][1] as (
      event: IpcRendererEvent,
      snapshot: unknown
    ) => void;
    const snapshot = { status: 'disabled' };

    firstWrapper({} as IpcRendererEvent, snapshot);
    secondWrapper({} as IpcRendererEvent, snapshot);
    expect(first).toHaveBeenCalledWith(snapshot);
    expect(second).toHaveBeenCalledWith(snapshot);

    removeFirst();
    expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith(
      channels.stateChanged,
      firstWrapper
    );
    expect(ipcRenderer.removeListener).not.toHaveBeenCalledWith(
      channels.stateChanged,
      secondWrapper
    );
    removeSecond();
    expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith(
      channels.stateChanged,
      secondWrapper
    );
  });
});
