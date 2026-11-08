import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

export const HTTP_AUTH_TOKEN_ENV = 'AGENT_TEAMS_HTTP_AUTH_TOKEN';

export function createHttpAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env[HTTP_AUTH_TOKEN_ENV]?.trim()) {
    throw new Error(
      `${HTTP_AUTH_TOKEN_ENV} is unsupported; read the generated key from the private authority file`
    );
  }
  return randomBytes(32).toString('hex');
}

export function exactHttpOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((item) => {
    const origin = item.trim();
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('CORS_ORIGIN requires exact HTTP origins');
    }
    return origin;
  });
}

/** Runs before CORS, body parsing, handlers and SSE. Credentials are accepted only in headers. */
export function registerHttpApiAuth(
  app: FastifyInstance,
  authToken: string | (() => string | null),
  options: { origins?: readonly string[]; authorities?: () => readonly string[] } = {}
): void {
  const origins = options.origins ?? [];
  app.addHook('onRequest', async (request, reply) => {
    const authorities = options.authorities?.() ?? ['127.0.0.1:3456'];
    const origin = request.headers.origin;
    if (
      !authorities.includes(request.headers.host ?? '') ||
      (origin !== undefined &&
        !origins.includes(origin) &&
        !authorities.some((authority) => origin === `http://${authority}`))
    ) {
      return reply.code(403).send({ error: 'Request authority is not allowed' });
    }
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const headers = request.headers['access-control-request-headers'];
      if (
        !origin ||
        !method ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
        (headers &&
          headers
            .split(',')
            .some(
              (header) =>
                !['authorization', 'content-type', 'accept', 'x-agent-teams-app-context'].includes(
                  header.trim().toLowerCase()
                )
            ))
      ) {
        return reply.code(403).send({ error: 'Invalid preflight' });
      }
      return reply
        .header('Access-Control-Allow-Origin', origin)
        .header('Vary', 'Origin')
        .header('Access-Control-Allow-Methods', method)
        .header(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, Accept, X-Agent-Teams-App-Context'
        )
        .code(204)
        .send();
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.raw.url ?? request.url, 'http://localhost').pathname
      );
    } catch {
      return reply.code(400).send({ error: 'Invalid request URL' });
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return;
    const token = typeof authToken === 'function' ? authToken() : authToken;
    const supplied = request.headers.authorization ?? '';
    const expected = token ? `Bearer ${token}` : '';
    if (
      !token ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      // This hook rejects before the CORS plugin can expose the response to a trusted browser.
      if (origin) {
        void reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      }
      return reply
        .header('WWW-Authenticate', 'Bearer realm="agent-teams-local"')
        .code(401)
        .send({ error: 'Authentication required' });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      void reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    }
    return payload;
  });
}

export function buildHttpAccessUrl(host: string, port: number): string {
  const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${port}`;
}
