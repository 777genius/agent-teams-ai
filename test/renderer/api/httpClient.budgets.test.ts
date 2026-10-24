import { TOKEN_USAGE_BUDGET_STATUS_CHANGED } from '@features/token-usage/contracts';
import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenUsageBudgetStatusDto } from '@features/token-usage/contracts';

class FakeEventSource {
  onopen = null;
  onerror = null;
  private listeners = new Map<string, EventListener>();
  addEventListener(channel: string, listener: EventListener): void {
    this.listeners.set(channel, listener);
  }
  emit(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.(new MessageEvent(channel, { data: JSON.stringify(payload) }));
  }
  close(): void {
    this.listeners.clear();
  }
}
const revision = '2026-10-03T12:00:00.000Z';
const status: TokenUsageBudgetStatusDto = {
  period: {
    key: '2026-10',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    timeZone: 'UTC',
  },
  computedAt: revision,
  settingsUpdatedAt: revision,
  usageUpdatedAt: revision,
  stale: false,
  degraded: false,
  notificationPolicy: { enabled: true, nativeToasts: true },
  targets: [],
  options: [],
};
describe('Budget HTTP and SSE timestamp parity', () => {
  const source = new FakeEventSource();
  beforeEach(() => {
    vi.stubGlobal(
      'EventSource',
      vi.fn(() => source)
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  // Date revival makes these string-DTO comparisons unordered and defeats the hook race guard.
  it('preserves string timestamps identically in GET and SSE status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(status))))
    );
    const client = new HttpAPIClient('http://127.0.0.1:53123');
    const received: TokenUsageBudgetStatusDto[] = [];
    const unsubscribe = client.tokenUsage.onBudgetStatusChanged((value) => received.push(value));
    source.emit(TOKEN_USAGE_BUDGET_STATUS_CHANGED, status);
    const loaded = await client.tokenUsage.getBudgetStatus();
    expect(loaded).toEqual(received[0]);
    expect(loaded.computedAt > '2026-10-03T11:59:59.999Z').toBe(true);
    expect(loaded.settingsUpdatedAt).toBe(revision);
    expect(loaded.period.from).toBe(status.period.from);
    unsubscribe();
    source.emit(TOKEN_USAGE_BUDGET_STATUS_CHANGED, status);
    expect(received).toHaveLength(1);
  });
  it('keeps GET and PUT settings revisions as ISO strings for CAS', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ updatedAt: revision })))
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpAPIClient('http://127.0.0.1:53123');
    const loaded = await client.tokenUsage.getBudgetSettings();
    expect(loaded.updatedAt).toBe(revision);
    const saved = await client.tokenUsage.updateBudgetSettings({
      settings: {},
      teamIdentityVersion: 1,
      expectedUpdatedAt: loaded.updatedAt!,
    });
    expect(saved.updatedAt).toBe(revision);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ settings: {}, teamIdentityVersion: 1, expectedUpdatedAt: revision }),
      })
    );
  });
  // Canonical filters must survive the actual client URL boundary and take priority.
  it('serializes canonical IDs and preserves raw filters for older callers', async () => {
    const fetchMock = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response('{}'))
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpAPIClient('http://127.0.0.1:53123');
    await client.tokenUsage.getSnapshot({
      teamIds: ['anonymous', 'team:unassigned'],
      teamName: 'ignored',
    });
    const canonical = new URL(fetchMock.mock.calls.at(-1)![0] as unknown as string);
    expect(canonical.searchParams.getAll('teamIds')).toEqual(['anonymous', 'team:unassigned']);
    expect(canonical.searchParams.has('teamName')).toBe(false);
    await client.tokenUsage.getSnapshot({ teamIds: [], teamName: 'ignored' });
    expect(new URL(fetchMock.mock.calls.at(-1)![0] as unknown as string).search).toBe('');
    await client.tokenUsage.getSnapshot({ teamNames: ['unassigned', 'team:raw'] });
    expect(
      new URL(fetchMock.mock.calls.at(-1)![0] as unknown as string).searchParams.getAll('teamNames')
    ).toEqual(['unassigned', 'team:raw']);
  });
});
