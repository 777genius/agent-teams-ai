import { NOTIFICATION_CHANNELS_HTTP } from '../../../contracts';

import type { NotificationChannelsFeatureFacade } from '../../composition/createNotificationChannelsFeature';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Canonical HTTP origin for an exact loopback Host, including the default port. */
function localHttpOrigin(host: string): string | null {
  if (!/^(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(host)) return null;
  const port = host.split(':')[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- normalize only the validated local origin
  return new URL('http://' + host).origin;
}
/** The settings API is local-only, including metadata reads. */
export function isLocalNotificationChannelsRead(request: FastifyRequest): boolean {
  const expectedOrigin = localHttpOrigin(request.headers.host ?? '');
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (expectedOrigin === null) return false;
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- exact loopback allowlist, never a remote destination
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return false;
  if (origin !== undefined && origin !== expectedOrigin) return false;
  return site === undefined || site === 'same-origin' || site === 'none';
}

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
