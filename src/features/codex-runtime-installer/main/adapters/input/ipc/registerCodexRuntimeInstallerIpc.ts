import {
  CODEX_RUNTIME_GET_STATUS,
  CODEX_RUNTIME_INSTALL,
  CODEX_RUNTIME_INVALIDATE_STATUS,
} from '@features/codex-runtime-installer/contracts';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { CodexRuntimeInstallerFeatureFacade } from '../../../composition/createCodexRuntimeInstallerFeature';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CapturedRuntimeSources } from '@features/agent-backend/main';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('Feature:codex-runtime-installer:ipc');

export function registerCodexRuntimeInstallerIpc(
  ipcMain: IpcMain,
  feature: CodexRuntimeInstallerFeatureFacade,
  capture?: (event: IpcMainInvokeEvent) => Promise<CapturedRuntimeSources> | null
): void {
  ipcMain.handle(
    CODEX_RUNTIME_GET_STATUS,
    (event: IpcMainInvokeEvent): Promise<IpcResult<CodexRuntimeStatus>> =>
      withIpcResult(async () => {
        const pending = capture?.(event),
          sources = pending ? await pending : undefined;
        await sources?.current();
        const status = await feature.getStatus();
        await sources?.current();
        return status;
      })
  );
  ipcMain.handle(
    CODEX_RUNTIME_INSTALL,
    (event: IpcMainInvokeEvent): Promise<IpcResult<CodexRuntimeStatus>> =>
      withIpcResult(async () => {
        const sources = capture?.(event);
        return feature.install(sources ? await sources : undefined);
      })
  );
  ipcMain.handle(
    CODEX_RUNTIME_INVALIDATE_STATUS,
    (event: IpcMainInvokeEvent): Promise<IpcResult<void>> =>
      withIpcResult(async () => {
        const sources = capture?.(event);
        await feature.invalidateStatus(sources ? await sources : undefined);
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
