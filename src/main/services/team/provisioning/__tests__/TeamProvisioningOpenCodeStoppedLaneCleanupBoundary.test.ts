import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setOpenCodeRuntimeActiveRunManifest,
  writeOpenCodeRuntimeLaneIndex,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
  type TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryDeps,
  type TeamProvisioningOpenCodeStoppedLaneCleanupPorts,
} from '../TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';
import { OPENCODE_STOPPED_LANE_STOP_BACKOFF_MS } from '../TeamProvisioningOpenCodeStoppedLaneStopBackoff';

import type { TeamRuntimeStopInput } from '../../runtime';

type Helpers = NonNullable<TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryDeps['helpers']>;

function createPorts(
  overrides: Partial<TeamProvisioningOpenCodeStoppedLaneCleanupPorts> = {}
): TeamProvisioningOpenCodeStoppedLaneCleanupPorts {
  return {
    withTeamLock: vi.fn(async (_teamName, operation) => operation()),
    isManagedByThisProfile: vi.fn(async () => true),
    canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => false),
    getOpenCodeRuntimeAdapter: vi.fn(() => null),
    readPreviousLaunchState: vi.fn(async () => null),
    readConfigForObservation: vi.fn(async () => null),
    readMembersMeta: vi.fn(async () => []),
    readPersistedTeamProjectPath: vi.fn(() => null),
    deleteSecondaryRuntimeRun: vi.fn(),
    clearPrimaryRuntimeRun: vi.fn(),
    markStoppedTeamOpenCodeRuntimeLanesCleaned: vi.fn(),
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    ...overrides,
  };
}

function createBoundary(
  ports = createPorts(),
  helpers: Helpers = {}
): ReturnType<typeof createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary> {
  return createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(ports, {
    getTeamsBasePath: () => '/teams',
    helpers,
  });
}

describe('TeamProvisioningOpenCodeStoppedLaneCleanupBoundary', () => {
  it('uses the configured teams base path for persisted process predicates', () => {
    const helpers: Helpers = {
      hasAlivePersistedTeamProcess: vi.fn(() => true),
      hasOnlyExplicitlyStoppedPersistedTeamProcesses: vi.fn(() => false),
    };
    const boundary = createBoundary(createPorts(), helpers);

    expect(boundary.hasAlivePersistedTeamProcess('alpha')).toBe(true);
    expect(boundary.hasOnlyExplicitlyStoppedPersistedTeamProcesses('alpha')).toBe(false);

    expect(helpers.hasAlivePersistedTeamProcess).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'alpha',
    });
    expect(helpers.hasOnlyExplicitlyStoppedPersistedTeamProcesses).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'alpha',
    });
  });

  it('delegates stopped lane cleanup to the background helper', () => {
    const ports = createPorts();
    const helpers: Helpers = {
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    };
    const boundary = createBoundary(ports, helpers);

    boundary.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground('alpha');

    expect(helpers.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'alpha',
        logWarning: ports.logWarning,
      })
    );
  });

  it('dedupes concurrent stopped lane cleanup for the same team', async () => {
    let resolveCleanup!: (value: number | PromiseLike<number>) => void;
    const cleanupPromise = new Promise<number>((resolve) => {
      resolveCleanup = resolve;
    });
    const helpers: Helpers = {
      stopOpenCodeRuntimeLanesForStoppedTeam: vi.fn(() => cleanupPromise),
    };
    const boundary = createBoundary(createPorts(), helpers);

    const first = boundary.stopOpenCodeRuntimeLanesForStoppedTeam('alpha');
    const second = boundary.stopOpenCodeRuntimeLanesForStoppedTeam('alpha');
    resolveCleanup(2);

    await expect(first).resolves.toBe(2);
    await expect(second).resolves.toBe(2);
    expect(helpers.stopOpenCodeRuntimeLanesForStoppedTeam).toHaveBeenCalledTimes(1);
  });

  it('wires stopped lane pid cleanup through injected safety helpers', async () => {
    const ports = createPorts();
    const helpers: Helpers = {
      readProcessCommandByPid: vi.fn(() => 'opencode serve'),
      isOpenCodeServeCommand: vi.fn(() => true),
      killProcessByPid: vi.fn(),
      tryStopPersistedOpenCodeRuntimePidForStoppedLane: vi.fn((): 'stopped' => 'stopped'),
      stopOpenCodeRuntimeLanesForStoppedTeam: vi.fn(async (input) => {
        await input.ports.withTeamLock(input.teamName, async () => undefined);
        input.ports.tryStopPersistedOpenCodeRuntimePidForStoppedLane({
          teamName: input.teamName,
          laneId: 'primary',
          previousLaunchState: null,
        });
        input.ports.deleteSecondaryRuntimeRun(input.teamName, 'primary');
        input.ports.clearPrimaryRuntimeRun(input.teamName);
        input.ports.markStoppedTeamOpenCodeRuntimeLanesCleaned(input.teamName);
        input.ports.logWarning('warn');
        return 1;
      }),
    };
    const boundary = createBoundary(ports, helpers);

    await expect(boundary.stopOpenCodeRuntimeLanesForStoppedTeam('alpha')).resolves.toBe(1);

    expect(helpers.stopOpenCodeRuntimeLanesForStoppedTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'alpha',
        teamsBasePath: '/teams',
      })
    );
    expect(helpers.tryStopPersistedOpenCodeRuntimePidForStoppedLane).toHaveBeenCalledWith(
      {
        teamName: 'alpha',
        laneId: 'primary',
        previousLaunchState: null,
      },
      expect.objectContaining({
        readProcessCommandByPid: helpers.readProcessCommandByPid,
        isOpenCodeServeCommand: helpers.isOpenCodeServeCommand,
        killProcessByPid: helpers.killProcessByPid,
        logInfo: ports.logInfo,
        logWarning: ports.logWarning,
      })
    );
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('alpha', 'primary');
    expect(ports.withTeamLock).toHaveBeenCalledWith('alpha', expect.any(Function));
    expect(ports.clearPrimaryRuntimeRun).toHaveBeenCalledWith('alpha');
    expect(ports.markStoppedTeamOpenCodeRuntimeLanesCleaned).toHaveBeenCalledWith('alpha');
    expect(ports.logWarning).toHaveBeenCalledWith('warn');
  });

  describe('backoff after an unconfirmed stop', () => {
    let teamsBasePath: string;
    let nowMs: number;

    beforeEach(async () => {
      teamsBasePath = mkdtempSync(join(tmpdir(), 'stopped-lane-stop-backoff-'));
      nowMs = 1_000_000;
      await writeOpenCodeRuntimeLaneIndex(teamsBasePath, 'team', {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        lanes: {
          primary: { laneId: 'primary', state: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath,
        teamName: 'team',
        laneId: 'primary',
        runId: 'run-1',
      });
    });

    afterEach(() => {
      rmSync(teamsBasePath, { recursive: true, force: true });
    });

    function createUnconfirmingBoundary(): {
      boundary: ReturnType<typeof createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary>;
      lockCalls: () => number;
      logWarning: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    } {
      const stop = vi.fn(async (input: TeamRuntimeStopInput) => ({
        runId: input.runId,
        teamName: input.teamName,
        stopped: false,
        members: {},
        warnings: [],
        diagnostics: ['runtime still active'],
      }));
      let lockCalls = 0;
      const withTeamLock: TeamProvisioningOpenCodeStoppedLaneCleanupPorts['withTeamLock'] = async (
        _teamName,
        operation
      ) => {
        lockCalls += 1;
        return await operation();
      };
      const logWarning = vi.fn();
      const ports = createPorts({
        withTeamLock,
        getOpenCodeRuntimeAdapter: vi.fn(() => ({ providerId: 'opencode', stop }) as never),
        logWarning,
      });
      const boundary = createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(ports, {
        getTeamsBasePath: () => teamsBasePath,
        nowMs: () => nowMs,
      });
      return { boundary, lockCalls: () => lockCalls, logWarning, stop };
    }

    it('does not ask the bridge again or take the team lock until the backoff ends', async () => {
      const { boundary, lockCalls, logWarning, stop } = createUnconfirmingBoundary();

      await expect(boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team')).resolves.toBe(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(lockCalls()).toBe(1);
      expect(logWarning).toHaveBeenCalledWith(
        expect.stringContaining('[team] OpenCode lane primary did not confirm stop')
      );

      nowMs += OPENCODE_STOPPED_LANE_STOP_BACKOFF_MS - 1;
      boundary.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground('team');
      // Joins the background pass above if it is still running.
      await expect(boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team')).resolves.toBe(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(lockCalls()).toBe(1);

      nowMs += 1;
      await boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team');
      expect(stop).toHaveBeenCalledTimes(2);
      expect(lockCalls()).toBe(2);
    });

    it('retries at once once the backoff of the team was cleared', async () => {
      const { boundary, lockCalls, stop } = createUnconfirmingBoundary();
      await boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team');

      boundary.clearStopBackoff('team');
      await boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team');

      expect(stop).toHaveBeenCalledTimes(2);
      expect(lockCalls()).toBe(2);
    });

    it('does not back off a new run of the same lane', async () => {
      const { boundary, stop } = createUnconfirmingBoundary();
      await boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team');

      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath,
        teamName: 'team',
        laneId: 'primary',
        runId: 'run-2',
      });
      await boundary.stopOpenCodeRuntimeLanesForStoppedTeam('team');

      expect(stop).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-2' }));
    });
  });
});
