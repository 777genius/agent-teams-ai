import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';
import type { ToolApprovalSettings } from '@shared/types/team';

const mocks = vi.hoisted(() => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
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

describe('preload team approvals wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (window as Window & { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__;
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockReset();
    mocks.ipcRenderer.invoke.mockResolvedValue({ success: true, data: null });
    mocks.ipcRenderer.on.mockReset();
    mocks.ipcRenderer.removeListener.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps approval command channel names and argument orders stable', async () => {
    await import('../../src/preload/index');
    const teams = getElectronApi().teams;
    const settings: ToolApprovalSettings = {
      autoAllowAll: false,
      autoAllowFileEdits: true,
      autoAllowSafeBash: false,
      timeoutAction: 'deny',
      timeoutSeconds: 45,
    };

    await teams.respondToToolApproval('team-one', 'run-1', 'request-1', false, 'Not allowed');
    await teams.updateToolApprovalSettings('team-one', settings);
    const toolOutputPath = path.resolve('tool-output.txt');
    await teams.readFileForToolApproval(toolOutputPath);

    expect(mocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['team:toolApprovalRespond', 'team-one', 'run-1', 'request-1', false, 'Not allowed'],
      ['team:toolApprovalSettings', 'team-one', settings],
      ['team:toolApprovalReadFile', toolOutputPath],
    ]);
  });

  it('subscribes and unsubscribes the same callback on the approval event channel', async () => {
    await import('../../src/preload/index');
    const callback = vi.fn();

    const cleanup = getElectronApi().teams.onToolApprovalEvent(callback);

    expect(
      mocks.ipcRenderer.on.mock.calls.filter(([channel]) => channel === 'team:toolApprovalEvent')
    ).toHaveLength(1);
    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith('team:toolApprovalEvent', callback);

    cleanup();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledOnce();
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'team:toolApprovalEvent',
      callback
    );
  });
});
