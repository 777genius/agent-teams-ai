import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '@renderer/api/httpClient';

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {
    // noop browser-mode stub
  }
  close(): void {
    // noop browser-mode stub
  }
}

describe('HttpAPIClient queued user messages in browser mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses the queued listing instead of answering with an empty queue', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');

    // Negative control for the discard confirmation: an empty snapshot means
    // "nothing queued for this member", which the renderer reports as already
    // delivered. A client that cannot answer must not say that.
    await expect(client.teams.getQueuedUserMessages('demo team', 'bob/qa')).rejects.toThrow(
      'Listing queued messages is not available in browser mode'
    );
    // No HTTP route backs this yet, so the browser client must answer locally
    // rather than call an endpoint that would 404.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to discard queued messages instead of pretending it worked', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');

    await expect(
      client.teams.discardQueuedUserMessages('demo team', 'bob/qa', ['message-1'])
    ).rejects.toThrow('Discarding queued messages is not available in browser mode');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
