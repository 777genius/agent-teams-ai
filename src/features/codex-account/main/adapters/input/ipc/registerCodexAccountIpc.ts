import {
  CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN,
  CODEX_ACCOUNT_GET_SNAPSHOT,
  CODEX_ACCOUNT_LOGOUT,
  CODEX_ACCOUNT_REFRESH_SNAPSHOT,
  CODEX_ACCOUNT_START_CHATGPT_LOGIN,
} from '@features/codex-account/contracts';

import type { CodexAccountFeatureFacade } from '../../../composition/createCodexAccountFeature';
import type { IpcMain } from 'electron';

export function registerCodexAccountIpc(
  ipcMain: IpcMain,
  feature: CodexAccountFeatureFacade
): void {
  ipcMain.handle(CODEX_ACCOUNT_GET_SNAPSHOT, () => feature.getSnapshot());
  ipcMain.handle(
    CODEX_ACCOUNT_REFRESH_SNAPSHOT,
    (_event, options?: { includeRateLimits?: boolean; forceRefreshToken?: boolean }) =>
      feature.refreshSnapshot(options)
  );
  ipcMain.handle(CODEX_ACCOUNT_START_CHATGPT_LOGIN, () => feature.startChatgptLogin());
  ipcMain.handle(CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN, () => feature.cancelLogin());
  ipcMain.handle(CODEX_ACCOUNT_LOGOUT, () => feature.logout());
}

export function removeCodexAccountIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CODEX_ACCOUNT_GET_SNAPSHOT);
  ipcMain.removeHandler(CODEX_ACCOUNT_REFRESH_SNAPSHOT);
  ipcMain.removeHandler(CODEX_ACCOUNT_START_CHATGPT_LOGIN);
  ipcMain.removeHandler(CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN);
  ipcMain.removeHandler(CODEX_ACCOUNT_LOGOUT);
}
