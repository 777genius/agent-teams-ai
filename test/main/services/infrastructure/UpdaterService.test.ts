import { UpdaterService } from '@main/services/infrastructure/UpdaterService';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      ...updater,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        updater.listeners.set(name, listener),
    },
  },
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  net: { fetch: vi.fn() },
}));
vi.mock('@main/utils/safeWebContentsSend', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

describe('UpdaterService failure delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updater.listeners.clear();
  });

  it.each(['checkForUpdates', 'downloadUpdate'] as const)(
    'sends a %s rejection to the renderer without a native error event',
    async (operation) => {
      updater[operation].mockRejectedValueOnce(new Error('ECONNRESET'));
      const service = new UpdaterService();
      await service[operation]();
      expect(safeSendToRenderer).toHaveBeenCalledTimes(1);
      expect(safeSendToRenderer).toHaveBeenCalledWith(null, 'updater:status', {
        type: 'error',
        error: 'ECONNRESET',
      });
    }
  );

  it('delivers a pre-install rejection once and invalidates the downloaded artifact', async () => {
    const service = new UpdaterService();
    updater.listeners.get('update-downloaded')?.({ version: '2.0.0' });
    vi.mocked(safeSendToRenderer).mockClear();
    const beforeInstall = vi.fn().mockRejectedValue(new Error('Could not stop background work'));
    service.setBeforeQuitAndInstall(beforeInstall);
    await service.quitAndInstall();
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(safeSendToRenderer).toHaveBeenCalledTimes(1);
    expect(safeSendToRenderer).toHaveBeenLastCalledWith(null, 'updater:status', {
      type: 'error',
      error: 'Could not stop background work',
    });
    await service.quitAndInstall();
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('delivers a synchronous native install failure', async () => {
    const service = new UpdaterService();
    updater.listeners.get('update-downloaded')?.({ version: '2.0.0' });
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('Native installer failed');
    });
    vi.mocked(safeSendToRenderer).mockClear();
    await service.quitAndInstall();
    expect(safeSendToRenderer).toHaveBeenCalledTimes(1);
    expect(safeSendToRenderer).toHaveBeenCalledWith(null, 'updater:status', {
      type: 'error',
      error: 'Native installer failed',
    });
  });

  it.each(['checkForUpdates', 'downloadUpdate', 'nativeError'] as const)(
    'invalidates downloaded restart eligibility on %s failure',
    async (operation) => {
      const service = new UpdaterService();
      updater.listeners.get('update-downloaded')?.({ version: '2.0.0' });
      if (operation === 'nativeError') {
        updater.listeners.get('error')?.(new Error('The update is improperly signed'));
      } else {
        updater[operation].mockRejectedValueOnce(new Error('Failed'));
        await service[operation]();
      }
      await service.quitAndInstall();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      expect(safeSendToRenderer).toHaveBeenLastCalledWith(null, 'updater:status', {
        type: 'error',
        error: 'Refused to install a non-newer app version.',
      });
    }
  );
});
