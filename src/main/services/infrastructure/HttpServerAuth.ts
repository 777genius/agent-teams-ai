import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

export const HTTP_AUTH_TOKEN_ENV = 'AGENT_TEAMS_HTTP_AUTH_TOKEN';
export const HTTP_AUTH_QUERY_PARAM = 'access_token';

const MIN_AUTH_TOKEN_LENGTH = 32;
const MAX_AUTH_TOKEN_LENGTH = 512;

function validConfiguredToken(value: string | undefined): string | null {
  const token = value?.trim();
  if (!token) return null;
  if (!/^\S{32,512}$/.test(token)) {
    throw new Error(
      `${HTTP_AUTH_TOKEN_ENV} must be between ${MIN_AUTH_TOKEN_LENGTH} and ${MAX_AUTH_TOKEN_LENGTH} characters`
    );
  }
  return token;
}

export function createHttpAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  return validConfiguredToken(env[HTTP_AUTH_TOKEN_ENV]) ?? randomBytes(32).toString('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function eventStreamToken(request: FastifyRequest): string | null {
  const url = new URL(request.raw.url ?? request.url, 'http://127.0.0.1');
  if (url.pathname !== '/api/events') return null;
  return url.searchParams.get(HTTP_AUTH_QUERY_PARAM);
}

function isAuthorized(request: FastifyRequest, expectedToken: string): boolean {
  const supplied = bearerToken(request) ?? eventStreamToken(request);
  return supplied !== null && constantTimeEqual(supplied, expectedToken);
}

export function registerHttpApiAuth(app: FastifyInstance, authToken: string): void {
  app.addHook('onRequest', async (request, reply) => {
    const pathname = new URL(request.raw.url ?? request.url, 'http://127.0.0.1').pathname;
    if (!pathname.startsWith('/api/') || request.method === 'OPTIONS') return;
    if (isAuthorized(request, authToken)) return;
    return reply
      .header('WWW-Authenticate', 'Bearer realm="agent-teams-local"')
      .code(401)
      .send({ error: 'Authentication required' });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const pathname = new URL(request.raw.url ?? request.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/')) {
      void reply.header('Cache-Control', 'no-store');
      void reply.header('X-Content-Type-Options', 'nosniff');
    }
    return payload;
  });
}

export function buildHttpAccessUrl(host: string, port: number, authToken: string): string {
  const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const authority = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
  const fragment = new URLSearchParams({ [HTTP_AUTH_QUERY_PARAM]: authToken });
  return `http://${authority}:${port}/#${fragment.toString()}`;
}
