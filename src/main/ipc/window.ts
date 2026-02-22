/**
 * IPC Handlers for native window controls.
 * Used when the title bar is hidden (e.g. Windows / Linux) so the renderer
 * can provide conventional min / maximize / close buttons.
 */

import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow, type IpcMain } from 'electron';

const logger = createLogger('IPC:window');

function getMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) return win;
  const all = BrowserWindow.getAllWindows();
  return all.length > 0 ? all[0] : null;
}

export function registerWindowHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('window:minimize', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle('window:isMaximized', (): boolean => {
    const win = getMainWindow();
    return win != null && !win.isDestroyed() && win.isMaximized();
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  logger.info('Window handlers registered');
}

export function removeWindowHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('window:minimize');
  ipcMain.removeHandler('window:maximize');
  ipcMain.removeHandler('window:close');
  ipcMain.removeHandler('window:isMaximized');
  ipcMain.removeHandler('app:relaunch');
  logger.info('Window handlers removed');
}
