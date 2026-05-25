import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadPersistedMessagesPanelMode,
  savePersistedMessagesPanelMode,
} from '../../../src/renderer/store/team/teamMessagesPanelModePersistence';

import type { TeamMessagesPanelMode } from '../../../src/renderer/types/teamMessagesPanelMode';

const STORAGE_KEY = 'team:messagesPanelMode';

describe('teamMessagesPanelModePersistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to sidebar when no value was persisted', () => {
    expect(loadPersistedMessagesPanelMode()).toBe('sidebar');
  });

  it('loads each supported persisted mode', () => {
    const modes: TeamMessagesPanelMode[] = [
      'sidebar',
      'inline',
      'bottom-sheet',
      'floating-composer',
    ];

    for (const mode of modes) {
      window.localStorage.setItem(STORAGE_KEY, mode);

      expect(loadPersistedMessagesPanelMode()).toBe(mode);
    }
  });

  it('falls back to sidebar for invalid persisted values', () => {
    window.localStorage.setItem(STORAGE_KEY, 'bad-mode');

    expect(loadPersistedMessagesPanelMode()).toBe('sidebar');
  });

  it('persists the selected mode', () => {
    savePersistedMessagesPanelMode('inline');

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('inline');
  });

  it('falls back to sidebar when localStorage read fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(loadPersistedMessagesPanelMode()).toBe('sidebar');
  });

  it('ignores localStorage write failures', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => savePersistedMessagesPanelMode('bottom-sheet')).not.toThrow();
  });
});
