import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN,
  CODEX_ACCOUNT_GET_SNAPSHOT,
  CODEX_ACCOUNT_LOGOUT,
  CODEX_ACCOUNT_REFRESH_SNAPSHOT,
  CODEX_ACCOUNT_SNAPSHOT_CHANGED,
  CODEX_ACCOUNT_START_CHATGPT_LOGIN,
} from '../../../../src/features/codex-account/contracts';
import { createCodexAccountBridge } from '../../../../src/features/codex-account/preload/createCodexAccountBridge';

describe('createCodexAccountBridge', () => {
  it('forwards Codex account IPC requests through raw ipcRenderer.invoke and returns raw payloads', async () => {
    const snapshot = { ok: true };
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue(snapshot),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createCodexAccountBridge({
      ipcRenderer: ipcRenderer as never,
    });

    const refreshOptions = {
      includeRateLimits: true,
      forceRefreshToken: true,
    };

    await expect(bridge.getCodexAccountSnapshot()).resolves.toBe(snapshot);
    await expect(bridge.refreshCodexAccountSnapshot(refreshOptions)).resolves.toBe(snapshot);
    await expect(bridge.startCodexChatgptLogin()).resolves.toBe(snapshot);
    await expect(bridge.cancelCodexChatgptLogin()).resolves.toBe(snapshot);
    await expect(bridge.logoutCodexAccount()).resolves.toBe(snapshot);

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [CODEX_ACCOUNT_GET_SNAPSHOT],
      [CODEX_ACCOUNT_REFRESH_SNAPSHOT, refreshOptions],
      [CODEX_ACCOUNT_START_CHATGPT_LOGIN],
      [CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN],
      [CODEX_ACCOUNT_LOGOUT],
    ]);
  });

  it('subscribes and unsubscribes from Codex snapshot change notifications', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createCodexAccountBridge({
      ipcRenderer: ipcRenderer as never,
    });
    const callback = vi.fn();

    const unsubscribe = bridge.onCodexAccountSnapshotChanged(callback);

    expect(ipcRenderer.on).toHaveBeenCalledWith(CODEX_ACCOUNT_SNAPSHOT_CHANGED, callback);

    unsubscribe();

    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      CODEX_ACCOUNT_SNAPSHOT_CHANGED,
      callback
    );
  });
});
