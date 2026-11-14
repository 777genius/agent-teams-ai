import {
  CODEX_RUNTIME_GET_STATUS,
  CODEX_RUNTIME_INSTALL,
  CODEX_RUNTIME_INVALIDATE_STATUS,
} from '@features/codex-runtime-installer/contracts';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { CapturedCodexInstallRequest } from '../../../application/CapturedCodexRuntimeInstaller';
import type { CodexRuntimeInstallerFeatureFacade } from '../../../composition/createCodexRuntimeInstallerFeature';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('Feature:codex-runtime-installer:ipc');

export function registerCodexRuntimeInstallerIpc(
  ipcMain: IpcMain,
  feature: CodexRuntimeInstallerFeatureFacade,
  capture?: (event: IpcMainInvokeEvent) => CapturedCodexInstallRequest | undefined
): void {
  ipcMain.handle(
    CODEX_RUNTIME_GET_STATUS,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<CodexRuntimeStatus>> =>
      withIpcResult(() => {
        const captured = capture?.(_event);
        return captured ? feature.getStatus(captured) : feature.getStatus();
      })
  );
  ipcMain.handle(
    CODEX_RUNTIME_INSTALL,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<CodexRuntimeStatus>> =>
      withIpcResult(() => {
        const captured = capture?.(_event);
        return captured ? feature.install(captured) : feature.install();
      })
  );
  ipcMain.handle(
    CODEX_RUNTIME_INVALIDATE_STATUS,
    (_event: IpcMainInvokeEvent): IpcResult<void> | Promise<IpcResult<void>> => {
      const original = withSyncIpcResult(() => capture?.(_event));
      if (!original.success)
        return { success: false, error: original.error ?? 'Codex selection is unavailable.' };
      const captured = original.data;
      if (captured)
        return withIpcResult(async () => {
          await feature.invalidateStatus(captured);
          return undefined;
        });
      return withSyncIpcResult(() => {
        feature.invalidateStatus();
        return undefined;
      });
    }
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
