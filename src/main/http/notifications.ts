/**
 * HTTP route handlers for Notification Operations.
 *
 * Routes:
 * - GET /api/notifications - Get notifications (paginated)
 * - POST /api/notifications/:id/read - Mark as read
 * - POST /api/notifications/read-all - Mark all as read
 * - DELETE /api/notifications/:id - Delete notification
 * - DELETE /api/notifications - Clear all notifications
 * - GET /api/notifications/unread-count - Get unread count
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { coercePageLimit, validateNotificationId } from '../ipc/guards';
import { NotificationManager } from '../services/infrastructure/NotificationManager';

import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:notifications');

export function registerNotificationRoutes(app: FastifyInstance): void {
  // Get notifications
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/api/notifications',
    async (request) => {
      try {
        const limit = coercePageLimit(
          request.query.limit ? Number(request.query.limit) : undefined,
          20
        );
        const rawOffset = request.query.offset ? Number(request.query.offset) : 0;
        const offset =
          typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0
            ? Math.floor(rawOffset)
            : 0;

        const manager = NotificationManager.getInstance();
        const result = await manager.getNotifications({ limit, offset });
        return result;
      } catch (error) {
        logger.error('Error in GET /api/notifications:', getErrorMessage(error));
        return {
          notifications: [],
          total: 0,
          totalCount: 0,
          unreadCount: 0,
          hasMore: false,
        };
      }
    }
  );

  // Mark read
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (request) => {
    try {
      const validated = validateNotificationId(request.params.id);
      if (!validated.valid) {
        logger.error(`POST notifications/:id/read rejected: ${validated.error ?? 'unknown'}`);
        return false;
      }

      const manager = NotificationManager.getInstance();
      return await manager.markRead(validated.value!);
    } catch (error) {
      logger.error(`Error in POST notifications/${request.params.id}/read:`, error);
      return false;
    }
  });

  // Mark all read
  app.post('/api/notifications/read-all', async () => {
    try {
      const manager = NotificationManager.getInstance();
      return await manager.markAllRead();
    } catch (error) {
      logger.error('Error in POST /api/notifications/read-all:', error);
      return false;
    }
  });

  // Delete notification
  app.delete<{ Params: { id: string } }>('/api/notifications/:id', async (request) => {
    try {
      const validated = validateNotificationId(request.params.id);
      if (!validated.valid) {
        logger.error(`DELETE notifications/:id rejected: ${validated.error ?? 'unknown'}`);
        return false;
      }

      const manager = NotificationManager.getInstance();
      return manager.deleteNotification(validated.value!);
    } catch (error) {
      logger.error(`Error in DELETE notifications/${request.params.id}:`, error);
      return false;
    }
  });

  // Clear all
  app.delete('/api/notifications', async () => {
    try {
      const manager = NotificationManager.getInstance();
      return await manager.clearAll();
    } catch (error) {
      logger.error('Error in DELETE /api/notifications:', error);
      return false;
    }
  });

  // Unread count
  app.get('/api/notifications/unread-count', async () => {
    try {
      const manager = NotificationManager.getInstance();
      return await manager.getUnreadCount();
    } catch (error) {
      logger.error('Error in GET /api/notifications/unread-count:', error);
      return 0;
    }
  });
}
