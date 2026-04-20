import {
  CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN,
  CODEX_ACCOUNT_GET_SNAPSHOT,
  CODEX_ACCOUNT_LOGOUT,
  CODEX_ACCOUNT_REFRESH_SNAPSHOT,
  CODEX_ACCOUNT_SNAPSHOT_CHANGED,
  CODEX_ACCOUNT_START_CHATGPT_LOGIN,
  type CodexAccountElectronApi,
} from '@features/codex-account/contracts';

import type { IpcRenderer } from 'electron';

interface CreateCodexAccountBridgeDeps {
  ipcRenderer: IpcRenderer;
}

export function createCodexAccountBridge({
  ipcRenderer,
}: CreateCodexAccountBridgeDeps): CodexAccountElectronApi {
  return {
    getCodexAccountSnapshot: () => ipcRenderer.invoke(CODEX_ACCOUNT_GET_SNAPSHOT),
    refreshCodexAccountSnapshot: (options) =>
      ipcRenderer.invoke(CODEX_ACCOUNT_REFRESH_SNAPSHOT, options),
    startCodexChatgptLogin: () => ipcRenderer.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN),
    cancelCodexChatgptLogin: () => ipcRenderer.invoke(CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN),
    logoutCodexAccount: () => ipcRenderer.invoke(CODEX_ACCOUNT_LOGOUT),
    onCodexAccountSnapshotChanged: (callback) => {
      ipcRenderer.on(
        CODEX_ACCOUNT_SNAPSHOT_CHANGED,
        callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
      );
      return (): void => {
        ipcRenderer.removeListener(
          CODEX_ACCOUNT_SNAPSHOT_CHANGED,
          callback as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
        );
      };
    },
  };
}
