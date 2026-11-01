import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

const tmuxMocks = vi.hoisted(() => ({ killTmuxPaneForCurrentPlatformSync: vi.fn() }));
vi.mock('@features/tmux-installer/main', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  killTmuxPaneForCurrentPlatformSync: tmuxMocks.killTmuxPaneForCurrentPlatformSync,
}));

import { buildOpenCodeAppProfileScope } from '../../opencode/bridge/OpenCodeMcpBridgeEnv';
import {
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  writeOpenCodeRuntimeLaneIndex,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamTaskActivityIntervalService } from '../../TeamTaskActivityIntervalService';
import { createAnthropicApiKeyHelperCleanupRetryOwner } from '../TeamProvisioningAnthropicApiKeyHelperLease';
import {
  createNodeClearStoppedTeamLiveRuntimeHandlesPorts,
  persistClearedStoppedTeamLiveRuntimeHandles,
} from '../TeamProvisioningClearStoppedTeamRuntimeHandles';
import {
  createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
  type TeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
} from '../TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';
import {
  listPersistedTeamNames,
  readPersistedRuntimeMembers,
} from '../TeamProvisioningPersistedTeamConfigAccess';
import { createTeamProvisioningPersistentRuntimeCleanup } from '../TeamProvisioningPersistentRuntimeCleanup';
import {
  claimTeamForThisProfile,
  createTeamProfileOwnership,
  TEAM_PROFILE_OWNER_MARKER_FILE,
  type TeamProfileOwnership,
} from '../TeamProvisioningProfileOwnership';
import {
  createTeamProvisioningRequestAdmissionBoundary,
  type TeamProvisioningRequestAdmissionServiceHost,
} from '../TeamProvisioningRequestAdmission';
import { createTeamProvisioningShutdownCoordination } from '../TeamProvisioningShutdownCoordination';
import { stopAllTeamsFlow } from '../TeamProvisioningStopFlow';
import {
  killOrphanedTeamAgentProcesses,
  killPersistedPaneMembers,
} from '../TeamProvisioningStopProcessCleanup';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { PersistedTeamLaunchSnapshot, TeamLaunchRequest } from '@shared/types';

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
const canChmodDeny =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

let root: string;
let userDataA: string;
let userDataB: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-profile-ownership-'));
  userDataA = path.join(root, 'user-data-a');
  userDataB = path.join(root, 'user-data-b');
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(userDataA);
  tmuxMocks.killTmuxPaneForCurrentPlatformSync.mockReset();
});

afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

function scopeOf(userData: string): string {
  return buildOpenCodeAppProfileScope(userData, path.join(root, 'claude'));
}

/** A new process of profile A: nothing tracked in memory. */
function freshOwnership(): TeamProfileOwnership {
  return createTeamProfileOwnership({ isTrackedInThisProcess: () => false });
}

async function writeTeam(
  teamName: string,
  input: { paneId: string; ownerScope?: string; ownerMarkerRaw?: string }
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: teamName,
        members: [
          { name: 'team-lead' },
          { name: 'bob', backendType: 'tmux', tmuxPaneId: input.paneId, isActive: true },
        ],
      },
      null,
      2
    )}\n`
  );
  const taskPath = path.join(root, 'claude', 'tasks', teamName, 'held.json');
  await mkdir(path.dirname(taskPath), { recursive: true });
  await writeFile(
    taskPath,
    JSON.stringify({
      id: 'held',
      owner: 'bob',
      status: 'in_progress',
      historyEvents: [
        { type: 'task_created', status: 'in_progress', timestamp: '2026-10-28T10:00:00.000Z' },
      ],
      workIntervals: [{ startedAt: '2026-10-28T10:00:00.000Z' }],
    })
  );
  if (input.ownerScope) {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      reason: 'launch',
      profileScope: input.ownerScope,
    });
  }
  if (input.ownerMarkerRaw !== undefined) {
    await writeFile(path.join(teamDir, TEAM_PROFILE_OWNER_MARKER_FILE), input.ownerMarkerRaw);
  }
}

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    snapshot[path.relative(dir, filePath)] = await readFile(filePath, 'utf8');
  }
  return snapshot;
}

async function snapshotTeam(teamName: string): Promise<Record<string, Record<string, string>>> {
  return {
    team: await snapshotTree(path.join(getTeamsBasePath(), teamName)),
    tasks: await snapshotTree(path.join(root, 'claude', 'tasks', teamName)),
  };
}

interface ProcessTable {
  killPid: Mock<(pid: number) => void>;
  overrides: NonNullable<Parameters<typeof killOrphanedTeamAgentProcesses>[1]>;
}

/** A live process table with one teammate per team; killPid removes the process. */
function createProcessTable(entries: Record<string, number>): ProcessTable {
  const live = new Map(
    Object.entries(entries).map(([teamName, pid]) => [
      pid,
      `node agent --team-name ${teamName} --agent-id bob@${teamName}`,
    ])
  );
  const killPid = vi.fn((pid: number) => {
    live.delete(pid);
  });
  return {
    killPid,
    overrides: {
      readRows: () => [...live].map(([pid, command]) => ({ pid, command })),
      readIdentities: () =>
        new Map(
          [...live.keys()].map((pid) => [
            pid,
            { pid, parentPid: 1, processGroupId: pid, startIdentity: `test:${pid}` },
          ])
        ),
      killPid,
      isPidAlive: (pid: number) => live.has(pid),
    },
  };
}

/**
 * Runs the real quit sequence of a fresh process of profile A over the temp
 * Claude root. `stopTeam` performs the same destructive steps as a tracked
 * stop (pause, pane/process kill, handle rewrite), so any stop of a foreign
 * team shows up in the assertions.
 */
async function runShutdown(
  ownership: TeamProfileOwnership,
  table: ProcessTable,
  options: {
    lockedTeamNames?: string[];
    afterOrphanCleanup?: (teamName: string) => Promise<void>;
  } = {}
): Promise<{
  cleanupAnthropicTeamApiKeyHelperForTeam: Mock<() => Promise<undefined>>;
  stopTeam: Mock<(teamName: string) => Promise<void>>;
}> {
  const cleanupAnthropicTeamApiKeyHelperForTeam = vi.fn(async () => undefined);
  const activity = new TeamTaskActivityIntervalService();
  const persistent = createTeamProvisioningPersistentRuntimeCleanup({
    readPersistedRuntimeMembers: (teamName) =>
      readPersistedRuntimeMembers(teamName, {
        teamsBasePath: getTeamsBasePath(),
        cache: new Map(),
      }),
    killPersistedPaneMembers: (teamName, members) =>
      killPersistedPaneMembers(teamName, members, logger),
    killOrphanedTeamAgentProcesses: (teamName, currentRunPid, knownPids, killOptions) =>
      killOrphanedTeamAgentProcesses(
        { teamName, currentRunPid, knownPids, isRecheck: killOptions?.isRecheck, logger },
        table.overrides
      ),
    getCurrentRunPid: () => undefined,
    cleanupAnthropicTeamApiKeyHelperForTeam,
    getClaudeBasePath: () => path.join(root, 'claude'),
    clearPersistedLiveRuntimeHandles: (teamName) =>
      persistClearedStoppedTeamLiveRuntimeHandles(teamName, {
        ...createNodeClearStoppedTeamLiveRuntimeHandlesPorts(),
        invalidateTeamConfig: () => undefined,
      }),
    sleep: async () => undefined,
    logger,
  });
  const stopTeam = vi.fn(async (teamName: string) => {
    activity.pauseActiveIntervalsForTeam(teamName);
    persistent.stopPersistentTeamMembers(teamName);
    await persistent.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
  });
  // Operations holding these locks finish while shutdown waits for them.
  const teamOpLocks = new Map(
    (options.lockedTeamNames ?? []).map((teamName) => [teamName, Promise.resolve()])
  );
  const coordination = createTeamProvisioningShutdownCoordination(
    {
      provisioningRunByTeam: new Map(),
      aliveRunByTeam: new Map(),
      runtimeAdapterRunByTeam: new Map(),
      secondaryRuntimeRunByTeam: new Map(),
      teamOpLocks,
      runtimeAdapterProgressByRunId: new Map(),
      transientProbeProcesses: new Set(),
    },
    {
      isCancellableRuntimeAdapterProgress: () => false,
      getOpenCodeAggregatePrimaryRestartTeamNames: () => [],
      getOpenCodeRuntimeAdapterStopInFlightTeamNames: () => [],
      stopTeam,
      cancelRuntimeAdapterProvisioning: async () => undefined,
      killProcessTree: vi.fn(),
      isManagedByThisProfile: (teamName) => ownership.isManagedByThisProfile(teamName),
      logger,
    }
  );
  await stopAllTeamsFlow({
    incrementStopAllTeamsGeneration: vi.fn(),
    getShutdownTrackedTeamNames: () => coordination.getShutdownTrackedTeamNames(),
    getShutdownRunningTeamNames: () => coordination.getShutdownRunningTeamNames(),
    pauseActiveIntervalsForTeam: (teamName) => {
      activity.pauseActiveIntervalsForTeam(teamName);
    },
    killTrackedCliProcesses: vi.fn(),
    killTransientProbeProcessesForShutdown: () =>
      coordination.killTransientProbeProcessesForShutdown(),
    stopTrackedTeamsForShutdown: (label) => coordination.stopTrackedTeamsForShutdown(label),
    cancelPendingRuntimeAdapterLaunchesForShutdown: () =>
      coordination.cancelPendingRuntimeAdapterLaunchesForShutdown(),
    waitForInFlightTeamOperationsForShutdown: async () => {
      await coordination.waitForInFlightTeamOperationsForShutdown();
      teamOpLocks.clear();
    },
    listPersistedTeamNames: () => listPersistedTeamNames(getTeamsBasePath()),
    isManagedByThisProfile: (teamName) => ownership.isManagedByThisProfile(teamName),
    stopPersistentTeamMembers: (teamName) => {
      persistent.stopPersistentTeamMembers(teamName);
    },
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: async (teamName) => {
      await persistent.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
      await options.afterOrphanCleanup?.(teamName);
    },
    logger,
  });
  return { cleanupAnthropicTeamApiKeyHelperForTeam, stopTeam };
}

describe('shutdown leftovers cleanup (F1)', () => {
  it('leaves teams of other profiles byte-identical and still cleans this profile', async () => {
    await writeTeam('foreign-unmarked', { paneId: '%11' });
    await writeTeam('foreign-other-profile', { paneId: '%12', ownerScope: scopeOf(userDataB) });
    await writeTeam('own', { paneId: '%13', ownerScope: scopeOf(userDataA) });
    const foreignBefore = {
      unmarked: await snapshotTeam('foreign-unmarked'),
      otherProfile: await snapshotTeam('foreign-other-profile'),
    };
    const ownBefore = await snapshotTeam('own');
    const table = createProcessTable({
      'foreign-unmarked': 41,
      'foreign-other-profile': 42,
      own: 43,
    });

    const { cleanupAnthropicTeamApiKeyHelperForTeam } = await runShutdown(freshOwnership(), table);

    expect(table.killPid.mock.calls).toEqual([[43]]);
    expect(tmuxMocks.killTmuxPaneForCurrentPlatformSync.mock.calls).toEqual([['%13']]);
    expect(cleanupAnthropicTeamApiKeyHelperForTeam.mock.calls).toEqual([
      [{ teamName: 'own', baseClaudeDir: path.join(root, 'claude') }],
    ]);
    expect(await snapshotTeam('foreign-unmarked')).toEqual(foreignBefore.unmarked);
    expect(await snapshotTeam('foreign-other-profile')).toEqual(foreignBefore.otherProfile);

    const ownAfter = await snapshotTeam('own');
    expect(ownAfter).not.toEqual(ownBefore);
    const ownConfig = JSON.parse(ownAfter.team['config.json']) as {
      members: { tmuxPaneId?: string }[];
    };
    expect(ownConfig.members.every((member) => member.tmuxPaneId === undefined)).toBe(true);
    const ownTask = JSON.parse(ownAfter.tasks['held.json']) as {
      workIntervals: { completedAt?: string }[];
    };
    expect(ownTask.workIntervals.every((interval) => !!interval.completedAt)).toBe(true);
  });

  it('does not stop a foreign team that is known only through a held team lock', async () => {
    await writeTeam('foreign-locked', { paneId: '%14', ownerScope: scopeOf(userDataB) });
    await writeTeam('own-locked', { paneId: '%15', ownerScope: scopeOf(userDataA) });
    const foreignBefore = await snapshotTeam('foreign-locked');
    const table = createProcessTable({ 'foreign-locked': 44, 'own-locked': 45 });

    const { stopTeam } = await runShutdown(freshOwnership(), table, {
      lockedTeamNames: ['foreign-locked', 'own-locked'],
    });

    expect(stopTeam.mock.calls.map(([teamName]) => teamName)).toEqual(['own-locked']);
    expect(table.killPid.mock.calls).toEqual([[45]]);
    expect(tmuxMocks.killTmuxPaneForCurrentPlatformSync.mock.calls).toEqual([['%15']]);
    expect(await snapshotTeam('foreign-locked')).toEqual(foreignBefore);
  });

  it('skips an orphan whose ownership moved after the sweep started', async () => {
    await writeTeam('own-a', { paneId: '%16', ownerScope: scopeOf(userDataA) });
    await writeTeam('own-b', { paneId: '%17', ownerScope: scopeOf(userDataA) });
    const table = createProcessTable({ 'own-a': 46, 'own-b': 47 });
    const takeover: { teamName: string | null; snapshot: unknown } = {
      teamName: null,
      snapshot: null,
    };

    await runShutdown(freshOwnership(), table, {
      afterOrphanCleanup: async (cleanedTeamName) => {
        if (takeover.teamName) return;
        const otherTeamName = cleanedTeamName === 'own-a' ? 'own-b' : 'own-a';
        // Another profile launches the other team while this one is cleaned up.
        await claimTeamForThisProfile({
          teamsBasePath: getTeamsBasePath(),
          teamName: otherTeamName,
          reason: 'launch',
          profileScope: scopeOf(userDataB),
        });
        takeover.teamName = otherTeamName;
        takeover.snapshot = await snapshotTeam(otherTeamName);
      },
    });

    const takenOver = takeover.teamName;
    if (!takenOver) throw new Error('no orphan was cleaned up');
    const cleanedOwn = takenOver === 'own-a' ? { pid: 47, pane: '%17' } : { pid: 46, pane: '%16' };
    expect(table.killPid.mock.calls).toEqual([[cleanedOwn.pid]]);
    expect(tmuxMocks.killTmuxPaneForCurrentPlatformSync.mock.calls).toEqual([[cleanedOwn.pane]]);
    expect(await snapshotTeam(takenOver)).toEqual(takeover.snapshot);
  });
});

async function writeActiveLanes(teamName: string): Promise<PersistedTeamLaunchSnapshot> {
  const teamsBasePath = getTeamsBasePath();
  const updatedAt = '2026-10-28T10:00:00.000Z';
  await writeOpenCodeRuntimeLaneIndex(teamsBasePath, teamName, {
    version: 1,
    updatedAt,
    lanes: {
      primary: { laneId: 'primary', state: 'active', updatedAt },
      'secondary:opencode:alice': {
        laneId: 'secondary:opencode:alice',
        state: 'active',
        updatedAt,
      },
    },
  });
  await setOpenCodeRuntimeActiveRunManifest({
    teamsBasePath,
    teamName,
    laneId: 'primary',
    runId: `run-${teamName}`,
  });
  return {
    members: {
      alice: {
        name: 'alice',
        providerId: 'opencode',
        laneId: 'secondary:opencode:alice',
        runtimePid: 4242,
        processCommand: 'opencode serve --port 4242',
      },
    },
  } as unknown as PersistedTeamLaunchSnapshot;
}

interface StoppedLaneCleanupFixture {
  boundary: TeamProvisioningOpenCodeStoppedLaneCleanupBoundary;
  stop: Mock;
  killProcessByPid: Mock;
  markStoppedTeamOpenCodeRuntimeLanesCleaned: Mock;
  withTeamLock: Mock;
}

function createStoppedLaneCleanup(
  ownership: TeamProfileOwnership,
  launchStates: Record<string, PersistedTeamLaunchSnapshot>,
  options: { whileWaitingForLock?: (teamName: string) => Promise<void> } = {}
): StoppedLaneCleanupFixture {
  const stop = vi.fn(async (input: { runId: string; teamName: string }) => ({
    runId: input.runId,
    teamName: input.teamName,
    stopped: true,
    members: {},
    warnings: [],
    diagnostics: [],
  }));
  const killProcessByPid = vi.fn();
  const markStoppedTeamOpenCodeRuntimeLanesCleaned = vi.fn();
  const withTeamLock = vi.fn();
  const boundary = createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(
    {
      withTeamLock: async (teamName, operation) => {
        withTeamLock(teamName);
        await options.whileWaitingForLock?.(teamName);
        return operation();
      },
      isManagedByThisProfile: (teamName) => ownership.isManagedByThisProfile(teamName),
      canDeliverToOpenCodeRuntimeForTeam: () => false,
      getOpenCodeRuntimeAdapter: () =>
        ({ providerId: 'opencode', stop }) as unknown as TeamLaunchRuntimeAdapter,
      readPreviousLaunchState: async (teamName) => launchStates[teamName] ?? null,
      readConfigForObservation: async () => null,
      readMembersMeta: async () => [],
      readPersistedTeamProjectPath: () => null,
      deleteSecondaryRuntimeRun: vi.fn(),
      clearPrimaryRuntimeRun: vi.fn(),
      markStoppedTeamOpenCodeRuntimeLanesCleaned,
      logInfo: vi.fn(),
      logWarning: vi.fn(),
    },
    {
      getTeamsBasePath,
      helpers: {
        readProcessCommandByPid: () => 'opencode serve --port 4242',
        isOpenCodeServeCommand: () => true,
        killProcessByPid,
      },
    }
  );
  return {
    boundary,
    stop,
    killProcessByPid,
    markStoppedTeamOpenCodeRuntimeLanesCleaned,
    withTeamLock,
  };
}

describe('stopped-team OpenCode lane cleanup (F2)', () => {
  it('never stops, kills or clears lanes of a foreign team, even when called directly', async () => {
    await writeTeam('foreign-unmarked', { paneId: '%21' });
    await writeTeam('foreign-other-profile', { paneId: '%22', ownerScope: scopeOf(userDataB) });
    const launchStates = {
      'foreign-unmarked': await writeActiveLanes('foreign-unmarked'),
      'foreign-other-profile': await writeActiveLanes('foreign-other-profile'),
    };
    const before = {
      unmarked: await snapshotTeam('foreign-unmarked'),
      otherProfile: await snapshotTeam('foreign-other-profile'),
    };
    const cleanup = createStoppedLaneCleanup(freshOwnership(), launchStates);

    await expect(
      cleanup.boundary.stopOpenCodeRuntimeLanesForStoppedTeam('foreign-unmarked')
    ).resolves.toBe(0);
    await expect(
      cleanup.boundary.stopOpenCodeRuntimeLanesForStoppedTeam('foreign-other-profile')
    ).resolves.toBe(0);

    expect(cleanup.stop).not.toHaveBeenCalled();
    expect(cleanup.killProcessByPid).not.toHaveBeenCalled();
    expect(cleanup.markStoppedTeamOpenCodeRuntimeLanesCleaned).not.toHaveBeenCalled();
    // Not even the team lock: a held lock makes a team look like this app's at shutdown.
    expect(cleanup.withTeamLock).not.toHaveBeenCalled();
    expect(await snapshotTeam('foreign-unmarked')).toEqual(before.unmarked);
    expect(await snapshotTeam('foreign-other-profile')).toEqual(before.otherProfile);
  });

  it('still stops and clears the lanes of a stopped team of this profile', async () => {
    await writeTeam('own', { paneId: '%23', ownerScope: scopeOf(userDataA) });
    const cleanup = createStoppedLaneCleanup(freshOwnership(), {
      own: await writeActiveLanes('own'),
    });

    await expect(cleanup.boundary.stopOpenCodeRuntimeLanesForStoppedTeam('own')).resolves.toBe(1);

    expect(cleanup.stop).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'own', laneId: 'primary', runId: 'run-own', force: true })
    );
    expect(cleanup.killProcessByPid).toHaveBeenCalledWith(4242);
    expect(cleanup.markStoppedTeamOpenCodeRuntimeLanesCleaned).toHaveBeenCalledWith('own');
    expect((await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), 'own')).lanes).toEqual({});
  });

  it('re-checks ownership under the lock and leaves a team claimed meanwhile alone', async () => {
    await writeTeam('own', { paneId: '%24', ownerScope: scopeOf(userDataA) });
    const launchStates = { own: await writeActiveLanes('own') };
    const before: { snapshot: unknown } = { snapshot: null };
    const cleanup = createStoppedLaneCleanup(freshOwnership(), launchStates, {
      // Another profile launches the team while this cleanup waits for the lock.
      whileWaitingForLock: async (teamName) => {
        await claimTeamForThisProfile({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          reason: 'launch',
          profileScope: scopeOf(userDataB),
        });
        before.snapshot = await snapshotTeam(teamName);
      },
    });

    await expect(cleanup.boundary.stopOpenCodeRuntimeLanesForStoppedTeam('own')).resolves.toBe(0);

    expect(cleanup.withTeamLock).toHaveBeenCalledOnce();
    expect(cleanup.stop).not.toHaveBeenCalled();
    expect(cleanup.killProcessByPid).not.toHaveBeenCalled();
    expect(await snapshotTeam('own')).toEqual(before.snapshot);
  });
});

const launchRequest: TeamLaunchRequest = {
  teamName: 'interrupted',
  cwd: '/repo',
  providerId: 'opencode',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
};

function unexpected(): never {
  throw new Error('unexpected provisioning flow call');
}

function createAdmissionHost(
  launch: TeamProvisioningRequestAdmissionServiceHost['launchOpenCodeTeamThroughRuntimeAdapter']
): TeamProvisioningRequestAdmissionServiceHost {
  return {
    withTeamLock: (_teamName, fn) => fn(),
    anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
    cleanedStoppedTeamOpenCodeRuntimeLanes: new Set(),
    runTracking: { getResolvableProvisioningRunId: () => null },
    configTaskActivityBoundary: {
      readTaskActivityRepairLaunchSnapshot: vi.fn(unexpected),
      repairStaleTaskActivityIntervalsOnce: vi.fn(unexpected),
    },
    stopAllTeamsGeneration: 0,
    provisioningRunByTeam: new Map(),
    initializeToolApprovalSettingsForLaunch: vi.fn(),
    shouldRouteOpenCodeToRuntimeAdapter: () => true,
    createOpenCodeTeamThroughRuntimeAdapter: vi.fn(unexpected),
    launchOpenCodeTeamThroughRuntimeAdapter: launch,
    createDeterministicCreateSetupFlowPorts: vi.fn(unexpected),
    createDeterministicCreateRunFlowPorts: vi.fn(unexpected),
    createDeterministicCreateSpawnFlowPorts: vi.fn(unexpected),
    deterministicLaunchFlowBoundary: {
      createSetupPorts: vi.fn(unexpected),
      createRunFlowPorts: vi.fn(unexpected),
    },
  };
}

describe('interrupted launch', () => {
  it('stays recoverable by the same profile after a crash before spawn and foreign to another', async () => {
    await writeTeam('interrupted', { paneId: '%31' });
    const launchStates = { interrupted: await writeActiveLanes('interrupted') };
    const crashBeforeSpawn = vi.fn(async () => {
      throw new Error('TEST process died before spawn');
    });

    await expect(
      createTeamProvisioningRequestAdmissionBoundary(
        createAdmissionHost(crashBeforeSpawn),
        async () => null
      ).launchTeam(launchRequest, vi.fn())
    ).rejects.toThrow('TEST process died before spawn');
    expect(crashBeforeSpawn).toHaveBeenCalledOnce();
    const marker = JSON.parse(
      await readFile(
        path.join(getTeamsBasePath(), 'interrupted', TEAM_PROFILE_OWNER_MARKER_FILE),
        'utf8'
      )
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schemaVersion: 1,
      profileScope: scopeOf(userDataA),
      reason: 'launch',
    });

    // Another profile (other userData, same ~/.claude) starts next: hands off.
    setAppDataBasePath(userDataB);
    const before = await snapshotTeam('interrupted');
    await expect(freshOwnership().isManagedByThisProfile('interrupted')).resolves.toBe(false);
    const otherLanes = createStoppedLaneCleanup(freshOwnership(), launchStates);
    await expect(
      otherLanes.boundary.stopOpenCodeRuntimeLanesForStoppedTeam('interrupted')
    ).resolves.toBe(0);
    expect(otherLanes.stop).not.toHaveBeenCalled();
    expect(otherLanes.killProcessByPid).not.toHaveBeenCalled();
    expect(await snapshotTeam('interrupted')).toEqual(before);

    // A new process of the launching profile recognises the team as its own.
    setAppDataBasePath(userDataA);
    await expect(freshOwnership().isManagedByThisProfile('interrupted')).resolves.toBe(true);
    const ownLanes = createStoppedLaneCleanup(freshOwnership(), launchStates);
    await expect(
      ownLanes.boundary.stopOpenCodeRuntimeLanesForStoppedTeam('interrupted')
    ).resolves.toBe(1);
    expect(ownLanes.killProcessByPid).toHaveBeenCalledWith(4242);
    const table = createProcessTable({ interrupted: 61 });
    await runShutdown(freshOwnership(), table);
    expect(table.killPid.mock.calls).toEqual([[61]]);
    expect(tmuxMocks.killTmuxPaneForCurrentPlatformSync.mock.calls).toEqual([['%31']]);
  });
});

describe('fail-closed claim', () => {
  const blockers = [
    {
      name: 'marker path occupied by a directory',
      block: (teamDir: string) => mkdir(path.join(teamDir, TEAM_PROFILE_OWNER_MARKER_FILE)),
      enabled: true,
    },
    {
      name: 'read-only team directory',
      block: (teamDir: string) => chmod(teamDir, 0o500),
      enabled: canChmodDeny,
    },
  ];

  for (const blocker of blockers) {
    it.skipIf(!blocker.enabled)(`cancels launch before spawn: ${blocker.name}`, async () => {
      await writeTeam('interrupted', { paneId: '%41' });
      const teamDir = path.join(getTeamsBasePath(), 'interrupted');
      await blocker.block(teamDir);
      const spawn = vi.fn(async () => ({ runId: 'never' }));
      const host = createAdmissionHost(spawn);
      const retryPendingForTeam = vi.spyOn(
        host.anthropicApiKeyHelperCleanupRetryOwner,
        'retryPendingForTeam'
      );

      try {
        await expect(
          createTeamProvisioningRequestAdmissionBoundary(host, async () => null).launchTeam(
            launchRequest,
            vi.fn()
          )
        ).rejects.toThrow(/Team "interrupted" was not started: this app could not record itself/);
        expect(spawn).not.toHaveBeenCalled();
        expect(retryPendingForTeam).not.toHaveBeenCalled();
      } finally {
        await chmod(teamDir, 0o700);
      }
    });
  }
});

describe('launch claim', () => {
  const markerPath = (): string =>
    path.join(getTeamsBasePath(), 'interrupted', TEAM_PROFILE_OWNER_MARKER_FILE);

  async function launch(): Promise<ReturnType<typeof vi.fn>> {
    const spawn = vi.fn(async () => ({ runId: 'run-launched' }));
    await createTeamProvisioningRequestAdmissionBoundary(
      createAdmissionHost(spawn),
      async () => null
    ).launchTeam(launchRequest, vi.fn());
    return spawn;
  }

  async function writeOwnMarker(): Promise<string> {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName: 'interrupted',
      reason: 'create',
      profileScope: scopeOf(userDataA),
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });
    return readFile(markerPath(), 'utf8');
  }

  it('keeps a marker that already names this profile', async () => {
    await writeTeam('interrupted', { paneId: '%91' });
    const before = await writeOwnMarker();

    expect(await launch()).toHaveBeenCalledOnce();
    expect(await readFile(markerPath(), 'utf8')).toBe(before);
  });

  it.each([
    ['another profile', { paneId: '%92', ownerScope: 'b'.repeat(64) }],
    ['a malformed marker', { paneId: '%93', ownerMarkerRaw: '{"schemaVersion":1,' }],
  ])('takes the team over from %s', async (_name, team) => {
    await writeTeam('interrupted', team);

    expect(await launch()).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      profileScope: scopeOf(userDataA),
      reason: 'launch',
    });
  });

  it.skipIf(!canChmodDeny)('relaunches its own team without writing to it', async () => {
    await writeTeam('interrupted', { paneId: '%94' });
    await writeOwnMarker();
    const teamDir = path.join(getTeamsBasePath(), 'interrupted');
    await chmod(teamDir, 0o500);
    try {
      expect(await launch()).toHaveBeenCalledOnce();
    } finally {
      await chmod(teamDir, 0o700);
    }
  });

  it('aborts when this profile cannot be resolved instead of trusting a missing marker', async () => {
    await writeTeam('interrupted', { paneId: '%95' });
    // No marker to read and no computable scope: null must not count as "ours".
    setAppDataBasePath('   ');
    const spawn = vi.fn(async () => ({ runId: 'never' }));

    await expect(
      createTeamProvisioningRequestAdmissionBoundary(
        createAdmissionHost(spawn),
        async () => null
      ).launchTeam(launchRequest, vi.fn())
    ).rejects.toThrow(/Team "interrupted" was not started/);
    expect(spawn).not.toHaveBeenCalled();
    await expect(stat(markerPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('isManagedByThisProfile', () => {
  it('treats unmarked, foreign, unreadable or malformed markers and native sessions as foreign', async () => {
    const ownership = freshOwnership();
    const ownScope = scopeOf(userDataA);
    await writeTeam('own', { paneId: '%51', ownerScope: ownScope });
    await writeTeam('unmarked', { paneId: '%52' });
    await writeTeam('other-profile', { paneId: '%53', ownerScope: scopeOf(userDataB) });
    await writeTeam('corrupt', { paneId: '%54', ownerMarkerRaw: '{"schemaVersion":1,' });
    await writeTeam('future-schema', {
      paneId: '%55',
      ownerMarkerRaw: JSON.stringify({ schemaVersion: 2, profileScope: ownScope }),
    });
    await writeTeam('session-0d4c1a5e-native', { paneId: '%56' });
    await mkdir(path.join(getTeamsBasePath(), 'marker-is-dir', TEAM_PROFILE_OWNER_MARKER_FILE), {
      recursive: true,
    });

    await expect(ownership.isManagedByThisProfile('own')).resolves.toBe(true);
    // The quit-time backup cannot await; its synchronous twin must decide the same.
    expect(ownership.isManagedByThisProfileSync('own')).toBe(true);
    for (const teamName of [
      'unmarked',
      'other-profile',
      'corrupt',
      'future-schema',
      'session-0d4c1a5e-native',
      'marker-is-dir',
      'missing',
      '..',
      'own/../own',
    ]) {
      await expect(ownership.isManagedByThisProfile(teamName)).resolves.toBe(false);
      expect(ownership.isManagedByThisProfileSync(teamName)).toBe(false);
    }
  });

  it.skipIf(!canChmodDeny)('treats a marker it cannot read as foreign', async () => {
    await writeTeam('unreadable', { paneId: '%61', ownerScope: scopeOf(userDataA) });
    const markerPath = path.join(getTeamsBasePath(), 'unreadable', TEAM_PROFILE_OWNER_MARKER_FILE);
    await chmod(markerPath, 0o000);
    try {
      expect((await stat(markerPath)).mode & 0o777).toBe(0);
      await expect(freshOwnership().isManagedByThisProfile('unreadable')).resolves.toBe(false);
      expect(freshOwnership().isManagedByThisProfileSync('unreadable')).toBe(false);
    } finally {
      await chmod(markerPath, 0o600);
    }
  });

  it('keeps a team tracked by this process managed even without a marker', async () => {
    await writeTeam('tracked', { paneId: '%71' });
    const ownership = createTeamProfileOwnership({
      isTrackedInThisProcess: (teamName) => teamName === 'tracked',
    });

    await expect(ownership.isManagedByThisProfile('tracked')).resolves.toBe(true);
    expect(ownership.isManagedByThisProfileSync('tracked')).toBe(true);
  });
});
