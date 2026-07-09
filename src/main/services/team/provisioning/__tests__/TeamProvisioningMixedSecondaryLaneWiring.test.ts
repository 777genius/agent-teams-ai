import { describe, expect, it, vi } from 'vitest';

import {
  createMixedSecondaryLaneLaunchFlowPorts,
  createMixedSecondaryLaunchQueuePorts,
  createSingleMixedSecondaryRuntimeLaneStopPorts,
  createStaleMixedSecondaryRecoveryPorts,
  createTeamProvisioningMixedSecondaryLaneWiring,
  createTeamProvisioningMixedSecondaryLaneWiringDepsFromService,
  type TeamProvisioningMixedSecondaryLaneWiringDeps,
  type TeamProvisioningMixedSecondaryLaneWiringService,
  type TeamProvisioningMixedSecondaryLaneWiringServiceHost,
} from '../TeamProvisioningMixedSecondaryLaneWiring';

import type { TeamRuntimeLaunchResult } from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PlannedRuntimeMember, TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
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
    const lane = createLane();
    const run = createRun({ mixedSecondaryLanes: [lane] });

    await queuePorts.launchSingleMixedSecondaryLane(run, lane);
    await queuePorts.publishMixedSecondaryLaneStatusChange(run, lane);
    await queuePorts.persistLaunchStateSnapshot(run, 'active');
    expect(queuePorts.getMixedSecondaryLaunchPhase(run)).toBe('active');
    stopPorts.deleteSecondaryRuntimeRun('atlas-hq', lane.laneId);
    await expect(stopPorts.readLaunchState('atlas-hq')).resolves.toEqual(createSnapshot());

    expect(deps.service.launchSingleMixedSecondaryLane).toHaveBeenCalledWith(run, lane);
    expect(deps.service.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(deps.service.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
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

  it('builds mixed secondary lane wiring deps from service-shaped dependencies', async () => {
    const service = createService();
    const has = vi.fn(() => true);
    const logger = { warn: vi.fn() };
    const host = {
      stoppingSecondaryRuntimeTeams: { has },
      appShellBoundary: {
        getOpenCodeRuntimeAdapter: service.getOpenCodeRuntimeAdapter,
      },
      launchStateStore: {
        read: service.readLaunchState,
      },
      toolApprovalFacade: {
        syncOpenCodeRuntimeToolApprovals: service.syncOpenCodeRuntimeToolApprovals,
      },
      teamMetaStore: {
        getMeta: service.readTeamMeta,
      },
      membersMetaStore: {
        getMeta: service.readMembersMeta,
      },
      openCodeRuntimeRecoveryBoundary: {
        tryRecoverMissingOpenCodeSecondaryLaneFromRuntime:
          service.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime,
        tryRecoverActiveOpenCodeSecondaryLaneFromRuntime:
          service.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime,
      },
      openCodeRuntimeRecoveryIdentity: {
        resolveCurrentOpenCodeRuntimeRunId: service.resolveCurrentOpenCodeRuntimeRunId,
      },
      runtimeLaneCoordinator: {
        buildAggregateLaunchSnapshot: service.buildAggregateLaunchSnapshot,
      },
      deleteSecondaryRuntimeRun: service.deleteSecondaryRuntimeRun,
      publishMixedSecondaryLaneStatusChange: service.publishMixedSecondaryLaneStatusChange,
      setSecondaryRuntimeRun: service.setSecondaryRuntimeRun,
      buildOpenCodeSecondaryAppManagedLaunchPrompt:
        service.buildOpenCodeSecondaryAppManagedLaunchPrompt,
      guardCommittedOpenCodeSecondaryLaneEvidence:
        service.guardCommittedOpenCodeSecondaryLaneEvidence,
      launchSingleMixedSecondaryLane: service.launchSingleMixedSecondaryLane,
      persistLaunchStateSnapshot: service.persistLaunchStateSnapshot,
      hasMixedSecondaryLaunchMetadata: service.hasMixedSecondaryLaunchMetadata,
      shouldRecoverStalePersistedMixedLaunchSnapshot:
        service.shouldRecoverStalePersistedMixedLaunchSnapshot,
      readPersistedTeamProjectPath: service.readPersistedTeamProjectPath,
      writeLaunchStateSnapshot: service.writeLaunchStateSnapshot,
    } satisfies TeamProvisioningMixedSecondaryLaneWiringServiceHost<TestRun>;
    const deps = createTeamProvisioningMixedSecondaryLaneWiringDepsFromService(host, {
      logger,
    });
    const run = createRun();
    const lane = createLane();
    const snapshot = createSnapshot();

    expect(deps.logger).toBe(logger);
    expect(deps.service.isStoppingSecondaryRuntimeTeam('atlas-hq')).toBe(true);
    deps.service.deleteSecondaryRuntimeRun('atlas-hq', lane.laneId);
    await deps.service.publishMixedSecondaryLaneStatusChange(run, lane);
    await deps.service.readLaunchState('atlas-hq');
    deps.service.syncOpenCodeRuntimeToolApprovals({
      teamName: 'atlas-hq',
      runId: 'lane-run-1',
      laneId: lane.laneId,
      cwd: TEST_PROJECT_PATH,
      members: {},
      expectedMembers: [],
    });
    await deps.service.resolveCurrentOpenCodeRuntimeRunId('atlas-hq', lane.laneId);
    deps.service.buildAggregateLaunchSnapshot({
      teamName: 'atlas-hq',
      launchPhase: 'active',
      leadDefaults: {
        providerId: 'anthropic',
        providerBackendId: null,
      },
      primaryMembers: [],
      primaryStatuses: {},
      secondaryMembers: [],
    });
    await deps.service.writeLaunchStateSnapshot('atlas-hq', snapshot);

    expect(has).toHaveBeenCalledWith('atlas-hq');
    expect(service.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('atlas-hq', lane.laneId);
    expect(service.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(service.readLaunchState).toHaveBeenCalledWith('atlas-hq');
    expect(service.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledTimes(1);
    expect(service.resolveCurrentOpenCodeRuntimeRunId).toHaveBeenCalledWith(
      'atlas-hq',
      lane.laneId
    );
    expect(service.buildAggregateLaunchSnapshot).toHaveBeenCalledTimes(1);
    expect(service.writeLaunchStateSnapshot).toHaveBeenCalledWith('atlas-hq', snapshot);
  });

  it('exposes mixed secondary lane state helpers on the boundary', () => {
    const deps = createDeps();
    const boundary = createTeamProvisioningMixedSecondaryLaneWiring(deps);
    const member = {
      name: 'Builder',
      role: 'Build changes',
      providerId: 'opencode',
      cwd: `${TEST_PROJECT_PATH}/builder`,
    } as PlannedRuntimeMember;
    const plan: TeamRuntimeLanePlan = {
      mode: 'mixed_opencode_side_lanes',
      primaryMembers: [
        {
          name: 'Lead',
          role: 'Lead work',
          providerId: 'codex',
        } as PlannedRuntimeMember,
      ],
      allMembers: [member],
      sideLanes: [
        {
          laneId: 'secondary:opencode:Builder',
          providerId: 'opencode',
          member,
        },
      ],
    };

    expect(boundary.createMixedSecondaryLaneStates(plan)).toEqual([
      {
        laneId: 'secondary:opencode:Builder',
        providerId: 'opencode',
        member,
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ]);
    expect(
      boundary.createMixedSecondaryLaneStateForMember(
        {
          request: {
            teamName: 'atlas-hq',
            cwd: TEST_PROJECT_PATH,
            providerId: 'opencode',
            members: [],
          } as unknown as TeamCreateRequest,
          mixedSecondaryLanes: [],
        },
        member as TeamMember
      )
    ).toMatchObject({
      providerId: 'opencode',
      member,
      state: 'queued',
      result: null,
    });
    expect(boundary.getMixedSecondaryLaunchPhase({ mixedSecondaryLanes: [createLane()] })).toBe(
      'active'
    );
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
