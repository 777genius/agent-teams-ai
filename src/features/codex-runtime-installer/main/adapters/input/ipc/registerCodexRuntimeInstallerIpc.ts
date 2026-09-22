import {
  CODEX_RUNTIME_GET_STATUS,
  CODEX_RUNTIME_INSTALL,
  CODEX_RUNTIME_INVALIDATE_STATUS,
} from '@features/codex-runtime-installer/contracts';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { CodexRuntimeInstallerFeatureFacade } from '../../../composition/createCodexRuntimeInstallerFeature';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('Feature:codex-runtime-installer:ipc');

export function registerCodexRuntimeInstallerIpc(
  ipcMain: IpcMain,
  feature: CodexRuntimeInstallerFeatureFacade
): void {
  ipcMain.handle(
    CODEX_RUNTIME_GET_STATUS,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<CodexRuntimeStatus>> =>
      withIpcResult(() => feature.getStatus())
  );
  ipcMain.handle(
    CODEX_RUNTIME_INSTALL,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<CodexRuntimeStatus>> =>
      withIpcResult(() => feature.install())
  );
  ipcMain.handle(
    CODEX_RUNTIME_INVALIDATE_STATUS,
    (_event: IpcMainInvokeEvent): IpcResult<void> =>
      withSyncIpcResult(() => {
        feature.invalidateStatus();
        return undefined;
      })
  );
  logger.info('Codex runtime installer IPC handlers registered');
}

export function removeCodexRuntimeInstallerIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CODEX_RUNTIME_GET_STATUS);
  ipcMain.removeHandler(CODEX_RUNTIME_INSTALL);
  ipcMain.removeHandler(CODEX_RUNTIME_INVALIDATE_STATUS);
  logger.info('Codex runtime installer IPC handlers removed');
}

async function withIpcResult<T>(work: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    const message = getErrorMessage(error);
    return { success: false, error: message };
  }
}

function withSyncIpcResult<T>(work: () => T): IpcResult<T> {
  try {
    return { success: true, data: work() };
  } catch (error) {
    const message = getErrorMessage(error);
    return { success: false, error: message };
  }
}
