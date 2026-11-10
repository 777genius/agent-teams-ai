// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_CONNECTIONS_CHANNEL,
  AGENT_BACKEND_INVOKE_CHANNEL,
} from '../../../src/features/agent-backend/contracts';
import {
  BackendOperationsFacade,
  DesktopBackendFeature,
} from '../../../src/features/agent-backend/main';
import {
  captureBackendSenderContext,
  registerDesktopAgentBackend,
  removeDesktopAgentBackendHandlers,
  shutdownDesktopAgentBackend,
} from '../../../src/main/ipc/agentBackend';
import { ServiceContextRegistry } from '../../../src/main/services/infrastructure/ServiceContextRegistry';

import type { ServiceContext } from '../../../src/main/services/infrastructure/ServiceContext';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const url = 'http://localhost:5173/';

function renderer() {
  let currentUrl = url;
  const frame = {
    get url() {
      return currentUrl;
    },
  };
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => currentUrl };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return {
    window,
    event,
    navigate: (next: string) => {
      currentUrl = next;
    },
  };
}

afterEach(async () => {
  await shutdownDesktopAgentBackend();
  removeDesktopAgentBackendHandlers();
  vi.restoreAllMocks();
});

describe('Desktop backend shell authority', () => {
  it('requires the captured window, exact main frame and selected renderer URL', () => {
    const main = renderer();
    expect(captureBackendSenderContext(main.event, main.window, url, () => 'local')).toBe('local');
    expect(
      captureBackendSenderContext(main.event, renderer().window, url, () => 'local')
    ).toBeNull();
    const iframe = { ...main.event, senderFrame: { url } } as unknown as IpcMainInvokeEvent;
    expect(captureBackendSenderContext(iframe, main.window, url, () => 'local')).toBeNull();
    main.navigate(`${url}#task`);
    expect(captureBackendSenderContext(main.event, main.window, url, () => 'local')).toBe('local');
    for (const invalid of [
      'http://localhost:5174/',
      `${url}?foreign=1`,
      `${url}foreign`,
      'about:blank',
    ]) {
      main.navigate(invalid);
      expect(captureBackendSenderContext(main.event, main.window, url, () => 'local')).toBeNull();
    }
  });

  it.each(['return-to-same-id', 'replace-same-id'] as const)(
    'revokes pending IPC operation and discovery after %s',
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
      const main = renderer();
      const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(DesktopBackendFeature.prototype, 'initialize').mockImplementation(() => waiting);
      vi.spyOn(DesktopBackendFeature.prototype, 'authorizeHandle').mockReturnValue(true);
      const dispatch = vi.spyOn(BackendOperationsFacade.prototype, 'invoke');
      const discover = vi.spyOn(DesktopBackendFeature.prototype, 'discoverBindings');
      registerDesktopAgentBackend({
        ipc: {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
          removeHandler(channel) {
            handlers.delete(channel);
          },
        },
        getMainWindow: () => main.window,
        getActiveContextId: () => registry.getActiveContextId(),
        captureActiveSelection: () => registry.captureActiveSelection(),
        rendererIndexPath: '/TEST/renderer/index.html',
        userDataPath: '/TEST/epoch-ipc-no-writes',
        env: { NODE_ENV: 'development' },
      });
      const operation = handlers.get(AGENT_BACKEND_INVOKE_CHANNEL)!(main.event, {
        handle: { handleId: 'TEST-original' },
        commandId: 'TEST-original-command',
        operation: 'tasks.list',
        payload: {},
      });
      const discovery = handlers.get(AGENT_BACKEND_CONNECTIONS_CHANNEL)!(main.event);
      if (change === 'replace-same-id') registry.replaceContext('local', context('local'));
      else {
        registry.switch('ssh:TEST');
        registry.switch('local');
      }
      release();
      expect(await operation).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
      expect(await discovery).toEqual({ state: 'hold', bindings: [] });
      expect(dispatch).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      registry.dispose();
    }
  );

  it('exposes safe unconfigured state, rejects forged operations and seals on shutdown', async () => {
    const main = renderer();
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
    let contextId = 'local';
    registerDesktopAgentBackend({
      ipc,
      getMainWindow: () => main.window,
      getActiveContextId: () => contextId,
      captureActiveSelection: () => {
        const captured = contextId;
        return { contextId: captured, isCurrent: () => contextId === captured };
      },
      rendererIndexPath: '/TEST/renderer/index.html',
      userDataPath: '/TEST/unconfigured-backend-no-writes',
      env: { NODE_ENV: 'development' },
    });
    const connections = handlers.get(AGENT_BACKEND_CONNECTIONS_CHANNEL)!;
    expect(await connections(main.event)).toEqual({ state: 'unconfigured', bindings: [] });
    const pending = connections(main.event);
    contextId = 'ssh:test';
    expect(await pending).toEqual({ state: 'hold', bindings: [] });
    expect(
      await handlers.get(AGENT_BACKEND_INVOKE_CHANNEL)!(main.event, {
        handle: { handleId: 'forged' },
        commandId: 'test-command',
        operation: 'tasks.list',
        payload: {},
      })
    ).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
    const drain = shutdownDesktopAgentBackend();
    expect(await connections(main.event)).toEqual({ state: 'shutting-down', bindings: [] });
    await drain;
    removeDesktopAgentBackendHandlers();
    expect(handlers.size).toBe(0);
  });
});
