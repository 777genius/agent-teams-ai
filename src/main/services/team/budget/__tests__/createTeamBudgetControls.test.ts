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
  stopTeamWithVerifiedEscalation: (
    name: string,
    runtime: { stopTeam(team: string): Promise<void> }
  ) => runtime.stopTeam(name),
}));

vi.mock('@features/team-project-context/main', () => ({
  TeamProjectContextRegistry: {
    fromCurrentApp: () => {
      const aliases = new Map(registry.aliases);
      const nativeNames = [...registry.nativeNames];
      return {
        resolveOwnedExecutionAliases: async (names: string[]) =>
          new Map(
            names.map((name) => [
              name,
              registry.failNames.has(name)
                ? { error: new Error('Unresolved project owner') }
                : {
                    alias: aliases.has(name)
                      ? { logicalTeamName: aliases.get(name), context: {} }
                      : null,
                  },
            ])
          ),
        resolveOwnedExecutionAlias: async (name: string) => {
          if (registry.failNames.has(name)) throw new Error('Unresolved project owner');
          return aliases.has(name) ? { logicalTeamName: aliases.get(name), context: {} } : null;
        },
        listOwnedStopCandidates: async () => ({
          candidates: nativeNames.filter((name) => name !== 'alpha'),
          refused: registry.failedCopies.map((executionTeamName) => ({
            executionTeamName,
            error: new Error('Unverified project runtime'),
          })),
        }),
      };
    },
  },
}));

const budgetStatus = (input: {
  action?: TokenUsageBudgetExceededAction;
  used?: number;
  stale?: boolean;
  limit?: number;
  updatedAt?: string;
}): TokenUsageBudgetStatusDto => ({
  settingsUpdatedAt: input.updatedAt,
  period: {
    key: '2026-11',
    from: '2026-11-01T00:00:00Z',
    to: '2026-12-01T00:00:00Z',
    timeZone: 'UTC',
  },
  computedAt: '2026-11-25T14:00:00Z',
  stale: input.stale ?? false,
  degraded: false,
  notificationPolicy: { enabled: false, nativeToasts: false },
  options: [{ scope: 'team', id: 'team:alpha', label: 'alpha' }],
  targets: [
    {
      scope: 'team',
      id: 'team:alpha',
      label: 'alpha',
      thresholds: [80, 100],
      notificationsEnabled: false,
      onExceeded: input.action,
      metrics: [
        {
          metric: 'tokens',
          value: input.used ?? 0,
          limit: input.limit ?? 100,
          percent: ((input.used ?? 0) * 100) / (input.limit ?? 100),
          remaining: (input.limit ?? 100) - (input.used ?? 0),
          incomplete: false,
        },
      ],
    },
  ],
});

function setup(initial: {
  action?: TokenUsageBudgetExceededAction;
  used?: number;
  stale?: boolean;
  aliveName?: string;
  statusAction?: TokenUsageBudgetExceededAction;
  omitTarget?: boolean;
  repairOnRefresh?: boolean;
  settingsRevision?: string;
  statusRevision?: string;
  statusLimit?: number;
  changePolicyDuringStatusRead?: boolean;
}) {
  let state = initial;
  let alive = true;
  const refresh = vi.fn(async () => {
    state = {
      ...state,
      stale: false,
      ...(state.repairOnRefresh
        ? {
            omitTarget: false,
            statusAction: state.action,
            statusRevision: state.settingsRevision,
            statusLimit: 100,
          }
        : {}),
    };
    return {};
  });
  const stop = vi.fn(async () => {
    alive = false;
  });
  const warn = vi.fn();
  const runtime = {
    getAliveTeams: () => (alive ? [state.aliveName ?? 'alpha'] : []),
    isTeamManagedByThisProfile: async () => true,
    stopTeam: stop,
    isTeamAlive: async () => alive,
  };
  const reader = {
    getBudgetSettings: async () => ({
      ...(state.settingsRevision ? { updatedAt: state.settingsRevision } : {}),
      teams: {
        'team:alpha': {
          monthlyTokenLimit: 100,
          thresholds: [80, 100],
          notificationsEnabled: false,
          onExceeded: state.action,
        },
      },
    }),
    getBudgetStatus: async () => {
      const status = budgetStatus({
        ...state,
        action: state.statusAction ?? state.action,
        updatedAt:
          state.statusRevision ??
          (state.settingsRevision && !state.statusRevision ? undefined : state.settingsRevision),
        limit: state.statusLimit,
      });
      // Simulate an independent CAS Save after status projection but before
      // the admission guard can approve a launch.
      if (state.changePolicyDuringStatusRead) {
        state = {
          ...state,
          changePolicyDuringStatusRead: false,
          settingsRevision: '2026-11-27T12:02:00.000Z',
        };
      }
      return state.omitTarget ? { ...status, targets: [] } : status;
    },
    refreshSnapshot: refresh,
  };
  const guard = createTeamBudgetAdmission(() => reader);
  const controls = createTeamBudgetControls(
    () => reader,
    runtime,
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

  it('rejects a known reached subtotal without waiting for stale metering to refresh', async () => {
    const { guard, refresh } = setup({ action: 'stop_team', used: 120, stale: true });
    await expect(guard()).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects launches at the limit even if budget alerts are turned off', async () => {
    const { guard, refresh, controls } = setup({ action: 'stop_team', used: 100 });
    await expect(guard()).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    expect(refresh).not.toHaveBeenCalled();
    expect(controls.notificationSettings.getSettings().enabled).toBe(false);
  });

  it('fails closed when configured enforcement has no matching projected target', async () => {
    const { guard, refresh } = setup({ action: 'block_launch', omitTarget: true });
    await expect(guard()).rejects.toThrow(
      'TEAM_BUDGET_BLOCKED: Cannot verify active budget policy'
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('fails closed when projected action disagrees with enforced settings', async () => {
    const { guard, refresh } = setup({ action: 'stop_team', statusAction: 'notify' });
    await expect(guard()).rejects.toThrow(
      'TEAM_BUDGET_BLOCKED: Cannot verify active budget policy'
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refuses an older settings revision even if its policy action matches', async () => {
    const { guard, refresh } = setup({
      action: 'block_launch',
      used: 50,
      settingsRevision: '2026-11-27T12:01:00.000Z',
      statusRevision: '2026-11-27T12:00:00.000Z',
    });
    await expect(guard()).rejects.toThrow(
      'TEAM_BUDGET_BLOCKED: Cannot verify active budget policy'
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects an outdated higher limit even with matching policy action', async () => {
    const { guard, refresh } = setup({
      action: 'block_launch',
      used: 150,
      statusLimit: 200,
    });
    await expect(guard()).rejects.toThrow(
      'TEAM_BUDGET_BLOCKED: Cannot verify active budget policy'
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rechecks a stricter limit after the status catches up', async () => {
    const { guard, refresh } = setup({
      action: 'block_launch',
      used: 150,
      statusLimit: 200,
      repairOnRefresh: true,
    });
    await expect(guard()).rejects.toThrow('TEAM_BUDGET_BLOCKED: Cannot launch');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('fails closed if a concurrent Save changes the policy during admission', async () => {
    const { guard, refresh } = setup({
      action: 'block_launch',
      used: 20,
      settingsRevision: '2026-11-27T12:01:00.000Z',
      statusRevision: '2026-11-27T12:01:00.000Z',
      changePolicyDuringStatusRead: true,
    });
    await expect(guard()).rejects.toThrow(
      'TEAM_BUDGET_BLOCKED: Budget policy changed during launch admission'
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('permits a proven under-budget launch after refresh restores a missing target', async () => {
    const { guard, refresh } = setup({
      action: 'block_launch',
      omitTarget: true,
      repairOnRefresh: true,
    });
    await expect(guard()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
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
  it('uses the current root for admission, attribution and stop enumeration', async () => {
    const { guard, controls, stop } = setup({
      action: 'stop_team',
      used: 120,
      aliveName: 'ptc-new-root',
    });
    registry.aliases.set('ptc-new-root', 'alpha');
    registry.nativeNames = ['ptc-new-root'];
    await expect(guard('ptc-new-root')).rejects.toThrow('TEAM_BUDGET_BLOCKED');
    const lookup = await controls.resolveBudgetAliases(['ptc-new-root']);
    expect(lookup.aliases.get('ptc-new-root')).toBe('alpha');
    controls.observer.observe(budgetStatus({ action: 'stop_team', used: 120 }));
    for (let n = 0; n < 30; n++) await Promise.resolve();
    expect(stop).toHaveBeenCalledExactlyOnceWith('ptc-new-root');
  });

  it('never bypasses logical budget by launching a physical project alias', async () => {
    registry.aliases.set('ptc-copy-1', 'alpha');
    const { guard } = setup({ action: 'block_launch', used: 120 });
    await expect(guard('ptc-copy-1')).rejects.toThrow('TEAM_BUDGET_BLOCKED');
  });

  it('fails closed when a generated project copy has no verified logical owner', async () => {
    const { guard } = setup({ action: 'notify' });
    await expect(guard(`ptc-${'a'.repeat(24)}`)).rejects.toThrow(
      'TEAM_BUDGET_BLOCKED: Cannot verify project runtime ownership'
    );
  });

  it('does not infer project-copy identity from a prefix alone', async () => {
    const { guard } = setup({ action: 'notify' });
    await expect(guard('ptc-native')).resolves.toBeUndefined();
  });

  it('marks unowned generated copy usage unresolved without rejecting ordinary team names', async () => {
    const missing = `ptc-${'a'.repeat(24)}`;
    const owned = `ptc-${'b'.repeat(24)}`;
    registry.aliases.set(owned, 'alpha');
    const { controls } = setup({ action: 'block_launch' });
    const lookup = await controls.resolveBudgetAliases([missing, owned, 'ptc-native', 'alpha']);
    expect(lookup.unresolvedNames).toEqual([missing]);
    expect(lookup.aliases).toEqual(new Map([[owned, 'alpha']]));
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
      action: 'stop_team',
      used: 120,
      aliveName: 'ptc-healthy',
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
      action: 'stop_team',
      used: 120,
      aliveName: 'ptc-copy-1',
    });
    controls.observer.observe(budgetStatus({ action: 'stop_team', used: 120 }));
    for (let n = 0; n < 30; n++) await Promise.resolve();
    expect(stop).toHaveBeenCalledExactlyOnceWith('ptc-copy-1');
    expect(warn).not.toHaveBeenCalled();
  });
});
