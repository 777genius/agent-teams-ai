import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type TeamDataProcessCompatibilityPort,
  TeamDataProcessCompatibilityService,
} from '../../../../src/main/services/team/TeamDataProcessCompatibilityService';

import type { TeamProcess, TeamSummary } from '../../../../src/shared/types';

function process(pid: number, stoppedAt?: string): TeamProcess {
  return {
    id: String(pid),
    label: `process-${pid}`,
    pid,
    registeredAt: '2026-07-31T10:00:00.000Z',
    stoppedAt,
  };
}

function team(teamName: string, deletedAt?: string): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: null,
    deletedAt,
  };
}

function createHarness(overrides: Partial<TeamDataProcessCompatibilityPort> = {}) {
  const port: TeamDataProcessCompatibilityPort = {
    listTeams: vi.fn(async () => []),
    listProcesses: vi.fn(() => []),
    stopProcess: vi.fn(),
    killProcessByPid: vi.fn(),
    ...overrides,
  };
  return {
    port,
    service: new TeamDataProcessCompatibilityService(port, 25),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TeamDataProcessCompatibilityService', () => {
  it('lists only non-deleted teams with an active process and isolates read failures', async () => {
    const listProcesses = vi.fn((teamName: string) => {
      if (teamName === 'alpha') return [process(101)];
      if (teamName === 'beta') return [process(202, '2026-07-31T10:05:00.000Z')];
      throw new Error('registry unavailable');
    });
    const { service } = createHarness({
      listTeams: vi.fn(async () => [
        team('gamma'),
        team('beta'),
        team('deleted', '2026-07-31T10:06:00.000Z'),
        team('alpha'),
      ]),
      listProcesses,
    });

    await expect(service.listAliveProcessTeams()).resolves.toEqual(['alpha']);
    expect(listProcesses).not.toHaveBeenCalledWith('deleted');
  });

  it('owns polling state, polls tracked teams once per interval, and clears tracking on stop', async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn(() => []);
    const { service } = createHarness({ listProcesses });

    service.observeTeamAlive('alpha', true);
    service.observeTeamAlive('offline', false);
    service.startProcessHealthPolling();
    service.startProcessHealthPolling();
    await vi.advanceTimersByTimeAsync(25);

    expect(listProcesses).toHaveBeenCalledTimes(1);
    expect(listProcesses).toHaveBeenCalledWith('alpha');

    service.stopProcessHealthPolling();
    service.startProcessHealthPolling();
    await vi.advanceTimersByTimeAsync(25);
    expect(listProcesses).toHaveBeenCalledTimes(1);
    service.stopProcessHealthPolling();
  });

  it('keeps polling best-effort across tracked teams', async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn((teamName: string) => {
      if (teamName === 'broken') throw new Error('broken registry row');
      return [process(303)];
    });
    const { service } = createHarness({ listProcesses });
    service.trackProcessHealthForTeam('broken');
    service.trackProcessHealthForTeam('healthy');

    service.startProcessHealthPolling();
    await vi.advanceTimersByTimeAsync(25);

    expect(listProcesses.mock.calls.map(([teamName]) => teamName)).toEqual(['broken', 'healthy']);
    service.stopProcessHealthPolling();
  });

  it('delegates reads without acquiring a process registry', async () => {
    const expected = [process(404)];
    const listProcesses = vi.fn(() => expected);
    const { service } = createHarness({ listProcesses });

    await expect(service.readProcesses('alpha')).resolves.toBe(expected);
    expect(listProcesses).toHaveBeenCalledWith('alpha');
  });

  it('kills through the OS port before reconciling the external registry', async () => {
    const order: string[] = [];
    const { service } = createHarness({
      killProcessByPid: vi.fn(() => order.push('kill')),
      stopProcess: vi.fn(() => order.push('stop')),
    });

    await expect(service.killProcess('alpha', 505)).resolves.toBeUndefined();
    expect(order).toEqual(['kill', 'stop']);
  });

  it('reconciles ESRCH and missing registry rows but surfaces other OS kill errors', async () => {
    const alreadyGone = Object.assign(new Error('already gone'), { code: 'ESRCH' });
    const stopProcess = vi.fn(() => {
      throw new Error('missing registry row');
    });
    const { service } = createHarness({
      killProcessByPid: vi.fn(() => {
        throw alreadyGone;
      }),
      stopProcess,
    });

    await expect(service.killProcess('alpha', 606)).resolves.toBeUndefined();
    expect(stopProcess).toHaveBeenCalledWith('alpha', 606);

    const denied = createHarness({
      killProcessByPid: vi.fn(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
      stopProcess: vi.fn(),
    });
    await expect(denied.service.killProcess('alpha', 707)).rejects.toThrow(
      'Failed to kill process 707: denied'
    );
    expect(denied.port.stopProcess).not.toHaveBeenCalled();
  });
});
