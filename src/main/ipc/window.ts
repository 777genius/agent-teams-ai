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

export function registerWindowHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('window:minimize', (event) => {
    const win = getWindowForEvent(event);
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle('window:maximize', (event) => {
    const win = getWindowForEvent(event);
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
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
