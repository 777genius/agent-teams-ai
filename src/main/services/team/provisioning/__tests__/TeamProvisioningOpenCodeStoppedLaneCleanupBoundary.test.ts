import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
  type TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryDeps,
  type TeamProvisioningOpenCodeStoppedLaneCleanupPorts,
} from '../TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';

type Helpers = NonNullable<TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryDeps['helpers']>;

function createPorts(
  overrides: Partial<TeamProvisioningOpenCodeStoppedLaneCleanupPorts> = {}
): TeamProvisioningOpenCodeStoppedLaneCleanupPorts {
  return {
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
    expect(ports.clearPrimaryRuntimeRun).toHaveBeenCalledWith('alpha');
    expect(ports.markStoppedTeamOpenCodeRuntimeLanesCleaned).toHaveBeenCalledWith('alpha');
    expect(ports.logWarning).toHaveBeenCalledWith('warn');
  });
});
