import { describe, expect, it } from 'vitest';

import { getOpenCodeSidebarSourceState } from './openCodeSidebarSourceState';

const base = {
  directory: null,
  catalogLoading: false,
  catalogUnavailable: false,
  catalogRefreshFailed: false,
  scopedLoading: false,
  bootstrapLoading: false,
  passiveStatusFailed: false,
  passiveCatalogFailed: false,
} as const;

describe('getOpenCodeSidebarSourceState', () => {
  it('shows loading only for the active directory, not another project status', () => {
    const directory = { loading: false, authoritativePending: false, loaded: true, error: null };
    expect(getOpenCodeSidebarSourceState({
      ...base, directory, scopedLoading: true, catalogLoading: true,
    })).toEqual({ loading: false, unavailable: false, failureKind: null });
  });

  it('does not convert a connected directory into a failed model catalog', () => {
    const directory = { loading: false, authoritativePending: false, loaded: true, error: null };
    expect(getOpenCodeSidebarSourceState({
      ...base, directory, passiveCatalogFailed: true, passiveStatusFailed: true,
    })).toEqual({ loading: false, unavailable: false, failureKind: null });
  });

  it('labels a failed passive status distinctly from a catalog failure', () => {
    expect(getOpenCodeSidebarSourceState({ ...base, passiveStatusFailed: true }))
      .toEqual({ loading: false, unavailable: true, failureKind: 'status' });
    expect(getOpenCodeSidebarSourceState({ ...base, passiveCatalogFailed: true }))
      .toEqual({ loading: false, unavailable: true, failureKind: 'catalog' });
  });

  it('shows a scoped directory error without retrying full model verification', () => {
    const directory = {
      loading: false, authoritativePending: false, loaded: false, error: 'Discovery failed',
    };
    expect(getOpenCodeSidebarSourceState({ ...base, directory }))
      .toEqual({ loading: false, unavailable: true, failureKind: 'directory' });
  });
});
