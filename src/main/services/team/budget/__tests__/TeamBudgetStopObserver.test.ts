import { describe, expect, it, vi } from 'vitest';

import { TeamBudgetStopObserver } from '../TeamBudgetStopObserver';

import type { TokenUsageBudgetStatusDto } from '@features/token-usage/contracts';

function makeStatus(
  action: 'notify' | 'block_launch' | 'stop_team' = 'stop_team',
  value = 120
): TokenUsageBudgetStatusDto {
  return {
    computedAt: '2026-11-25T00:00:00.000Z',
    period: {
      key: '2026-11',
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
      timeZone: 'UTC',
    },
    stale: false,
    degraded: false,
    notificationPolicy: { enabled: false, nativeToasts: false },
    options: [],
    targets: [
      {
        id: 'team:alpha',
        label: 'alpha',
        scope: 'team',
        notificationsEnabled: false,
        thresholds: [100],
        onExceeded: action,
        metrics: [
          { metric: 'tokens', value, limit: 100, remaining: 0, percent: value, incomplete: false },
        ],
      },
    ],
  };
}

const settle = async () => {
  // The observer schedules an async read -> ownership check -> stop -> postcondition.
  for (let index = 0; index < 30; index++) await Promise.resolve();
};

describe('team budget stop observer', () => {
  it('stops only owned live teams, without duplicate concurrent stops', async () => {
    let alive = true;
    const stop = vi.fn(async () => {
      alive = false;
    });
    const warn = vi.fn();
    const current = makeStatus();
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => current,
      aliveTeams: () => (alive ? ['alpha'] : []),
      ownsTeam: async () => true,
      stopTeam: stop,
      isTeamAlive: async () => alive,
      warn,
    });
    observer.observe(current);
    observer.observe(current);
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rechecks policy after an event before stopping', async () => {
    const stop = vi.fn(async () => undefined);
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus('notify'),
      aliveTeams: () => ['alpha'],
      ownsTeam: async () => true,
      stopTeam: stop,
      isTeamAlive: async () => false,
      warn: vi.fn(),
    });
    observer.observe(makeStatus());
    await settle();
    expect(stop).not.toHaveBeenCalled();
  });

  it('honors a policy change during asynchronous ownership verification', async () => {
    let action: 'stop_team' | 'notify' = 'stop_team';
    const stop = vi.fn(async () => undefined);
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus(action),
      aliveTeams: () => ['alpha'],
      ownsTeam: async () => {
        action = 'notify';
        return true;
      },
      stopTeam: stop,
      isTeamAlive: async () => true,
      warn: vi.fn(),
    });
    observer.observe(makeStatus());
    await settle();
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not stop on unknown data, and records unconfirmed stops as failures', async () => {
    const stop = vi.fn(async () => undefined);
    const warn = vi.fn();
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus(),
      aliveTeams: () => ['alpha'],
      ownsTeam: async () => true,
      stopTeam: stop,
      isTeamAlive: async () => true,
      warn,
    });
    observer.observe({
      ...makeStatus(),
      stale: true,
      targets: [
        {
          ...makeStatus().targets[0],
          metrics: [{ ...makeStatus().targets[0].metrics[0], value: 0 }],
        },
      ],
    });
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    observer.observe({
      ...makeStatus(),
      targets: [
        {
          ...makeStatus().targets[0],
          metrics: [
            { ...makeStatus().targets[0].metrics[0], incomplete: true, value: 0, percent: 0 },
          ],
        },
      ],
    });
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    observer.observe(makeStatus());
    await settle();
    expect(stop).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
  it('never signals a foreign project runtime', async () => {
    const stop = vi.fn(async () => undefined);
    const warn = vi.fn();
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus(),
      aliveTeams: () => ['ptc-foreign'],
      resolveRuntimeNames: async () => ['ptc-foreign'],
      ownsTeam: async () => false,
      stopTeam: stop,
      isTeamAlive: async () => true,
      warn,
    });
    observer.observe(makeStatus());
    for (let n = 0; n < 30; n++) await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('honors a policy change before stopping the next project copy', async () => {
    let action: 'stop_team' | 'notify' = 'stop_team';
    const stop = vi.fn(async (name: string) => {
      if (name === 'ptc-first') action = 'notify';
    });
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus(action),
      aliveTeams: () => ['ptc-first', 'ptc-second'],
      resolveRuntimeNames: async () => ['ptc-first', 'ptc-second'],
      ownsTeam: async () => true,
      stopTeam: stop,
      isTeamAlive: async () => false,
      warn: vi.fn(),
    });
    observer.observe(makeStatus());
    await settle();
    expect(stop).toHaveBeenCalledExactlyOnceWith('ptc-first');
  });

  it('still stops the owned native team if its project index is unreadable', async () => {
    let alive = true;
    const stop = vi.fn(async () => {
      alive = false;
    });
    const warn = vi.fn();
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus(),
      aliveTeams: () => (alive ? ['alpha'] : []),
      resolveRuntimeNames: async () => {
        throw new Error('Corrupt project index');
      },
      ownsTeam: async () => true,
      stopTeam: stop,
      isTeamAlive: async () => alive,
      warn,
    });
    observer.observe(makeStatus());
    await settle();
    expect(stop).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('continues stopping other owned copies when the first stop fails', async () => {
    const stop = vi.fn(async (name: string) => {
      if (name === 'ptc-broken') throw new Error('Cannot stop broken runtime');
    });
    const warn = vi.fn();
    const observer = new TeamBudgetStopObserver({
      readCurrentStatus: async () => makeStatus(),
      aliveTeams: () => ['ptc-broken', 'ptc-healthy'],
      resolveRuntimeNames: async () => ['ptc-broken', 'ptc-healthy'],
      ownsTeam: async () => true,
      stopTeam: stop,
      isTeamAlive: async (name) => name === 'ptc-broken',
      warn,
    });
    observer.observe(makeStatus());
    await settle();
    expect(stop.mock.calls.map(([name]) => name)).toEqual(['ptc-broken', 'ptc-healthy']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ptc-broken');
  });
});
