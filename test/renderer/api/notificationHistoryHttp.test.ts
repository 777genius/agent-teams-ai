import { describe, expect, it, vi } from 'vitest';

import { createHttpNotificationHistoryApi } from '@renderer/api/notificationHistoryHttp';

describe('Notification history HTTP compatibility bridge', () => {
  it('preserves paging, mutations, and event callbacks', async () => {
    const calls: string[] = [];
    const subscribers = new Map<string, (payload: unknown) => void>();
    const unsubscribe = vi.fn();

    const api = createHttpNotificationHistoryApi({
      get: async <T>(path: string): Promise<T> => {
        calls.push('GET ' + path);
        return [] as unknown as T;
      },
      post: async <T>(path: string, _body?: unknown): Promise<T> => {
        calls.push('POST ' + path);
        return true as unknown as T;
      },
      del: async <T>(path: string): Promise<T> => {
        calls.push('DELETE ' + path);
        return true as unknown as T;
      },
      listen: (channel, callback) => {
        subscribers.set(channel, callback);
        return unsubscribe;
      },
    });

    await api.get({ limit: 25, offset: 50 });
    await api.markRead('id/2');
    await api.setViewedTeam('team');
    await api.markAllRead();
    await api.delete('id/2');
    await api.clear();
    expect(calls).toContain('GET /api/notifications?limit=25&offset=50');
    expect(calls).toContain('POST /api/notifications/id%2F2/read');
    expect(calls).toContain('POST /api/notifications/viewed-team');
    expect(calls).toContain('POST /api/notifications/read-all');
    expect(calls).toContain('DELETE /api/notifications/id%2F2');
    expect(calls).toContain('DELETE /api/notifications');

    const onNew = vi.fn();
    const onUpdated = vi.fn();
    const onClicked = vi.fn();
    api.onNew(onNew)();
    api.onUpdated(onUpdated)();
    api.onClicked(onClicked)();
    subscribers.get('notification:new')?.({ id: 'n1' });
    subscribers.get('notification:updated')?.({ total: 3, unreadCount: 1 });
    subscribers.get('notification:clicked')?.({ id: 'n1' });
    expect(onNew).toHaveBeenCalledWith(null, { id: 'n1' });
    expect(onUpdated).toHaveBeenCalledWith(null, { total: 3, unreadCount: 1 });
    expect(onClicked).toHaveBeenCalledWith(null, { id: 'n1' });
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    expect((await api.testNotification()).success).toBe(false);
  });
});
