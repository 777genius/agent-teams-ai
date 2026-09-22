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

describe('preload task log observability wiring', () => {
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

  it('keeps all six channel names and argument orders stable', async () => {
    await import('../../src/preload/index');
    const teams = getElectronApi().teams;

    await teams.getTaskActivity('team-one', 'task-1');
    await teams.getTaskActivityDetail('team-one', 'task-1', 'activity-1');
    await teams.getTaskLogStreamSummary('team-one', 'task-1');
    await teams.getTaskLogStream('team-one', 'task-1');
    await teams.getTaskExactLogSummaries('team-one', 'task-1');
    await teams.getTaskExactLogDetail('team-one', 'task-1', 'exact-1', 'generation-1');

    expect(mocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['team:getTaskActivity', 'team-one', 'task-1'],
      ['team:getTaskActivityDetail', 'team-one', 'task-1', 'activity-1'],
      ['team:getTaskLogStreamSummary', 'team-one', 'task-1'],
      ['team:getTaskLogStream', 'team-one', 'task-1'],
      ['team:getTaskExactLogSummaries', 'team-one', 'task-1'],
      ['team:getTaskExactLogDetail', 'team-one', 'task-1', 'exact-1', 'generation-1'],
    ]);
  });
});
