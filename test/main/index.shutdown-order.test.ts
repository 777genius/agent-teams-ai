import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  app: {
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- Isolated test-only Electron userData path.
    getPath: vi.fn(() => '/tmp/agent-teams-index-shutdown-test'),
    getVersion: vi.fn(() => '1.3.0'),
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows(): [] {
      return [];
    }
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron', () => electronMock);
vi.mock('electron-updater', () => {
  const autoUpdater = {
    on: vi.fn(),
  };
  return { autoUpdater, default: { autoUpdater } };
});

let disposeInternalStorageAfterWriterDrains: typeof import('@main/index').disposeInternalStorageAfterWriterDrains;

beforeAll(async () => {
  ({ disposeInternalStorageAfterWriterDrains } = await import('@main/index'));
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('internal storage shutdown order', () => {
  it('stops polling and drains storage writers before disposing storage', async () => {
    const order: string[] = [];

    await disposeInternalStorageAfterWriterDrains({
      teamDataService: {
        stopProcessHealthPolling: () => {
          order.push('team-data-polling-stop');
        },
      },
      teamTaskStallMonitor: {
        stop: () => {
          order.push('stall-monitor-drain');
          return Promise.resolve();
        },
      },
      memberWorkSyncFeature: {
        dispose: () => {
          order.push('member-work-sync-drain');
          return Promise.resolve();
        },
      },
      internalStorageFeature: {
        dispose: () => {
          order.push('internal-storage-dispose');
          return Promise.resolve();
        },
      },
    });

    expect(order).toEqual([
      'team-data-polling-stop',
      'stall-monitor-drain',
      'member-work-sync-drain',
      'internal-storage-dispose',
    ]);
  });

  it('keeps storage behind timed-out drains without deadlocking shutdown', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const stallMonitorDrain = createDeferred();
    const memberWorkSyncDrain = createDeferred();
    const internalStorageDispose = vi.fn(() => {
      order.push('internal-storage-dispose');
      return Promise.resolve();
    });

    const shutdown = disposeInternalStorageAfterWriterDrains(
      {
        teamDataService: {
          stopProcessHealthPolling: () => {
            order.push('team-data-polling-stop');
          },
        },
        teamTaskStallMonitor: {
          stop: () => {
            order.push('stall-monitor-stop-started');
            return stallMonitorDrain.promise;
          },
        },
        memberWorkSyncFeature: {
          dispose: () => {
            order.push('member-work-sync-stop-started');
            return memberWorkSyncDrain.promise;
          },
        },
        internalStorageFeature: {
          dispose: internalStorageDispose,
        },
      },
      { stepTimeoutMs: 5 }
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([
      'team-data-polling-stop',
      'stall-monitor-stop-started',
      'member-work-sync-stop-started',
    ]);

    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);
    await shutdown;

    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      '[App] Shutdown step timed out after 5ms: team task stall monitor stop',
      '[App] Shutdown step timed out after 5ms: member work sync dispose',
      '[App] Shutdown step timed out after 5ms: internal storage dispose',
    ]);
    vi.mocked(console.warn).mockClear();
    expect(internalStorageDispose).not.toHaveBeenCalled();

    stallMonitorDrain.resolve();
    await flushPromises();
    expect(internalStorageDispose).not.toHaveBeenCalled();

    memberWorkSyncDrain.resolve();
    await flushPromises();
    expect(internalStorageDispose).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('internal-storage-dispose');
  });
});
