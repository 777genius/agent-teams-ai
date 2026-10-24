import { EXTENSION_MANAGEMENT_METHODS, EXTENSION_MANAGEMENT_ROUTE } from '../../../contracts';

import type { ExtensionManagementFeature } from '../../../core/application/ports';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function admitsManagementHttp(
  request: Pick<FastifyRequest, 'ip' | 'headers'>,
  port: number
): boolean {
  const ip = request.ip.toLowerCase().split('%')[0];
  if (!(ip === '::1' || /^127\.\d+\.\d+\.\d+$/.test(ip) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(ip)))
    return false;
  const host = request.headers.host;
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host))
    return false;
  return (
    request.headers.origin === `http://${host}` &&
    request.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json'
  );
}

export function registerExtensionManagementHttp(
  app: FastifyInstance,
  feature: ExtensionManagementFeature
): void {
  const admission = async (request: FastifyRequest, reply: FastifyReply) => {
    const address = app.server.address();
    const peer = { ip: request.raw.socket.remoteAddress ?? '', headers: request.headers };
    if (!address || typeof address === 'string' || !admitsManagementHttp(peer, address.port)) {
      return reply
        .code(403)
        .send({ error: 'Extension management requires the trusted local application.' });
    }
  };
  for (const method of EXTENSION_MANAGEMENT_METHODS) {
    app.post(
      `${EXTENSION_MANAGEMENT_ROUTE}/${method}`,
      {
        bodyLimit: method === 'prepareLocalSkill' ? 15 * 1024 * 1024 : 65536,
        preHandler: admission,
      },
      async (request, reply) => {
        try {
          // Each facade method validates its own input before selecting captured authority.
          const call = feature[method] as (input: unknown) => Promise<unknown>;
          const result = await call(request.body);
          return result === undefined ? reply.code(204).send() : result;
        } catch (error) {
          return reply
            .code(400)
            .send({ error: error instanceof Error ? error.message : 'Extension request failed.' });
        }
      }
    );
  }
}
