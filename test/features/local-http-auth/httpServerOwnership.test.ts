// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { checkApiReadiness } from '@features/local-http-auth/main';
import { HttpServer } from '@main/services/infrastructure/HttpServer';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  participant: null as null | { pause(): Promise<unknown>; closeAdmission?(): void },
  info: vi.fn(),
}));
vi.mock('@features/local-http-auth/main', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/local-http-auth/main')>()),
  registerProfileParticipant: (participant: {
    pause(): Promise<unknown>;
    closeAdmission?(): void;
  }) => {
    state.participant = participant;
    return () => {
      if (state.participant === participant) state.participant = null;
    };
  },
}));
vi.mock('@main/http', () => ({
  registerHttpRoutes: (app: FastifyInstance) => {
    app.get('/api/fixture', () => ({ testOnly: true }));
  },
}));
vi.mock('@main/http/events', () => ({ broadcastEvent: vi.fn(), closeEventStreams: vi.fn() }));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ info: state.info, warn: vi.fn() }),
}));

let root: string;
let server: HttpServer;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'http-server-owner-TEST-')));
  const renderer = path.join(root, 'renderer');
  await mkdir(renderer, { mode: 0o700 });
  await writeFile(path.join(renderer, 'index.html'), '<!doctype html><p>TEST only</p>');
  vi.stubEnv('RENDERER_PATH', renderer);
  vi.stubEnv('AGENT_TEAMS_HTTP_AUTH_TOKEN', '');
  vi.stubEnv('AGENT_TEAMS_HTTP_PUBLIC_ORIGIN', '');
  vi.stubEnv('CORS_ORIGIN', '');
  state.info.mockClear();
  server = new HttpServer();
});
afterEach(async () => {
  await server.stop();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function assertOwnedPortClosed(port: number) {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    if (probe.listening)
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve()))
      );
  }
}

async function shutdownIngress(owner: HttpServer) {
  const source = ts.createSourceFile(
    'index.ts',
    await readFile(path.resolve('src/main/index.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const callbacks: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'runShutdownBackupAfterWorkSyncDrain'
    ) {
      const options = node.arguments[0];
      if (ts.isObjectLiteralExpression(options))
        for (const property of options.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === 'closeIngress')
            callbacks.push(property.initializer);
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (callbacks.length !== 1) throw new Error('Expected one shutdown ingress owner');
  const code = ts.transpileModule(`const closeIngress = ${callbacks[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const removeIpc = vi.fn();
  const close = runInNewContext(`${code}\ncloseIngress`, {
    httpServer: owner,
    removeMemberWorkSyncIpc: removeIpc,
    ipcMain: {},
  }) as () => Promise<void> | undefined;
  await close();
  expect(removeIpc).toHaveBeenCalledOnce();
}

it('returns and logs the real ephemeral listener port for authenticated readiness', async () => {
  const port = await server.start({} as HttpServices, async () => undefined, 0);
  expect(port).toBe(server.getPort());
  expect(port).toBeGreaterThan(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  await checkApiReadiness(baseUrl, server.getAuthToken()!);
  expect((await fetch(`${baseUrl}/api/auth/ready`)).status).toBe(401);
  expect(state.info).toHaveBeenCalledWith(`HTTP server started on ${baseUrl}`);
});

it('physically stops a paused ingress through the actual app shutdown callback', async () => {
  await server.start({} as HttpServices, async () => undefined, 0);
  const port = server.getPort();
  await checkApiReadiness(`http://127.0.0.1:${port}`, server.getAuthToken()!);
  expect(state.participant).not.toBeNull();
  await state.participant!.pause();
  expect(server.isRunning()).toBe(false);
  await shutdownIngress(server);
  await assertOwnedPortClosed(port);
  expect(server.getAuthToken()).toBeNull();
  expect(state.participant).toBeNull();
  await shutdownIngress(server); // The owner stop remains idempotent.
});

it('seals the latest resumed listener synchronously without another restart or credential rotation', async () => {
  await server.start({} as HttpServices, async () => undefined, 0);
  const previous = state.participant!;
  const resume = (await previous.pause()) as () => Promise<void>;
  await resume();
  const current = state.participant!;
  expect(current).not.toBe(previous);
  const port = server.getPort();
  const token = server.getAuthToken()!;
  await checkApiReadiness(`http://127.0.0.1:${port}`, token);
  previous.closeAdmission?.();
  expect(server.isRunning()).toBe(true); // A retired registration cannot seal the new drain.
  current.closeAdmission?.();
  const synchronouslyClosed = !server.isRunning();
  expect(server.getPort()).toBe(port);
  expect(server.getAuthToken()).toBe(token);
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/ready`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(503);
  expect(synchronouslyClosed).toBe(true);
  await response.text();
  expect(
    state.info.mock.calls.filter(([message]) =>
      String(message).startsWith('HTTP server started on ')
    )
  ).toHaveLength(2);
});
