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
import type { IpcMain, IpcMainEvent } from 'electron';

type IpcListener = (event: IpcMainEvent, ...args: unknown[]) => void;

function createMockIpcMain(): IpcMain & {
  emitToListener: (channel: string, ...args: unknown[]) => void;
  listenerCount: (channel: string) => number;
} {
  const listeners = new Map<string, IpcListener[]>();
  const ipcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn(),
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
    listenerCount: (channel: string) => listeners.get(channel)?.length ?? 0,
  };

  return ipcMain as unknown as IpcMain & {
    emitToListener: (channel: string, ...args: unknown[]) => void;
    listenerCount: (channel: string) => number;
  };
}

describe('terminal IPC handlers', () => {
  let ipcMain: ReturnType<typeof createMockIpcMain>;
  let resizeMock: ReturnType<typeof vi.fn<(id: string, cols: number, rows: number) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMain = createMockIpcMain();
    resizeMock = vi.fn<(id: string, cols: number, rows: number) => void>();
    initializeTerminalHandlers({ resize: resizeMock } as unknown as PtyTerminalService);
    registerTerminalHandlers(ipcMain);
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
