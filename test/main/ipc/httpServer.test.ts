import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clearTeamControlApiStateMock, updateConfigMock } = vi.hoisted(() => ({
  clearTeamControlApiStateMock: vi.fn(() => Promise.resolve()),
  updateConfigMock: vi.fn(),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@main/services', () => ({
  configManager: {
    updateConfig: updateConfigMock,
  },
}));

vi.mock('@main/services/team/TeamControlApiState', () => ({
  clearTeamControlApiState: clearTeamControlApiStateMock,
}));

import { initializeHttpServerHandlers, registerHttpServerHandlers } from '@main/ipc/httpServer';

import type { HttpServer } from '@main/services/infrastructure/HttpServer';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

interface HttpServerResult {
  success: boolean;
  data?: { running: boolean; port: number | null };
  error?: string;
}

type IpcHandler = (event: IpcMainInvokeEvent) => unknown;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createMockIpcMain(): IpcMain & {
  invoke: (channel: string) => Promise<unknown>;
} {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    invoke: async (channel: string) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for ${channel}`);
      }
      return await Promise.resolve(handler({} as IpcMainInvokeEvent));
    },
  };
  return ipcMain as unknown as IpcMain & {
    invoke: (channel: string) => Promise<unknown>;
  };
}

describe('httpServer IPC handlers', () => {
  let ipcMain: ReturnType<typeof createMockIpcMain>;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMain = createMockIpcMain();
  });

  it('waits for an in-flight start before stopping the server', async () => {
    const startGate = deferred<void>();
    const events: string[] = [];
    let running = false;
    const server = {
      stop: vi.fn(() => {
        events.push('stop');
        running = false;
        return Promise.resolve();
      }),
      isRunning: vi.fn(() => running),
      getPort: vi.fn(() => 3456),
    };
    const startServer = vi.fn(async () => {
      events.push('start');
      await startGate.promise;
      running = true;
    });
    initializeHttpServerHandlers(server as unknown as HttpServer, startServer);
    registerHttpServerHandlers(ipcMain);

    const startRequest = ipcMain.invoke('httpServer:start') as Promise<HttpServerResult>;
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledTimes(1));
    const stopRequest = ipcMain.invoke('httpServer:stop') as Promise<HttpServerResult>;
    await Promise.resolve();

    expect(server.stop).not.toHaveBeenCalled();

    startGate.resolve();
    await expect(startRequest).resolves.toEqual({
      success: true,
      data: { running: true, port: 3456 },
    });
    await expect(stopRequest).resolves.toEqual({
      success: true,
      data: { running: false, port: 3456 },
    });

    expect(events).toEqual(['start', 'stop']);
    expect(updateConfigMock.mock.calls).toEqual([
      ['httpServer', { enabled: true, port: 3456 }],
      ['httpServer', { enabled: false }],
    ]);
    expect(clearTeamControlApiStateMock).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight stop before restarting the server', async () => {
    const stopGate = deferred<void>();
    const events: string[] = [];
    let running = true;
    const server = {
      stop: vi.fn(async () => {
        events.push('stop');
        await stopGate.promise;
        running = false;
      }),
      isRunning: vi.fn(() => running),
      getPort: vi.fn(() => 3456),
    };
    const startServer = vi.fn(() => {
      events.push('start');
      running = true;
      return Promise.resolve();
    });
    initializeHttpServerHandlers(server as unknown as HttpServer, startServer);
    registerHttpServerHandlers(ipcMain);

    const stopRequest = ipcMain.invoke('httpServer:stop') as Promise<HttpServerResult>;
    await vi.waitFor(() => expect(server.stop).toHaveBeenCalledTimes(1));
    const startRequest = ipcMain.invoke('httpServer:start') as Promise<HttpServerResult>;
    await Promise.resolve();

    expect(startServer).not.toHaveBeenCalled();

    stopGate.resolve();
    await expect(stopRequest).resolves.toEqual({
      success: true,
      data: { running: false, port: 3456 },
    });
    await expect(startRequest).resolves.toEqual({
      success: true,
      data: { running: true, port: 3456 },
    });

    expect(events).toEqual(['stop', 'start']);
    expect(updateConfigMock.mock.calls).toEqual([
      ['httpServer', { enabled: false }],
      ['httpServer', { enabled: true, port: 3456 }],
    ]);
    expect(clearTeamControlApiStateMock).toHaveBeenCalledTimes(1);
  });
});
