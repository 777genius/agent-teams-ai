import { BOUND_CONTROL_CONTEXT_HEADER } from '../contracts';

import { AppContextMismatchError, type BoundControlContext } from './BoundControlContext';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Wrap the operation itself so an aborted socket cannot release its root fence early. */
export function registerBoundControlHttp(app: FastifyInstance, context: BoundControlContext): void {
  const isLoopback = (url: URL): boolean =>
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    try {
      const host = request.headers.host;
      if (!host || !address || typeof address === 'string')
        throw new Error('Missing listener authority');
      const authority = new URL(`http://${host}`);
      if (
        !isLoopback(authority) ||
        authority.pathname !== '/' ||
        authority.search ||
        authority.hash ||
        Number(authority.port || '80') !== address.port
      )
        throw new Error('Foreign Host');
      const rawOrigin = request.headers.origin;
      if (rawOrigin !== undefined) {
        if (typeof rawOrigin !== 'string') throw new Error('Invalid Origin');
        const origin = new URL(rawOrigin);
        if (
          !['http:', 'https:'].includes(origin.protocol) ||
          !isLoopback(origin) ||
          origin.pathname !== '/' ||
          origin.search ||
          origin.hash
        )
          throw new Error('Foreign Origin');
      }
    } catch {
      return reply
        .code(403)
        .send({ error: 'Desktop control requires a loopback Host and Origin.' });
    }
  });
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const original = route.handler;
    route.handler = async function (request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers[BOUND_CONTROL_CONTEXT_HEADER];
      if (header === undefined) return original.call(this, request, reply);
      if (typeof header !== 'string' || header.length > 1024) throw new AppContextMismatchError();
      let expected: unknown;
      try {
        expected = JSON.parse(header);
      } catch {
        throw new AppContextMismatchError();
      }
      if (
        ['/api/app/connection/retry', '/api/ssh/connect', '/api/ssh/disconnect'].includes(route.url)
      ) {
        throw new AppContextMismatchError();
      }
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : null;
      // Root switching drains bound operations; a bound request cannot drain itself.
      if (
        route.url === '/api/config/update' &&
        body?.section === 'general' &&
        body.data &&
        typeof body.data === 'object' &&
        'claudeRootPath' in body.data
      ) {
        throw new AppContextMismatchError();
      }
      const release = context.admit(expected);
      try {
        if (
          request.method === 'POST' &&
          ((route.url === '/api/teams' && body?.runtimeSelectionVersion === 1) ||
            route.url === '/api/teams/:teamName/update' ||
            route.url === '/api/teams/:teamName/trash')
        ) {
          context.assertExpected(body?.expectedContext);
        }
        return await original.call(this, request, reply);
      } finally {
        release();
      }
    };
  });
}
