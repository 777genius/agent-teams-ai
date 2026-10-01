import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  app: {
    quit: vi.fn(),
    relaunch: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(),
  },
}));

vi.mock('electron', () => electronMock);

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  configureWindowLifecycleActions,
  registerWindowHandlers,
  removeWindowHandlers,
} from '@main/ipc/window';
import { app, BrowserWindow } from 'electron';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

type WindowHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createMockIpcMain(): IpcMain & {
  invoke: (channel: string, event?: Partial<IpcMainInvokeEvent>) => Promise<unknown>;
} {
  const handlers = new Map<string, WindowHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: WindowHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    invoke: async (channel: string, event: Partial<IpcMainInvokeEvent> = {}) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return await Promise.resolve(handler(event as IpcMainInvokeEvent));
    },
  };
  return ipcMain as unknown as IpcMain & {
    invoke: (channel: string, event?: Partial<IpcMainInvokeEvent>) => Promise<unknown>;
  };
}

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
  };
}

describe('window IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
    configureWindowLifecycleActions({
      quit: () => app.quit(),
      relaunch: () => {
        app.relaunch();
        app.quit();
      },
    });
  });

  it('quits the app when the custom close control is clicked', async () => {
    const ipcMain = createMockIpcMain();
    registerWindowHandlers(ipcMain);

    await ipcMain.invoke('window:close');

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('relaunches through app.quit so shutdown cleanup can run', async () => {
    const ipcMain = createMockIpcMain();
    registerWindowHandlers(ipcMain);

    await ipcMain.invoke('app:relaunch');

    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('awaits configured guarded lifecycle actions before resolving window commands', async () => {
    const ipcMain = createMockIpcMain();
    const quit = vi.fn(() => Promise.resolve());
    const relaunch = vi.fn(() => Promise.resolve());
    configureWindowLifecycleActions({ quit, relaunch });
    registerWindowHandlers(ipcMain);

    await ipcMain.invoke('window:close');
    await ipcMain.invoke('app:relaunch');

    expect(quit).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it('uses the window that sent the IPC event for window-specific controls', async () => {
    const ipcMain = createMockIpcMain();
    const senderWindow = createMockWindow();
    const focusedWindow = createMockWindow();
    const sender = {};
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(senderWindow as never);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(focusedWindow as never);
    registerWindowHandlers(ipcMain);

    await ipcMain.invoke('window:minimize', { sender } as Partial<IpcMainInvokeEvent>);

    expect(senderWindow.minimize).toHaveBeenCalledTimes(1);
    expect(focusedWindow.minimize).not.toHaveBeenCalled();
  });

  it('removes registered handlers during shutdown cleanup', () => {
    const ipcMain = createMockIpcMain();
    registerWindowHandlers(ipcMain);
    removeWindowHandlers(ipcMain);

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('window:close');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('app:relaunch');
  });

  it.each([false, true])(
    'waits for the window manager acknowledgment (maximized=%s)',
    async (maximized) => {
      const win = Object.assign(new EventEmitter(), createMockWindow());
      win.isMaximized.mockReturnValue(maximized);
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
      const ipcMain = createMockIpcMain();
      registerWindowHandlers(ipcMain);
      let completed = false;
      const pending = ipcMain.invoke('window:maximize').then(() => {
        completed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(completed).toBe(false);
      expect(maximized ? win.unmaximize : win.maximize).toHaveBeenCalledTimes(1);
      win.isMaximized.mockReturnValue(!maximized);
      win.emit(maximized ? 'unmaximize' : 'maximize');
      await pending;
      expect(await ipcMain.invoke('window:isMaximized')).toBe(!maximized);
      expect(win.eventNames()).toEqual([]);
    }
  );

  it('releases pending window listeners when the window closes', async () => {
    const win = Object.assign(new EventEmitter(), createMockWindow());
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
    const ipcMain = createMockIpcMain();
    registerWindowHandlers(ipcMain);
    const pending = ipcMain.invoke('window:maximize');
    expect(win.listenerCount('maximize')).toBe(1);
    win.emit('closed');
    await pending;
    expect(win.eventNames()).toEqual([]);
  });

  it('bounds missing window manager acknowledgments and removes listeners', async () => {
    vi.useFakeTimers();
    try {
      const win = Object.assign(new EventEmitter(), createMockWindow());
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
      const ipcMain = createMockIpcMain();
      registerWindowHandlers(ipcMain);
      const pending = expect(ipcMain.invoke('window:maximize')).rejects.toThrow('Window manager');
      await vi.runAllTimersAsync();
      await pending;
      expect(win.eventNames()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
