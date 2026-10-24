// @vitest-environment node
import { get } from 'node:http';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_CONNECTIONS_ROUTE,
  AGENT_BACKEND_OPERATIONS_ROUTE,
  AGENT_BACKEND_REVIEW_EVENTS_ROUTE,
  AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
  AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
  AGENT_BACKEND_REVIEW_WATCH_ROUTE,
} from '../../../src/features/agent-backend/contracts';
import {
  BackendOperationsFacade,
  DesktopBackendFeature,
} from '../../../src/features/agent-backend/main';
import { createAgentBackendHttpClient } from '../../../src/features/agent-backend/renderer';
import { registerHttpRoutes } from '../../../src/main/http';
import {
  captureDesktopAgentBackendHttpScope,
  registerDesktopAgentBackend,
  removeDesktopAgentBackendHandlers,
} from '../../../src/main/ipc/agentBackend';
import { EditorFileWatcher } from '../../../src/main/services/editor/EditorFileWatcher';
import { ServiceContextRegistry } from '../../../src/main/services/infrastructure/ServiceContextRegistry';

import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main';
import type { HttpServices } from '../../../src/main/http';
import type { HttpAgentBackendScope } from '../../../src/main/http/agentBackend';
import type { ServiceContext } from '../../../src/main/services/infrastructure/ServiceContext';
import type { EditorFileChangeEvent } from '../../../src/shared/types/editor';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

vi.mock('../../../src/main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: class {
    static getInstance() {
      return {};
    }
  },
  configManager: {},
}));
afterEach(() => {
  removeDesktopAgentBackendHandlers();
  vi.restoreAllMocks();
});

function setup(originalScope?: HttpAgentBackendScope) {
  const app = Fastify();
  let slowStream = false;
  const slowWrites = vi.fn(() => false);
  app.addHook('onRequest', (request, reply, done) => {
    if (slowStream && request.url === AGENT_BACKEND_REVIEW_EVENTS_ROUTE)
      vi.spyOn(reply.raw, 'write').mockImplementation(slowWrites);
    done();
  });
  let current = true;
  const handle = { handleId: 'TEST-original-handle' };
  const calls = vi.fn<BackendOwnerRouter['request']>(
    async (_handle, request): Promise<JsonValue> => {
      if (request.method === 'team.tasks.list')
        return {
          ok: true,
          value: [{ id: 'TEST-task', status: 'pending', subject: 'TEST retained' }],
        };
      if (request.method === 'team.review.authorizeWatch')
        return {
          ok: true,
          value: {
            kind: 'review-watch-authorization',
            projectPath: '/TEST-project',
            filePaths: ['/TEST-project/file.txt'],
          },
        };
      return {
        ok: true,
        value: {
          commandId: request.commandId,
          phase: 'completed',
          command: { operation: 'task.create' },
          result: { id: 'TEST-created', status: 'pending', subject: 'TEST create' },
        },
      };
    }
  );
  const facade = new BackendOperationsFacade({ request: calls, lookup: vi.fn() });
  const feature =
    originalScope?.feature ??
    new DesktopBackendFeature({
      descriptor: null,
      bindingDirectory: '/TEST/http-bootstrap-no-writes',
    });
  const initialize = vi.spyOn(feature, 'initialize').mockResolvedValue();
  vi.spyOn(feature.facade, 'invoke').mockImplementation(facade.invoke.bind(facade));
  const discover = vi.spyOn(feature, 'discoverBindings').mockResolvedValue({
    state: 'ready',
    bindings: [{ handle, label: 'TEST original', members: [] }],
  });
  vi.spyOn(feature, 'authorizeHandle').mockImplementation(
    (context, selection) =>
      context === (originalScope?.contextId ?? 'TEST-origin-context') &&
      selection.handleId === handle.handleId
  );
  const services: HttpServices = {
    agentBackend: {
      feature,
      contextId: originalScope?.contextId ?? 'TEST-origin-context',
      isCurrent: () => current && (originalScope?.isCurrent() ?? true),
    },
    projectScanner: {} as never,
    sessionParser: {} as never,
    subagentResolver: {} as never,
    chunkBuilder: {} as never,
    dataCache: {} as never,
    updaterService: {} as never,
    sshConnectionManager: {} as never,
  };
  registerHttpRoutes(app, services, async () => {});
  const client = createAgentBackendHttpClient(
    async (route, payload) => (await app.inject({ method: 'POST', url: route, payload })).json(),
    async (route) => (await app.inject({ method: 'GET', url: route })).json()
  );
  return {
    app,
    slowWrites,
    setSlowStream(value: boolean) {
      slowStream = value;
    },
    handle,
    client,
    calls,
    initialize,
    discover,
    revoke() {
      current = false;
    },
  };
}

describe('production HTTP agent-backend bootstrap', () => {
  it('actual route orchestrator exposes connections and original commands through the same finite facade', async () => {
    const f = setup();
    try {
      expect(await f.client.getConnections()).toMatchObject({
        state: 'ready',
        bindings: [{ handle: f.handle }],
      });
      expect(
        await f.client.invoke({
          handle: f.handle,
          commandId: 'TEST-original-read',
          operation: 'tasks.list',
          payload: {},
        })
      ).toEqual({
        ok: true,
        value: [{ id: 'TEST-task', status: 'pending', subject: 'TEST retained' }],
      });
      const command = {
        handle: f.handle,
        commandId: 'TEST-original-command',
        operation: 'task.create' as const,
        payload: { subject: 'TEST create' },
      };
      expect(await f.client.invoke(command)).toMatchObject({
        ok: true,
        value: { commandId: command.commandId, phase: 'completed', task: { id: 'TEST-created' } },
      });
      expect(f.calls).toHaveBeenCalledWith(
        f.handle,
        expect.objectContaining({
          commandId: command.commandId,
          method: 'team.execute',
          payload: { operation: 'task.create', payload: command.payload },
          guard: expect.objectContaining({ isCurrent: expect.any(Function) }),
        })
      );
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: `${AGENT_BACKEND_CONNECTIONS_ROUTE}?contextId=foreign`,
          })
        ).json()
      ).toEqual({ state: 'hold', bindings: [] });
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: AGENT_BACKEND_OPERATIONS_ROUTE,
            payload: { ...command, handle: { handleId: 'foreign' } },
          })
        ).json()
      ).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
      expect(f.calls).toHaveBeenCalledTimes(2);
    } finally {
      await f.app.close();
    }
  });

  it('a captured context revoked during initialization cannot dispatch or silently switch to a new owner', async () => {
    const f = setup();
    let release!: () => void;
    f.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    try {
      const pending = f.client.invoke({
        handle: f.handle,
        commandId: 'TEST-original-read',
        operation: 'tasks.list',
        payload: {},
      });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      f.revoke();
      release();
      expect(await pending).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
      expect(await f.client.getConnections()).toEqual({ state: 'hold', bindings: [] });
      expect(f.calls).not.toHaveBeenCalled();
      expect(f.discover).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it.each(['switch-away-and-back', 'same-id-replacement'] as const)(
    'original HTTP authority cannot revive after %s',
    async (change) => {
      const registry = new ServiceContextRegistry();
      const context = (id: string) =>
        ({
          id,
          type: id === 'local' ? 'local' : 'ssh',
          startFileWatcher: vi.fn(),
          stopFileWatcher: vi.fn(),
          retireDetailReads: vi.fn(),
          dispose: vi.fn(),
        }) as unknown as ServiceContext;
      registry.registerContext(context('local'));
      registry.registerContext(context('ssh:TEST'));
      registerDesktopAgentBackend({
        ipc: { handle() {}, removeHandler() {} },
        getMainWindow: () => null,
        getActiveContextId: () => registry.getActiveContextId(),
        captureActiveSelection: () => registry.captureActiveSelection(),
        rendererIndexPath: '/TEST/renderer',
        userDataPath: '/TEST/epoch-no-writes',
        env: {},
      });
      const scope = captureDesktopAgentBackendHttpScope()!;
      const f = setup(scope);
      let release!: () => void;
      f.initialize.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      try {
        const pending = f.client.invoke({
          handle: f.handle,
          commandId: 'TEST-captured-before-transition',
          operation: 'tasks.list',
          payload: {},
        });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        if (change === 'same-id-replacement') registry.replaceContext('local', context('local'));
        else {
          registry.switch('ssh:TEST');
          registry.switch('local');
        }
        release();
        expect(await pending).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
        expect(scope.isCurrent()).toBe(false);
        expect(f.calls).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
        registry.dispose();
      }
    }
  );

  it('closes a backpressured stream and closes a live replacement feed when the server stops', async () => {
    const f = setup();
    f.setSlowStream(true);
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const connect = () =>
      new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const request = get(`${address}${AGENT_BACKEND_REVIEW_EVENTS_ROUTE}`, resolve);
        request.once('error', reject);
      });
    try {
      await expect(connect()).rejects.toMatchObject({ code: 'ECONNRESET' });
      expect(f.slowWrites).toHaveBeenCalledOnce();
      f.setSlowStream(false);
      const response = await connect();
      response.resume();
      expect(response.statusCode).toBe(200);
      const closed = new Promise<void>((resolve) => response.once('close', () => resolve()));
      await f.app.close();
      await closed;
    } finally {
      await f.app.close();
    }
  });

  it('production watch POST emits only on its captured server feed and exact cleanup survives revocation', async () => {
    let callback: ((event: EditorFileChangeEvent) => void) | undefined;
    vi.spyOn(EditorFileWatcher.prototype, 'start').mockImplementation((_root, onChange) => {
      callback = onChange;
    });
    vi.spyOn(EditorFileWatcher.prototype, 'setWatchedFiles').mockImplementation(() => {});
    const stop = vi.spyOn(EditorFileWatcher.prototype, 'stop').mockImplementation(() => {});
    const f = setup();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = get(`${address}${AGENT_BACKEND_REVIEW_EVENTS_ROUTE}`, resolve);
      request.once('error', reject);
    });
    response.setEncoding('utf8');
    let message = '';
    response.on('data', (chunk) => {
      message += String(chunk);
    });
    try {
      expect(response.statusCode).toBe(200);
      const watch = {
        handle: f.handle,
        watchId: 'TEST-browser-view',
        projectPath: '/TEST-project',
        filePaths: ['/TEST-project/file.txt'],
      };
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: AGENT_BACKEND_REVIEW_WATCH_ROUTE,
            payload: watch,
          })
        ).statusCode
      ).toBe(204);
      callback?.({ type: 'change', path: watch.filePaths[0] });
      await vi.waitFor(() =>
        expect(message).toContain(`event: ${AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL}`)
      );
      expect(String(message)).toContain(
        '"handleId":"TEST-original-handle","watchId":"TEST-browser-view"'
      );
      f.revoke();
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
            payload: watch,
          })
        ).statusCode
      ).toBe(204);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(
        (await f.app.inject({ method: 'GET', url: AGENT_BACKEND_REVIEW_EVENTS_ROUTE })).statusCode
      ).toBe(403);
    } finally {
      response.destroy();
      await f.app.close();
    }
  });
});
