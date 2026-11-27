import { HttpAPIClient } from '@renderer/api/httpClient';
import { getTeamMessageReadContextScope } from '@renderer/utils/teamMessageReadStorage';
import { afterEach, expect, it, vi } from 'vitest';

class MockEventSource {
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => vi.unstubAllGlobals());

it('keeps custom browser roots distinct from the default read namespace', async () => {
  vi.stubGlobal('EventSource', MockEventSource);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = new HttpAPIClient('http://localhost:9999');
  for (const path of [null, '/sandbox/root-a', '/sandbox/root-b']) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true, data: { general: { claudeRootPath: path } },
    })));
    const info = await client.config.getClaudeRootInfo();
    expect(getTeamMessageReadContextScope('local', info)).toBe(
      path === null ? 'local' : JSON.stringify(['local-root', path])
    );
  }
});
