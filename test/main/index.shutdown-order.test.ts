import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const windows: {
    isDestroyed: () => boolean;
    show: () => void;
    focus: () => void;
  }[] = [];

  return {
    windows,
    app: {
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- Isolated test-only Electron userData path.
      getPath: vi.fn(() => '/tmp/agent-teams-index-shutdown-test'),
      getVersion: vi.fn(() => '1.3.0'),
      isPackaged: false,
      on: vi.fn(),
      whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() {
        return windows;
      }
    },
    dialog: {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeListener: vi.fn(),
    },
  };
});

const electronUpdaterMock = vi.hoisted(() => {
  const listeners = new Map<string, (value: { version: string }) => void>();
  return {
    listeners,
    autoUpdater: {
      on: vi.fn((event: string, listener: (value: { version: string }) => void) => {
        listeners.set(event, listener);
      }),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock('electron', () => electronMock);
vi.mock('electron-updater', () => {
  const { autoUpdater } = electronUpdaterMock;
  return { autoUpdater, default: { autoUpdater } };
});

let disposeInternalStorageAfterWriterDrains: typeof import('@main/index').disposeInternalStorageAfterWriterDrains;
let reportDesktopShutdownFailure: typeof import('@main/index').reportDesktopShutdownFailure;
let runDesktopQuitLifecycle: typeof import('@main/index').runDesktopQuitLifecycle;
let runDesktopUpdateInstallLifecycle: typeof import('@main/index').runDesktopUpdateInstallLifecycle;
let runDesktopWindowCloseLifecycle: typeof import('@main/index').runDesktopWindowCloseLifecycle;
let shouldQuitAfterDesktopWindowClose: typeof import('@main/index').shouldQuitAfterDesktopWindowClose;
let UpdaterService: typeof import('@main/services/infrastructure/UpdaterService').UpdaterService;

beforeAll(async () => {
  ({
    disposeInternalStorageAfterWriterDrains,
    reportDesktopShutdownFailure,
    runDesktopQuitLifecycle,
    runDesktopUpdateInstallLifecycle,
    runDesktopWindowCloseLifecycle,
    shouldQuitAfterDesktopWindowClose,
  } = await import('@main/index'));
  ({ UpdaterService } = await import('@main/services/infrastructure/UpdaterService'));
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  electronMock.windows.length = 0;
  electronMock.dialog.showMessageBox.mockClear();
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

describe('desktop ConfigManager shutdown order', () => {
  it.each([
    ['app-quit', 'quit', 'Shutdown failed'],
    ['relaunch', 'relaunch', 'Shutdown failed'],
    ['update-install', 'update install', 'Shutdown before update install failed'],
  ] as const)(
    'surfaces deterministic %s failure through the desktop error convention',
    async (reason, actionLabel, logLabel) => {
      const flushFailure = new Error('injected final ConfigManager flush failure');
      const window = {
        isDestroyed: vi.fn(() => false),
        show: vi.fn(),
        focus: vi.fn(),
      };
      electronMock.windows.push(window);

      await reportDesktopShutdownFailure(reason, flushFailure);

      expect(window.show).toHaveBeenCalledOnce();
      expect(window.focus).toHaveBeenCalledOnce();
      expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
        window,
        expect.objectContaining({
          type: 'error',
          title: 'Changes could not finish shutting down',
          message: `The ${actionLabel} was canceled because app data could not be saved.`,
          detail: flushFailure.message,
          buttons: ['OK'],
        })
      );
      expect(console.error).toHaveBeenCalledWith('[App]', `${logLabel}: ${flushFailure.message}`);
      vi.mocked(console.error).mockClear();
    }
  );

  it.each(['linux', 'win32'] as const)(
    'treats the last %s window close as an app quit before destroying the window',
    (platform) => {
      expect(
        shouldQuitAfterDesktopWindowClose({
          platform,
          remainingWindowCount: 0,
          hasActiveTeamRuntimes: false,
          showDockIcon: true,
        })
      ).toBe(true);
      expect(
        shouldQuitAfterDesktopWindowClose({
          platform,
          remainingWindowCount: 1,
          hasActiveTeamRuntimes: false,
          showDockIcon: true,
        })
      ).toBe(false);
    }
  );

  it('retains the normal macOS last-window policy without bypassing active-runtime shutdown', () => {
    expect(
      shouldQuitAfterDesktopWindowClose({
        platform: 'darwin',
        remainingWindowCount: 0,
        hasActiveTeamRuntimes: false,
        showDockIcon: true,
      })
    ).toBe(false);
    expect(
      shouldQuitAfterDesktopWindowClose({
        platform: 'darwin',
        remainingWindowCount: 0,
        hasActiveTeamRuntimes: true,
        showDockIcon: true,
      })
    ).toBe(true);
    expect(
      shouldQuitAfterDesktopWindowClose({
        platform: 'darwin',
        remainingWindowCount: 0,
        hasActiveTeamRuntimes: false,
        showDockIcon: false,
      })
    ).toBe(true);
  });

  it('keeps an ordinary window close behind renderer readiness without starting app quit', async () => {
    const requestAppQuit = vi.fn(() => Promise.resolve(true));
    const requestWindowCloseReadiness = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const authorizeWindowClose = vi.fn();
    const closeWindow = vi.fn();
    const actions = {
      isWindowUsable: () => true,
      shouldQuitAfterClose: () => false,
      requestAppQuit,
      requestWindowCloseReadiness,
      authorizeWindowClose,
      closeWindow,
    };

    await expect(runDesktopWindowCloseLifecycle(actions)).resolves.toBe(false);
    expect(authorizeWindowClose).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();

    await expect(runDesktopWindowCloseLifecycle(actions)).resolves.toBe(true);
    expect(requestAppQuit).not.toHaveBeenCalled();
    expect(authorizeWindowClose).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('leaves the last window fully usable after flush failure and quits on a later retry', async () => {
    const order: string[] = [];
    const flushFailure = new Error('first last-window flush failed');
    const flushConfig = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        order.push('flush-failed');
        return Promise.reject(flushFailure);
      })
      .mockImplementationOnce(() => {
        order.push('flush-retried');
        return Promise.resolve();
      });
    const windowState = {
      destroyed: false,
      visible: true,
      focused: true,
      interactive: true,
    };
    const requestWindowCloseReadiness = vi.fn(() => Promise.resolve(true));
    const authorizeWindowClose = vi.fn();
    const closeWindow = vi.fn(() => {
      windowState.destroyed = true;
    });
    const requestAppQuit = () =>
      runDesktopQuitLifecycle('app-quit', {
        flushConfig,
        shutdownServices: () => {
          order.push('shutdown');
          return Promise.resolve();
        },
        reportShutdownFailure: () => {
          order.push('report');
          windowState.visible = true;
          windowState.focused = true;
        },
        prepareToQuit: () => {
          order.push('prepare');
          windowState.visible = false;
          windowState.interactive = false;
        },
        markShutdownComplete: () => {
          order.push('complete');
        },
        relaunch: vi.fn(),
        quit: () => {
          order.push('quit');
          windowState.destroyed = true;
        },
      });
    const actions = {
      isWindowUsable: () => !windowState.destroyed && windowState.interactive,
      shouldQuitAfterClose: () => true,
      requestAppQuit,
      requestWindowCloseReadiness,
      authorizeWindowClose,
      closeWindow,
    };

    await expect(runDesktopWindowCloseLifecycle(actions)).resolves.toBe(false);

    expect(order).toEqual(['flush-failed', 'report']);
    expect(windowState).toEqual({
      destroyed: false,
      visible: true,
      focused: true,
      interactive: true,
    });
    expect(requestWindowCloseReadiness).not.toHaveBeenCalled();
    expect(authorizeWindowClose).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();

    await expect(runDesktopWindowCloseLifecycle(actions)).resolves.toBe(true);

    expect(order).toEqual([
      'flush-failed',
      'report',
      'flush-retried',
      'shutdown',
      'prepare',
      'complete',
      'quit',
    ]);
    expect(flushConfig).toHaveBeenCalledTimes(2);
    expect(windowState.destroyed).toBe(true);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it.each(['app-quit', 'relaunch'] as const)(
    'does not complete or proceed with %s when the final flush rejects',
    async (reason) => {
      const flushFailure = new Error('injected final ConfigManager flush failure');
      const flush = vi.fn(() => Promise.reject(flushFailure));
      const shutdownServices = vi.fn(() => Promise.resolve());
      const reportShutdownFailure = vi.fn(() => Promise.resolve());
      const prepareToQuit = vi.fn();
      const markShutdownComplete = vi.fn();
      const relaunch = vi.fn();
      const quit = vi.fn();

      await expect(
        runDesktopQuitLifecycle(reason, {
          flushConfig: flush,
          shutdownServices,
          reportShutdownFailure,
          prepareToQuit,
          markShutdownComplete,
          relaunch,
          quit,
        })
      ).resolves.toBe(false);

      expect(shutdownServices).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledOnce();
      expect(reportShutdownFailure).toHaveBeenCalledWith(flushFailure);
      expect(prepareToQuit).not.toHaveBeenCalled();
      expect(markShutdownComplete).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
    }
  );

  it.each(['app-quit', 'relaunch'] as const)(
    'completes %s only after a successful final flush',
    async (reason) => {
      const order: string[] = [];

      await expect(
        runDesktopQuitLifecycle(reason, {
          flushConfig: () => {
            order.push('flush');
            return Promise.resolve();
          },
          shutdownServices: () => {
            order.push('shutdown');
            return Promise.resolve();
          },
          reportShutdownFailure: () => {
            order.push('failure');
          },
          prepareToQuit: () => {
            order.push('prepare');
          },
          markShutdownComplete: () => {
            order.push('complete');
          },
          relaunch: () => {
            order.push('relaunch');
          },
          quit: () => {
            order.push('quit');
          },
        })
      ).resolves.toBe(true);

      expect(order).toEqual(
        reason === 'relaunch'
          ? ['flush', 'shutdown', 'prepare', 'complete', 'relaunch', 'quit']
          : ['flush', 'shutdown', 'prepare', 'complete', 'quit']
      );
    }
  );

  it.each(['app-quit', 'relaunch'] as const)(
    'keeps %s fully usable after rejection and succeeds on a later flush retry',
    async (reason) => {
      const flushFailure = new Error('first final flush failed');
      const flushConfig = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(flushFailure)
        .mockResolvedValueOnce(undefined);
      const shutdownServices = vi.fn(() => Promise.resolve());
      const reportShutdownFailure = vi.fn(() => Promise.resolve());
      const prepareToQuit = vi.fn();
      const markShutdownComplete = vi.fn();
      const relaunch = vi.fn();
      const quit = vi.fn();
      const actions = {
        flushConfig,
        shutdownServices,
        reportShutdownFailure,
        prepareToQuit,
        markShutdownComplete,
        relaunch,
        quit,
      };

      await expect(runDesktopQuitLifecycle(reason, actions)).resolves.toBe(false);
      expect(shutdownServices).not.toHaveBeenCalled();
      expect(prepareToQuit).not.toHaveBeenCalled();
      expect(markShutdownComplete).not.toHaveBeenCalled();

      await expect(runDesktopQuitLifecycle(reason, actions)).resolves.toBe(true);
      expect(flushConfig).toHaveBeenCalledTimes(2);
      expect(shutdownServices).toHaveBeenCalledOnce();
      expect(prepareToQuit).toHaveBeenCalledOnce();
      expect(markShutdownComplete).toHaveBeenCalledOnce();
      expect(quit).toHaveBeenCalledOnce();
      expect(relaunch).toHaveBeenCalledTimes(reason === 'relaunch' ? 1 : 0);
    }
  );

  it('marks shutdown complete before app.quit can emit before-quit again', async () => {
    let shutdownComplete = false;
    const beforeQuitReentry = vi.fn();

    await runDesktopQuitLifecycle('app-quit', {
      flushConfig: () => Promise.resolve(),
      shutdownServices: () => Promise.resolve(),
      reportShutdownFailure: vi.fn(),
      prepareToQuit: vi.fn(),
      markShutdownComplete: () => {
        shutdownComplete = true;
      },
      relaunch: vi.fn(),
      quit: () => {
        if (!shutdownComplete) beforeQuitReentry();
      },
    });

    expect(shutdownComplete).toBe(true);
    expect(beforeQuitReentry).not.toHaveBeenCalled();
  });

  it('propagates update-install shutdown rejection without marking success', async () => {
    const flushFailure = new Error('injected final ConfigManager flush failure');
    const flush = vi.fn(() => Promise.reject(flushFailure));
    const shutdownServices = vi.fn(() => Promise.resolve());
    const reportShutdownFailure = vi.fn(() => Promise.resolve());
    const markShutdownComplete = vi.fn();
    electronUpdaterMock.listeners.clear();
    electronUpdaterMock.autoUpdater.quitAndInstall.mockClear();
    const updaterService = new UpdaterService();
    electronUpdaterMock.listeners.get('update-downloaded')?.({ version: '1.4.0' });
    updaterService.setBeforeQuitAndInstall(() =>
      runDesktopUpdateInstallLifecycle({
        flushConfig: flush,
        shutdownServices,
        reportShutdownFailure,
        markShutdownComplete,
      })
    );

    await expect(updaterService.quitAndInstall()).rejects.toBe(flushFailure);

    expect(shutdownServices).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(reportShutdownFailure).toHaveBeenCalledWith(flushFailure);
    expect(markShutdownComplete).not.toHaveBeenCalled();
    expect(electronUpdaterMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('marks update-install shutdown complete only after a successful final flush', async () => {
    const order: string[] = [];

    await runDesktopUpdateInstallLifecycle({
      flushConfig: () => {
        order.push('flush');
        return Promise.resolve();
      },
      shutdownServices: () => {
        order.push('shutdown');
        return Promise.resolve();
      },
      reportShutdownFailure: () => {
        order.push('failure');
      },
      markShutdownComplete: () => {
        order.push('complete');
      },
    });

    expect(order).toEqual(['flush', 'shutdown', 'complete']);
  });

  it('allows update install to retry after a later successful flush', async () => {
    const flushFailure = new Error('first update flush failed');
    const flushConfig = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(flushFailure)
      .mockResolvedValueOnce(undefined);
    const shutdownServices = vi.fn(() => Promise.resolve());
    const reportShutdownFailure = vi.fn(() => Promise.resolve());
    const markShutdownComplete = vi.fn();
    electronUpdaterMock.listeners.clear();
    electronUpdaterMock.autoUpdater.quitAndInstall.mockClear();
    const updaterService = new UpdaterService();
    electronUpdaterMock.listeners.get('update-downloaded')?.({ version: '1.4.0' });
    updaterService.setBeforeQuitAndInstall(() =>
      runDesktopUpdateInstallLifecycle({
        flushConfig,
        shutdownServices,
        reportShutdownFailure,
        markShutdownComplete,
      })
    );

    await expect(updaterService.quitAndInstall()).rejects.toBe(flushFailure);
    await expect(updaterService.quitAndInstall()).resolves.toBeUndefined();

    expect(flushConfig).toHaveBeenCalledTimes(2);
    expect(shutdownServices).toHaveBeenCalledOnce();
    expect(markShutdownComplete).toHaveBeenCalledOnce();
    expect(electronUpdaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
