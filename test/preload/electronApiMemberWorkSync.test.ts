import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';

const mocks = vi.hoisted(() => {
  const memberWorkSyncBridge = {
    getStatus: vi.fn(),
    getMetrics: vi.fn(),
    report: vi.fn(),
  };

  return {
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    },
    memberWorkSyncBridge,
    createMemberWorkSyncBridge: vi.fn(() => memberWorkSyncBridge),
    webUtils: {
      getPathForFile: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
  webUtils: mocks.webUtils,
}));

vi.mock('@features/member-work-sync/preload', () => ({
  createMemberWorkSyncBridge: mocks.createMemberWorkSyncBridge,
}));

describe('preload electronAPI memberWorkSync wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockClear();
    mocks.createMemberWorkSyncBridge.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes the member work sync bridge on the shared Electron API', async () => {
    await import('../../src/preload/index');

    expect(mocks.createMemberWorkSyncBridge).toHaveBeenCalledWith(mocks.ipcRenderer);
    expect(mocks.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);

    const [apiName, electronAPI] = mocks.contextBridge.exposeInMainWorld.mock.calls[0] as [
      string,
      ElectronAPI,
    ];

    expect(apiName).toBe('electronAPI');
    expect(electronAPI.memberWorkSync).toBe(mocks.memberWorkSyncBridge);
  });

  it('wires the Windows elevation status API to the app IPC channel', async () => {
    await import('../../src/preload/index');

    const [, electronAPI] = mocks.contextBridge.exposeInMainWorld.mock.calls[0] as [
      string,
      ElectronAPI,
    ];
    const expectedStatus = {
      platform: 'win32',
      isWindows: true,
      isAdministrator: false,
      checkFailed: false,
      error: null,
    };
    mocks.ipcRenderer.invoke.mockResolvedValueOnce(expectedStatus);

    await expect(electronAPI.getWindowsElevationStatus()).resolves.toBe(expectedStatus);
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('app:getWindowsElevationStatus');
  });
});
