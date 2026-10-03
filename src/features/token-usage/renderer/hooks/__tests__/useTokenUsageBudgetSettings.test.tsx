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
  async function mount(initialStatus: TokenUsageBudgetStatusDto = status) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    calls.getSettings.mockResolvedValue(settings);
    calls.getStatus.mockResolvedValue(initialStatus);
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
  it('Save uses the supplied draft CAS revision; status load failure keeps durable saved state and resolves', async () => {
    const harness = await mount();
    const saved = { ...settings, updatedAt: '2026-10-03T00:00:00.001Z' };
    calls.save.mockResolvedValue(saved);
    calls.getStatus.mockRejectedValueOnce(new Error('status unavailable'));
    try {
      await act(async () =>
        harness
          .current()
          .saveBudgetConfig({ settings, expectedUpdatedAt: settings.updatedAt ?? null })
      );
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
  it('ordered live status updates remain visible when the system clock moves backwards', async () => {
    const initial = { ...status, statusOrder: { epoch: 'service-a', sequence: 1 } };
    const harness = await mount(initial);
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    const rolledBack = {
      ...initial,
      computedAt: '2026-10-03T11:00:00.000Z',
      statusOrder: { epoch: 'service-a', sequence: 2 },
      stale: false,
    };
    const next = {
      ...rolledBack,
      computedAt: '2026-10-03T11:01:00.000Z',
      statusOrder: { epoch: 'service-a', sequence: 3 },
      degraded: true,
    };
    try {
      await act(async () => listener(rolledBack));
      expect(harness.current().budgetStatus).toEqual(rolledBack);
      await act(async () => listener(next));
      expect(harness.current().budgetStatus).toEqual(next);
    } finally {
      await harness.unmount();
    }
  });
  it.each(['same revision', 'new revision', 'new period', 'legacy status'] as const)(
    'explicit Reload accepts a lower computedAt with %s',
    async (change) => {
      const initial =
        change === 'legacy status'
          ? status
          : { ...status, statusOrder: { epoch: 'service-a', sequence: 1 } };
      const harness = await mount(initial);
      const reloadedSettings =
        change === 'new revision'
          ? { ...settings, updatedAt: '2026-10-03T00:00:00.001Z' }
          : settings;
      const reloadedStatus: TokenUsageBudgetStatusDto = {
        ...status,
        statusOrder: change === 'legacy status' ? undefined : { epoch: 'service-a', sequence: 2 },
        computedAt: '2026-09-30T23:00:00.000Z',
        settingsUpdatedAt: reloadedSettings.updatedAt,
        stale: false,
        period:
          change === 'new period'
            ? {
                key: '2026-09',
                from: '2026-09-01T00:00:00.000Z',
                to: '2026-10-01T00:00:00.000Z',
                timeZone: 'UTC',
              }
            : status.period,
      };
      calls.getSettings.mockResolvedValueOnce(reloadedSettings);
      calls.getStatus.mockResolvedValueOnce(reloadedStatus);
      try {
        await act(async () => harness.current().reloadBudgetConfig());
        expect(harness.current().budgetConfig).toEqual(reloadedSettings);
        expect(harness.current().budgetStatus).toEqual(reloadedStatus);
      } finally {
        await harness.unmount();
      }
    }
  );
  it.each([2, 3])(
    'a buffered live event at sequence %s cannot replace a newer GET projection',
    async (sequence) => {
      const initial = { ...status, statusOrder: { epoch: 'service-a', sequence: 1 } };
      const harness = await mount(initial);
      const latest = {
        ...initial,
        computedAt: '2026-10-03T13:00:00.000Z',
        statusOrder: { epoch: 'service-a', sequence: 3 },
        stale: false,
      };
      const buffered = {
        ...initial,
        computedAt: '2026-10-03T14:00:00.000Z',
        statusOrder: { epoch: 'service-a', sequence },
      };
      const listener = calls.onStatus.mock.calls[0][0] as (
        value: TokenUsageBudgetStatusDto
      ) => void;
      calls.getStatus.mockResolvedValueOnce(latest);
      try {
        await act(async () => harness.current().reloadBudgetConfig());
        expect(harness.current().budgetStatus).toEqual(latest);
        await act(async () => listener(buffered));
        expect(harness.current().budgetStatus).toEqual(latest);
      } finally {
        await harness.unmount();
      }
    }
  );
  it('retired service epochs cannot return through late events or status responses', async () => {
    const initial = { ...status, statusOrder: { epoch: 'service-a', sequence: 100 } };
    const harness = await mount(initial);
    const restarted = {
      ...initial,
      computedAt: '2026-10-03T11:00:00.000Z',
      statusOrder: { epoch: 'service-b', sequence: 1 },
      stale: false,
    };
    const retired = {
      ...initial,
      computedAt: '2026-10-03T14:00:00.000Z',
      statusOrder: { epoch: 'service-a', sequence: 101 },
    };
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    calls.getStatus.mockResolvedValueOnce(restarted);
    try {
      await act(async () => harness.current().reloadBudgetConfig());
      expect(harness.current().budgetStatus).toEqual(restarted);
      await act(async () => listener(retired));
      expect(harness.current().budgetStatus).toEqual(restarted);
      calls.getStatus.mockResolvedValueOnce(retired);
      await act(async () => harness.current().reloadBudgetConfig());
      expect(harness.current().budgetStatus).toEqual(restarted);
    } finally {
      await harness.unmount();
    }
  });
  it('unsequenced legacy statuses cannot replace an accepted ordered status', async () => {
    const initial = { ...status, statusOrder: { epoch: 'service-a', sequence: 1 } };
    const harness = await mount(initial);
    const legacy = { ...status, computedAt: '2026-10-03T14:00:00.000Z', stale: false };
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    try {
      await act(async () => listener(legacy));
      expect(harness.current().budgetStatus).toEqual(initial);
      calls.getStatus.mockResolvedValueOnce(legacy);
      await act(async () => harness.current().reloadBudgetConfig());
      expect(harness.current().budgetStatus).toEqual(initial);
    } finally {
      await harness.unmount();
    }
  });
  it('an in-flight GET from an earlier service instance cannot replace a restart event', async () => {
    const initial = { ...status, statusOrder: { epoch: 'service-a', sequence: 100 } };
    const harness = await mount(initial);
    const pending = deferred<TokenUsageBudgetStatusDto>();
    const restarted = {
      ...initial,
      computedAt: '2026-10-03T11:00:00.000Z',
      statusOrder: { epoch: 'service-b', sequence: 1 },
      stale: false,
    };
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    calls.getStatus.mockReturnValueOnce(pending.promise);
    try {
      let reading!: Promise<TokenUsageBudgetSettingsDto | null>;
      await act(async () => {
        reading = harness.current().reloadBudgetConfig();
        await Promise.resolve();
      });
      await act(async () => listener(restarted));
      expect(harness.current().budgetStatus).toEqual(restarted);
      await act(async () => {
        pending.resolve({
          ...initial,
          computedAt: '2026-10-03T14:00:00.000Z',
          statusOrder: { epoch: 'service-a', sequence: 101 },
        });
        await reading;
      });
      expect(harness.current().budgetStatus).toEqual(restarted);
    } finally {
      await harness.unmount();
    }
  });
  it.each([
    { operation: 'Reload', ordered: false },
    { operation: 'Save', ordered: false },
    { operation: 'Reload', ordered: true },
    { operation: 'Save', ordered: true },
  ] as const)(
    'a pending $operation status GET (ordered=$ordered) cannot overwrite a newer live event',
    async ({ operation, ordered }) => {
      const initial = ordered
        ? { ...status, statusOrder: { epoch: 'service-a', sequence: 1 } }
        : status;
      const harness = await mount(initial);
      const pending = deferred<TokenUsageBudgetStatusDto>();
      const revision = '2026-10-03T00:00:00.001Z';
      const saved = { ...settings, updatedAt: revision };
      const projection = {
        ...status,
        statusOrder: ordered ? { epoch: 'service-a', sequence: 2 } : undefined,
        settingsUpdatedAt: revision,
        computedAt: '2026-10-03T14:00:00.000Z',
      };
      const live = {
        ...projection,
        statusOrder: ordered ? { epoch: 'service-a', sequence: 3 } : undefined,
        // The later service event has a lower timestamp after a clock correction.
        computedAt: '2026-10-03T13:00:00.000Z',
        stale: false,
      };
      const listener = calls.onStatus.mock.calls[0][0] as (
        value: TokenUsageBudgetStatusDto
      ) => void;
      if (operation === 'Reload') calls.getSettings.mockResolvedValueOnce(saved);
      else calls.save.mockResolvedValueOnce(saved);
      calls.getStatus.mockReturnValueOnce(pending.promise);
      try {
        let reading!: Promise<unknown>;
        await act(async () => {
          reading =
            operation === 'Reload'
              ? harness.current().reloadBudgetConfig()
              : harness
                  .current()
                  .saveBudgetConfig({ settings, expectedUpdatedAt: settings.updatedAt ?? null });
          await Promise.resolve();
        });
        expect(calls.getStatus).toHaveBeenCalledTimes(2);
        await act(async () => listener(live));
        expect(harness.current().budgetStatus).toEqual(live);
        await act(async () => {
          pending.resolve(projection);
          await reading;
        });
        expect(harness.current().budgetConfig).toEqual(saved);
        expect(harness.current().budgetStatus).toEqual(live);
      } finally {
        await harness.unmount();
      }
    }
  );
  it('a newer ordered GET remains usable after an earlier live event arrives during the read', async () => {
    const initial = { ...status, statusOrder: { epoch: 'service-a', sequence: 1 } };
    const harness = await mount(initial);
    const pending = deferred<TokenUsageBudgetStatusDto>();
    const earlierEvent = {
      ...initial,
      computedAt: '2026-10-03T13:00:00.000Z',
      statusOrder: { epoch: 'service-a', sequence: 2 },
    };
    const laterProjection = {
      ...initial,
      computedAt: '2026-10-03T11:00:00.000Z',
      statusOrder: { epoch: 'service-a', sequence: 3 },
      stale: false,
    };
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    calls.getStatus.mockReturnValueOnce(pending.promise);
    try {
      let reading!: Promise<TokenUsageBudgetSettingsDto | null>;
      await act(async () => {
        reading = harness.current().reloadBudgetConfig();
        await Promise.resolve();
      });
      await act(async () => listener(earlierEvent));
      expect(harness.current().budgetStatus).toEqual(earlierEvent);
      await act(async () => {
        pending.resolve(laterProjection);
        await reading;
      });
      expect(harness.current().budgetStatus).toEqual(laterProjection);
    } finally {
      await harness.unmount();
    }
  });
  it('status events older than the saved settings revision are still rejected', async () => {
    const harness = await mount();
    const saved = { ...settings, updatedAt: '2026-10-03T00:00:00.001Z' };
    const savedStatus = {
      ...status,
      settingsUpdatedAt: saved.updatedAt,
      computedAt: '2026-10-03T13:00:00.000Z',
    };
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    calls.save.mockResolvedValueOnce(saved);
    calls.getStatus.mockResolvedValueOnce(savedStatus);
    try {
      await act(async () =>
        harness
          .current()
          .saveBudgetConfig({ settings, expectedUpdatedAt: settings.updatedAt ?? null })
      );
      await act(async () =>
        listener({ ...status, computedAt: '2026-10-03T14:00:00.000Z', stale: false })
      );
      expect(harness.current().budgetStatus).toEqual(savedStatus);
    } finally {
      await harness.unmount();
    }
  });
  it('a rejected stale-revision event does not supersede a valid pending status read', async () => {
    const harness = await mount();
    const saved = { ...settings, updatedAt: '2026-10-03T00:00:00.001Z' };
    const pending = deferred<TokenUsageBudgetStatusDto>();
    const fresh = {
      ...status,
      settingsUpdatedAt: saved.updatedAt,
      computedAt: '2026-10-03T13:00:00.000Z',
      stale: false,
    };
    const listener = calls.onStatus.mock.calls[0][0] as (value: TokenUsageBudgetStatusDto) => void;
    calls.save.mockResolvedValueOnce(saved);
    calls.getStatus.mockReturnValueOnce(pending.promise);
    try {
      let saving!: Promise<void>;
      await act(async () => {
        saving = harness
          .current()
          .saveBudgetConfig({ settings, expectedUpdatedAt: settings.updatedAt ?? null });
        await Promise.resolve();
      });
      expect(harness.current().budgetConfig).toEqual(saved);
      await act(async () => listener({ ...status, computedAt: '2026-10-03T14:00:00.000Z' }));
      await act(async () => {
        pending.resolve(fresh);
        await saving;
      });
      expect(harness.current().budgetStatus).toEqual(fresh);
    } finally {
      await harness.unmount();
    }
  });
  it('failed Reload reports unavailable and keeps the previously saved configuration', async () => {
    const harness = await mount();
    calls.getSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    try {
      let result: TokenUsageBudgetSettingsDto | null = settings;
      await act(async () => {
        result = await harness.current().reloadBudgetConfig();
      });
      expect(result).toBeNull();
      expect(harness.current().budgetConfig).toEqual(settings);
      expect(harness.current().budgetConfigError).toBe('settings unavailable');
    } finally {
      await harness.unmount();
    }
  });
  it('a successful reload cannot promote the CAS revision of an unreconciled draft', async () => {
    const harness = await mount();
    const fresh = { ...settings, updatedAt: '2026-10-03T00:00:00.002Z' };
    calls.getSettings.mockResolvedValue(fresh);
    calls.save.mockRejectedValueOnce(new Error('Budget settings changed'));
    try {
      let result: TokenUsageBudgetSettingsDto | null = null;
      await act(async () => {
        result = await harness.current().reloadBudgetConfig();
      });
      expect(result).toEqual(fresh);
      await act(async () => {
        await expect(
          harness.current().saveBudgetConfig({
            settings: {
              global: { monthlyTokenLimit: 250, thresholds: [], notificationsEnabled: true },
            },
            expectedUpdatedAt: settings.updatedAt ?? null,
          })
        ).rejects.toThrow('Budget settings changed');
      });
      expect(calls.save).toHaveBeenCalledWith({
        settings: {
          global: { monthlyTokenLimit: 250, thresholds: [], notificationsEnabled: true },
        },
        expectedUpdatedAt: settings.updatedAt,
      });
      expect(harness.current().budgetConfig).toEqual(fresh);
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
        saving = harness
          .current()
          .saveBudgetConfig({ settings, expectedUpdatedAt: settings.updatedAt ?? null });
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
