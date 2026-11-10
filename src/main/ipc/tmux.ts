import {
  createTmuxInstallerFeature,
  registerTmuxInstallerIpc,
  removeTmuxInstallerIpc,
} from '@features/tmux-installer/main';
import { createLogger } from '@shared/utils/logger';

import type { BrowserWindow, IpcMain } from 'electron';

const logger = createLogger('IPC:tmux');
const tmuxInstallerFeature = createTmuxInstallerFeature();

export function registerTmuxHandlers(ipcMain: IpcMain): void {
  registerTmuxInstallerIpc(ipcMain, tmuxInstallerFeature);
  logger.info('tmux handlers registered');
}

export function removeTmuxHandlers(ipcMain: IpcMain): void {
  removeTmuxInstallerIpc(ipcMain);
  logger.info('tmux handlers removed');
}

export function setTmuxMainWindow(window: BrowserWindow | null): void {
  tmuxInstallerFeature.setMainWindow(window);
}
