import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener = vi.fn();
  close = vi.fn();
}

describe('HttpAPIClient memberWorkSync', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let eventSourceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    eventSourceMock = vi.fn(() => new FakeEventSource());
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', eventSourceMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maps browser-mode member work sync calls to the HTTP routes', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ state: 'needs_sync' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'still_working' }))
      .mockResolvedValueOnce(jsonResponse({ memberCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ accepted: true }));

    await expect(
      client.memberWorkSync.getStatus({ teamName: 'demo team', memberName: 'bob/qa' })
    ).resolves.toEqual({ state: 'needs_sync' });
    await expect(
      client.memberWorkSync.refreshStatus({ teamName: 'demo team', memberName: 'bob/qa' })
    ).resolves.toEqual({ state: 'still_working' });
    await expect(client.memberWorkSync.getMetrics({ teamName: 'demo team' })).resolves.toEqual({
      memberCount: 1,
    });
    await expect(
      client.memberWorkSync.report({
        teamName: 'demo team',
        memberName: 'bob/qa',
        state: 'still_working',
        agendaFingerprint: 'agenda:v1:test',
        taskIds: ['task-a'],
        source: 'app',
      })
    ).resolves.toEqual({ accepted: true });

    expect(eventSourceMock).toHaveBeenCalledWith('http://127.0.0.1:53123/api/events');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:53123/api/teams/demo%20team/member-work-sync/bob%2Fqa',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:53123/api/teams/demo%20team/member-work-sync/bob%2Fqa/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: expect.any(AbortSignal),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:53123/api/teams/demo%20team/member-work-sync/metrics',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:53123/api/teams/demo%20team/member-work-sync/report',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamName: 'demo team',
          memberName: 'bob/qa',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:test',
          taskIds: ['task-a'],
          source: 'app',
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('rejects recovery commands that have no browser-mode HTTP route', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');
    await expect(
      client.memberWorkSync.stopAutoResume({ teamName: 'demo team', memberName: 'bob' })
    ).rejects.toThrow('not available in browser mode');
    await expect(
      client.memberWorkSync.resumeAutoResume({ teamName: 'demo team', memberName: 'bob' })
    ).rejects.toThrow('not available in browser mode');
    await expect(
      client.memberWorkSync.continueManually({ teamName: 'demo team', memberName: 'bob' })
    ).rejects.toThrow('not available in browser mode');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
