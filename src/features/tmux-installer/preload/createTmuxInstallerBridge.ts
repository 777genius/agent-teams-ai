import {
  TMUX_CANCEL_INSTALL,
  TMUX_GET_INSTALLER_SNAPSHOT,
  TMUX_GET_STATUS,
  TMUX_INSTALL,
  TMUX_INSTALLER_PROGRESS,
  TMUX_INVALIDATE_STATUS,
  TMUX_SUBMIT_INSTALLER_INPUT,
} from '@features/tmux-installer/contracts';

import type { TmuxAPI } from '@features/tmux-installer/contracts';
import type { IpcRenderer } from 'electron';

interface CreateTmuxInstallerBridgeDeps {
  ipcRenderer: IpcRenderer;
  invokeIpcWithResult: <T>(channel: string, ...args: unknown[]) => Promise<T>;
}

export function createTmuxInstallerBridge({
  ipcRenderer,
  invokeIpcWithResult,
}: CreateTmuxInstallerBridgeDeps): TmuxAPI {
  return {
    getStatus: () => invokeIpcWithResult(TMUX_GET_STATUS),
    getInstallerSnapshot: () => invokeIpcWithResult(TMUX_GET_INSTALLER_SNAPSHOT),
    install: () => invokeIpcWithResult(TMUX_INSTALL),
    cancelInstall: () => invokeIpcWithResult(TMUX_CANCEL_INSTALL),
    submitInstallerInput: (input) => invokeIpcWithResult(TMUX_SUBMIT_INSTALLER_INPUT, input),
    invalidateStatus: () => invokeIpcWithResult(TMUX_INVALIDATE_STATUS),
    onProgress: (callback) => {
      ipcRenderer.on(
        TMUX_INSTALLER_PROGRESS,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          TMUX_INSTALLER_PROGRESS,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  };
}
