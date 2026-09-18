import {
  createSidebarLogsHeightSlice,
  loadPersistedSidebarLogsHeight,
  resolveOpenSidebarLogsHeight,
  savePersistedSidebarLogsHeight,
  SIDEBAR_LOGS_MIN_HEIGHT,
  SIDEBAR_LOGS_OPEN_CHROME_PX,
} from '@renderer/store/team/sidebarLogsHeight';
import { afterEach, describe, expect, it } from 'vitest';

const STORAGE_KEY = 'team:sidebarLogsHeight';

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe('resolveOpenSidebarLogsHeight', () => {
  it('opens the logs viewer so the whole block is half the sidebar height', () => {
    expect(resolveOpenSidebarLogsHeight(700, null)).toBe(350 - SIDEBAR_LOGS_OPEN_CHROME_PX);
  });

  it('keeps a user-resized height instead of the automatic half', () => {
    expect(resolveOpenSidebarLogsHeight(700, 220)).toBe(220);
  });

  it('clamps a saved height so it still fits the current sidebar', () => {
    expect(resolveOpenSidebarLogsHeight(250, 520)).toBe(250 - SIDEBAR_LOGS_OPEN_CHROME_PX);
    expect(resolveOpenSidebarLogsHeight(700, 80)).toBe(SIDEBAR_LOGS_MIN_HEIGHT);
  });
});

describe('sidebar logs height persistence', () => {
  it('returns null when the user has not resized logs', () => {
    expect(loadPersistedSidebarLogsHeight()).toBeNull();
  });

  it('round-trips a user-resized height', () => {
    savePersistedSidebarLogsHeight(260);
    expect(loadPersistedSidebarLogsHeight()).toBe(260);
  });
});

describe('createSidebarLogsHeightSlice', () => {
  it('persists only after the user resizes logs', () => {
    const state = {
      sidebarLogsHeight: 213,
      sidebarLogsHeightCustom: false,
    };
    const slice = createSidebarLogsHeightSlice(
      (partial) => {
        Object.assign(state, partial);
      },
      () => state
    );
    Object.assign(state, {
      sidebarLogsHeight: slice.sidebarLogsHeight,
      sidebarLogsHeightCustom: slice.sidebarLogsHeightCustom,
    });

    slice.applyDefaultSidebarLogsHeight(300);
    expect(state.sidebarLogsHeight).toBe(300);
    expect(state.sidebarLogsHeightCustom).toBe(false);
    expect(loadPersistedSidebarLogsHeight()).toBeNull();

    slice.setSidebarLogsHeight(240);
    expect(state.sidebarLogsHeight).toBe(240);
    expect(state.sidebarLogsHeightCustom).toBe(true);
    expect(loadPersistedSidebarLogsHeight()).toBe(240);
  });
});
