import { describe, expect, it, vi } from 'vitest';

import { createTeamBudgetControls } from '../createTeamBudgetControls';

import type {
  TokenUsageBudgetExceededAction,
  TokenUsageBudgetStatusDto,
} from '@features/token-usage/contracts';

const budgetStatus = (input: {
  action?: TokenUsageBudgetExceededAction;
  used?: number;
  stale?: boolean;
}): TokenUsageBudgetStatusDto => ({
  period: {
    key: '2026-11', from: '2026-11-01T00:00:00Z',
    to: '2026-12-01T00:00:00Z', timeZone: 'UTC',
  },
  computedAt: '2026-11-25T14:00:00Z',
  stale: input.stale ?? false,
  degraded: false,
  notificationPolicy: { enabled: false, nativeToasts: false },
  options: [{ scope: 'team', id: 'team:alpha', label: 'alpha' }],
  targets: [{
    scope: 'team', id: 'team:alpha', label: 'alpha',
    thresholds: [80, 100], notificationsEnabled: false, onExceeded: input.action,
    metrics: [{
      metric: 'tokens', value: input.used ?? 0, limit: 100,
      percent: input.used ?? 0, remaining: 100 - (input.used ?? 0), incomplete: false,
    }],
  }],
});

function setup(initial: {
  action?: TokenUsageBudgetExceededAction;
  used?: number;
  stale?: boolean;
}) {
  let state = initial;
  let alive = true;
  let guard!: (name: string) => Promise<void>;
  const refresh = vi.fn(async () => {
    state = { ...state, stale: false };
    return {};
  });
  const stop = vi.fn(async () => { alive = false; });
  const warn = vi.fn();
  const runtime = {
    setTeamBudgetAdmissionGuard: (callback: (name: string) => Promise<void>) => {
      guard = callback;
    },
    getAliveTeams: () => alive ? ['alpha'] : [],
    isTeamManagedByThisProfile: async () => true,
    stopTeam: stop,
    isTeamAlive: async () => alive,
  };
  const reader = {
    getBudgetSettings: async () => ({
      teams: { 'team:alpha': {
        monthlyTokenLimit: 100, thresholds: [80, 100],
        notificationsEnabled: false, onExceeded: state.action,
      } },
    }),
    getBudgetStatus: async () => budgetStatus(state),
    refreshSnapshot: refresh,
  };
  const controls = createTeamBudgetControls(
    () => reader, runtime,
    () => ({
      notifyOnUsageBudgetAlerts: false,
      notifyOnUsageBudgetWarning: false,
      notifyOnUsageBudgetCritical: false,
      notifyOnUsageBudgetNativeToast: false,
    }),
    warn
  );
  return { guard: (name = 'alpha') => guard(name), controls, stop, refresh, warn };
}

describe('team budget composition - no live provider required', () => {
  it('refreshes first-use evidence once, then permits an under-budget launch', async () => {
    const { guard, refresh } = setup({ action: 'block_launch', stale: true });
    await expect(guard()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects launches at the limit even if budget alerts are turned off', async () => {
    const { guard, refresh, controls } = setup({ action: 'stop_team', used: 100 });
    await expect(guard()).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    expect(refresh).not.toHaveBeenCalled();
    expect(controls.notificationSettings.getSettings().enabled).toBe(false);
  });

  it('does not block legacy notification-only teams', async () => {
    const { guard, refresh } = setup({ action: 'notify', stale: true, used: 120 });
    await expect(guard()).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not claim a confirmed stop if the runtime still runs', async () => {
    const { controls, stop, warn } = setup({ action: 'stop_team', used: 120 });
    controls.observer.observe(budgetStatus({ action: 'stop_team', used: 120 }));
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});
