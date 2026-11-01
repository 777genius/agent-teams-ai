// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cancelApiProfileChanges,
  configureApiProfileChanges,
  scheduleApiProfileChange,
} from '@features/local-http-auth/main';
import { HttpServer } from '@main/services/infrastructure/HttpServer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

let held: { entered(): void; wait: Promise<void> } | null = null;
let profile = 'old';
let transition: { settled: Promise<void> } | null = null;
vi.mock('@main/http', () => ({
  registerHttpRoutes(app: FastifyInstance, services: { profile: string }) {
    app.get('/api/profile', () => ({ profile: services.profile }));
    app.get('/api/held', async () => {
      held?.entered();
      await held?.wait;
      return {};
    });
    app.post('/api/change', (request) => {
      const changing = scheduleApiProfileChange(() => {
        profile = 'new';
        return { changed: true };
      }, request);
      transition = changing;
      return changing.result;
    });
  },
}));
let server: HttpServer | null = null;
let fixtureRoot: string;
beforeEach(async () => {
  fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'http-generation-TEST-')));
  const renderer = path.join(fixtureRoot, 'renderer');
  await mkdir(renderer, { mode: 0o700 });
  await writeFile(path.join(renderer, 'index.html'), '<!doctype html><p>TEST renderer</p>');
  vi.stubEnv('RENDERER_PATH', renderer);
});
afterEach(async () => {
  await server?.stop();
  server = null;
  transition = null;
  held = null;
  vi.unstubAllEnvs();
  await rm(fixtureRoot, { recursive: true, force: true });
});
async function unusedPort(preferredPort = 0): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(preferredPort, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}
const services = () => ({ profile }) as unknown as HttpServices;

it('drains the initiating HTTP response then replaces services and key at the same port', async () => {
  configureApiProfileChanges(() => undefined);
  profile = 'old';
  const port = await unusedPort();
  server = new HttpServer({ getServices: services });
  await server.start(services(), async () => undefined, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const old = server.getAuthToken();
  const headers = { Authorization: `Bearer ${old}` };
  expect(await (await fetch(`${baseUrl}/api/profile`, { headers })).json()).toEqual({
    profile: 'old',
  });
  const changing = await fetch(`${baseUrl}/api/change`, { method: 'POST', headers });
  expect(changing.ok).toBe(true);
  await changing.text();
  await transition?.settled;
  const current = server.getAuthToken();
  expect(current).toBeTruthy();
  expect(current).not.toBe(old);
  expect(server.getPort()).toBe(port);
  expect((await fetch(`${baseUrl}/api/profile`, { headers })).status).toBe(401);
  expect(
    await (
      await fetch(`${baseUrl}/api/profile`, {
        headers: { Authorization: `Bearer ${current}` },
      })
    ).json()
  ).toEqual({ profile: 'new' });
});

it('coalesces startup and rotates a stopped physical listener credential', async () => {
  profile = 'old';
  server = new HttpServer();
  const port = await unusedPort();
  expect(
    await Promise.all([
      server.start(services(), async () => undefined, port),
      server.start(services(), async () => undefined, port),
    ])
  ).toEqual([port, port]);
  const old = server.getAuthToken();
  await server.stop();
  expect(server.getAuthToken()).toBeNull();
  await server.start(services(), async () => undefined, port);
  expect(server.getAuthToken()).not.toBe(old);
});

it('does not resurrect the HTTP listener after an explicit stop interrupts a profile drain', async () => {
  configureApiProfileChanges(() => undefined);
  server = new HttpServer({ getServices: services });
  const port = await server.start(services(), async () => undefined, await unusedPort());
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  held = {
    entered,
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const pending = fetch(`http://127.0.0.1:${port}/api/held`, {
    headers: { Authorization: `Bearer ${server.getAuthToken()}` },
  });
  await ready;
  const afterResume = vi.fn(async () => {
    await server!.start(services(), async () => undefined, port);
  });
  const commit = vi.fn(() => undefined);
  const change = scheduleApiProfileChange(commit, undefined, { afterResume });
  const outcomes = Promise.allSettled([change.result, change.settled]);
  let stopping: Promise<void> | undefined;
  try {
    // A held handler keeps the real drain pending. Observe paused admission over
    // the socket before stopping; one microtask does not establish this boundary.
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/profile`, {
        headers: { Authorization: `Bearer ${server!.getAuthToken()}` },
      });
      const status = response.status;
      await response.text();
      expect(status).toBe(503);
    });
    expect(server.isRunning()).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    stopping = server.stop();
  } finally {
    release();
    await (await pending).text();
    await stopping;
    await outcomes;
  }
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  expect(afterResume).not.toHaveBeenCalled();
  expect(server.isRunning()).toBe(false);
  expect(server.getAuthToken()).toBeNull();
  held = null;
  expect(await unusedPort(port)).toBe(port); // The exact owned listener is physically closed.
});

it('cancels every coalesced startup caller when an explicit stop wins before listen', async () => {
  server = new HttpServer();
  const port = await unusedPort();
  const first = server.start(services(), async () => undefined, port);
  const second = server.start(services(), async () => undefined, port);
  const stopping = server.stop();
  const results = await Promise.allSettled([first, second]);
  await stopping;
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(server.isRunning()).toBe(false);
  expect(server.getAuthToken()).toBeNull();
});

it('does not resurrect the listener when shutdown cancels its owner before pause starts', async () => {
  configureApiProfileChanges(() => undefined);
  server = new HttpServer({ getServices: services });
  const port = await server.start(services(), async () => undefined, await unusedPort());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = vi.fn(() => undefined);
  const afterResume = vi.fn(async () => {
    await server!.start(services(), async () => undefined, port);
  });
  const change = scheduleApiProfileChange(commit, undefined, {
    beforePause: async () => {
      enter();
      await gate;
    },
    afterResume,
  });
  const outcomes = Promise.allSettled([change.result, change.settled]);
  await entered;
  // Desktop closeAdmission cancels the coordinator synchronously before its
  // later HTTP stop. This is a separate boundary from the paused-drain case.
  const cancelled = cancelApiProfileChanges();
  const stopped = server.stop();
  release();
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  await Promise.all([cancelled, stopped]);
  expect(commit).not.toHaveBeenCalled();
  expect(afterResume).not.toHaveBeenCalled();
  expect(server.isRunning()).toBe(false);
  expect(server.getAuthToken()).toBeNull();
  expect(await unusedPort(port)).toBe(port);
});
