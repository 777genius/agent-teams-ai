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

function getExposedValue<TValue>(name: string): TValue {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(([exposedName]) => {
    return exposedName === name;
  });
  if (!call) {
    throw new Error(`Expected ${name} to be exposed in preload`);
  }
  return call[1] as TValue;
}

async function loadElectronAPI(): Promise<ElectronAPI> {
  await import('../../src/preload/index');
  return getExposedValue<ElectronAPI>('electronAPI');
}

describe('preload electronAPI queued user message wiring', () => {
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
    vi.restoreAllMocks();
  });

  it('wires the queued message listing to its team IPC channel', async () => {
    const electronAPI = await loadElectronAPI();
    const snapshot = {
      member: 'bob/qa',
      messages: [{ messageId: 'message-1', text: 'ping', timestamp: 'ts' }],
    };
    mocks.ipcRenderer.invoke.mockResolvedValueOnce({ success: true, data: snapshot });

    await expect(electronAPI.teams.getQueuedUserMessages('demo team', 'bob/qa')).resolves.toEqual(
      snapshot
    );
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      'team:getQueuedUserMessages',
      'demo team',
      'bob/qa'
    );
  });

  it('forwards the discard target, including "every queued message" as an absent id', async () => {
    const electronAPI = await loadElectronAPI();
    mocks.ipcRenderer.invoke
      .mockResolvedValueOnce({ success: true, data: { discarded: 1, remainingQueued: 0 } })
      .mockResolvedValueOnce({ success: true, data: { discarded: 3, remainingQueued: 0 } });

    await expect(
      electronAPI.teams.discardQueuedUserMessages('demo team', 'bob/qa', 'message-1')
    ).resolves.toEqual({ discarded: 1, remainingQueued: 0 });
    expect(mocks.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      'team:discardQueuedUserMessages',
      'demo team',
      'bob/qa',
      'message-1'
    );

    // The main handler reads an absent messageId as "discard the whole queue",
    // so the argument has to reach it as undefined rather than be dropped.
    await expect(
      electronAPI.teams.discardQueuedUserMessages('demo team', 'bob/qa')
    ).resolves.toEqual({ discarded: 3, remainingQueued: 0 });
    expect(mocks.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      'team:discardQueuedUserMessages',
      'demo team',
      'bob/qa',
      undefined
    );
  });

  it('rejects with the main-process error instead of resolving a failed result', async () => {
    const electronAPI = await loadElectronAPI();
    mocks.ipcRenderer.invoke
      .mockResolvedValueOnce({ success: false, error: 'Invalid inbox path' })
      .mockResolvedValueOnce({ success: false, error: 'Invalid inbox path' });

    await expect(electronAPI.teams.getQueuedUserMessages('demo team', '../escape')).rejects.toThrow(
      'Invalid inbox path'
    );
    await expect(
      electronAPI.teams.discardQueuedUserMessages('demo team', '../escape')
    ).rejects.toThrow('Invalid inbox path');
  });
});
