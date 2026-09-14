import { EventEmitter } from 'node:events';

import {
  broadcastEvent,
  type HostedWorkspaceEventBridge,
  registerEventRoutes,
  registerHostedWorkspaceEventBridge,
  runWithEventStreamsDrained,
} from '@main/http/events';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

const apps: FastifyInstance[] = [];
const bridges: HostedWorkspaceEventBridge[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('hosted SSE continuing authorization', () => {
  it('admits only active registered workspace events and removes host paths', async () => {
    const fileEvents = new EventEmitter();
    const notificationEvents = new EventEmitter();
    const broadcasts: { channel: string; data: Record<string, unknown> }[] = [];
    const bridge = registerHostedWorkspaceEventBridge({
      fileEvents,
      notificationEvents,
      isWorkspaceRegistered: (runtimeWorkspaceId) => {
        if (runtimeWorkspaceId === 'runtime-first') return Promise.resolve(true);
        if (runtimeWorkspaceId === 'storage-failure') {
          return Promise.reject(new Error('synthetic_workspace_storage_unavailable'));
        }
        return Promise.resolve(false);
      },
      broadcast: (channel, data) => {
        broadcasts.push({ channel, data: data as Record<string, unknown> });
      },
    });
    bridges.push(bridge);

    fileEvents.emit('file-change', {
      projectId: 'runtime-unregistered',
      sessionId: 'session-denied',
      path: '/srv/private/denied.jsonl',
    });
    fileEvents.emit('file-change', {
      projectId: 'storage-failure',
      sessionId: 'session-failure',
      path: '/srv/private/failure.jsonl',
    });
    notificationEvents.emit('notification-new', {
      category: 'team',
      projectId: 'runtime-first',
      sessionId: 'session-team',
      filePath: '/srv/private/team.jsonl',
    });
    notificationEvents.emit('notification-new', {
      category: 'error',
      projectId: 'runtime-first',
      sessionId: 'session-first',
      filePath: '/srv/private/session-first.jsonl',
      context: { projectName: 'First', cwd: '/srv/private/first' },
    });
    await bridge.drain();

    expect(broadcasts).toEqual([
      {
        channel: 'notification:new',
        data: {
          category: 'error',
          projectId: 'runtime-first',
          sessionId: 'session-first',
          context: { projectName: 'First' },
        },
      },
    ]);
  });

  it('attributes todo events through one registered session and denies ambiguity', async () => {
    const fileEvents = new EventEmitter();
    const notificationEvents = new EventEmitter();
    const broadcasts: { channel: string; data: Record<string, unknown> }[] = [];
    const registered = new Set(['runtime-first', 'runtime-second']);
    const bridge = registerHostedWorkspaceEventBridge({
      fileEvents,
      notificationEvents,
      isWorkspaceRegistered: (runtimeWorkspaceId) =>
        Promise.resolve(registered.has(runtimeWorkspaceId)),
      broadcast: (channel, data) => {
        broadcasts.push({ channel, data: data as Record<string, unknown> });
      },
    });
    bridges.push(bridge);

    fileEvents.emit('file-change', {
      projectId: 'runtime-first',
      sessionId: 'session-shared',
      path: '/srv/private/first.jsonl',
    });
    fileEvents.emit('todo-change', {
      sessionId: 'session-shared',
      path: '/srv/private/session-shared.json',
      type: 'change',
    });
    await bridge.drain();
    registered.delete('runtime-first');
    fileEvents.emit('todo-change', {
      sessionId: 'session-shared',
      path: '/srv/private/session-shared.json',
      type: 'change',
    });
    await bridge.drain();
    registered.add('runtime-first');
    fileEvents.emit('file-change', {
      projectId: 'runtime-second',
      sessionId: 'session-shared',
      path: '/srv/private/second.jsonl',
    });
    fileEvents.emit('todo-change', {
      sessionId: 'session-shared',
      path: '/srv/private/session-shared.json',
      type: 'change',
    });
    await bridge.drain();
    registered.delete('runtime-first');
    fileEvents.emit('todo-change', {
      sessionId: 'session-shared',
      path: '/srv/private/session-shared.json',
      type: 'change',
    });
    await bridge.drain();

    expect(broadcasts).toEqual([
      {
        channel: 'file-change',
        data: {
          projectId: 'runtime-first',
          sessionId: 'session-shared',
        },
      },
      {
        channel: 'todo-change',
        data: {
          projectId: 'runtime-first',
          sessionId: 'session-shared',
          type: 'change',
        },
      },
      {
        channel: 'file-change',
        data: {
          projectId: 'runtime-second',
          sessionId: 'session-shared',
        },
      },
      {
        channel: 'todo-change',
        data: {
          projectId: 'runtime-second',
          sessionId: 'session-shared',
          type: 'change',
        },
      },
    ]);
  });

  it('expires todo session attribution instead of guessing after a quiet restart window', async () => {
    const fileEvents = new EventEmitter();
    const notificationEvents = new EventEmitter();
    const broadcasts: string[] = [];
    let nowMs = 1_000;
    const bridge = registerHostedWorkspaceEventBridge({
      fileEvents,
      notificationEvents,
      isWorkspaceRegistered: () => Promise.resolve(true),
      broadcast: (channel) => {
        broadcasts.push(channel);
      },
      nowMs: () => nowMs,
    });
    bridges.push(bridge);

    fileEvents.emit('file-change', {
      projectId: 'runtime-first',
      sessionId: 'session-first',
    });
    await bridge.drain();
    nowMs += 60 * 60 * 1_000;
    fileEvents.emit('todo-change', {
      sessionId: 'session-first',
      path: '/srv/private/session-first.json',
    });
    await bridge.drain();

    expect(broadcasts).toEqual(['file-change']);
  });

  it('closes a connected stream before delivering after its session is revoked', async () => {
    const app = Fastify();
    apps.push(app);
    const authorize = vi.fn(() => Promise.resolve(false));
    registerEventRoutes(app, { authorize, project: () => Promise.resolve(null) });

    const responsePromise = app.inject({ method: 'GET', url: '/api/events' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    broadcastEvent('synthetic', { privateValue: 'must-not-deliver' });
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    expect(response.body).not.toContain('must-not-deliver');
  });

  it('expires an idle stream when fake-clock keepalives only revalidate it', async () => {
    vi.useFakeTimers();
    const app = Fastify();
    apps.push(app);
    let now = 1_000;
    const idleExpiresAt = now + 30_000;
    const authorize = vi.fn(() => Promise.resolve(now < idleExpiresAt));
    registerEventRoutes(app, { authorize, project: () => Promise.resolve(null) });

    const responsePromise = app.inject({ method: 'GET', url: '/api/events' });
    await vi.advanceTimersByTimeAsync(0);
    now = idleExpiresAt;
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    expect(response.body).not.toContain(':ping');
  });

  it('blocks new streams throughout a personal reset drain window', async () => {
    const app = Fastify();
    apps.push(app);
    registerEventRoutes(app);
    let release!: () => void;
    const operation = runWithEventStreamsDrained(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const response = await app.inject({ method: 'GET', url: '/api/events' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'event_stream_draining' });
    release();
    await operation;
  });

  it('projects an event only to the principal granted its workspace and honors revoke', async () => {
    const app = Fastify();
    apps.push(app);
    const fileEvents = new EventEmitter();
    const notificationEvents = new EventEmitter();
    const grants = new Map([
      ['session-first', new Set(['runtime-first'])],
      ['session-second', new Set(['runtime-second'])],
    ]);
    registerEventRoutes(app, {
      authorize: () => Promise.resolve(true),
      project: (request, _channel, data) => {
        const cookie = request.headers.cookie ?? '';
        const session = cookie.split('=', 2)[1] ?? '';
        const row = data as { projectId: string };
        if (!grants.get(session)?.has(row.projectId)) return Promise.resolve(null);
        return Promise.resolve({
          workspaceId:
            row.projectId === 'runtime-first'
              ? 'workspace_11111111111111111111111111111111'
              : 'workspace_22222222222222222222222222222222',
        });
      },
    });
    const bridge = registerHostedWorkspaceEventBridge({
      fileEvents,
      notificationEvents,
      isWorkspaceRegistered: () => Promise.resolve(true),
      broadcast: broadcastEvent,
    });
    bridges.push(bridge);

    const firstResponse = app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { cookie: 'session=session-first' },
    });
    const secondResponse = app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { cookie: 'session=session-second' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    fileEvents.emit('file-change', {
      projectId: 'runtime-first',
      sessionId: 'session-runtime-first',
      path: '/srv/private/runtime-first',
    });
    await bridge.drain();
    grants.get('session-first')!.delete('runtime-first');
    notificationEvents.emit('notification-new', {
      category: 'error',
      projectId: 'runtime-first',
      sessionId: 'session-runtime-first',
      filePath: '/srv/private/after-revoke',
    });
    await bridge.drain();
    await runWithEventStreamsDrained(() => Promise.resolve());

    const [first, second] = await Promise.all([firstResponse, secondResponse]);
    expect(first.body).toContain('workspace_11111111111111111111111111111111');
    expect(first.body).not.toContain('runtime-first');
    expect(first.body).not.toContain('/srv/private');
    expect(first.body.match(/event: file-change/gu)).toHaveLength(1);
    expect(first.body).not.toContain('notification:new');
    expect(second.body).not.toContain('file-change');
    expect(second.body).not.toContain('runtime-first');
  });
});
