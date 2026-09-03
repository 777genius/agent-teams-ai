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
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('answers the queued message listing with an empty queue for the requested member', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');

    await expect(client.teams.getQueuedUserMessages('demo team', 'bob/qa')).resolves.toEqual({
      member: 'bob/qa',
      messages: [],
    });
    // No HTTP route backs this yet, so the browser client must answer locally
    // rather than call an endpoint that would 404.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[HttpAPIClient] getQueuedUserMessages is not available in browser mode'
    );
  });

  it('refuses to discard queued messages instead of pretending it worked', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');

    await expect(
      client.teams.discardQueuedUserMessages('demo team', 'bob/qa', 'message-1')
    ).rejects.toThrow('Discarding queued messages is not available in browser mode');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
