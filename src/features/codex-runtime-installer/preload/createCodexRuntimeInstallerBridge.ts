import {
  CODEX_RUNTIME_GET_STATUS,
  CODEX_RUNTIME_INSTALL,
  CODEX_RUNTIME_INVALIDATE_STATUS,
  CODEX_RUNTIME_PROGRESS,
} from '@features/codex-runtime-installer/contracts';

import type { CodexRuntimeAPI } from '@features/codex-runtime-installer/contracts';
import type { IpcRenderer } from 'electron';

interface CreateCodexRuntimeInstallerBridgeDeps {
  ipcRenderer: IpcRenderer;
  invokeIpcWithResult: <T>(channel: string, ...args: unknown[]) => Promise<T>;
}

export function createCodexRuntimeInstallerBridge({
  ipcRenderer,
  invokeIpcWithResult,
}: CreateCodexRuntimeInstallerBridgeDeps): CodexRuntimeAPI {
  return {
    getStatus: () => invokeIpcWithResult(CODEX_RUNTIME_GET_STATUS),
    install: () => invokeIpcWithResult(CODEX_RUNTIME_INSTALL),
    invalidateStatus: () => invokeIpcWithResult(CODEX_RUNTIME_INVALIDATE_STATUS),
    onProgress: (callback) => {
      ipcRenderer.on(
        CODEX_RUNTIME_PROGRESS,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          CODEX_RUNTIME_PROGRESS,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  };
}
