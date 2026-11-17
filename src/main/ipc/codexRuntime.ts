import {
  createCodexRuntimeInstallerFeature,
  registerCodexRuntimeInstallerIpc,
  removeCodexRuntimeInstallerIpc,
} from '@features/codex-runtime-installer/main';
import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { createLogger } from '@shared/utils/logger';

import { captureDesktopRuntimeSources } from './agentBackend';

import type { CapturedCodexInstallRequest } from '@features/codex-runtime-installer/main';
import type { BrowserWindow, IpcMain } from 'electron';

const logger = createLogger('IPC:codexRuntime');
const codexRuntimeInstallerFeature = createCodexRuntimeInstallerFeature();

export function registerCodexRuntimeHandlers(ipcMain: IpcMain): void {
  registerCodexRuntimeInstallerIpc(ipcMain, codexRuntimeInstallerFeature, (event) => {
    try {
      let resolver: CapturedCodexInstallRequest['resolver'] | undefined;
      const sources = captureDesktopRuntimeSources(event, 'codex', (isCurrent) => {
        resolver = CodexBinaryResolver.captureSelection(isCurrent);
      });
      if (!sources) return undefined;
      if (!resolver) throw new Error('The original Codex installation context is unavailable.');
      return Object.freeze({ sources, resolver });
    } catch (cause) {
      throw new Error('The original Codex installation context is unavailable.', { cause });
    }
  });
  logger.info('Codex runtime handlers registered');
}

export function removeCodexRuntimeHandlers(ipcMain: IpcMain): void {
  removeCodexRuntimeInstallerIpc(ipcMain);
  logger.info('Codex runtime handlers removed');
}

export function setCodexRuntimeMainWindow(window: BrowserWindow | null): void {
  codexRuntimeInstallerFeature.setMainWindow(window);
}
