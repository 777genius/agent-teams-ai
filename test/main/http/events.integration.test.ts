// @vitest-environment node
import { once } from 'node:events';
import { get } from 'node:http';

import cors from '@fastify/cors';
import { broadcastEvent, closeEventStreams, registerEventRoutes } from '@main/http/events';
import { registerHttpApiAuth } from '@main/services/infrastructure/HttpServerAuth';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';
import type { ClientRequest, IncomingMessage } from 'node:http';

const origin = 'https://browser.fixture.test';
const key = 'synthetic-sse-fixture-key';
const apps: FastifyInstance[] = [];
const requests: ClientRequest[] = [];

afterEach(async () => {
  for (const request of requests.splice(0)) request.destroy();
  for (const app of apps.splice(0)) {
    closeEventStreams(app);
    await app.close();
  }
});

async function fixture(): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ logger: false });
  apps.push(app);
  let authority = '';
  registerHttpApiAuth(app, key, {
    origins: [origin],
    authorities: () => [authority],
  });
  await app.register(cors, { origin: [origin], credentials: false });
  registerEventRoutes(app);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  authority = new URL(url).host;
  return { app, url };
}

function connect(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  // Receipt of the HTTP response proves headers arrived before any event/30s ping.
  return new Promise((resolve, reject) => {
    const request = get(`${url}/api/events`, { headers }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    requests.push(request);
    const timer = setTimeout(
      () => request.destroy(new Error('SSE headers were not flushed')),
      1000
    );
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const authorizedHeaders = () => ({
  Origin: origin,
  Authorization: `Bearer ${key}`,
});

it('flushes trusted browser CORS and privacy headers before the first event', async () => {
  const { url } = await fixture();
  const response = await connect(url, authorizedHeaders());
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/event-stream');
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers.vary?.split(/,\s*/)).toContain('Origin');
  expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.readableLength).toBe(0);
  const next = once(response, 'data');
  broadcastEvent('fixture', { changed: true });
  const [chunk] = await next;
  expect(String(chunk)).toBe('event: fixture\ndata: {"changed":true}\n\n');
});

it.each([
  ['missing credential', { Origin: origin }, 401],
  ['wrong credential', { Origin: origin, Authorization: 'Bearer wrong-fixture-key' }, 401],
  [
    'foreign origin',
    { Origin: 'https://foreign.fixture.test', Authorization: `Bearer ${key}` },
    403,
  ],
  ['foreign authority', { ...authorizedHeaders(), Host: 'foreign.fixture.test' }, 403],
] as const)('refuses %s before opening a stream', async (_case, headers, status) => {
  const { url } = await fixture();
  const response = await connect(url, headers);
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  if (status === 401) {
    expect(response.headers['www-authenticate']).toBe('Bearer realm="agent-teams-local"');
    expect(response.headers['access-control-allow-origin']).toBe(origin);
  } else {
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  }
  response.resume();
  await once(response, 'end');
});

it('retires only the owning listener streams while another app keeps broadcasting', async () => {
  const first = await fixture();
  const second = await fixture();
  const a = await connect(first.url, authorizedHeaders());
  const b = await connect(second.url, authorizedHeaders());
  a.resume();
  const ended = once(a, 'end');
  closeEventStreams(first.app);
  await ended;
  expect(b.readableEnded).toBe(false);
  const next = once(b, 'data');
  broadcastEvent('still-live', 1);
  expect(String((await next)[0])).toBe('event: still-live\ndata: 1\n\n');
  await first.app.close();
});
