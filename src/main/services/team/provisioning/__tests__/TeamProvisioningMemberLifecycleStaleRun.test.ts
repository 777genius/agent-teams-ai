import {
  listTmuxPaneRuntimeInfoForCurrentPlatform,
  sendKeysToTmuxPaneForCurrentPlatform,
} from '@features/tmux-installer/main';
import { spawnCli } from '@main/utils/childProcess';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeBinaryResolver } from '../../ClaudeBinaryResolver';
import { TeamProvisioningMemberLifecycleController } from '../TeamProvisioningMemberLifecycle';

import type { TeamProvisioningMemberLifecycleHost } from '../TeamProvisioningMemberLifecycleHostPorts';
import type { TeamProvisioningMemberLifecycleOperationUseCases } from '../TeamProvisioningMemberLifecycleOperationUseCases';
import type { ProvisioningRun } from '../TeamProvisioningMemberLifecycleTypes';
import type { TeamConfig, TeamCreateRequest } from '@shared/types';

vi.mock('@features/tmux-installer/main', () => ({
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
  sendKeysToTmuxPaneForCurrentPlatform: vi.fn(async () => undefined),
}));

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
}));

vi.mock('../../ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: vi.fn(async () => '/bin/echo'),
  },
}));

const immediateOperationUseCases: TeamProvisioningMemberLifecycleOperationUseCases = {
  isMemberLifecycleOperationActive: () => false,
  async runMemberLifecycleOperation(_teamName, _memberName, _kind, operation) {
    return operation();
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValue(new Map());
  vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockResolvedValue(undefined);
  vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/bin/echo');
  vi.mocked(spawnCli).mockImplementation(() => {
    throw new Error('spawnCli should not be called by stale-run guard tests');
  });
});

function createRun(member: TeamCreateRequest['members'][number]): ProvisioningRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    request: {
      teamName: 'team-a',
      cwd: '/safe-test-project',
      providerId: 'codex',
      members: [member],
    },
    detectedSessionId: null,
    memberMcpConfigPaths: [],
    memberSpawnStatuses: new Map(),
    memberSpawnToolUseIds: new Map(),
    pendingMemberRestarts: new Map(),
    mixedSecondaryLanes: [],
    processKilled: false,
    cancelRequested: false,
    isLaunch: true,
    provisioningComplete: false,
  };
}

function createRunWithId(
  member: TeamCreateRequest['members'][number],
  runId: string
): ProvisioningRun {
  const run = createRun(member);
  run.runId = runId;
  return run;
}

function createConfig(member: TeamCreateRequest['members'][number]): TeamConfig {
  return {
    name: 'Team A',
    projectPath: '/safe-test-project',
    members: [member],
  } as TeamConfig;
}

function createHost(
  run: ProvisioningRun,
  overrides: Partial<TeamProvisioningMemberLifecycleHost> = {}
): TeamProvisioningMemberLifecycleHost {
  const member = run.request.members[0];
  const host: TeamProvisioningMemberLifecycleHost = {
    runs: new Map([[run.runId, run]]),
    runtimeAdapterRunByTeam: new Map(),
    failedOpenCodeSecondaryRetryInFlightByTeam: new Map(),
    mcpConfigBuilder: {
      async writeConfigFile() {
        return '/safe-test-project/mcp.json';
      },
    },
    membersMetaStore: {
      async getMembers() {
        return [];
      },
    },
    teamMetaStore: {
      async getMeta() {
        return null;
      },
    },
    launchStateStore: {
      async read() {
        return null;
      },
    },
    async readConfigForStrictDecision() {
      return createConfig(member);
    },
    readPersistedRuntimeMembers() {
      return [];
    },
    readPersistedTeamProjectPath() {
      return '/safe-test-project';
    },
    buildPrimaryOwnedMemberSpecForRuntime(input) {
      return input.configuredMember;
    },
    async materializeEffectiveTeamMemberSpecs(input) {
      return input.members;
    },
    resolveEffectiveConfiguredMember(configMembers, _metaMembers, memberName) {
      return (
        (configMembers ?? []).find(
          (candidate) => candidate.name.trim().toLowerCase() === memberName.trim().toLowerCase()
        ) ?? null
      );
    },
    resolveLeadMemberName() {
      return 'Lead';
    },
    buildConfiguredProvisioningMember(configuredMember) {
      return configuredMember;
    },
    getAliveRunId() {
      return run.runId;
    },
    getTrackedRunId() {
      return run.runId;
    },
    getProvisioningRunId() {
      return null;
    },
    getRunTrackedCwd() {
      return run.request.cwd;
    },
    appendMemberBootstrapDiagnostic() {
      return undefined;
    },
    setMemberSpawnStatus() {
      return undefined;
    },
    upsertRunAllEffectiveMember() {
      return undefined;
    },
    removeRunAllEffectiveMember() {
      return undefined;
    },
    invalidateRuntimeSnapshotCaches() {
      return undefined;
    },
    resetRuntimeToolActivity() {
      return undefined;
    },
    clearMemberSpawnToolTracking() {
      return undefined;
    },
    isCurrentTrackedRun(candidateRun) {
      return candidateRun === run && !run.processKilled && !run.cancelRequested;
    },
    async getLiveTeamAgentRuntimeMetadata() {
      return new Map();
    },
    async persistLaunchStateSnapshot() {
      return null;
    },
    async writeLaunchStateSnapshot() {
      return null;
    },
    async buildProvisioningEnv() {
      return { env: {} };
    },
    async resolveDirectMemberLaunchIdentity() {
      return null;
    },
    async buildTeamRuntimeLaunchArgsPlan() {
      return {
        settingsArgs: [],
        fastModeArgs: [],
        runtimeTurnSettledHookArgs: [],
        providerArgs: [],
        appManagedSettingsPath: null,
      };
    },
    async buildTrackedMemberMcpLaunchConfig() {
      return null;
    },
    async removeTrackedMemberMcpLaunchConfig() {
      return undefined;
    },
    async sendMessageToRun() {
      return null;
    },
    persistInboxMessage() {
      return undefined;
    },
    persistSentMessage() {
      return undefined;
    },
    getOpenCodeRuntimeAdapter() {
      return null;
    },
    async resolveOpenCodeMemberWorkspacesForRuntime(input) {
      return input.members;
    },
    async runOpenCodeTeamRuntimeAdapterLaunch() {
      return null;
    },
    createMixedSecondaryLaneStateForMember(_targetRun, laneMember) {
      return {
        laneId: `secondary:opencode:${laneMember.name.toLowerCase()}`,
        providerId: 'opencode',
        member: laneMember,
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      };
    },
    async stopSingleMixedSecondaryRuntimeLane() {
      return undefined;
    },
    getRunLeadName() {
      return 'Lead';
    },
    async launchSingleMixedSecondaryLane() {
      return undefined;
    },
    getMixedSecondaryLaunchPhase() {
      return 'active';
    },
  };

  return { ...host, ...overrides };
}

describe('TeamProvisioningMemberLifecycle stale run guards', () => {
  it('does not spawn a primary-owned attach after the active run changes during config reads', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    const spawnStatuses: string[] = [];
    let launched = false;
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      async readConfigForStrictDecision() {
        aliveRunId = null;
        return createConfig(member);
      },
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async launchDirectProcessMemberRestart() {
            launched = true;
          },
        },
      }
    );

    await expect(controller.attachLiveRosterMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(launched).toBe(false);
    expect(spawnStatuses).toEqual([]);
  });

  it('does not mark a primary-owned attach online after live runtime metadata observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let upserted = false;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      async getLiveTeamAgentRuntimeMetadata() {
        aliveRunId = null;
        return new Map([
          [
            'Worker',
            {
              alive: true,
              livenessKind: 'runtime_process',
            },
          ],
        ]);
      },
      upsertRunAllEffectiveMember() {
        upserted = true;
      },
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases
    );

    await expect(controller.attachLiveRosterMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(upserted).toBe(false);
    expect(spawnStatuses).toEqual([]);
  });

  it('does not reattach an OpenCode member from a primary attach after the active run changes', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'opencode',
    };
    const run = createRun(member);
    const replacementRun = createRunWithId(member, 'run-2');
    let aliveRunId: string | null = run.runId;
    let laneCreatedForRunId: string | null = null;
    let laneLaunched = false;
    let configReadCount = 0;
    const host = createHost(run, {
      runs: new Map([
        [run.runId, run],
        [replacementRun.runId, replacementRun],
      ]),
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      getOpenCodeRuntimeAdapter: () => ({ providerId: 'opencode' }),
      async readConfigForStrictDecision() {
        configReadCount += 1;
        if (configReadCount === 1) {
          aliveRunId = replacementRun.runId;
        }
        return createConfig(member);
      },
      createMixedSecondaryLaneStateForMember(targetRun, laneMember) {
        laneCreatedForRunId = targetRun.runId;
        return createHost(targetRun).createMixedSecondaryLaneStateForMember(targetRun, laneMember);
      },
      async launchSingleMixedSecondaryLane() {
        laneLaunched = true;
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases
    );

    await expect(controller.attachLiveRosterMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(laneCreatedForRunId).toBeNull();
    expect(laneLaunched).toBe(false);
    expect(replacementRun.mixedSecondaryLanes).toEqual([]);
  });

  it('does not mark a primary-owned attach error when launch observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async launchDirectProcessMemberRestart() {
            aliveRunId = null;
            throw new Error('stale launch');
          },
        },
      }
    );

    await expect(controller.attachLiveRosterMember('team-a', 'Worker')).rejects.toThrow(
      'stale launch'
    );

    expect(spawnStatuses).toEqual(['spawning']);
  });

  it('does not stop or mutate a primary-owned detach after the active run changes', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let stopped = false;
    let removed = false;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      async readConfigForStrictDecision() {
        aliveRunId = null;
        return createConfig(member);
      },
      async stopSingleMixedSecondaryRuntimeLane() {
        throw new Error('unexpected OpenCode stop');
      },
      removeRunAllEffectiveMember() {
        removed = true;
      },
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async stopPrimaryOwnedRosterRuntime() {
            stopped = true;
          },
        },
      }
    );

    await expect(controller.detachLiveRosterMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(stopped).toBe(false);
    expect(removed).toBe(false);
    expect(spawnStatuses).toEqual([]);
  });

  it('does not detach an OpenCode member from a primary detach after the active run changes', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'opencode',
    };
    const run = createRun(member);
    const replacementRun = createRunWithId(member, 'run-2');
    let aliveRunId: string | null = run.runId;
    let removedFromRunId: string | null = null;
    const host = createHost(run, {
      runs: new Map([
        [run.runId, run],
        [replacementRun.runId, replacementRun],
      ]),
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      async readConfigForStrictDecision() {
        aliveRunId = replacementRun.runId;
        return createConfig(member);
      },
      removeRunAllEffectiveMember(targetRun) {
        removedFromRunId = targetRun.runId;
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases
    );

    await expect(controller.detachLiveRosterMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(removedFromRunId).toBeNull();
  });

  it('does not enqueue an OpenCode lane reattach after workspace resolution observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'opencode',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let laneCreated = false;
    let laneLaunched = false;
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      getOpenCodeRuntimeAdapter: () => ({ providerId: 'opencode' }),
      async resolveOpenCodeMemberWorkspacesForRuntime(input) {
        aliveRunId = null;
        return input.members;
      },
      createMixedSecondaryLaneStateForMember(targetRun, laneMember) {
        laneCreated = true;
        return createHost(targetRun).createMixedSecondaryLaneStateForMember(targetRun, laneMember);
      },
      async launchSingleMixedSecondaryLane() {
        laneLaunched = true;
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases
    );

    await expect(
      controller.reattachOpenCodeOwnedMemberLane('team-a', 'Worker', {
        reason: 'manual_restart',
      })
    ).rejects.toThrow('Team "team-a" is not currently running');

    expect(laneCreated).toBe(false);
    expect(laneLaunched).toBe(false);
    expect(run.mixedSecondaryLanes).toEqual([]);
  });

  it('does not prepare or mutate a restart after the active run changes during config reads', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let prepareCalled = false;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      async readConfigForStrictDecision() {
        aliveRunId = null;
        return createConfig(member);
      },
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async preparePrimaryOwnedMemberRestartRuntime() {
            prepareCalled = true;
            return { directTmuxRestartPaneId: null, shouldDirectProcessRestart: false };
          },
        },
      }
    );

    await expect(controller.restartMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(prepareCalled).toBe(false);
    expect(spawnStatuses).toEqual([]);
  });

  it('does not reattach an OpenCode member from restart after the active run changes', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'opencode',
    };
    const run = createRun(member);
    const replacementRun = createRunWithId(member, 'run-2');
    let aliveRunId: string | null = run.runId;
    let laneCreatedForRunId: string | null = null;
    let laneLaunched = false;
    let configReadCount = 0;
    const host = createHost(run, {
      runs: new Map([
        [run.runId, run],
        [replacementRun.runId, replacementRun],
      ]),
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      getOpenCodeRuntimeAdapter: () => ({ providerId: 'opencode' }),
      async readConfigForStrictDecision() {
        configReadCount += 1;
        if (configReadCount === 1) {
          aliveRunId = replacementRun.runId;
        }
        return createConfig(member);
      },
      createMixedSecondaryLaneStateForMember(targetRun, laneMember) {
        laneCreatedForRunId = targetRun.runId;
        return createHost(targetRun).createMixedSecondaryLaneStateForMember(targetRun, laneMember);
      },
      async launchSingleMixedSecondaryLane() {
        laneLaunched = true;
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases
    );

    await expect(controller.restartMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(laneCreatedForRunId).toBeNull();
    expect(laneLaunched).toBe(false);
    expect(replacementRun.mixedSecondaryLanes).toEqual([]);
  });

  it('does not mark a restarted member offline after preparation observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let prepareCalled = false;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async preparePrimaryOwnedMemberRestartRuntime() {
            prepareCalled = true;
            aliveRunId = null;
            return { directTmuxRestartPaneId: null, shouldDirectProcessRestart: false };
          },
        },
      }
    );

    await expect(controller.restartMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(prepareCalled).toBe(true);
    expect(spawnStatuses).toEqual([]);
  });

  it('does not mark a restarted member spawning after the active run changes during config refresh', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let configReadCount = 0;
    let buildTrackedConfigCalled = false;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      async readConfigForStrictDecision() {
        configReadCount += 1;
        if (configReadCount === 2) {
          aliveRunId = null;
        }
        return createConfig(member);
      },
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
      async buildTrackedMemberMcpLaunchConfig() {
        buildTrackedConfigCalled = true;
        return null;
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async preparePrimaryOwnedMemberRestartRuntime() {
            return { directTmuxRestartPaneId: null, shouldDirectProcessRestart: false };
          },
        },
      }
    );

    await expect(controller.restartMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(run.pendingMemberRestarts.has('Worker')).toBe(false);
    expect(buildTrackedConfigCalled).toBe(false);
    expect(spawnStatuses).toEqual(['offline']);
  });

  it('does not mark a manual restart error when direct launch observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    const spawnStatuses: string[] = [];
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          async preparePrimaryOwnedMemberRestartRuntime() {
            return { directTmuxRestartPaneId: null, shouldDirectProcessRestart: true };
          },
          async launchDirectProcessMemberRestart() {
            aliveRunId = null;
            throw new Error('stale restart launch');
          },
        },
      }
    );

    await expect(controller.restartMember('team-a', 'Worker')).rejects.toThrow(
      'stale restart launch'
    );

    expect(spawnStatuses).toEqual(['offline', 'spawning']);
  });

  it('does not track a direct process MCP config after its write observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
      mcpPolicy: {
        mode: 'appOnly',
      },
    };
    const run = createRun(member);
    run.spawnContext = { claudePath: '/bin/echo' };
    let aliveRunId: string | null = run.runId;
    let wroteMcpConfig = false;
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      mcpConfigBuilder: {
        async writeConfigFile() {
          wroteMcpConfig = true;
          aliveRunId = null;
          return `${process.cwd()}/worker.mcp.json`;
        },
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          resolveDirectRestartRuntimeCwd: () => process.cwd(),
        },
      }
    );

    await expect(
      controller.launchDirectProcessMemberRestartInternal({
        run,
        teamName: 'team-a',
        displayName: 'Team A',
        leadName: 'Lead',
        memberName: 'Worker',
        config: createConfig(member),
        configuredMember: member,
        persistedRuntimeMembers: [],
      })
    ).rejects.toThrow('Team "team-a" is not currently running');

    expect(wroteMcpConfig).toBe(true);
    expect(run.memberMcpConfigPaths).toEqual([]);
  });

  it('does not send tmux launch keys after direct tmux config update observes a stale run', async () => {
    const member: TeamCreateRequest['members'][number] = {
      name: 'Worker',
      role: 'Developer',
      providerId: 'codex',
    };
    const run = createRun(member);
    let aliveRunId: string | null = run.runId;
    let promptEnqueued = false;
    const spawnStatuses: string[] = [];
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValue(
      new Map([['pane-1', { currentCommand: 'bash' }]]) as Awaited<
        ReturnType<typeof listTmuxPaneRuntimeInfoForCurrentPlatform>
      >
    );
    const host = createHost(run, {
      getAliveRunId: () => aliveRunId,
      getTrackedRunId: () => aliveRunId,
      isCurrentTrackedRun: (candidateRun) => aliveRunId === candidateRun.runId,
      persistInboxMessage() {
        promptEnqueued = true;
      },
      setMemberSpawnStatus(_targetRun, _memberName, status) {
        spawnStatuses.push(status);
      },
    });
    const controller = new TeamProvisioningMemberLifecycleController(
      host,
      immediateOperationUseCases,
      {
        restart: {
          resolveDirectRestartRuntimeCwd: () => process.cwd(),
          async preparePrimaryOwnedMemberRestartRuntime() {
            return { directTmuxRestartPaneId: 'pane-1', shouldDirectProcessRestart: false };
          },
          async updateDirectTmuxRestartMemberConfig() {
            aliveRunId = null;
          },
        },
      }
    );

    await expect(controller.restartMember('team-a', 'Worker')).rejects.toThrow(
      'Team "team-a" is not currently running'
    );

    expect(promptEnqueued).toBe(false);
    expect(sendKeysToTmuxPaneForCurrentPlatform).not.toHaveBeenCalled();
    expect(spawnStatuses).toEqual(['offline', 'spawning']);
  });
});
