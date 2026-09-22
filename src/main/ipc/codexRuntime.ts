import {
  createCodexRuntimeInstallerFeature,
  registerCodexRuntimeInstallerIpc,
  removeCodexRuntimeInstallerIpc,
} from '@features/codex-runtime-installer/main';
import { createLogger } from '@shared/utils/logger';

import type { BrowserWindow, IpcMain } from 'electron';

const logger = createLogger('IPC:codexRuntime');
const codexRuntimeInstallerFeature = createCodexRuntimeInstallerFeature();

export function registerCodexRuntimeHandlers(ipcMain: IpcMain): void {
  registerCodexRuntimeInstallerIpc(ipcMain, codexRuntimeInstallerFeature);
  logger.info('Codex runtime handlers registered');
}

export function removeCodexRuntimeHandlers(ipcMain: IpcMain): void {
  removeCodexRuntimeInstallerIpc(ipcMain);
  logger.info('Codex runtime handlers removed');
}

export function setCodexRuntimeMainWindow(window: BrowserWindow | null): void {
  codexRuntimeInstallerFeature.setMainWindow(window);
}
