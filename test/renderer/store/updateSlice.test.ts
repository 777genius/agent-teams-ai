import { beforeEach, describe, expect, it } from 'vitest';

import { createTestStore, type TestStore } from './storeTestUtils';

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

  it('preserves a known update across periodic checking, errors, and not-available events', () => {
    store.getState().handleUpdaterStatus({ type: 'available', version: AVAILABLE_VERSION });

    store.getState().handleUpdaterStatus({ type: 'checking' });
    store.getState().handleUpdaterStatus({ type: 'error', error: 'Temporary network failure' });
    store.getState().handleUpdaterStatus({ type: 'not-available' });

    expect(store.getState()).toMatchObject({
      updateStatus: 'available',
      availableVersion: AVAILABLE_VERSION,
      showUpdateBanner: true,
      updateError: 'Temporary network failure',
    });
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
});
