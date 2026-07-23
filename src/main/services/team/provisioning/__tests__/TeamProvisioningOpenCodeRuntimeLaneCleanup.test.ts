import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  writeOpenCodeRuntimeLaneIndex,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground,
  hasAlivePersistedTeamProcessRows,
  hasOnlyExplicitlyStoppedPersistedTeamProcessRows,
  resolveOpenCodeRuntimeLaneCleanupCwd,
  selectActiveOpenCodeRuntimeLaneIds,
  stopOpenCodeRuntimeLanesForStoppedTeam,
  stopOpenCodeRuntimeLanesForStoppedTeamOnce,
  tryStopPersistedOpenCodeRuntimePidForStoppedLane,
} from '../TeamProvisioningOpenCodeRuntimeLaneCleanup';

import type { TeamRuntimeStopInput } from '../../runtime';
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

  it('retains stopped-team lane ownership and storage when adapter stop is not confirmed', async () => {
    const teamsBasePath = mkdtempSync(join(tmpdir(), 'stopped-team-lane-cleanup-'));
    const laneId = 'primary';
    const stop = vi.fn(async () => ({
      runId: 'run-1',
      teamName: 'team',
      stopped: false,
      members: {},
      warnings: [],
      diagnostics: ['runtime still active'],
    }));
    const deleteSecondaryRuntimeRun = vi.fn();
    const clearPrimaryRuntimeRun = vi.fn();
    const markStoppedTeamOpenCodeRuntimeLanesCleaned = vi.fn();
    const logWarning = vi.fn();

    try {
      await writeOpenCodeRuntimeLaneIndex(teamsBasePath, 'team', {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        lanes: {
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath,
        teamName: 'team',
        laneId,
        runId: 'run-1',
      });

      await expect(
        stopOpenCodeRuntimeLanesForStoppedTeam({
          teamName: 'team',
          teamsBasePath,
          ports: {
            canDeliverToOpenCodeRuntimeForTeam: () => false,
            getOpenCodeRuntimeAdapter: () =>
              ({
                providerId: 'opencode',
                stop,
              }) as unknown as ReturnType<
                Parameters<
                  typeof stopOpenCodeRuntimeLanesForStoppedTeam
                >[0]['ports']['getOpenCodeRuntimeAdapter']
              >,
            readPreviousLaunchState: async () => null,
            readConfigForObservation: async () => null,
            readMembersMeta: async () => [],
            readPersistedTeamProjectPath: () => null,
            tryStopPersistedOpenCodeRuntimePidForStoppedLane: () => 'no_pid',
            deleteSecondaryRuntimeRun,
            clearPrimaryRuntimeRun,
            markStoppedTeamOpenCodeRuntimeLanesCleaned,
            logWarning,
          },
        })
      ).resolves.toBe(0);

      expect(deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
      expect(clearPrimaryRuntimeRun).not.toHaveBeenCalled();
      expect(markStoppedTeamOpenCodeRuntimeLanesCleaned).not.toHaveBeenCalled();
      expect((await readOpenCodeRuntimeLaneIndex(teamsBasePath, 'team')).lanes.primary?.state).toBe(
        'active'
      );
      expect(logWarning).toHaveBeenCalledWith(
        '[team] OpenCode lane primary did not confirm stop; retaining runtime ownership and storage.'
      );
    } finally {
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('does not clear a replacement generation installed while stopped-team adapter stop is deferred', async () => {
    const teamsBasePath = mkdtempSync(join(tmpdir(), 'stopped-team-lane-replacement-'));
    const laneId = 'primary';
    let resolveStop!: () => void;
    let signalStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      signalStopStarted = resolve;
    });
    const stopRelease = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => {
      signalStopStarted();
      await stopRelease;
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const deleteSecondaryRuntimeRun = vi.fn();
    const clearPrimaryRuntimeRun = vi.fn();
    const markStoppedTeamOpenCodeRuntimeLanesCleaned = vi.fn();
    const logWarning = vi.fn();

    try {
      await writeOpenCodeRuntimeLaneIndex(teamsBasePath, 'team', {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        lanes: {
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath,
        teamName: 'team',
        laneId,
        runId: 'run-old',
      });

      const cleanup = stopOpenCodeRuntimeLanesForStoppedTeam({
        teamName: 'team',
        teamsBasePath,
        ports: {
          canDeliverToOpenCodeRuntimeForTeam: () => false,
          getOpenCodeRuntimeAdapter: () =>
            ({
              providerId: 'opencode',
              stop,
            }) as unknown as ReturnType<
              Parameters<
                typeof stopOpenCodeRuntimeLanesForStoppedTeam
              >[0]['ports']['getOpenCodeRuntimeAdapter']
            >,
          readPreviousLaunchState: async () => null,
          readConfigForObservation: async () => null,
          readMembersMeta: async () => [],
          readPersistedTeamProjectPath: () => null,
          tryStopPersistedOpenCodeRuntimePidForStoppedLane: () => 'no_pid',
          deleteSecondaryRuntimeRun,
          clearPrimaryRuntimeRun,
          markStoppedTeamOpenCodeRuntimeLanesCleaned,
          logWarning,
        },
      });
      await stopStarted;

      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath,
        teamName: 'team',
        laneId,
        runId: 'run-new',
      });
      resolveStop();

      await expect(cleanup).resolves.toBe(1);
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-old', laneId }));
      expect(deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
      expect(clearPrimaryRuntimeRun).not.toHaveBeenCalled();
      expect(markStoppedTeamOpenCodeRuntimeLanesCleaned).not.toHaveBeenCalled();
      expect(
        (
          await new OpenCodeRuntimeManifestEvidenceReader({
            teamsBasePath,
          }).read('team', laneId)
        ).activeRunId
      ).toBe('run-new');
      expect(logWarning).toHaveBeenCalledWith(
        '[team] OpenCode lane primary ownership changed before stopped-team storage cleanup; retaining current runtime tracking.'
      );
    } finally {
      resolveStop();
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });
});
