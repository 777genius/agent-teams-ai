import { createNotificationChannelsFeature, registerNotificationChannelsIpc,
  removeNotificationChannelsIpc, type NotificationChannelsFeatureFacade,
} from '@features/notification-channels/main';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { join } from 'node:path';

import { ApiKeyService } from './services/extensions/apikeys/ApiKeyService';
import { ConfigManager } from './services/infrastructure/ConfigManager';

import type { HttpServer } from './services/infrastructure/HttpServer';
import type { NotificationManager } from './services/infrastructure/NotificationManager';
import type { DetectedError } from '@shared/types/notifications';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:NotificationChannels');

export interface NotificationChannelsRuntime {
  readonly feature: NotificationChannelsFeatureFacade;
  start(ipc: IpcMain, notifications: NotificationManager, http: HttpServer): void;
  dispose(): void;
}

/** Main-only composition. Core and renderer stay independent of the transport. */
export function createNotificationChannelsRuntime(): NotificationChannelsRuntime {
  const appDataPath = getAppDataPath();
  const feature = createNotificationChannelsFeature({
    storePath: join(appDataPath, 'notification-channels.json'),
    // Dedicated vault, intentionally not listed with user-managed API keys.
    apiKeys: new ApiKeyService(join(appDataPath, 'notification-channel-credentials')),
    canDeliver: () => {
      const settings = ConfigManager.getInstance().getConfig().notifications;
      return settings.enabled &&
        (settings.snoozedUntil == null || settings.snoozedUntil <= Date.now());
    },
  });

  let cleanup: (() => void) | null = null;

  return {
    feature,
    start(ipc, notifications, http) {
      if (cleanup) return;
      registerNotificationChannelsIpc(ipc, feature);
      const onNew = (value: unknown): void => { http.broadcast('notification:new', value); };
      const onUpdated = (value: unknown): void => { http.broadcast('notification:updated', value); };
      const onClicked = (value: unknown): void => { http.broadcast('notification:clicked', value); };
      const onDelivery = (value: unknown): void => {
        void feature.dispatch(value as DetectedError).catch(() => {
          logger.warn('External notification delivery skipped.');
        });
      };
      notifications.on('notification-new', onNew);
      notifications.on('notification-updated', onUpdated);
      notifications.on('notification-clicked', onClicked);
      notifications.on('notification-delivery', onDelivery);
      cleanup = () => {
        notifications.off('notification-new', onNew);
        notifications.off('notification-updated', onUpdated);
        notifications.off('notification-clicked', onClicked);
        notifications.off('notification-delivery', onDelivery);
        removeNotificationChannelsIpc(ipc);
      };
    },
    dispose() {
      cleanup?.();
      cleanup = null;
    },
  };
}
