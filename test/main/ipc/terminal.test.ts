import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => loggerMock,
}));

import {
  initializeTerminalHandlers,
  registerTerminalHandlers,
  removeTerminalHandlers,
} from '@main/ipc/terminal';

import type { PtyTerminalService } from '@main/services';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

type IpcListener = (event: IpcMainEvent, ...args: unknown[]) => void;
type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createMockIpcMain(): IpcMain & {
  emitToListener: (channel: string, ...args: unknown[]) => void;
  invokeHandler: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  listenerCount: (channel: string) => number;
} {
  const handlers = new Map<string, IpcHandler>();
  const listeners = new Map<string, IpcListener[]>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    on: vi.fn((channel: string, listener: IpcListener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return ipcMain;
    }),
    removeListener: vi.fn((channel: string, listener: IpcListener) => {
      listeners.set(
        channel,
        (listeners.get(channel) ?? []).filter((registered) => registered !== listener)
      );
      return ipcMain;
    }),
    emitToListener: (channel: string, ...args: unknown[]) => {
      const channelListeners = listeners.get(channel);
      if (!channelListeners?.length) {
        throw new Error(`No listener for ${channel}`);
      }
      for (const listener of channelListeners) {
        listener({} as IpcMainEvent, ...args);
      }
    },
    invokeHandler: async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for ${channel}`);
      }
      return (await handler({} as IpcMainInvokeEvent, ...args)) as T;
    },
    listenerCount: (channel: string) => listeners.get(channel)?.length ?? 0,
  };

  return ipcMain as unknown as IpcMain & {
    emitToListener: (channel: string, ...args: unknown[]) => void;
    invokeHandler: <T>(channel: string, ...args: unknown[]) => Promise<T>;
    listenerCount: (channel: string) => number;
  };
}

describe('terminal IPC handlers', () => {
  let ipcMain: ReturnType<typeof createMockIpcMain>;
  let spawnMock: ReturnType<typeof vi.fn<(options?: unknown) => Promise<string>>>;
  let resizeMock: ReturnType<typeof vi.fn<(id: string, cols: number, rows: number) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMain = createMockIpcMain();
    spawnMock = vi.fn<(options?: unknown) => Promise<string>>().mockResolvedValue('pty-new');
    resizeMock = vi.fn<(id: string, cols: number, rows: number) => void>();
    initializeTerminalHandlers({
      spawn: spawnMock,
      resize: resizeMock,
    } as unknown as PtyTerminalService);
    registerTerminalHandlers(ipcMain);
  });

  it('rejects native-unsafe spawn dimensions before calling the service', async () => {
    const invalidSpawnOptions = [
      { cols: 0, rows: 24 },
      { cols: 80, rows: -1 },
      { cols: 80.5, rows: 24 },
      { cols: 80, rows: Number.NaN },
      { cols: Number.POSITIVE_INFINITY, rows: 24 },
      { cols: '80', rows: 24 },
      { cols: 32_768, rows: 24 },
      { cols: 80, rows: 32_768 },
    ];

    for (const options of invalidSpawnOptions) {
      await expect(ipcMain.invokeHandler('terminal:spawn', options)).resolves.toEqual({
        success: false,
        error: 'Invalid terminal dimensions',
      });
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(invalidSpawnOptions.length);
  });

  it('forwards valid or omitted spawn dimensions', async () => {
    await expect(
      ipcMain.invokeHandler('terminal:spawn', { command: '/bin/sh', cols: 120, rows: 40 })
    ).resolves.toEqual({ success: true, data: 'pty-new' });
    await expect(ipcMain.invokeHandler('terminal:spawn')).resolves.toEqual({
      success: true,
      data: 'pty-new',
    });

    expect(spawnMock).toHaveBeenNthCalledWith(1, {
      command: '/bin/sh',
      cols: 120,
      rows: 40,
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, undefined);
  });

  it('forwards valid positive integer dimensions', () => {
    ipcMain.emitToListener('terminal:resize', 'pty-1', 120, 40);

    expect(resizeMock).toHaveBeenCalledOnce();
    expect(resizeMock).toHaveBeenCalledWith('pty-1', 120, 40);
  });

  it('rejects malformed or native-unsafe resize dimensions before calling the service', () => {
    const invalidResizeArguments: [unknown, unknown, unknown][] = [
      ['pty-1', 0, 24],
      ['pty-1', 80, -1],
      ['pty-1', 80.5, 24],
      ['pty-1', 80, Number.NaN],
      ['pty-1', Number.POSITIVE_INFINITY, 24],
      ['pty-1', '80', 24],
      ['pty-1', 32_768, 24],
      ['pty-1', 80, 32_768],
    ];

    for (const args of invalidResizeArguments) {
      expect(() => ipcMain.emitToListener('terminal:resize', ...args)).not.toThrow();
    }

    expect(resizeMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(invalidResizeArguments.length);
  });

  it('contains resize service failures and continues handling later requests', () => {
    resizeMock.mockImplementationOnce(() => {
      throw new Error('native resize failed');
    });

    expect(() => ipcMain.emitToListener('terminal:resize', 'pty-1', 100, 30)).not.toThrow();
    expect(() => ipcMain.emitToListener('terminal:resize', 'pty-1', 101, 31)).not.toThrow();

    expect(resizeMock).toHaveBeenNthCalledWith(1, 'pty-1', 100, 30);
    expect(resizeMock).toHaveBeenNthCalledWith(2, 'pty-1', 101, 31);
    expect(loggerMock.warn).toHaveBeenCalledWith('terminal:resize error:', 'native resize failed');
  });

  it('owns idempotent registrations independently for each IpcMain instance', () => {
    const otherIpcMain = createMockIpcMain();
    const externalResizeListener = vi.fn<IpcListener>();
    ipcMain.on('terminal:resize', externalResizeListener);

    registerTerminalHandlers(ipcMain);
    registerTerminalHandlers(otherIpcMain);

    expect(ipcMain.handle).toHaveBeenCalledOnce();
    expect(ipcMain.listenerCount('terminal:write')).toBe(1);
    expect(ipcMain.listenerCount('terminal:resize')).toBe(2);
    expect(ipcMain.listenerCount('terminal:kill')).toBe(1);
    expect(otherIpcMain.handle).toHaveBeenCalledOnce();
    expect(otherIpcMain.listenerCount('terminal:write')).toBe(1);
    expect(otherIpcMain.listenerCount('terminal:resize')).toBe(1);
    expect(otherIpcMain.listenerCount('terminal:kill')).toBe(1);

    removeTerminalHandlers(ipcMain);
    removeTerminalHandlers(ipcMain);

    expect(ipcMain.removeHandler).toHaveBeenCalledOnce();
    expect(ipcMain.removeListener).toHaveBeenCalledTimes(3);
    expect(ipcMain.listenerCount('terminal:write')).toBe(0);
    expect(ipcMain.listenerCount('terminal:resize')).toBe(1);
    expect(ipcMain.listenerCount('terminal:kill')).toBe(0);
    expect(otherIpcMain.listenerCount('terminal:write')).toBe(1);
    expect(otherIpcMain.listenerCount('terminal:resize')).toBe(1);
    expect(otherIpcMain.listenerCount('terminal:kill')).toBe(1);

    ipcMain.emitToListener('terminal:resize', 'pty-1', 120, 40);
    otherIpcMain.emitToListener('terminal:resize', 'pty-2', 121, 41);

    expect(externalResizeListener).toHaveBeenCalledOnce();
    expect(resizeMock).toHaveBeenCalledOnce();
    expect(resizeMock).toHaveBeenCalledWith('pty-2', 121, 41);
  });
});
