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

describe('HttpAPIClient Codex account browser fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects Codex account actions with a consistent browser-mode error and returns a safe noop subscription', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const client = new HttpAPIClient('http://localhost:9999');
    const expectedMessage = 'Codex account bridge is unavailable in browser mode';

    await expect(client.getCodexAccountSnapshot()).rejects.toThrow(expectedMessage);
    await expect(
      client.refreshCodexAccountSnapshot({
        includeRateLimits: true,
        forceRefreshToken: true,
      })
    ).rejects.toThrow(expectedMessage);
    await expect(client.startCodexChatgptLogin()).rejects.toThrow(expectedMessage);
    await expect(client.cancelCodexChatgptLogin()).rejects.toThrow(expectedMessage);
    await expect(client.logoutCodexAccount()).rejects.toThrow(expectedMessage);

    expect(typeof client.onCodexAccountSnapshotChanged(() => undefined)).toBe('function');
  });
});
