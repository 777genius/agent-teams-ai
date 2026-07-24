import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';

const mocks = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

vi.mock('electron', () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
  webUtils: mocks.webUtils,
}));

function getElectronApi(): ElectronAPI {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'electronAPI'
  );
  if (!call) throw new Error('Expected electronAPI to be exposed in preload');
  return call[1] as ElectronAPI;
}

describe('preload team configuration wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (window as Window & { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__;
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockReset();
    mocks.ipcRenderer.invoke.mockResolvedValue({ success: true, data: null });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps channel names and argument order stable', async () => {
    await import('../../src/preload/index');
    const teams = getElectronApi().teams;
    const createRequest = { teamName: 'demo-team', members: [] };
    const updates = { name: 'Demo Team', description: 'Updated' };

    await teams.createConfig(createRequest);
    await teams.updateConfig('demo-team', updates);
    await teams.getSavedRequest('demo-team');
    await teams.deleteDraft('demo-team');

    expect(mocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['team:createConfig', createRequest],
      ['team:updateConfig', 'demo-team', updates],
      ['team:getSavedRequest', 'demo-team'],
      ['team:deleteDraft', 'demo-team'],
    ]);
  });
});
