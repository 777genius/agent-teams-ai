// @vitest-environment node
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { expect, it, vi } from 'vitest';

import type { DeterministicCreateRunFlowPorts } from '@main/services/team/provisioning/TeamProvisioningCreateDeterministicRunFlow';
import type { DeterministicCreateSetupFlowPorts } from '@main/services/team/provisioning/TeamProvisioningCreateDeterministicSetupFlow';
import type { DeterministicCreateSpawnFlowPorts } from '@main/services/team/provisioning/TeamProvisioningCreateDeterministicSpawnFlow';
import type { TeamProvisioningCreateDeterministicSpawnFlowBoundaryInput } from '@main/services/team/provisioning/TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import type { ProvisioningRun } from '@main/services/team/provisioning/TeamProvisioningRunModel';
import type { TeamProvisioningRunWriterAuthority } from '@main/services/team/provisioning/TeamProvisioningRunWriterAuthority';
import type { MixedSecondaryRuntimeLaneState } from '@main/services/team/provisioning/TeamProvisioningSecondaryRuntimeRuns';
import type { TeamCreateRequest } from '@shared/types';
import type { spawn } from 'node:child_process';

vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: { getInstance: () => ({ addTeamNotification: vi.fn() }) },
}));
vi.mock('@main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder', () => ({
  buildNativeAppManagedBootstrapSpecsWithDiagnostics: async () => ({
    specs: new Map(),
    diagnostics: {},
  }),
}));

type SetupPorts = DeterministicCreateSetupFlowPorts<MixedSecondaryRuntimeLaneState>;
type RunPorts = DeterministicCreateRunFlowPorts<ProvisioningRun, MixedSecondaryRuntimeLaneState>;
type SpawnPorts = DeterministicCreateSpawnFlowPorts<ProvisioningRun>;
type TestService = Pick<
  TeamProvisioningService,
  'createTeam' | 'setDesktopWriterWorkflowLease'
> & {
  createDeterministicCreateSetupFlowPorts(): SetupPorts;
  createDeterministicCreateRunFlowPorts(): RunPorts;
  createDeterministicCreateSpawnFlowPorts(
    input: TeamProvisioningCreateDeterministicSpawnFlowBoundaryInput
  ): SpawnPorts;
  runs: Map<string, ProvisioningRun>;
  runWriterAuthority: TeamProvisioningRunWriterAuthority;
};

type Scenario =
  | 'fresh'
  | 'partial-tasks'
  | 'replacement-before-write'
  | 'replacement-during-validation'
  | 'failed-validation';

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

it.each<Scenario>([
  'fresh',
  'partial-tasks',
  'replacement-before-write',
  'replacement-during-validation',
  'failed-validation',
])('keeps deterministic create rollback on its generation: %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'deterministic-rollback-generation-'));
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const owner = new TeamBackupService();
  const teamName = 'deterministic-test';
  const team = join(root, 'teams', teamName);
  const tasks = join(root, 'tasks', teamName);
  const teamMarker = join(team, 'replacement.txt');
  const taskMarker = join(tasks, 'replacement-task.txt');
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
  }) as unknown as ReturnType<typeof spawn>;
  let service: TestService | null = null;

  try {
    await owner.initialize();
    service = new TeamProvisioningService() as unknown as TestService;
    service.setDesktopWriterWorkflowLease((name, operation, continuation) =>
      owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation)
    );
    const request: TeamCreateRequest = {
      teamName,
      cwd: root,
      providerId: 'anthropic',
      extraCliArgs: '--teammate-mode in-process',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'anthropic' }],
    };
    if (scenario === 'partial-tasks') await mkdir(tasks, { recursive: true });

    const realSetup = service.createDeterministicCreateSetupFlowPorts.bind(service);
    service.createDeterministicCreateSetupFlowPorts = () => ({
      ...realSetup(),
      resolveClaudePath: async () => '/synthetic/never-executed',
      buildProvisioningEnv: async () => ({
        env: {},
        authSource: 'none',
        geminiRuntimeAuth: null,
        providerArgs: [],
      }),
      materializeEffectiveTeamMemberSpecs: async ({ members }) => members,
      resolveOpenCodeMemberWorkspacesForRuntime: async ({ members }) => members,
      buildCrossProviderMemberArgs: async () => ({
        args: [],
        envPatch: {},
        providerArgsByProvider: new Map(),
        usesAnthropicApiKeyHelper: false,
        anthropicApiKeyHelper: null,
      }),
      resolveAndValidateLaunchIdentity: async () => null,
      resolveWorkspaceTrustFeatureFlags: () => ({
        enabled: false,
        claudePty: false,
        codexArgs: false,
        retry: false,
        fileLock: false,
      }),
      runtimeTurnSettledEnvironmentProvider: async () => ({}),
    });
    const realRun = service.createDeterministicCreateRunFlowPorts.bind(service);
    service.createDeterministicCreateRunFlowPorts = () => ({
      ...realRun(),
      prepareWorkspaceTrustForDeterministicRun: async () => undefined,
    });

    const replacePublicDirectories = async () => {
      await rename(team, `${team}-old`);
      await mkdir(team);
      await writeFile(teamMarker, 'replacement-C');
      await writeFile(
        join(team, 'config.json'),
        JSON.stringify({ name: teamName, _backupIdentityId: 'replacement-C' })
      );
      await rename(tasks, `${tasks}-old`);
      await mkdir(tasks);
      await writeFile(taskMarker, 'replacement-task-C');
    };
    const syntheticSpawn = vi.fn(() => child);
    const realSpawn = service.createDeterministicCreateSpawnFlowPorts.bind(service);
    service.createDeterministicCreateSpawnFlowPorts = (input) => {
      const ports = realSpawn(input);
      const writeMeta = ports.teamMetaStore.writeMeta.bind(ports.teamMetaStore);
      return {
        ...ports,
        teamMetaStore: {
          writeMeta: async (...args) => {
            if (scenario === 'replacement-before-write') await replacePublicDirectories();
            return writeMeta(...args);
          },
        },
        mcpConfigBuilder: {
          ...ports.mcpConfigBuilder,
          writeConfigFile: async () => {
            const configPath = join(root, 'synthetic-mcp.json');
            await writeFile(configPath, '{}');
            return configPath;
          },
          removeConfigFile: async (configPath) => rm(configPath, { force: true }),
        },
        buildMemberMcpLaunchConfigs: async () => new Map(),
        validateAgentTeamsMcpRuntime: async () => {
          if (scenario === 'replacement-during-validation') {
            await replacePublicDirectories();
          }
          if (scenario === 'replacement-during-validation' || scenario === 'failed-validation') {
            throw new Error('synthetic runtime validation failure');
          }
        },
        buildTeamRuntimeLaunchArgsPlan: async () => ({
          providerArgs: [],
          fastModeArgs: [],
          runtimeTurnSettledHookArgs: [],
          extraArgs: [],
          settingsArgs: [],
          inheritedProviderArgs: [],
          appManagedSettingsPath: null,
        }),
        spawnCli: syntheticSpawn as SpawnPorts['spawnCli'],
        attachStdoutHandler: () => undefined,
        attachStderrHandler: () => undefined,
        startStallWatchdog: () => undefined,
        startFilesystemMonitor: () => undefined,
      };
    };

    const outcome = await service.createTeam(request, () => undefined).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    );
    if (scenario === 'fresh' || scenario === 'partial-tasks') {
      expect(outcome.ok).toBe(true);
      expect(syntheticSpawn).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(join(team, 'team.meta.json'), 'utf8')).cwd).toBe(root);
      return;
    }

    expect(outcome.ok).toBe(false);
    expect(syntheticSpawn).not.toHaveBeenCalled();
    if (!outcome.ok) {
      expect(outcome.error.message).toContain('operator_required:');
      expect(outcome.error.message).toContain('pending reconciliation');
      expect(outcome.error.cause).toBeInstanceOf(Error);
    }
    expect(await exists(team)).toBe(true);
    expect(await exists(tasks)).toBe(true);
    if (scenario === 'failed-validation') {
      expect(JSON.parse(await readFile(join(team, 'team.meta.json'), 'utf8')).cwd).toBe(root);
    } else {
      expect(await exists(`${team}-old`)).toBe(true);
      expect(await exists(`${tasks}-old`)).toBe(true);
      expect(await readFile(teamMarker, 'utf8')).toBe('replacement-C');
      expect(await readFile(taskMarker, 'utf8')).toBe('replacement-task-C');
      expect(JSON.parse(await readFile(join(team, 'config.json'), 'utf8'))._backupIdentityId)
        .toBe('replacement-C');
    }
  } finally {
    for (const run of service?.runs.values() ?? []) {
      if (run.timeoutHandle) clearTimeout(run.timeoutHandle);
      service?.runWriterAuthority.cleaned(run);
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    owner.dispose();
    vi.restoreAllMocks();
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    await rm(root, { recursive: true, force: true });
  }
});
