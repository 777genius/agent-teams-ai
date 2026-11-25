import type { NotificationsAPI } from '@shared/types/api';

interface NotificationHttpTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  listen(channel: string, callback: (data: unknown) => void): () => void;
}

/** Browser transport for the legacy notification-history contract. */
export function createHttpNotificationHistoryApi(
  transport: NotificationHttpTransport
): NotificationsAPI {
  return {
    get: (options) =>
      transport.get(
        '/api/notifications?' +
          new URLSearchParams(
            options
              ? {
                  limit: String(options.limit ?? 20),
                  offset: String(options.offset ?? 0),
                }
              : {}
          ).toString()
      ),
    markRead: (id) => transport.post('/api/notifications/' + encodeURIComponent(id) + '/read'),
    markAllRead: () => transport.post('/api/notifications/read-all'),
    setViewedTeam: (teamName) => transport.post('/api/notifications/viewed-team', { teamName }),
    delete: (id) => transport.del('/api/notifications/' + encodeURIComponent(id)),
    clear: () => transport.del('/api/notifications'),
    getUnreadCount: () => transport.get('/api/notifications/unread-count'),
    testNotification: async () => ({
      success: false,
      error: 'Test notifications require Electron (not available in browser mode)',
    }),
    onNew: (callback) => transport.listen('notification:new', (data) => callback(null, data)),
    onUpdated: (callback) =>
      transport.listen('notification:updated', (data) =>
        callback(null, data as { total: number; unreadCount: number })
      ),
    onClicked: (callback) =>
      transport.listen('notification:clicked', (data) => callback(null, data)),
  };
}
