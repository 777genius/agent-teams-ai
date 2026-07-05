import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningCreateDeterministicSpawnFlowBoundary,
  type TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps,
} from '../TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import { buildCreateTeamMetaPayload } from '../TeamProvisioningCreateTeamFlow';

import type { DeterministicCreateSpawnFlowRun } from '../TeamProvisioningCreateDeterministicSpawnFlow';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

type TestRun = DeterministicCreateSpawnFlowRun;

const TEST_MCP_CONFIG_PATH = '/repo/.agent-teams/mcp.json';

const request: TeamCreateRequest = {
  teamName: 'demo',
  cwd: '/repo',
  providerId: 'codex',
  providerBackendId: 'codex-native',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
  members: [{ name: 'Lead', role: 'Lead' }],
  prompt: 'start work',
};

const progress: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'demo',
  state: 'spawning',
  message: 'Starting',
  startedAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
};

function createRun(): TestRun {
  return {
    runId: 'run-1',
    teamName: 'demo',
    progress,
    provisioningTraceLines: [],
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    child: null,
    processClosed: false,
    spawnContext: null,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    timeoutHandle: null,
    processKilled: false,
    provisioningComplete: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    mcpConfigPath: null,
    requiresFirstRealTurnSuccess: false,
    deterministicBootstrap: true,
    effectiveMembers: request.members,
    onProgress: vi.fn(),
  };
}

class BoundCallbackHost {
  readonly marker = 'host-context';
  readonly calls: string[] = [];

  attachStdoutHandler(run: TestRun): void {
    this.calls.push(`${this.marker}:stdout:${run.runId}`);
  }

  startFilesystemMonitor(run: TestRun, targetRequest: TeamCreateRequest): void {
    this.calls.push(`${this.marker}:fs:${run.runId}:${targetRequest.teamName}`);
  }

  cleanupRun(run: TestRun): void {
    this.calls.push(`${this.marker}:cleanup:${run.runId}`);
  }
}

function createDeps(host: BoundCallbackHost): {
  deps: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TestRun>;
  deletedRunIds: string[];
  deletedTeamNames: string[];
  shellEnv: NodeJS.ProcessEnv;
} {
  const deletedRunIds: string[] = [];
  const deletedTeamNames: string[] = [];
  const shellEnv = { PATH: '/bin' };

  return {
    deletedRunIds,
    deletedTeamNames,
    shellEnv,
    deps: {
      teamMetaStore: {
        writeMeta: vi.fn(async () => undefined),
        deleteMeta: vi.fn(async () => undefined),
      },
      membersMetaStore: {
        writeMembers: vi.fn(async () => undefined),
      },
      mcpConfigBuilder: {
        writeConfigFile: vi.fn(async () => TEST_MCP_CONFIG_PATH),
        removeConfigFile: vi.fn(async () => undefined),
      },
      buildMemberMcpLaunchConfigs: vi.fn(async () => new Map()),
      validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
      buildTeamRuntimeLaunchArgsPlan: vi.fn(async () => ({
        settingsArgs: [],
        fastModeArgs: [],
        runtimeTurnSettledHookArgs: [],
        providerArgs: [],
        extraArgs: [],
        inheritedProviderArgs: [],
        appManagedSettingsPath: null,
      })),
      seedLeadBootstrapPermissionRules: vi.fn(async () => undefined),
      spawnCli:
        vi.fn() as unknown as TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TestRun>['spawnCli'],
      updateProgress: vi.fn((run) => run.progress),
      attachStdoutHandler: (run) => host.attachStdoutHandler(run),
      attachStderrHandler: vi.fn(),
      startStallWatchdog: vi.fn(),
      startFilesystemMonitor: (run, targetRequest) =>
        host.startFilesystemMonitor(run, targetRequest),
      tryCompleteAfterTimeout: vi.fn(async () => false),
      handleProcessExit: vi.fn(async () => undefined),
      killTeamProcess: vi.fn(),
      cleanupRun: (run) => host.cleanupRun(run),
      removeRunMemberMcpConfigFiles: vi.fn(async () => undefined),
      deleteRun: (runId) => {
        deletedRunIds.push(runId);
      },
      deleteProvisioningRunByTeam: (teamName) => {
        deletedTeamNames.push(teamName);
      },
      getStopAllTeamsGeneration: vi.fn(() => 7),
    },
  };
}

describe('createTeamProvisioningCreateDeterministicSpawnFlowBoundary', () => {
  it('creates deterministic create spawn ports from bound service adapters', async () => {
    const host = new BoundCallbackHost();
    const { deps, deletedRunIds, deletedTeamNames, shellEnv } = createDeps(host);
    const boundary = createTeamProvisioningCreateDeterministicSpawnFlowBoundary(deps);
    const ports = boundary.createSpawnFlowPorts({
      request,
      claudePath: '/bin/claude',
      shellEnv,
    });
    const run = createRun();
    const cancellationOptions = { isCancelled: () => false };

    const metaPayload = buildCreateTeamMetaPayload(request, null, 123);

    await ports.teamMetaStore.writeMeta(request.teamName, metaPayload);
    await ports.validateAgentTeamsMcpRuntime(TEST_MCP_CONFIG_PATH, cancellationOptions);
    ports.attachStdoutHandler(run);
    ports.startFilesystemMonitor(run, request);
    ports.cleanupRun(run);
    ports.unregisterRun(run.runId, request.teamName);

    expect(deps.teamMetaStore.writeMeta).toHaveBeenCalledWith(request.teamName, metaPayload);
    expect(deps.validateAgentTeamsMcpRuntime).toHaveBeenCalledWith({
      claudePath: '/bin/claude',
      cwd: request.cwd,
      shellEnv,
      mcpConfigPath: TEST_MCP_CONFIG_PATH,
      options: cancellationOptions,
    });
    expect(host.calls).toEqual([
      'host-context:stdout:run-1',
      'host-context:fs:run-1:demo',
      'host-context:cleanup:run-1',
    ]);
    expect(deletedRunIds).toEqual(['run-1']);
    expect(deletedTeamNames).toEqual(['demo']);
    expect(ports.spawnCli).toBe(deps.spawnCli);
    expect(ports.membersMetaStore).toBe(deps.membersMetaStore);
    expect(ports.mcpConfigBuilder).toBe(deps.mcpConfigBuilder);
    expect(ports.getStopAllTeamsGeneration()).toBe(7);
  });
});
