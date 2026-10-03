import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTokenUsageBudgetSettings } from '../useTokenUsageBudgetSettings';

import type { TokenUsageBudgetSettingsDto, TokenUsageBudgetStatusDto } from '../../../contracts';

const calls = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getStatus: vi.fn(),
  save: vi.fn(),
  onStatus: vi.fn(),
}));
vi.mock('@renderer/api', () => ({
  api: {
    tokenUsage: {
      getBudgetSettings: calls.getSettings,
      getBudgetStatus: calls.getStatus,
      updateBudgetSettings: calls.save,
      onBudgetStatusChanged: calls.onStatus,
    },
  },
}));
const settings: TokenUsageBudgetSettingsDto = {
  updatedAt: '2026-10-03T00:00:00.000Z',
  global: { monthlyTokenLimit: 100, thresholds: [], notificationsEnabled: false },
};
const status: TokenUsageBudgetStatusDto = {
  computedAt: '2026-10-03T12:00:00.000Z',
  settingsUpdatedAt: settings.updatedAt,
  stale: true,
  degraded: false,
  notificationPolicy: { enabled: true, nativeToasts: false },
  period: {
    key: '2026-10',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    timeZone: 'UTC',
  },
  targets: [],
  options: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Budget saved state generation', () => {
  async function mount() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    calls.getSettings.mockResolvedValue(settings);
    calls.getStatus.mockResolvedValue(status);
    calls.onStatus.mockReturnValue(vi.fn());
    let current!: ReturnType<typeof useTokenUsageBudgetSettings>;
    const Harness = () => {
      current = useTokenUsageBudgetSettings({
        loadErrorMessage: 'load failed',
        saveErrorMessage: 'save failed',
      });
      return null;
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    return {
      current: () => current,
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }
  it('Save uses loaded CAS revision; status load failure keeps durable saved state and resolves', async () => {
    const harness = await mount();
    const saved = { ...settings, updatedAt: '2026-10-03T00:00:00.001Z' };
    calls.save.mockResolvedValue(saved);
    calls.getStatus.mockRejectedValueOnce(new Error('status unavailable'));
    try {
      await act(async () => harness.current().saveBudgetConfig(settings));
      expect(calls.save).toHaveBeenCalledWith({ settings, expectedUpdatedAt: settings.updatedAt });
      expect(harness.current().budgetConfig.updatedAt).toBe(saved.updatedAt);
      expect(harness.current().budgetConfigError).toBe('status unavailable');
      const listener = calls.onStatus.mock.calls[0][0] as (
        value: TokenUsageBudgetStatusDto
      ) => void;
      await act(async () => listener({ ...status, computedAt: '2026-10-03T13:00:00.000Z' }));
      expect(harness.current().budgetStatus?.computedAt).toBe(status.computedAt);
    } finally {
      await harness.unmount();
    }
  });
  it('failed Reload reports false and keeps the previously saved configuration', async () => {
    const harness = await mount();
    calls.getSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    try {
      let result = true;
      await act(async () => {
        result = await harness.current().reloadBudgetConfig();
      });
      expect(result).toBe(false);
      expect(harness.current().budgetConfig).toEqual(settings);
      expect(harness.current().budgetConfigError).toBe('settings unavailable');
    } finally {
      await harness.unmount();
    }
  });
  it('late post-Save status error cannot overwrite a newer successful reload', async () => {
    const harness = await mount();
    const pending = deferred<TokenUsageBudgetStatusDto>();
    calls.save.mockResolvedValue({ ...settings, updatedAt: '2026-10-03T00:00:00.001Z' });
    calls.getStatus.mockReturnValueOnce(pending.promise);
    try {
      let saving!: Promise<void>;
      await act(async () => {
        saving = harness.current().saveBudgetConfig(settings);
        await Promise.resolve();
      });
      calls.getSettings.mockResolvedValue({ ...settings, updatedAt: '2026-10-03T00:00:00.002Z' });
      calls.getStatus.mockResolvedValue({
        ...status,
        settingsUpdatedAt: '2026-10-03T00:00:00.002Z',
        computedAt: '2026-10-03T13:00:00.000Z',
      });
      await act(async () => harness.current().reloadBudgetConfig());
      await act(async () => {
        pending.reject(new Error('late old read'));
        await saving;
      });
      expect(harness.current().budgetConfigError).toBeNull();
      expect(harness.current().budgetConfig.updatedAt).toBe('2026-10-03T00:00:00.002Z');
    } finally {
      await harness.unmount();
    }
  });
});
