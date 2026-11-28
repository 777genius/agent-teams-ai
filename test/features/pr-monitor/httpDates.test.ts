import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FixtureEvents {
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => vi.unstubAllGlobals());

describe('PR Monitor HTTP wire contract', () => {
  it('preserves ISO strings throughout PR snapshots while other POST APIs retain date revival', async () => {
    vi.stubGlobal('EventSource', FixtureEvents);
    const fetchedAt = '2026-11-28T19:00:00.000Z';
    const response = {
      ok: true,
      value: {
        fetchedAt,
        pullRequest: { number: 3, createdAt: '2026-11-27T18:00:00.000Z', updatedAt: fetchedAt },
        runs: [
          { id: 1, createdAt: '2026-11-28T17:00:00.000Z' },
          { id: 2, createdAt: '2026-11-28T18:00:00.000Z' },
        ],
      },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    const client = new HttpAPIClient('http://localhost:9999');
    await expect(
      client.prMonitor.get({ contextId: 'local', projectId: 'TEST-A', number: 3 })
    ).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:9999/api/pr-monitor/read',
      expect.objectContaining({ method: 'POST' })
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ checkedAt: fetchedAt })));
    await expect(
      client.workspaceTrust.getProjectStatus({ projectPath: '/TEST/project' })
    ).resolves.toEqual({ checkedAt: new Date(fetchedAt) });
  });
});
