import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => loggerMock,
}));

import { initializeTerminalHandlers, registerTerminalHandlers } from '@main/ipc/terminal';

import type { PtyTerminalService } from '@main/services';
import type { IpcMain, IpcMainEvent } from 'electron';

type IpcListener = (event: IpcMainEvent, ...args: unknown[]) => void;

function createMockIpcMain(): IpcMain & {
  emitToListener: (channel: string, ...args: unknown[]) => void;
} {
  const listeners = new Map<string, IpcListener>();
  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn((channel: string, listener: IpcListener) => {
      listeners.set(channel, listener);
    }),
    emitToListener: (channel: string, ...args: unknown[]) => {
      const listener = listeners.get(channel);
      if (!listener) {
        throw new Error(`No listener for ${channel}`);
      }
      listener({} as IpcMainEvent, ...args);
    },
  };

  return ipcMain as unknown as IpcMain & {
    emitToListener: (channel: string, ...args: unknown[]) => void;
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
});
