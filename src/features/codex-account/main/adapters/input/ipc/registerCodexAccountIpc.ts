import {
  CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN,
  CODEX_ACCOUNT_GET_SNAPSHOT,
  CODEX_ACCOUNT_LOGOUT,
  CODEX_ACCOUNT_REFRESH_SNAPSHOT,
  CODEX_ACCOUNT_START_CHATGPT_LOGIN,
  type CodexChatgptLoginMode,
  type CodexStartChatgptLoginOptions,
} from '@features/codex-account/contracts';

import type { CodexAccountFeatureFacade } from '../../../composition/createCodexAccountFeature';
import type { IpcMain } from 'electron';

function asOptionsRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseRefreshOptions(
  value: unknown
): { includeRateLimits?: boolean; forceRefreshToken?: boolean } | undefined {
  const options = asOptionsRecord(value, 'Codex account refresh options');
  if (!options) {
    return undefined;
  }

  for (const key of ['includeRateLimits', 'forceRefreshToken'] as const) {
    if (typeof options[key] !== 'undefined' && typeof options[key] !== 'boolean') {
      throw new TypeError(`Codex account refresh option ${key} must be a boolean.`);
    }
  }

  return {
    ...(typeof options.includeRateLimits === 'boolean'
      ? { includeRateLimits: options.includeRateLimits }
      : {}),
    ...(typeof options.forceRefreshToken === 'boolean'
      ? { forceRefreshToken: options.forceRefreshToken }
      : {}),
  };
}

function parseLoginOptions(value: unknown): CodexStartChatgptLoginOptions | undefined {
  const options = asOptionsRecord(value, 'Codex ChatGPT login options');
  if (!options) {
    return undefined;
  }

  const mode = options.mode;
  if (typeof mode === 'undefined') {
    return {};
  }
  if (mode !== 'browser' && mode !== 'device_code') {
    throw new TypeError('Codex ChatGPT login mode must be browser or device_code.');
  }
  return { mode: mode as CodexChatgptLoginMode };
}

export function registerCodexAccountIpc(
  ipcMain: IpcMain,
  feature: CodexAccountFeatureFacade
): void {
  ipcMain.handle(CODEX_ACCOUNT_GET_SNAPSHOT, () => feature.getSnapshot());
  ipcMain.handle(CODEX_ACCOUNT_REFRESH_SNAPSHOT, (_event, options?: unknown) =>
    feature.refreshSnapshot(parseRefreshOptions(options))
  );
  ipcMain.handle(CODEX_ACCOUNT_START_CHATGPT_LOGIN, (_event, options?: unknown) =>
    feature.startChatgptLogin(parseLoginOptions(options))
  );
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
