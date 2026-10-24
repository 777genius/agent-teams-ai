// @vitest-environment node
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
  AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
  AGENT_BACKEND_REVIEW_WATCH_ROUTE,
} from '../../../src/features/agent-backend/contracts/reviewWatch';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createCapturedReviewWatch } from '../../../src/features/agent-backend/main/adapters/input/CapturedReviewWatch';
import { registerCapturedReviewWatchHttp } from '../../../src/features/agent-backend/main/adapters/input/registerCapturedReviewWatchHttp';
import { DesktopBackendFeature } from '../../../src/features/agent-backend/main/composition/DesktopBackendFeature';
import { createAgentBackendReviewWatchBridge } from '../../../src/features/agent-backend/preload';
import { createAgentBackendReviewWatchHttpClient } from '../../../src/features/agent-backend/renderer/adapters/http/createAgentBackendReviewWatchHttpClient';
import {
  registerDesktopAgentBackend,
  removeDesktopAgentBackendHandlers,
  shutdownDesktopAgentBackend,
} from '../../../src/main/ipc/agentBackend';
import { EditorFileWatcher } from '../../../src/main/services/editor/EditorFileWatcher';

import type { BackendReviewWatchEvent } from '../../../src/features/agent-backend/contracts/reviewWatch';
import type { EditorFileChangeEvent } from '../../../src/shared/types/editor';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const request = {
  handle: { handleId: 'TEST-owner-a' },
  watchId: 'TEST-watch',
  projectPath: '/TEST-project',
  filePaths: ['/TEST-project/file.txt'],
};
const grant = {
  ok: true as const,
  value: {
    kind: 'review-watch-authorization' as const,
    projectPath: '/TEST-project',
    filePaths: ['/TEST-project/file.txt'],
  },
};
const url = 'http://localhost:5173/';

afterEach(async () => {
  await shutdownDesktopAgentBackend();
  removeDesktopAgentBackendHandlers();
  vi.restoreAllMocks();
});

function desktop() {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const listeners = new Map<string, (event: unknown, value: BackendReviewWatchEvent) => void>();
  const callbacks: ((event: EditorFileChangeEvent) => void)[] = [];
  const stopped = vi.spyOn(EditorFileWatcher.prototype, 'stop').mockImplementation(() => {});
  const watched = vi
    .spyOn(EditorFileWatcher.prototype, 'setWatchedFiles')
    .mockImplementation(() => {});
  vi.spyOn(EditorFileWatcher.prototype, 'start').mockImplementation((_root, callback) => {
    callbacks.push(callback);
  });
  const initialize = vi.spyOn(DesktopBackendFeature.prototype, 'initialize').mockResolvedValue();
  vi.spyOn(DesktopBackendFeature.prototype, 'authorizeHandle').mockImplementation(
    (context, handle) => context === 'TEST-context-a' && handle.handleId === request.handle.handleId
  );
  const invoke = vi.spyOn(BackendOperationsFacade.prototype, 'invoke').mockResolvedValue(grant);
  const frame = { url };
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => url,
    send(channel: string, value: BackendReviewWatchEvent) {
      listeners.get(channel)?.({}, value);
    },
  };
  const closed: (() => void)[] = [];
  const window = {
    webContents: contents,
    isDestroyed: () => false,
    once(_event: string, callback: () => void) {
      closed.push(callback);
    },
  } as unknown as BrowserWindow;
  let selectedWindow: BrowserWindow | null = null;
  let event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  let context = 'TEST-context-a';
  registerDesktopAgentBackend({
    ipc: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    getMainWindow: () => selectedWindow,
    getActiveContextId: () => context,
    captureActiveSelection: () => {
      const captured = context;
      return { contextId: captured, isCurrent: () => context === captured };
    },
    rendererIndexPath: '/TEST/renderer/index.html',
    userDataPath: '/TEST/watch-shell-no-writes',
    env: {
      NODE_ENV: 'development',
      AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: '/TEST/never-read-descriptor',
      AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: 'TEST',
    },
  });
  const api = createAgentBackendReviewWatchBridge({
    async invoke(channel, value) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error('Missing watch handler');
      await handler(event, value);
    },
    on(channel, callback) {
      listeners.set(channel, callback);
    },
    removeListener(channel, callback) {
      if (listeners.get(channel) === callback) listeners.delete(channel);
    },
  });
  return {
    api,
    initialize,
    invoke,
    watched,
    stopped,
    callbacks,
    handlers,
    closed,
    attach() {
      selectedWindow = window;
    },
    replaceWindow() {
      selectedWindow = {
        ...window,
        webContents: { ...contents, mainFrame: { url } },
      } as unknown as BrowserWindow;
    },
    setContext(value: string) {
      context = value;
    },
    wrongFrame() {
      event = { sender: contents, senderFrame: { url } } as unknown as IpcMainInvokeEvent;
    },
    mainFrame() {
      event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    },
  };
}

describe('captured review watch transports', () => {
  it('real shell registration waits for an available authorized window, validates frame, then preload receives qualified events', async () => {
    const f = desktop();
    const events: BackendReviewWatchEvent[] = [];
    const unsubscribe = f.api.onReviewFileChange((event) => events.push(event));
    await expect(f.api.watchReviewFiles(request)).rejects.toThrow('sender unavailable');
    expect(f.initialize).not.toHaveBeenCalled();
    f.attach();
    f.wrongFrame();
    await expect(f.api.watchReviewFiles(request)).rejects.toThrow('sender unavailable');
    expect(f.initialize).not.toHaveBeenCalled();
    f.mainFrame();
    await f.api.watchReviewFiles(request);
    expect(f.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'review.authorizeWatch', handle: request.handle }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    );
    expect(f.watched).toHaveBeenCalledWith(request.filePaths);
    f.callbacks[0]({ type: 'change', path: request.filePaths[0] });
    expect(events).toEqual([
      {
        handleId: request.handle.handleId,
        watchId: request.watchId,
        type: 'change',
        path: request.filePaths[0],
      },
    ]);
    unsubscribe();
    f.callbacks[0]({ type: 'change', path: request.filePaths[0] });
    expect(events).toHaveLength(1);
  });

  it('context revocation blocks events/new admission while exact authenticated cleanup survives and wrong-frame cleanup cannot stop it', async () => {
    const f = desktop();
    f.attach();
    const events: BackendReviewWatchEvent[] = [];
    f.api.onReviewFileChange((event) => events.push(event));
    await f.api.watchReviewFiles(request);
    f.setContext('TEST-context-b');
    f.wrongFrame();
    await expect(f.api.unwatchReviewFiles(request)).rejects.toThrow('sender unavailable');
    expect(f.stopped).not.toHaveBeenCalled();
    f.mainFrame();
    await f.api.unwatchReviewFiles(request);
    expect(f.stopped).toHaveBeenCalledTimes(1);
    f.callbacks[0]({ type: 'delete', path: request.filePaths[0] });
    expect(events).toEqual([]);
    await expect(f.api.watchReviewFiles({ ...request, watchId: 'TEST-new-view' })).rejects.toThrow(
      'sender unavailable'
    );
    expect(f.watched).toHaveBeenCalledTimes(1);
  });

  it('unwatch while the first Host initialization is pending prevents later watcher admission', async () => {
    const f = desktop();
    f.attach();
    let release!: () => void;
    f.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const pending = f.api.watchReviewFiles(request);
    await f.api.unwatchReviewFiles(request);
    release();
    await pending;
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.watched).not.toHaveBeenCalled();
  });

  it('window replacement retires the original bridge before rejecting the old frame and removal clears channels', async () => {
    const f = desktop();
    f.attach();
    await f.api.watchReviewFiles(request);
    f.replaceWindow();
    await expect(f.api.unwatchReviewFiles(request)).rejects.toThrow('sender unavailable');
    expect(f.stopped).toHaveBeenCalledTimes(1);
    removeDesktopAgentBackendHandlers();
    expect(f.handlers.size).toBe(0);
  });

  it('feature HTTP routes use the same bridge with an injected session event port and exact revoked cleanup', async () => {
    const app = Fastify();
    let current = true;
    let callback: ((event: EditorFileChangeEvent) => void) | undefined;
    const events = new Set<(event: BackendReviewWatchEvent) => void>();
    const stop = vi.fn();
    const bridge = createCapturedReviewWatch({
      window: null,
      facade: { invoke: vi.fn().mockResolvedValue(grant) },
      createWatcher: () => ({
        start(_root, onChange) {
          callback = onChange;
        },
        setWatchedFiles() {},
        stop,
      }),
      send(_window, channel, event) {
        expect(channel).toBe(AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL);
        for (const listener of events) listener(event);
        return true;
      },
    });
    registerCapturedReviewWatchHttp(app, {
      async captureWatch(request) {
        return request.headers.authorization === 'TEST-session' && current
          ? { bridge, guard: { isCurrent: () => current } }
          : null;
      },
      captureCleanup(request) {
        return request.headers.authorization === 'TEST-session' ? bridge : null;
      },
    });
    const routes: string[] = [];
    const api = createAgentBackendReviewWatchHttpClient({
      async post(route, payload) {
        routes.push(route);
        const response = await app.inject({
          method: 'POST',
          url: route,
          headers: { authorization: 'TEST-session' },
          payload,
        });
        if (response.statusCode !== 204) throw new Error('HTTP watch rejected');
      },
      subscribe(listener) {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      },
    });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: AGENT_BACKEND_REVIEW_WATCH_ROUTE,
            payload: request,
          })
        ).statusCode
      ).toBe(403);
      const received: BackendReviewWatchEvent[] = [];
      const unsubscribe = api.onReviewFileChange((event) => received.push(event));
      await api.watchReviewFiles(request);
      callback?.({ type: 'change', path: request.filePaths[0] });
      expect(received).toHaveLength(1);
      current = false;
      await api.unwatchReviewFiles(request);
      expect(stop).toHaveBeenCalledTimes(1);
      callback?.({ type: 'change', path: request.filePaths[0] });
      expect(received).toHaveLength(1);
      expect(routes).toEqual([
        AGENT_BACKEND_REVIEW_WATCH_ROUTE,
        AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
      ]);
      unsubscribe();
    } finally {
      bridge.dispose();
      await app.close();
    }
  });
});
