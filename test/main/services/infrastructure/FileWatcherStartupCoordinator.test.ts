import { describe, expect, it, vi } from 'vitest';

import { FileWatcherStartupCoordinator } from '../../../../src/main/services/infrastructure/FileWatcherStartupCoordinator';

describe('FileWatcherStartupCoordinator', () => {
  it('starts exactly once when main-process services become ready', () => {
    let servicesReady = false;
    const startFileWatcher = vi.fn();
    const coordinator = new FileWatcherStartupCoordinator({
      isServicesReady: () => servicesReady,
      isShutdownStarted: () => false,
      getActiveContext: () => ({ startFileWatcher }),
      schedule: vi.fn(),
      platform: 'darwin',
    });

    coordinator.startWhenServicesReady();
    expect(startFileWatcher).not.toHaveBeenCalled();

    servicesReady = true;
    coordinator.startWhenServicesReady();
    coordinator.startWhenServicesReady();

    expect(startFileWatcher).toHaveBeenCalledOnce();
  });

  it('does not start during shutdown', () => {
    const startFileWatcher = vi.fn();
    const coordinator = new FileWatcherStartupCoordinator({
      isServicesReady: () => true,
      isShutdownStarted: () => true,
      getActiveContext: () => ({ startFileWatcher }),
      schedule: vi.fn(),
      platform: 'linux',
    });

    coordinator.startWhenServicesReady();

    expect(startFileWatcher).not.toHaveBeenCalled();
  });

  it('keeps the Windows delay but rechecks shutdown before starting', () => {
    let shutdownStarted = false;
    const startFileWatcher = vi.fn();
    const schedule = vi.fn<(action: () => void, delayMs: number) => void>();
    const coordinator = new FileWatcherStartupCoordinator({
      isServicesReady: () => true,
      isShutdownStarted: () => shutdownStarted,
      getActiveContext: () => ({ startFileWatcher }),
      schedule,
      platform: 'win32',
    });

    coordinator.startWhenServicesReady();

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1500);
    expect(startFileWatcher).not.toHaveBeenCalled();

    shutdownStarted = true;
    schedule.mock.calls[0]?.[0]();
    expect(startFileWatcher).not.toHaveBeenCalled();
  });

  it('starts the current Windows context when it changes during the delay', () => {
    const firstContextStart = vi.fn();
    const secondContextStart = vi.fn();
    let activeContext = { startFileWatcher: firstContextStart };
    const schedule = vi.fn<(action: () => void, delayMs: number) => void>();
    const coordinator = new FileWatcherStartupCoordinator({
      isServicesReady: () => true,
      isShutdownStarted: () => false,
      getActiveContext: () => activeContext,
      schedule,
      platform: 'win32',
    });

    coordinator.startWhenServicesReady();
    activeContext = { startFileWatcher: secondContextStart };
    schedule.mock.calls[0]?.[0]();

    expect(firstContextStart).not.toHaveBeenCalled();
    expect(secondContextStart).toHaveBeenCalledOnce();
  });
});
