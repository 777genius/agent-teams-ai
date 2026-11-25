import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTeamBudgetAdmission, createTeamBudgetControls } from '../createTeamBudgetControls';

import type {
  TokenUsageBudgetExceededAction,
  TokenUsageBudgetStatusDto,
} from '@features/token-usage/contracts';

const registry = vi.hoisted(() => ({
  aliases: new Map<string, string>(),
  failNames: new Set<string>(),
  failedCopies: [] as string[],
  nativeNames: ['alpha'] as string[],
}));
// Budget integration must use the same verified stop path as HTTP; here only
// the native process is a fake, so delegate the shared boundary to that fake.
vi.mock('@main/services/team/lifecycle/stopTeamWithVerifiedEscalation', () => ({
  stopTeamWithVerifiedEscalation: (name: string, runtime: { stopTeam(team: string): Promise<void> }) =>
    runtime.stopTeam(name),
}));

vi.mock('@features/team-project-context/main', () => ({
  TeamProjectContextRegistry: {
    fromCurrentApp: () => ({
      resolveOwnedExecutionAliases: async (names: string[]) => new Map(
        names.map((name) => [name, registry.failNames.has(name)
          ? { error: new Error('Unresolved project owner') }
          : {
              alias: registry.aliases.has(name)
                ? { logicalTeamName: registry.aliases.get(name), context: {} }
                : null,
            }])
      ),
      resolveOwnedExecutionAlias: async (name: string) => {
        if (registry.failNames.has(name)) throw new Error('Unresolved project owner');
        return registry.aliases.has(name)
          ? { logicalTeamName: registry.aliases.get(name), context: {} }
          : null;
      },
      listOwnedStopCandidates: async () => ({
        candidates: registry.nativeNames.filter((name) => name !== 'alpha'),
        refused: registry.failedCopies.map((executionTeamName) => ({
          executionTeamName,
          error: new Error('Unverified project runtime'),
        })),
      }),
    }),
  },
}));

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
  aliveName?: string;
}) {
  let state = initial;
  let alive = true;
  const refresh = vi.fn(async () => {
    state = { ...state, stale: false };
    return {};
  });
  const stop = vi.fn(async () => { alive = false; });
  const warn = vi.fn();
  const runtime = {
    getAliveTeams: () => alive ? [state.aliveName ?? 'alpha'] : [],
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
  const guard = createTeamBudgetAdmission(() => reader);
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
  beforeEach(() => {
    registry.aliases.clear();
    registry.failNames.clear();
    registry.failedCopies = [];
    registry.nativeNames = ['alpha'];
  });

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
  it('never bypasses logical budget by launching a physical project alias', async () => {
    registry.aliases.set('ptc-copy-1', 'alpha');
    const { guard } = setup({ action: 'block_launch', used: 120 });
    await expect(guard('ptc-copy-1')).rejects.toThrow('TEAM_BUDGET_BLOCKED');
  });

  it('preserves good alias mappings and reports unreadable aliases without hiding the budget', async () => {
    registry.aliases.set('ptc-good', 'alpha');
    registry.failNames.add('ptc-bad');
    const { controls, guard } = setup({ action: 'stop_team', used: 120 });
    const lookup = await controls.resolveBudgetAliases(['ptc-good', 'ptc-bad', 'alpha']);
    expect(lookup.aliases.get('ptc-good')).toBe('alpha');
    expect(lookup.unresolvedNames).toEqual(['ptc-bad']);
    await expect(guard('ptc-bad')).rejects.toThrow('Unresolved project owner');
    await expect(guard('ptc-good')).rejects.toThrow('TEAM_BUDGET_BLOCKED');
  });

  it('warns about one unreadable copy while stopping a different owned copy', async () => {
    registry.failedCopies = ['ptc-unverified'];
    registry.nativeNames = ['ptc-healthy'];
    const { controls, stop, warn } = setup({
      action: 'stop_team', used: 120, aliveName: 'ptc-healthy',
    });
    controls.observer.observe(budgetStatus({ action: 'stop_team', used: 120 }));
    for (let n = 0; n < 30; n++) await Promise.resolve();
    expect(stop).toHaveBeenCalledExactlyOnceWith('ptc-healthy');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('ptc-unverified'),
      expect.any(Error)
    );
  });

  it('stops an owned physical project copy when the logical team reaches its limit', async () => {
    registry.nativeNames = ['ptc-copy-1'];
    const { controls, stop, warn } = setup({
      action: 'stop_team', used: 120, aliveName: 'ptc-copy-1',
    });
    controls.observer.observe(budgetStatus({ action: 'stop_team', used: 120 }));
    for (let n = 0; n < 30; n++) await Promise.resolve();
    expect(stop).toHaveBeenCalledExactlyOnceWith('ptc-copy-1');
    expect(warn).not.toHaveBeenCalled();
  });

});
