import {
  CODEX_ACCOUNT_REFRESH_SNAPSHOT,
  CODEX_ACCOUNT_START_CHATGPT_LOGIN,
} from '@features/codex-account/contracts';
import { registerCodexAccountIpc } from '@features/codex-account/main/adapters/input/ipc/registerCodexAccountIpc';
import { describe, expect, it, vi } from 'vitest';

import type { CodexAccountFeatureFacade } from '@features/codex-account/main/composition/createCodexAccountFeature';

function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  };
  const feature = {
    refreshSnapshot: vi.fn(),
    startChatgptLogin: vi.fn(),
  } as unknown as CodexAccountFeatureFacade;
  registerCodexAccountIpc(ipcMain as never, feature);
  return { handlers, feature };
}

describe('registerCodexAccountIpc', () => {
  it('forwards validated refresh and login options', () => {
    const { handlers, feature } = createHarness();

    handlers.get(CODEX_ACCOUNT_REFRESH_SNAPSHOT)?.(
      {},
      {
        includeRateLimits: true,
        forceRefreshToken: false,
      }
    );
    handlers.get(CODEX_ACCOUNT_START_CHATGPT_LOGIN)?.({}, { mode: 'device_code' });

    expect(feature.refreshSnapshot).toHaveBeenCalledWith({
      includeRateLimits: true,
      forceRefreshToken: false,
    });
    expect(feature.startChatgptLogin).toHaveBeenCalledWith({ mode: 'device_code' });
  });

  it('rejects malformed refresh options before invoking the feature', () => {
    const { handlers, feature } = createHarness();
    const handler = handlers.get(CODEX_ACCOUNT_REFRESH_SNAPSHOT);

    expect(() => handler?.({}, { includeRateLimits: 'yes' })).toThrow(
      'Codex account refresh option includeRateLimits must be a boolean.'
    );
    expect(() => handler?.({}, [])).toThrow('Codex account refresh options must be an object.');
    expect(feature.refreshSnapshot).not.toHaveBeenCalled();
  });

  it('rejects malformed login modes before invoking the feature', () => {
    const { handlers, feature } = createHarness();
    const handler = handlers.get(CODEX_ACCOUNT_START_CHATGPT_LOGIN);

    expect(() => handler?.({}, { mode: 'automatic' })).toThrow(
      'Codex ChatGPT login mode must be browser or device_code.'
    );
    expect(feature.startChatgptLogin).not.toHaveBeenCalled();
  });
});
