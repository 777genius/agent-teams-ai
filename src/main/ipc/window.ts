/**
 * IPC Handlers for native window controls.
 * Used when the title bar is hidden (e.g. Windows / Linux) so the renderer
 * can provide conventional min / maximize / close buttons.
 */

import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';

const WINDOW_IS_FULLSCREEN = 'window:isFullScreen';

const logger = createLogger('IPC:window');

interface WindowLifecycleActions {
  quit: () => Promise<void> | void;
  relaunch: () => Promise<void> | void;
}

let lifecycleActions: WindowLifecycleActions = {
  quit: () => app.quit(),
  relaunch: () => {
    app.relaunch();
    app.quit();
  },
};

export function configureWindowLifecycleActions(actions: WindowLifecycleActions): void {
  lifecycleActions = actions;
}

function getMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) return win;
  const all = BrowserWindow.getAllWindows();
  return all.length > 0 ? all[0] : null;
}

function getWindowForEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) return win;
  return getMainWindow();
}

function toggleMaximized(win: BrowserWindow): Promise<void> {
  const wasMaximized = win.isMaximized();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (wasMaximized) win.removeListener('unmaximize', finish);
      else win.removeListener('maximize', finish);
      win.removeListener('closed', finish);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Window manager did not acknowledge the maximize change'));
    }, 5_000);
    timeout.unref();
    // Linux window managers acknowledge this asynchronously. The renderer must
    // read isMaximized only after that acknowledgment, including on restore.
    if (wasMaximized) win.once('unmaximize', finish);
    else win.once('maximize', finish);
    win.once('closed', finish);
    try {
      if (wasMaximized) win.unmaximize();
      else win.maximize();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function registerWindowHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('window:minimize', (event) => {
    const win = getWindowForEvent(event);
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle('window:maximize', (event) => {
    const win = getWindowForEvent(event);
    if (win && !win.isDestroyed()) {
      return toggleMaximized(win);
    }
  });

  ipcMain.handle('window:close', async () => {
    await lifecycleActions.quit();
  });

  ipcMain.handle('window:isMaximized', (event): boolean => {
    const win = getWindowForEvent(event);
    return win != null && !win.isDestroyed() && win.isMaximized();
  });

  ipcMain.handle(WINDOW_IS_FULLSCREEN, (event): boolean => {
    const win = getWindowForEvent(event);
    return win != null && !win.isDestroyed() && win.isFullScreen();
  });

  ipcMain.handle('app:relaunch', async () => {
    await lifecycleActions.relaunch();
  });

  logger.info('Window handlers registered');
}

export function removeWindowHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('window:minimize');
  ipcMain.removeHandler('window:maximize');
  ipcMain.removeHandler('window:close');
  ipcMain.removeHandler('window:isMaximized');
  ipcMain.removeHandler(WINDOW_IS_FULLSCREEN);
  ipcMain.removeHandler('app:relaunch');
  logger.info('Window handlers removed');
}
