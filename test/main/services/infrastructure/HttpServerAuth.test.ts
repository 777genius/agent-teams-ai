import {
  buildHttpAccessUrl,
  createHttpAuthToken,
  registerHttpApiAuth,
} from '@main/services/infrastructure/HttpServerAuth';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

const TOKEN = 'sandbox-http-auth-token-0123456789abcdef';
const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createFixture() {
  const server = Fastify({ logger: false });
  const executions = { count: 0 };
  servers.push(server);
  registerHttpApiAuth(server, TOKEN, {
    origins: ['http://localhost:5173'],
    authorities: () => ['localhost:80'],
  });
  server.get('/api/session-secret', async () => ({ session: 'private' }));
  server.post('/api/execute', async () => {
    executions.count += 1;
    return { executed: true };
  });
  server.get('/api/events', async () => ({ stream: true }));
  server.get('/', async () => 'renderer');
  await server.ready();
  return { server, executions };
}

describe('HttpServerAuth', () => {
  it('rejects unauthenticated API reads and mutations before route handlers run', async () => {
    const { server, executions } = await createFixture();

    const response = await server.inject({ method: 'GET', url: '/api/session-secret' });
    const mutation = await server.inject({ method: 'POST', url: '/api/execute' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Authentication required' });
    expect(response.headers['www-authenticate']).toContain('Bearer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mutation.statusCode).toBe(401);
    expect(executions.count).toBe(0);
  });

  it('accepts only the exact bearer token and keeps static renderer assets public', async () => {
    const { server } = await createFixture();

    const wrong = await server.inject({
      method: 'GET',
      url: '/api/session-secret',
      headers: { authorization: 'Bearer wrong-token' },
    });
    const accepted = await server.inject({
      method: 'GET',
      url: '/api/session-secret',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const renderer = await server.inject({ method: 'GET', url: '/' });

    expect(wrong.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ session: 'private' });
    expect(renderer.statusCode).toBe(200);
  });

  it('refuses query credentials for every endpoint including SSE', async () => {
    const { server } = await createFixture();

    const event = await server.inject({
      method: 'GET',
      url: `/api/events?access_token=${encodeURIComponent(TOKEN)}`,
    });
    const other = await server.inject({
      method: 'GET',
      url: `/api/session-secret?access_token=${encodeURIComponent(TOKEN)}`,
    });

    expect(event.statusCode).toBe(401);
    expect(other.statusCode).toBe(401);
  });

  it('rejects foreign authorities and null origins even with the correct key', async () => {
    const { server, executions } = await createFixture();
    for (const headers of [
      { host: 'localhost:5173', origin: 'http://localhost:5173' },
      { host: 'foreign.test', origin: 'http://localhost' },
      { host: 'localhost:80', origin: 'null' },
      { host: 'localhost:80', origin: 'http://localhost:9999' },
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/execute',
        headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(executions.count).toBe(0);
    const allowed = await server.inject({
      method: 'OPTIONS',
      url: '/api/execute',
      headers: {
        host: 'localhost:80',
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, X-Agent-Teams-App-Context',
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(executions.count).toBe(0);
  });

  it('creates high-entropy tokens and keeps credentials out of browser URLs', () => {
    const token = createHttpAuthToken({});
    const url = new URL(buildHttpAccessUrl('0.0.0.0', 3456));

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(url.hostname).toBe('localhost');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(() =>
      createHttpAuthToken({ AGENT_TEAMS_HTTP_AUTH_TOKEN: 'contains whitespace token value' })
    ).toThrow('unsupported');
  });
});
