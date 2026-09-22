import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

describe('HttpAPIClient exact task logs browser fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns safe fallback shapes for exact task logs in browser mode', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HttpAPIClient('http://localhost:9999');

    await expect(client.teams.getTaskLogStream('demo', 'task-a')).resolves.toEqual({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    });
    await expect(client.teams.getTaskExactLogSummaries('demo', 'task-a')).resolves.toEqual({
      items: [],
    });
    await expect(
      client.teams.getTaskExactLogDetail('demo', 'task-a', 'bundle-1', 'gen-1')
    ).resolves.toEqual({ status: 'missing' });

    expect(warnSpy).toHaveBeenCalled();
  });
});
