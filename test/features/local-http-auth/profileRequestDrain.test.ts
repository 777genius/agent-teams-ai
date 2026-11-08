/* eslint-disable @typescript-eslint/require-await -- synthetic async services preserve their promise contracts */
// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { ProfileRequestDrain } from '@features/local-http-auth/main';
import { registerHttpApiAuth } from '@main/services/infrastructure/HttpServerAuth';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';

const apps: FastifyInstance[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
async function fixture(register: (app: FastifyInstance, drain: ProfileRequestDrain) => void) {
  const app = Fastify();
  apps.push(app);
  const authority = {
    schemaVersion: 1 as const,
    service: 'api' as const,
    profileScope: 'synthetic',
    instanceId: randomUUID(),
    generation: randomUUID(),
    token: randomBytes(32).toString('hex'),
    baseUrl: 'http://127.0.0.1',
  };
  registerHttpApiAuth(app, authority.token, {
    authorities: () => [new URL(authority.baseUrl).host],
  });
  const drain = new ProfileRequestDrain(app);
  register(app, drain);
  authority.baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    drain,
    url: authority.baseUrl,
    headers: { authorization: `Bearer ${authority.token}` },
  };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('keeps an authenticated async handler in the drain after real socket abort so effects stay on the old profile', async () => {
  const entered = deferred(),
    release = deferred(),
    closed = deferred(),
    finished = deferred();
  let profile = 'old';
  const effects: string[] = [];
  const { drain, url, headers } = await fixture((app) => {
    app.get('/api/held', async (_request, reply) => {
      reply.raw.once('close', closed.resolve);
      entered.resolve();
      await release.promise;
      effects.push(profile);
      finished.resolve();
      return { ok: true };
    });
  });
  const req = httpRequest(url + '/api/held', { headers });
  req.on('error', () => {
    /* synthetic no-op callback */
  });
  req.end();
  await entered.promise;
  req.destroy();
  await closed.promise;
  drain.paused = true;
  let switched = false;
  const switching = drain.wait().then(() => {
    switched = true;
    profile = 'new';
  });
  try {
    await turn();
    expect(switched).toBe(false);
  } finally {
    release.resolve();
    await finished.promise;
    await switching;
  }
  expect(effects).toEqual(['old']);
  await drain.wait();
});

it.each(['normal', 'error', 'early-send'] as const)(
  'waits for %s handler completion and preserves Fastify child context, returns/errors and cleanup',
  async (mode) => {
    const entered = deferred(),
      release = deferred(),
      responseClosed = deferred();
    const contexts: string[] = [];
    const { drain, url, headers } = await fixture((app) => {
      app.register(async (child) => {
        child.decorate('fixtureName', 'child-context');
        child.get('/api/held', async function (_request, reply) {
          contexts.push((this as FastifyInstance & { fixtureName: string }).fixtureName);
          reply.raw.once('close', responseClosed.resolve);
          if (mode === 'early-send') reply.send({ early: true });
          entered.resolve();
          await release.promise;
          if (mode === 'error') throw new Error('fixture handler error');
          if (mode === 'normal') return { normal: true };
        });
      });
    });
    const response = fetch(url + '/api/held', { headers });
    await entered.promise;
    if (mode === 'early-send') await responseClosed.promise;
    drain.paused = true;
    let resolved = false;
    const waiting = drain.wait().then(() => {
      resolved = true;
    });
    try {
      await turn();
      expect(resolved).toBe(false);
    } finally {
      release.resolve();
      await waiting;
    }
    const result = await response;
    expect(result.status).toBe(mode === 'error' ? 500 : 200);
    const successfulResult = mode === 'early-send' ? { early: true } : { normal: true };
    expect(await result.json()).toMatchObject(
      mode === 'error' ? { message: 'fixture handler error' } : successfulResult
    );
    expect(contexts).toEqual(['child-context']);
    await Promise.all([drain.wait(), drain.wait()]);
  }
);

it('cleans an aborted pending request body that never entered a handler', async () => {
  const admitted = deferred(),
    aborted = deferred();
  let calls = 0;
  const { drain, url, headers } = await fixture((app) => {
    app.addHook('onRequest', async (request) => {
      if (request.url === '/api/body') admitted.resolve();
    });
    app.addHook('onRequestAbort', async (_request) => {
      expect(_request.url).toBe('/api/body');
      aborted.resolve();
    });
    app.post('/api/body', async () => {
      calls++;
      return {};
    });
  });
  const req = httpRequest(url + '/api/body', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'content-length': '1000' },
  });
  req.on('error', () => {
    /* synthetic no-op callback */
  });
  req.write('{');
  await admitted.promise;
  req.destroy();
  await aborted.promise;
  drain.paused = true;
  await drain.wait();
  expect(calls).toBe(0);
});

it('excludes only the actual changing handler and releases all waiters after its real response', async () => {
  const entered = deferred(),
    release = deferred(),
    changing = deferred();
  let profile = 'old';
  const effects: string[] = [];
  const { drain, url, headers } = await fixture((app, currentDrain) => {
    app.get('/api/held', async () => {
      entered.resolve();
      await release.promise;
      effects.push(profile);
      return {};
    });
    app.post('/api/change', async (request) => {
      currentDrain.paused = true;
      changing.resolve();
      await currentDrain.wait(request);
      profile = 'new';
      return { changed: true };
    });
  });
  const old = fetch(url + '/api/held', { headers });
  await entered.promise;
  const update = fetch(url + '/api/change', { method: 'POST', headers });
  await changing.promise;
  try {
    await turn();
    expect(profile).toBe('old');
  } finally {
    release.resolve();
  }
  expect((await update).status).toBe(200);
  await (await old).json();
  expect(effects).toEqual(['old']);
  expect(profile).toBe('new');
  await Promise.all([drain.wait(), drain.wait()]);
});
