import {
  TEAM_UPDATE_MEMBER_SETTINGS,
  type UpdateMemberSettingsRequest,
} from '@features/team-provisioning/contracts';
import {
  type BeginRosterAuthorizationTransactionRequest,
  TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
} from '@shared/types/rosterAuthorizationTransaction';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';

const mocks = vi.hoisted(() => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
  webUtils: {
    getPathForFile: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
  webUtils: mocks.webUtils,
}));

function getElectronApi(): ElectronAPI {
  const exposure = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'electronAPI'
  );
  if (!exposure) throw new Error('Expected electronAPI to be exposed');
  return exposure[1] as ElectronAPI;
}

describe('preload teams boundary composition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (window as Window & { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__;
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps issue 443 roster authorization and member settings on one typed API', async () => {
    await import('../../src/preload/index');
    const teams = getElectronApi().teams;
    const rosterRequest: BeginRosterAuthorizationTransactionRequest = {
      transactionId: 'transaction-1',
      members: [],
    };
    const settingsRequest: UpdateMemberSettingsRequest = {
      commandId: 'command-1',
      idempotencyKey: 'settings-1',
      teamName: 'team-a',
      memberName: 'worker',
      expectedFingerprint: 'before',
      targetKind: 'member',
      settings: {
        role: 'Builder',
        workflow: null,
        isolation: 'worktree',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.6-sol',
        effort: 'medium',
        fastMode: 'inherit',
        mcpPolicy: null,
      },
    };

    mocks.ipcRenderer.invoke.mockResolvedValue({ success: true, data: {} });

    await teams.beginRosterAuthorizationTransaction('team-a', rosterRequest);
    await teams.updateMemberSettings(settingsRequest);

    expect(mocks.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
      'team-a',
      rosterRequest
    );
    expect(mocks.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      TEAM_UPDATE_MEMBER_SETTINGS,
      settingsRequest
    );
  });
});
