import { afterEach, describe, expect, it, vi } from 'vitest';

const renderer = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));
import { ANNOUNCEMENTS_CHANNELS as channels } from '../../../src/features/announcements/contracts';
import { createAnnouncementsBridge } from '../../../src/features/announcements/preload';
import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('announcements transport capability', () => {
  it('passes only typed feature payload and removes exactly its listener', () => {
    const api = createAnnouncementsBridge();
    const input = { id: 'news', revision: 'a'.repeat(64), bodySha256: 'b'.repeat(64) };
    void api.claimAuto(input);
    expect(renderer.invoke).toHaveBeenCalledWith(channels.claimAuto, input);
    void api.loadCover('news', 'cover_1');
    expect(renderer.invoke).toHaveBeenCalledWith(channels.loadCover, 'news', 'cover_1');
    void api.cancelCover('cover_1');
    expect(renderer.invoke).toHaveBeenCalledWith(channels.cancelCover, 'cover_1');
    const assetUrl = 'https://agentteams.live/announcements/content/news/a/assets/x.png';
    void api.loadAsset(assetUrl, 'request_1');
    expect(renderer.invoke).toHaveBeenCalledWith(channels.loadAsset, assetUrl, 'request_1');
    void api.cancelAsset('request_1');
    expect(renderer.invoke).toHaveBeenCalledWith(channels.cancelAsset, 'request_1');
    const listener = vi.fn();
    const unsubscribe = api.onStateChanged(listener);
    const handler = renderer.on.mock.calls[0][1] as (event: unknown, data: unknown) => void;
    handler({ secret: 'main event' }, { status: 'disabled' });
    expect(listener).toHaveBeenCalledWith({ status: 'disabled' });
    unsubscribe();
    expect(renderer.removeListener).toHaveBeenCalledWith(channels.stateChanged, handler);
  });
  it('HTTP explicitly reports unavailable without announcement network calls or tracking', async () => {
    vi.stubGlobal(
      'EventSource',
      class {
        close() {}
      }
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new HttpAPIClient('http://test.invalid').announcements;
    expect(await api.getSnapshot()).toMatchObject({
      status: 'unavailable',
      autoShowEnabled: false,
    });
    expect(await api.refresh()).toMatchObject({ status: 'unavailable' });
    expect(await api.prepareAuto()).toBeNull();
    expect(await api.openManual('news')).toBeNull();
    expect(await api.loadCover('news', 'cover_1')).toBeNull();
    await expect(api.cancelCover('cover_1')).resolves.toBeUndefined();
    expect(
      await api.loadAsset('https://agentteams.live/announcements/x.png', 'request_1')
    ).toBeNull();
    await expect(api.cancelAsset('request_1')).resolves.toBeUndefined();
    expect(await api.dismiss('news')).toEqual({ saved: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
