import { randomUUID } from 'node:crypto';

import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';

import { NotificationChannelsService } from '../../core/application/NotificationChannelsService';
import { ThinwrapDeliverySender } from '../adapters/output/ThinwrapDeliverySender';
import { JsonDeliveryChannelRepository } from '../infrastructure/JsonDeliveryChannelRepository';

export type NotificationChannelsFeatureFacade = Pick<
  NotificationChannelsService,
  'list' | 'save' | 'remove' | 'test' | 'dispatch'
>;

export function createNotificationChannelsFeature(options: {
  storePath: string;
  apiKeys: Pick<ApiKeyService, 'save' | 'delete' | 'readValueById'>;
  canDeliver?(): boolean;
}): NotificationChannelsFeatureFacade {
  return new NotificationChannelsService({
    repository: new JsonDeliveryChannelRepository(options.storePath),
    sender: new ThinwrapDeliverySender(),
    credentials: {
      create: async (name, value) => {
        const saved = await options.apiKeys.save({
          name: 'Notification: ' + name,
          envVarName: 'NOTIFICATION_CHANNEL_' + randomUUID().replace(/-/g, '').toUpperCase(),
          value,
          scope: 'user',
        });
        return saved.id;
      },
      read: (id) => options.apiKeys.readValueById(id),
      remove: (id) => options.apiKeys.delete(id),
    },
    newId: randomUUID,
    now: () => new Date().toISOString(),
    canDeliver: options.canDeliver,
  });
}
