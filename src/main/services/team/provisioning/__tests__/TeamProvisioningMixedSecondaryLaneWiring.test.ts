import { describe, expect, it, vi } from 'vitest';

import {
  createMixedSecondaryLaneLaunchFlowPorts,
  createMixedSecondaryLaunchQueuePorts,
  createSingleMixedSecondaryRuntimeLaneStopPorts,
  createStaleMixedSecondaryRecoveryPorts,
  createTeamProvisioningMixedSecondaryLaneWiring,
  type TeamProvisioningMixedSecondaryLaneWiringDeps,
  type TeamProvisioningMixedSecondaryLaneWiringService,
} from '../TeamProvisioningMixedSecondaryLaneWiring';

import type { TeamRuntimeLaunchResult } from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot, TeamCreateRequest, TeamMember } from '@shared/types';

interface TestRun {
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  request: Pick<TeamCreateRequest, 'cwd' | 'skipPermissions' | 'color' | 'displayName'>;
  mixedSecondaryLanes?: MixedSecondaryRuntimeLaneState[];
  mixedSecondaryLaneLaunchQueue?: Promise<void>;
}

const TEST_PROJECT_PATH = '/repo/project';

function createLane(
  overrides: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary:opencode:Builder',
    providerId: 'opencode',
    member: {
      name: 'Builder',
      role: 'Build changes',
      color: 'blue',
      cwd: TEST_PROJECT_PATH,
    } as TeamMember,
    runId: 'lane-run-1',
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    teamName: 'atlas-hq',
    cancelRequested: false,
    processKilled: false,
    request: {
      cwd: TEST_PROJECT_PATH,
      skipPermissions: true,
      color: 'blue',
      displayName: 'Atlas HQ',
    },
    ...overrides,
  };
}

function createLaunchResult(): TeamRuntimeLaunchResult {
  return {
    runId: 'lane-run-1',
    teamName: 'atlas-hq',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {},
    warnings: [],
    diagnostics: [],
  };
}

function createSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 1,
    runId: 'run-1',
    teamName: 'atlas-hq',
    launchPhase: 'active',
    teamLaunchState: 'partial_failure',
    members: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as PersistedTeamLaunchSnapshot;
}

function createService(
  overrides: Partial<TeamProvisioningMixedSecondaryLaneWiringService<TestRun>> = {}
): TeamProvisioningMixedSecondaryLaneWiringService<TestRun> {
  return {
    isStoppingSecondaryRuntimeTeam: vi.fn(() => false),
    deleteSecondaryRuntimeRun: vi.fn(),
    getOpenCodeRuntimeAdapter: vi.fn(() => null),
    publishMixedSecondaryLaneStatusChange: vi.fn(async () => undefined),
    readLaunchState: vi.fn(async () => createSnapshot()),
    setSecondaryRuntimeRun: vi.fn(),
    buildOpenCodeSecondaryAppManagedLaunchPrompt: vi.fn(async () => 'launch prompt'),
    guardCommittedOpenCodeSecondaryLaneEvidence: vi.fn(async ({ result }) => result),
    syncOpenCodeRuntimeToolApprovals: vi.fn(),
    launchSingleMixedSecondaryLane: vi.fn(async () => undefined),
    persistLaunchStateSnapshot: vi.fn(async () => createSnapshot()),
    getMixedSecondaryLaunchPhase: vi.fn(() => 'active' as const),
    hasMixedSecondaryLaunchMetadata: vi.fn(() => true),
    shouldRecoverStalePersistedMixedLaunchSnapshot: vi.fn(() => false),
    readTeamMeta: vi.fn(async () => null),
    readMembersMeta: vi.fn(async () => null),
    readPersistedTeamProjectPath: vi.fn(() => TEST_PROJECT_PATH),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'lane-run-1'),
    buildAggregateLaunchSnapshot: vi.fn(() => createSnapshot()),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, snapshot) => snapshot),
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<TeamProvisioningMixedSecondaryLaneWiringService<TestRun>> = {}
): TeamProvisioningMixedSecondaryLaneWiringDeps<TestRun> {
  return {
    service: createService(overrides),
    logger: {
      warn: vi.fn(),
    },
  };
}

describe('TeamProvisioningMixedSecondaryLaneWiring', () => {
  it('wires launch-flow ports to service callbacks and shared runtime helpers', async () => {
    const deps = createDeps();
    const ports = createMixedSecondaryLaneLaunchFlowPorts(deps);
    const run = createRun();
    const lane = createLane();
    const launchResult = createLaunchResult();

    expect(ports.isStoppingSecondaryRuntimeTeam('atlas-hq')).toBe(false);
    ports.deleteSecondaryRuntimeRun('atlas-hq', lane.laneId);
    await ports.publishMixedSecondaryLaneStatusChange(run, lane);
    await expect(ports.readLaunchState('atlas-hq')).resolves.toEqual(createSnapshot());
    ports.setSecondaryRuntimeRun({
      teamName: 'atlas-hq',
      runId: 'lane-run-1',
      providerId: 'opencode',
      laneId: lane.laneId,
      memberName: 'Builder',
      cwd: TEST_PROJECT_PATH,
    });
    await expect(ports.buildOpenCodeSecondaryAppManagedLaunchPrompt(run, lane)).resolves.toBe(
      'launch prompt'
    );
    await expect(
      ports.guardCommittedOpenCodeSecondaryLaneEvidence({
        teamName: 'atlas-hq',
        laneId: lane.laneId,
        memberName: 'Builder',
        result: launchResult,
      })
    ).resolves.toBe(launchResult);
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName: 'atlas-hq',
      runId: 'lane-run-1',
      laneId: lane.laneId,
      cwd: TEST_PROJECT_PATH,
      members: {},
      expectedMembers: [],
    });

    expect(deps.service.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('atlas-hq', lane.laneId);
    expect(deps.service.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(deps.service.setSecondaryRuntimeRun).toHaveBeenCalledWith({
      teamName: 'atlas-hq',
      runId: 'lane-run-1',
      providerId: 'opencode',
      laneId: lane.laneId,
      memberName: 'Builder',
      cwd: TEST_PROJECT_PATH,
    });
    expect(deps.service.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledTimes(1);
    expect(ports.randomUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('wires queue and stop ports through the same explicit service boundary', async () => {
    const deps = createDeps();
    const queuePorts = createMixedSecondaryLaunchQueuePorts(deps);
    const stopPorts = createSingleMixedSecondaryRuntimeLaneStopPorts(deps);
    const run = createRun();
    const lane = createLane();

    await queuePorts.launchSingleMixedSecondaryLane(run, lane);
    await queuePorts.publishMixedSecondaryLaneStatusChange(run, lane);
    await queuePorts.persistLaunchStateSnapshot(run, 'active');
    expect(queuePorts.getMixedSecondaryLaunchPhase(run)).toBe('active');
    stopPorts.deleteSecondaryRuntimeRun('atlas-hq', lane.laneId);
    await expect(stopPorts.readLaunchState('atlas-hq')).resolves.toEqual(createSnapshot());

    expect(deps.service.launchSingleMixedSecondaryLane).toHaveBeenCalledWith(run, lane);
    expect(deps.service.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(deps.service.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
    expect(deps.service.getMixedSecondaryLaunchPhase).toHaveBeenCalledWith(run);
    expect(deps.service.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('atlas-hq', lane.laneId);
    expect(stopPorts.logger).toBe(deps.logger);
  });

  it('wires stale recovery ports to service state and recovery callbacks', async () => {
    const deps = createDeps();
    const ports = createStaleMixedSecondaryRecoveryPorts(deps);
    const snapshot = createSnapshot();
    const member = createLane().member;

    expect(ports.hasMixedSecondaryLaunchMetadata(snapshot)).toBe(true);
    expect(ports.shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot)).toBe(false);
    await expect(ports.readTeamMeta('atlas-hq')).resolves.toBeNull();
    await expect(ports.readMembersMeta('atlas-hq')).resolves.toBeNull();
    expect(ports.readPersistedTeamProjectPath('atlas-hq')).toBe(TEST_PROJECT_PATH);
    await expect(
      ports.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
        teamName: 'atlas-hq',
        laneId: 'secondary:opencode:Builder',
        member,
        projectPath: TEST_PROJECT_PATH,
        previousLaunchState: snapshot,
        persistedMember: snapshot.members.Builder,
      })
    ).resolves.toBeNull();
    await expect(
      ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
        teamName: 'atlas-hq',
        laneId: 'secondary:opencode:Builder',
        member,
        projectPath: TEST_PROJECT_PATH,
        previousLaunchState: snapshot,
      })
    ).resolves.toBeNull();
    await expect(
      ports.resolveCurrentOpenCodeRuntimeRunId('atlas-hq', 'secondary:opencode:Builder')
    ).resolves.toBe('lane-run-1');
    expect(
      ports.buildAggregateLaunchSnapshot({
        teamName: 'atlas-hq',
        launchPhase: 'active',
        leadDefaults: {
          providerId: 'anthropic',
          providerBackendId: null,
        },
        primaryMembers: [],
        primaryStatuses: {},
        secondaryMembers: [],
      })
    ).toEqual(snapshot);
    await expect(ports.writeLaunchStateSnapshot('atlas-hq', snapshot)).resolves.toBe(snapshot);

    expect(deps.service.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime).toHaveBeenCalledTimes(1);
    expect(deps.service.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime).toHaveBeenCalledTimes(1);
    expect(deps.service.buildAggregateLaunchSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.service.writeLaunchStateSnapshot).toHaveBeenCalledWith('atlas-hq', snapshot);
  });

  it('exposes a small lane boundary that delegates launch and recovery flows', async () => {
    const run = createRun({
      mixedSecondaryLanes: [createLane()],
    });
    const deps = createDeps({
      readLaunchState: vi.fn(async () => null),
      persistLaunchStateSnapshot: vi.fn(async () => createSnapshot()),
    });
    const boundary = createTeamProvisioningMixedSecondaryLaneWiring(deps);

    await expect(boundary.launchMixedSecondaryLaneIfNeeded(run)).resolves.toEqual(createSnapshot());
    await expect(
      boundary.recoverStaleMixedSecondaryLaunchSnapshot('atlas-hq', null, createSnapshot())
    ).resolves.toEqual(createSnapshot());

    expect(deps.service.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'finished');
    expect(deps.service.hasMixedSecondaryLaunchMetadata).toHaveBeenCalledTimes(1);
  });
});
