import { WINDOW_SET_ZOOM_FACTOR_CHANNEL } from '@shared/constants';
import type { BrowserWindow, IpcMain } from 'electron';

/**
 * Only the active main window may change renderer zoom. Keep macOS native
 * traffic-light placement in sync through the existing main process callback.
 */
export function registerWindowZoomHandler(
  ipc: IpcMain,
  getWindow: () => BrowserWindow | null,
  synchronizeWindow: (window: BrowserWindow) => void
): void {
  ipc.handle(WINDOW_SET_ZOOM_FACTOR_CHANNEL, (event, factor: unknown): number => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) {
      throw new Error('Zoom request from an unauthorized window');
    }
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0.7 || factor > 2) {
      throw new Error('Zoom factor must be between 0.7 and 2');
    }
    window.webContents.setZoomFactor(factor);
    synchronizeWindow(window);
    return window.webContents.getZoomFactor();
  });
}
