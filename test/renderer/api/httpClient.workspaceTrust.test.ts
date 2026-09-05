import {
  WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
  WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
} from '@features/workspace-trust/contracts';
import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, describe, expect, it, vi } from 'vitest';

class MockEventSource {
  addEventListener(): void {}
  close(): void {}
}

describe('HttpAPIClient workspace trust', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts both contracts without changing provider-specific results', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const result = { providers: [{ providerId: 'codex', status: 'launch_scoped' }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetch);
    const client = new HttpAPIClient('http://localhost:9999');
    const request = { projectPath: '/sandbox/repo', providerIds: ['codex' as const] };
    await expect(client.workspaceTrust.getLaunchStatus?.(request)).resolves.toEqual(result);
    expect(fetch).toHaveBeenLastCalledWith(
      `http://localhost:9999${WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) })
    );
    fetch.mockResolvedValue(new Response(JSON.stringify({ status: 'trusted' })));
    await expect(
      client.workspaceTrust.getProjectStatus({ projectPath: request.projectPath })
    ).resolves.toEqual({ status: 'trusted' });
    expect(fetch).toHaveBeenLastCalledWith(
      `http://localhost:9999${WORKSPACE_TRUST_PROJECT_STATUS_ROUTE}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectPath: request.projectPath }),
      })
    );
  });

  it('rejects a missing route instead of treating an old server as trusted', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }))
    );
    const client = new HttpAPIClient('http://localhost:9999');
    await expect(
      client.workspaceTrust.getLaunchStatus?.({ projectPath: '/sandbox', providerIds: ['codex'] })
    ).rejects.toThrow();
  });
});
