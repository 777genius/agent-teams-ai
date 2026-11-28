import { isLocalHttpRead as isLocalNotificationChannelsRead, localHttpOrigin } from '@main/http/localAccess';

import { NOTIFICATION_CHANNELS_HTTP } from '../../../contracts';

import type { NotificationChannelsFeatureFacade } from '../../composition/createNotificationChannelsFeature';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export { isLocalHttpRead as isLocalNotificationChannelsRead } from '@main/http/localAccess';

export function isLocalNotificationChannelsMutation(request: FastifyRequest): boolean {
  return (
    isLocalNotificationChannelsRead(request) &&
    request.headers.origin === localHttpOrigin(request.headers.host ?? '')
  );
}

export function registerNotificationChannelsHttp(
  app: FastifyInstance,
  feature: NotificationChannelsFeatureFacade
): void {
  app.get(NOTIFICATION_CHANNELS_HTTP, async (request, reply) => {
    if (!isLocalNotificationChannelsRead(request)) {
      return reply.code(403).send({ error: 'Local access required' });
    }
    return feature.list();
  });

  app.post(NOTIFICATION_CHANNELS_HTTP, async (request, reply) => {
    if (!isLocalNotificationChannelsMutation(request)) {
      return reply.code(403).send({ error: 'Cross-origin modification denied' });
    }
    try {
      return await feature.save(request.body as Parameters<typeof feature.save>[0]);
    } catch {
      return reply
        .code(400)
        .send({ error: 'Invalid channel settings or secure storage unavailable' });
    }
  });

  app.post<{ Params: { id: string } }>(
    NOTIFICATION_CHANNELS_HTTP + '/:id/test',
    async (request, reply) => {
      if (!isLocalNotificationChannelsMutation(request)) {
        return reply.code(403).send({ error: 'Cross-origin modification denied' });
      }
      try {
        return await feature.test(request.params.id);
      } catch {
        return reply.code(400).send({ error: 'Unable to test this channel' });
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    NOTIFICATION_CHANNELS_HTTP + '/:id',
    async (request, reply) => {
      if (!isLocalNotificationChannelsMutation(request)) {
        return reply.code(403).send({ error: 'Cross-origin modification denied' });
      }
      try {
        await feature.remove(request.params.id);
        return { success: true };
      } catch {
        return reply.code(400).send({ error: 'Unable to remove this channel' });
      }
    }
  );
}
