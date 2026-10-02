import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, type TestStore } from './storeTestUtils';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const AVAILABLE_VERSION = '999.0.0';

describe('updateSlice', () => {
  let store: TestStore;

  beforeEach(() => {
    localStorage.clear();
    store = createTestStore();
  });

  it('shows the global dialog and banner for a new version', () => {
    store.getState().handleUpdaterStatus({
      type: 'available',
      version: AVAILABLE_VERSION,
      releaseNotes: 'Important fixes',
    });

    expect(store.getState()).toMatchObject({
      updateStatus: 'available',
      availableVersion: AVAILABLE_VERSION,
      releaseNotes: 'Important fixes',
      showUpdateDialog: true,
      showUpdateBanner: true,
      updateError: null,
    });
  });

  it('reopens a transiently closed dialog on the next availability event', () => {
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store.getState().closeUpdateDialog();

    expect(store.getState().showUpdateDialog).toBe(false);
    expect(store.getState().dismissedUpdateVersion).toBeNull();
    expect(localStorage.getItem('update:dismissed-version')).toBeNull();

    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });

    expect(store.getState().showUpdateDialog).toBe(true);
  });

  it('keeps an explicitly dismissed dialog hidden for the same version', () => {
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store.getState().dismissUpdateDialog();

    expect(localStorage.getItem('update:dismissed-version')).toBe(AVAILABLE_VERSION);

    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });

    expect(store.getState().showUpdateDialog).toBe(false);
  });

  it('does not reopen a dismissed banner during the same known-version session', () => {
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store.getState().dismissUpdateBanner();

    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });

    expect(store.getState().showUpdateBanner).toBe(false);
  });

  it('preserves a known version and recovery after a failure and unrelated not-available event', () => {
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });

    store.getState().handleUpdaterStatus({ type: 'checking' });
    store.getState().handleUpdaterStatus({ type: 'error', error: 'Temporary network failure' });
    store.getState().handleUpdaterStatus({ type: 'not-available' });

    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      availableVersion: AVAILABLE_VERSION,
      showUpdateBanner: true,
      showUpdateDialog: true,
      updateError: 'Temporary network failure',
    });
  });

  it('keeps failure recovery through periodic checking and availability events until an explicit new attempt', () => {
    const check = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { updater: { check } });
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store
      .getState()
      .handleUpdaterStatus({ type: 'error', error: 'The update is improperly signed' });
    store.getState().closeUpdateDialog();
    store.getState().handleUpdaterStatus({ type: 'checking' });
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store.getState().handleUpdaterStatus({ type: 'not-available' });
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      updateError: 'The update is improperly signed',
      showUpdateDialog: false,
    });
    store.getState().checkForUpdates();
    expect(store.getState()).toMatchObject({ updateStatus: 'checking', updateError: null });
    vi.unstubAllGlobals();
  });

  it('restores the global banner when the update finishes downloading', () => {
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store.getState().dismissUpdateBanner();

    store.getState().handleUpdaterStatus({ type: 'downloaded', version: AVAILABLE_VERSION });

    expect(store.getState()).toMatchObject({
      updateStatus: 'downloaded',
      downloadProgress: 100,
      showUpdateBanner: true,
    });
  });
  it('surfaces an error before a version is known and prevents invalid install', () => {
    const install = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { updater: { install } });
    store
      .getState()
      .handleUpdaterStatus({ type: 'error', error: 'The update is improperly signed' });
    store.getState().installUpdate();
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      availableVersion: null,
      showUpdateDialog: true,
    });
    expect(install).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('surfaces a rejected update check before a version is known', async () => {
    vi.stubGlobal('electronAPI', {
      updater: { check: vi.fn().mockRejectedValue(new Error('HTTP 503')) },
    });
    store.getState().checkForUpdates();
    await Promise.resolve();
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      availableVersion: null,
      updateError: 'HTTP 503',
      showUpdateDialog: true,
    });
    vi.unstubAllGlobals();
  });

  it('retries a failed download once and clears its stale error immediately', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { updater: { download } });
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    store.getState().downloadUpdate();
    await Promise.resolve();
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      updateError: 'ECONNRESET',
      showUpdateDialog: true,
    });
    store.getState().retryUpdate();
    store.getState().retryUpdate();
    expect(download).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ updateStatus: 'downloading', updateError: null });
    vi.unstubAllGlobals();
  });

  it('rechecks transient failures without a version, but refuses retry for signature and unknown errors', () => {
    const check = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { updater: { check } });
    for (const error of ['The update is improperly signed', 'Unknown error']) {
      store.getState().handleUpdaterStatus({ type: 'error', error });
      store.getState().retryUpdate();
    }
    expect(check).not.toHaveBeenCalled();
    store.getState().handleUpdaterStatus({ type: 'error', error: 'HTTP 503' });
    store.getState().retryUpdate();
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ updateStatus: 'checking', updateError: null });
    vi.unstubAllGlobals();
  });

  it('does not allow restart after an error invalidates a downloaded update', async () => {
    const install = vi.fn().mockRejectedValue(new Error('Installer failed'));
    vi.stubGlobal('electronAPI', { updater: { install } });
    store.getState().handleUpdaterStatus({ type: 'downloaded', version: AVAILABLE_VERSION });
    store.getState().installUpdate();
    store.getState().installUpdate();
    await Promise.resolve();
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      updateError: 'Installer failed',
      showUpdateDialog: true,
    });
    store.getState().installUpdate();
    expect(install).toHaveBeenCalledTimes(1);
    store.getState().handleUpdaterStatus({ type: 'downloaded', version: AVAILABLE_VERSION });
    expect(store.getState().updateError).toBeNull();
    vi.unstubAllGlobals();
  });

  it('ignores a stale IPC rejection after a successful status event', async () => {
    let reject!: (error: Error) => void;
    const check = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        })
    );
    vi.stubGlobal('electronAPI', { updater: { check } });
    store.getState().checkForUpdates();
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });
    reject(new Error('Stale error'));
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ updateStatus: 'available', updateError: null });
    vi.unstubAllGlobals();
  });
  it('preserves a verified downloaded update and restart after an hourly check failure', () => {
    const install = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { updater: { install } });
    store.getState().handleUpdaterStatus({ type: 'downloaded', version: AVAILABLE_VERSION });
    store.getState().handleUpdaterStatus({ type: 'checking', operation: 'check' });
    store.getState().handleUpdaterStatus({ type: 'error', operation: 'check', error: 'HTTP 503' });
    expect(store.getState()).toMatchObject({
      updateStatus: 'downloaded',
      updateError: null,
      downloadProgress: 100,
      showUpdateDialog: false,
    });
    store.getState().installUpdate();
    expect(install).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('keeps background check failures nonintrusive but available for manual opening', () => {
    store.getState().handleUpdaterStatus({ type: 'checking', operation: 'check' });
    store.getState().handleUpdaterStatus({ type: 'error', operation: 'check', error: 'HTTP 503' });
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      updateError: 'HTTP 503',
      showUpdateDialog: false,
      showUpdateBanner: true,
    });
    store.getState().openUpdateDialog();
    expect(store.getState().showUpdateDialog).toBe(true);
  });

  it('opens recovery for an explicit check and ignores its duplicate IPC rejection', async () => {
    let reject!: (error: Error) => void;
    vi.stubGlobal('electronAPI', {
      updater: {
        check: vi.fn().mockImplementation(
          () =>
            new Promise<void>((_resolve, rejectPromise) => {
              reject = rejectPromise;
            })
        ),
      },
    });
    store.getState().checkForUpdates();
    store.getState().handleUpdaterStatus({ type: 'error', operation: 'check', error: 'HTTP 503' });
    expect(store.getState().showUpdateDialog).toBe(true);
    store.getState().closeUpdateDialog();
    reject(new Error('HTTP 503'));
    await Promise.resolve();
    expect(store.getState().showUpdateDialog).toBe(false);
    vi.unstubAllGlobals();
  });

  it('still invalidates a downloaded artifact on signature failure during a check', () => {
    store.getState().handleUpdaterStatus({ type: 'downloaded', version: AVAILABLE_VERSION });
    store.getState().handleUpdaterStatus({
      type: 'error',
      operation: 'check',
      error: 'The update is improperly signed',
    });
    expect(store.getState()).toMatchObject({
      updateStatus: 'error',
      updateError: 'The update is improperly signed',
      showUpdateDialog: true,
    });
  });

  it('does not replace active update recovery with an unrelated background check error', () => {
    store.getState().handleUpdaterStatus({
      type: 'error',
      operation: 'download',
      error: 'The update is improperly signed',
    });
    store.getState().closeUpdateDialog();
    store.getState().handleUpdaterStatus({ type: 'error', operation: 'check', error: 'HTTP 503' });
    expect(store.getState()).toMatchObject({
      updateError: 'The update is improperly signed',
      updateOperation: 'download',
      showUpdateDialog: false,
    });
  });
});
