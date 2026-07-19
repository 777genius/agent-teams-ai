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
    const quit = vi.fn(async () => undefined);
    const relaunch = vi.fn(async () => undefined);
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
});
