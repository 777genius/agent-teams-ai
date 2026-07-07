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

function getExposedValue<TValue>(name: string): TValue {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(([exposedName]) => {
    return exposedName === name;
  });
  if (!call) {
    throw new Error(`Expected ${name} to be exposed in preload`);
  }
  return call[1] as TValue;
}

describe('preload electronAPI memberWorkSync wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (window as Window & { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__;
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

    const electronAPI = getExposedValue<ElectronAPI>('electronAPI');
    expect(electronAPI.memberWorkSync).toBe(mocks.memberWorkSyncBridge);
  });

  it('exposes Sentry renderer IPC without relying on package subpath exports', async () => {
    await import('../../src/preload/index');

    const sentryIpc = getExposedValue<Record<string, { sendRendererStart: () => void }>>(
      '__SENTRY_IPC__'
    );

    expect(sentryIpc['sentry-ipc']).toEqual(
      expect.objectContaining({
        sendRendererStart: expect.any(Function),
        sendEnvelope: expect.any(Function),
        sendScope: expect.any(Function),
      })
    );

    sentryIpc['sentry-ipc'].sendRendererStart();
    expect(mocks.ipcRenderer.send).toHaveBeenCalledWith('sentry-ipc.start');
  });

  it('wires the Windows elevation status API to the app IPC channel', async () => {
    await import('../../src/preload/index');

    const electronAPI = getExposedValue<ElectronAPI>('electronAPI');
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
