import {
  TMUX_CANCEL_INSTALL,
  TMUX_GET_INSTALLER_SNAPSHOT,
  TMUX_GET_STATUS,
  TMUX_INSTALL,
  TMUX_INVALIDATE_STATUS,
  TMUX_SUBMIT_INSTALLER_INPUT,
} from '@features/tmux-installer/contracts';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { TmuxInstallerFeatureFacade } from '../../../composition/createTmuxInstallerFeature';
import type { TmuxInstallerSnapshot, TmuxStatus } from '@features/tmux-installer/contracts';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('Feature:tmux-installer:ipc');

export function registerTmuxInstallerIpc(
  ipcMain: IpcMain,
  feature: TmuxInstallerFeatureFacade
): void {
  ipcMain.handle(
    TMUX_GET_STATUS,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<TmuxStatus>> =>
      withIpcResult(() => feature.getStatus())
  );
  ipcMain.handle(
    TMUX_GET_INSTALLER_SNAPSHOT,
    (_event: IpcMainInvokeEvent): IpcResult<TmuxInstallerSnapshot> =>
      withSyncIpcResult(() => feature.getInstallerSnapshot())
  );
  ipcMain.handle(
    TMUX_INSTALL,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<void>> => withIpcResult(() => feature.install())
  );
  ipcMain.handle(
    TMUX_CANCEL_INSTALL,
    (_event: IpcMainInvokeEvent): Promise<IpcResult<void>> =>
      withIpcResult(() => feature.cancelInstall())
  );
  ipcMain.handle(
    TMUX_SUBMIT_INSTALLER_INPUT,
    (_event: IpcMainInvokeEvent, input: string): Promise<IpcResult<void>> =>
      withIpcResult(() => feature.submitInstallerInput(input))
  );
  ipcMain.handle(
    TMUX_INVALIDATE_STATUS,
    (_event: IpcMainInvokeEvent): IpcResult<void> =>
      withSyncIpcResult(() => {
        feature.invalidateStatus();
        return undefined;
      })
  );
  logger.info('tmux installer IPC handlers registered');
}

export function removeTmuxInstallerIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TMUX_GET_STATUS);
  ipcMain.removeHandler(TMUX_GET_INSTALLER_SNAPSHOT);
  ipcMain.removeHandler(TMUX_INSTALL);
  ipcMain.removeHandler(TMUX_CANCEL_INSTALL);
  ipcMain.removeHandler(TMUX_SUBMIT_INSTALLER_INPUT);
  ipcMain.removeHandler(TMUX_INVALIDATE_STATUS);
  logger.info('tmux installer IPC handlers removed');
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
