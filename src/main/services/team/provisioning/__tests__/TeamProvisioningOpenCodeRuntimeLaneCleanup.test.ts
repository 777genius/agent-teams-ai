import { describe, expect, it, vi } from 'vitest';

import {
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground,
  hasAlivePersistedTeamProcessRows,
  hasOnlyExplicitlyStoppedPersistedTeamProcessRows,
  resolveOpenCodeRuntimeLaneCleanupCwd,
  selectActiveOpenCodeRuntimeLaneIds,
  stopOpenCodeRuntimeLanesForStoppedTeamOnce,
  tryStopPersistedOpenCodeRuntimePidForStoppedLane,
} from '../TeamProvisioningOpenCodeRuntimeLaneCleanup';

import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

function buildLaunchSnapshot(member: Record<string, unknown>): PersistedTeamLaunchSnapshot {
  return {
    members: {
      teammate: member,
    },
  } as unknown as PersistedTeamLaunchSnapshot;
}

describe('TeamProvisioningOpenCodeRuntimeLaneCleanup', () => {
  it('detects alive persisted process rows only when the row is active and the pid is live', () => {
    const isProcessAlive = vi.fn((pid: number) => pid === 42);

    expect(
      hasAlivePersistedTeamProcessRows(
        [
          null,
          { pid: 41 },
          { pid: 42, stoppedAt: null },
          { pid: 43, stoppedAt: '2026-01-01T00:00:00.000Z' },
        ],
        { isProcessAlive }
      )
    ).toBe(true);
    expect(isProcessAlive).toHaveBeenCalledWith(41);
    expect(isProcessAlive).toHaveBeenCalledWith(42);
    expect(isProcessAlive).not.toHaveBeenCalledWith(43);

    expect(
      hasAlivePersistedTeamProcessRows([{ pid: 99, stoppedAt: 'done' }], { isProcessAlive })
    ).toBe(false);
    expect(hasAlivePersistedTeamProcessRows(null, { isProcessAlive })).toBe(false);
  });

  it('requires every persisted process row to be explicitly stopped', () => {
    expect(
      hasOnlyExplicitlyStoppedPersistedTeamProcessRows([
        { pid: 1, stoppedAt: '2026-01-01T00:00:00.000Z' },
        { pid: 2, stoppedAt: '2026-01-01T00:00:01.000Z' },
      ])
    ).toBe(true);
    expect(hasOnlyExplicitlyStoppedPersistedTeamProcessRows([])).toBe(false);
    expect(hasOnlyExplicitlyStoppedPersistedTeamProcessRows([{ pid: 1 }])).toBe(false);
    expect(hasOnlyExplicitlyStoppedPersistedTeamProcessRows([null])).toBe(false);
  });

  it('selects active OpenCode runtime lanes in deterministic order', () => {
    expect(
      selectActiveOpenCodeRuntimeLaneIds({
        lanes: {
          'secondary:opencode:zeta': {
            laneId: 'secondary:opencode:zeta',
            state: 'active',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          primary: { laneId: 'primary', state: 'stopped', updatedAt: '2026-01-01T00:00:00.000Z' },
          'secondary:opencode:alpha': {
            laneId: 'secondary:opencode:alpha',
            state: 'active',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })
    ).toEqual(['secondary:opencode:alpha', 'secondary:opencode:zeta']);
  });

  it('reuses an in-flight stopped-team lane cleanup promise and clears it after settlement', async () => {
    const inFlight = new Map<string, Promise<number>>();
    const stopInternal = vi.fn(() => Promise.resolve(2));

    const first = stopOpenCodeRuntimeLanesForStoppedTeamOnce({
      teamName: 'team',
      inFlight,
      stopInternal,
    });
    const second = stopOpenCodeRuntimeLanesForStoppedTeamOnce({
      teamName: 'team',
      inFlight,
      stopInternal,
    });

    expect(second).toBe(first);
    expect(await first).toBe(2);
    expect(stopInternal).toHaveBeenCalledTimes(1);
    expect(inFlight.has('team')).toBe(false);
  });

  it('logs background stopped-team lane cleanup failures', async () => {
    const logWarning = vi.fn();

    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground({
      teamName: 'team',
      stopOpenCodeRuntimeLanesForStoppedTeam: () => Promise.reject(new Error('cleanup failed')),
      logWarning,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logWarning).toHaveBeenCalledWith(
      '[team] Failed to clean up stopped-team OpenCode runtime lanes: cleanup failed'
    );
  });

  it('resolves cleanup cwd from member metadata before config and project fallback', () => {
    const config: TeamConfig = {
      name: 'Runtime Lane Team',
      projectPath: ' /repo/root ',
      members: [{ name: 'Builder', cwd: ' /repo/config-builder ' }],
    };
    const metaMembers: TeamMember[] = [{ name: ' builder ', cwd: ' /repo/meta-builder ' }];

    expect(
      resolveOpenCodeRuntimeLaneCleanupCwd({
        laneId: 'secondary:opencode:Builder',
        config,
        metaMembers,
        persistedTeamProjectPath: '/repo/persisted',
      })
    ).toBe('/repo/meta-builder');
    expect(
      resolveOpenCodeRuntimeLaneCleanupCwd({
        laneId: 'secondary:opencode:Missing',
        config,
        metaMembers,
        persistedTeamProjectPath: '/repo/persisted',
      })
    ).toBe('/repo/root');
    expect(
      resolveOpenCodeRuntimeLaneCleanupCwd({
        laneId: 'primary',
        config: null,
        metaMembers: [],
        persistedTeamProjectPath: '/repo/persisted',
      })
    ).toBe('/repo/persisted');
  });

  it('stops persisted OpenCode runtime pids only when command identity is unchanged and safe', () => {
    const killProcessByPid = vi.fn();
    const ports = {
      readProcessCommandByPid: vi.fn(() => 'opencode serve --hostname 127.0.0.1'),
      isOpenCodeServeCommand: vi.fn(() => true),
      killProcessByPid,
      logInfo: vi.fn(),
      logWarning: vi.fn(),
    };
    const snapshot = buildLaunchSnapshot({
      providerId: 'opencode',
      laneId: 'secondary:opencode:Builder',
      runtimePid: 123,
      processCommand: ' opencode serve --hostname 127.0.0.1 ',
    });

    expect(
      tryStopPersistedOpenCodeRuntimePidForStoppedLane(
        {
          teamName: 'team',
          laneId: 'secondary:opencode:Builder',
          previousLaunchState: snapshot,
        },
        ports
      )
    ).toBe('stopped');
    expect(killProcessByPid).toHaveBeenCalledWith(123);

    ports.readProcessCommandByPid.mockReturnValueOnce('node server.js');
    expect(
      tryStopPersistedOpenCodeRuntimePidForStoppedLane(
        {
          teamName: 'team',
          laneId: 'secondary:opencode:Builder',
          previousLaunchState: snapshot,
        },
        ports
      )
    ).toBe('unsafe');
  });

  it('does not stop a user-managed OpenCode serve process without persisted command identity', () => {
    const killProcessByPid = vi.fn();
    const ports = {
      readProcessCommandByPid: vi.fn(() => '/usr/local/bin/opencode serve --port 4096'),
      isOpenCodeServeCommand: vi.fn(() => true),
      killProcessByPid,
      logInfo: vi.fn(),
      logWarning: vi.fn(),
    };

    expect(
      tryStopPersistedOpenCodeRuntimePidForStoppedLane(
        {
          teamName: 'team',
          laneId: 'secondary:opencode:Builder',
          previousLaunchState: buildLaunchSnapshot({
            providerId: 'opencode',
            laneId: 'secondary:opencode:Builder',
            runtimePid: 123,
          }),
        },
        ports
      )
    ).toBe('unsafe');
    expect(killProcessByPid).not.toHaveBeenCalled();
    expect(ports.isOpenCodeServeCommand).not.toHaveBeenCalled();
    expect(ports.logWarning).toHaveBeenCalledWith(
      '[team] Refusing to stop persisted OpenCode pid 123 for lane secondary:opencode:Builder: persisted process command is unavailable.'
    );
  });
});
