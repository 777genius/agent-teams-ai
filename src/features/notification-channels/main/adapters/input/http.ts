import { NOTIFICATION_CHANNELS_HTTP } from '../../../contracts';

import type { NotificationChannelsFeatureFacade } from '../../composition/createNotificationChannelsFeature';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** A localhost browser may manage credentials; cross-origin pages may not. */
export function isLocalNotificationChannelsMutation(request: FastifyRequest): boolean {
  const host = request.headers.host ?? '';
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (!/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(host)) return false;
  if (origin !== 'http://' + host) return false;
  return site === undefined || site === 'same-origin' || site === 'none';
}

export function registerNotificationChannelsHttp(
  app: FastifyInstance,
  feature: NotificationChannelsFeatureFacade
): void {
  app.get(NOTIFICATION_CHANNELS_HTTP, async () => feature.list());

  app.post(NOTIFICATION_CHANNELS_HTTP, async (request, reply) => {
    if (!isLocalNotificationChannelsMutation(request)) {
      return reply.code(403).send({ error: 'Cross-origin modification denied' });
    }
    try {
      return await feature.save(request.body as Parameters<typeof feature.save>[0]);
    } catch {
      return reply.code(400).send({ error: 'Invalid channel settings or secure storage unavailable' });
    }
  });

  app.post<{ Params: { id: string } }>(
    NOTIFICATION_CHANNELS_HTTP + '/:id/test', async (request, reply) => {
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
    NOTIFICATION_CHANNELS_HTTP + '/:id', async (request, reply) => {
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
