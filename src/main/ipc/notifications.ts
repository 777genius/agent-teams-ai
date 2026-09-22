/**
 * IPC Handlers for Notification Operations.
 *
 * Handlers:
 * - notifications:get: Get all notifications (paginated)
 * - notifications:markRead: Mark notification as read
 * - notifications:markAllRead: Mark all as read
 * - notifications:delete: Delete a single notification
 * - notifications:clear: Clear all notifications
 * - notifications:getUnreadCount: Get unread count for badge
 * - notifications:testNotification: Send a test notification to verify delivery
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import {
  type GetNotificationsOptions,
  type GetNotificationsResult,
  NotificationManager,
} from '../services';

import { coercePageLimit, validateNotificationId } from './guards';

const logger = createLogger('IPC:notifications');

/**
 * Registers all notification-related IPC handlers.
 *
 * @param ipcMain - The Electron IpcMain instance
 */
export function registerNotificationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('notifications:get', handleGetNotifications);
  ipcMain.handle('notifications:markRead', handleMarkRead);
  ipcMain.handle('notifications:markAllRead', handleMarkAllRead);
  ipcMain.handle('notifications:delete', handleDelete);
  ipcMain.handle('notifications:clear', handleClear);
  ipcMain.handle('notifications:getUnreadCount', handleGetUnreadCount);
  ipcMain.handle('notifications:testNotification', handleTestNotification);

  logger.info('Notification handlers registered');
}

/**
 * Removes all notification IPC handlers.
 * Should be called when shutting down.
 */
export function removeNotificationHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('notifications:get');
  ipcMain.removeHandler('notifications:markRead');
  ipcMain.removeHandler('notifications:markAllRead');
  ipcMain.removeHandler('notifications:delete');
  ipcMain.removeHandler('notifications:clear');
  ipcMain.removeHandler('notifications:getUnreadCount');
  ipcMain.removeHandler('notifications:testNotification');

  logger.info('Notification handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

/**
 * Handler for 'notifications:get' IPC call.
 * Gets all notifications with optional pagination and filtering.
 */
async function handleGetNotifications(
  _event: IpcMainInvokeEvent,
  options?: GetNotificationsOptions
): Promise<GetNotificationsResult> {
  try {
    const opts = options ?? {};
    const safeOptions: GetNotificationsOptions = {
      limit: coercePageLimit(opts.limit, 20),
      offset:
        typeof opts.offset === 'number' && Number.isFinite(opts.offset) && opts.offset >= 0
          ? Math.floor(opts.offset)
          : 0,
    };
    const manager = NotificationManager.getInstance();
    const result = await manager.getNotifications(safeOptions);
    return result;
  } catch (error) {
    logger.error('Error in notifications:get:', getErrorMessage(error));
    return {
      notifications: [],
      total: 0,
      totalCount: 0,
      unreadCount: 0,
      hasMore: false,
    };
  }
}

/**
 * Handler for 'notifications:markRead' IPC call.
 * Marks a specific notification as read.
 */
async function handleMarkRead(
  _event: IpcMainInvokeEvent,
  notificationId: string
): Promise<boolean> {
  try {
    const validatedNotification = validateNotificationId(notificationId);
    if (!validatedNotification.valid) {
      logger.error(
        `notifications:markRead rejected: ${validatedNotification.error ?? 'Invalid notificationId'}`
      );
      return false;
    }

    const manager = NotificationManager.getInstance();
    const success = await manager.markRead(validatedNotification.value!);
    return success;
  } catch (error) {
    logger.error(`Error in notifications:markRead for ${notificationId}:`, error);
    return false;
  }
}

/**
 * Handler for 'notifications:markAllRead' IPC call.
 * Marks all notifications as read.
 */
async function handleMarkAllRead(_event: IpcMainInvokeEvent): Promise<boolean> {
  try {
    const manager = NotificationManager.getInstance();
    const success = await manager.markAllRead();
    return success;
  } catch (error) {
    logger.error('Error in notifications:markAllRead:', error);
    return false;
  }
}

/**
 * Handler for 'notifications:delete' IPC call.
 * Deletes a single notification.
 */
async function handleDelete(_event: IpcMainInvokeEvent, notificationId: string): Promise<boolean> {
  try {
    const validatedNotification = validateNotificationId(notificationId);
    if (!validatedNotification.valid) {
      logger.error(
        `notifications:delete rejected: ${validatedNotification.error ?? 'Invalid notificationId'}`
      );
      return false;
    }

    const manager = NotificationManager.getInstance();
    const success = manager.deleteNotification(validatedNotification.value!);
    return success;
  } catch (error) {
    logger.error(`Error in notifications:delete for ${notificationId}:`, error);
    return false;
  }
}

/**
 * Handler for 'notifications:clear' IPC call.
 * Clears all notifications.
 */
async function handleClear(_event: IpcMainInvokeEvent): Promise<boolean> {
  try {
    const manager = NotificationManager.getInstance();
    const success = await manager.clearAll();
    return success;
  } catch (error) {
    logger.error('Error in notifications:clear:', error);
    return false;
  }
}

/**
 * Handler for 'notifications:getUnreadCount' IPC call.
 * Gets the count of unread notifications for badge display.
 */
async function handleGetUnreadCount(_event: IpcMainInvokeEvent): Promise<number> {
  try {
    const manager = NotificationManager.getInstance();
    const count = await manager.getUnreadCount();
    return count;
  } catch (error) {
    logger.error('Error in notifications:getUnreadCount:', error);
    return 0;
  }
}

/**
 * Handler for 'notifications:testNotification' IPC call.
 * Sends a test notification to verify that native OS notifications are delivered.
 */
function handleTestNotification(_event: IpcMainInvokeEvent): { success: boolean; error?: string } {
  try {
    logger.debug('Handling notifications:testNotification request');
    const manager = NotificationManager.getInstance();
    const result = manager.sendTestNotification();
    logger.debug(`notifications:testNotification result: success=${String(result.success)}`);
    return result;
  } catch (error) {
    logger.error('Error in notifications:testNotification:', error);
    return { success: false, error: getErrorMessage(error) };
  }
}
