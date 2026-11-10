import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, type TestStore } from './storeTestUtils';

vi.mock('../../../src/renderer/api', () => ({
  api: {
    config: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/telemetry', () => ({
  syncRendererTelemetry: vi.fn(),
}));

import { api } from '../../../src/renderer/api';

describe('configSlice', () => {
  let store: TestStore;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rethrows updateConfig failures after storing configError', async () => {
    const configApi = api.config;
    if (!configApi) {
      throw new Error('config api mock is missing');
    }
    vi.mocked(configApi.update).mockRejectedValue(new Error('update failed'));

    await expect(store.getState().updateConfig('general', { theme: 'light' })).rejects.toThrow(
      'update failed'
    );

    expect(store.getState().configError).toBe('update failed');
  });
});
