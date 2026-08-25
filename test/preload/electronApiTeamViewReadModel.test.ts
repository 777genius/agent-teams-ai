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
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'electronAPI'
  );
  if (!call) throw new Error('Expected electronAPI to be exposed in preload');
  return call[1] as ElectronAPI;
}

describe('preload team view read-model wiring', () => {
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

  it('keeps channel names, argument order, and optional argument arity stable', async () => {
    await import('../../src/preload/index');
    const teams = getElectronApi().teams;
    const dataOptions = { includeMemberBranches: false } as const;
    const pageOptions = { cursor: 'cursor-1', limit: 25 };

    await teams.getData('team-one');
    await teams.getData('team-one', dataOptions);
    await teams.getMessagesPage('team-one');
    await teams.getMessagesPage('team-one', pageOptions);
    await teams.getMemberActivityMeta('team-one');

    expect(mocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['team:getData', 'team-one'],
      ['team:getData', 'team-one', dataOptions],
      ['team:getMessagesPage', 'team-one', undefined],
      ['team:getMessagesPage', 'team-one', pageOptions],
      ['team:getMemberActivityMeta', 'team-one'],
    ]);
  });
});
