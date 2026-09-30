import { getAppIconPath } from '@main/utils/appIcon';
import { createLogger } from '@shared/utils/logger';

import type { NotificationConstructorOptions } from 'electron';

const logger = createLogger('Service:NotificationManager');

type NotificationEventName = 'click' | 'close' | 'show' | 'failed';

export interface NotificationInstance {
  on(event: NotificationEventName, listener: (...args: unknown[]) => void): void;
  show(): void;
}

export interface NotificationClass {
  new (options: NotificationConstructorOptions): NotificationInstance;
  isSupported(): boolean;
}

type DeliveryResult = { success: boolean; error?: string };

export async function sendTestNotification(
  activeNotifications: Set<NotificationInstance>,
  getNotificationClass: () => NotificationClass | null,
  isNativeNotificationSupported: () => boolean
): Promise<DeliveryResult> {
  try {
    const NotificationClass = getNotificationClass();
    if (!NotificationClass || !isNativeNotificationSupported()) {
      logger.warn('[test-notification] native notifications not supported');
      return { success: false, error: 'Native notifications are not supported on this platform' };
    }
    const isMac = process.platform === 'darwin';
    const iconPath = isMac ? undefined : getAppIconPath();
    const notification = new NotificationClass({
      title: 'Test Notification',
      ...(isMac ? { subtitle: 'Agent Teams AI' } : {}),
      body: isMac
        ? 'Notifications are working correctly!'
        : 'Agent Teams AI\nNotifications are working correctly!',
      ...(iconPath ? { icon: iconPath } : {}),
    });
    return await new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        activeNotifications.delete(notification);
      };
      const settle = (result: DeliveryResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.success) cleanup();
        resolve(result);
      };
      const timer = setTimeout(() => {
        settle({
          success: false,
          error: 'Native notification was not confirmed within 5 seconds',
        });
        try {
          (notification as NotificationInstance & { close?: () => void }).close?.();
        } catch (error) {
          logger.debug(
            `[test-notification] failed to close timed out notification: ${String(error)}`
          );
        }
      }, 5000);
      try {
        activeNotifications.add(notification);
        notification.on('click', cleanup);
        notification.on('close', () => {
          cleanup();
          settle({ success: false, error: 'Native notification closed before it was shown' });
        });
        notification.on('show', () => settle({ success: true }));
        notification.on('failed', (_, error) => {
          logger.warn(`[notification] test notification failed: ${String(error)}`);
          cleanup();
          settle({ success: false, error: String(error) });
        });
        notification.show();
      } catch (error) {
        settle({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
