import { UserAttentionUnsupportedError } from '@features/user-attention/contracts';
import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, expect, it, vi } from 'vitest';

class MockEventSource {
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => vi.unstubAllGlobals());

it('classifies only an absent Attention route as unsupported', async () => {
  vi.stubGlobal('EventSource', MockEventSource);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = new HttpAPIClient('http://localhost:9999');
  const snapshot = { contextId: 'local', teams: [], complete: true };
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
  await expect(client.getUserAttentionSnapshot()).rejects.toBeInstanceOf(UserAttentionUnsupportedError);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }));
  await expect(client.getUserAttentionSnapshot()).rejects.toThrow('Unavailable');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(snapshot)));
  await expect(client.getUserAttentionSnapshot('alpha')).resolves.toEqual(snapshot);
  expect(fetch).toHaveBeenLastCalledWith(
    'http://localhost:9999/api/user-attention?teamName=alpha',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});
