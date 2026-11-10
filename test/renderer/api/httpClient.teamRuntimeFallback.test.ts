import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

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

describe('HttpAPIClient team runtime browser fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns valid member spawn and runtime snapshots when diagnostic fields are absent', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const client = new HttpAPIClient('http://localhost:9999');

    await expect(client.teams.getMemberSpawnStatuses('demo-team')).resolves.toEqual({
      statuses: {},
      runId: null,
    });
    await expect(client.teams.getTeamAgentRuntime('demo-team')).resolves.toMatchObject({
      teamName: 'demo-team',
      runId: null,
      members: {},
    });
  });
});
