import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = {
  invoke: vi.fn(async () => undefined),
  subscribe: vi.fn(),
};
import { ANNOUNCEMENTS_CHANNELS as channels } from '../../../src/features/announcements/contracts';
import { createAnnouncementsBridge } from '../../../src/features/announcements/preload';
import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('announcements transport capability', () => {
  it('passes only typed feature payload and removes exactly its listener', () => {
    const unsubscribe = vi.fn();
    transport.subscribe.mockReturnValue(unsubscribe);
    const api = createAnnouncementsBridge(transport);
    const input = { id: 'news', revision: 'a'.repeat(64), bodySha256: 'b'.repeat(64) };
    void api.claimAuto(input);
    expect(transport.invoke).toHaveBeenCalledWith(channels.claimAuto, input);
    void api.loadCover('news', 'cover_1');
    expect(transport.invoke).toHaveBeenCalledWith(channels.loadCover, 'news', 'cover_1');
    void api.cancelCover('cover_1');
    expect(transport.invoke).toHaveBeenCalledWith(channels.cancelCover, 'cover_1');
    const assetUrl = 'https://agentteams.live/announcements/content/news/a/assets/x.png';
    void api.loadAsset(assetUrl, 'request_1');
    expect(transport.invoke).toHaveBeenCalledWith(channels.loadAsset, assetUrl, 'request_1');
    void api.cancelAsset('request_1');
    expect(transport.invoke).toHaveBeenCalledWith(channels.cancelAsset, 'request_1');
    const listener = vi.fn();
    const remove = api.onStateChanged(listener);
    const handler = transport.subscribe.mock.calls[0][1] as (data: unknown) => void;
    handler({ status: 'disabled' });
    expect(listener).toHaveBeenCalledWith({ status: 'disabled' });
    remove();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(transport.subscribe).toHaveBeenCalledWith(channels.stateChanged, handler);
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
