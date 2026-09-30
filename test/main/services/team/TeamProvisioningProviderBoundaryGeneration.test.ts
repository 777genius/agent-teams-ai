// @vitest-environment node
import { EventEmitter } from 'node:events';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { bindProjectDirectoryLease } from '@main/services/team/provisioning/TeamProvisioningProjectDirectoryLease';
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
  buildNativeAppManagedBootstrapSpecsWithDiagnostics: () =>
    Promise.resolve({
      specs: new Map(),
      diagnostics: {},
    }),
}));

type SetupPorts = DeterministicCreateSetupFlowPorts<MixedSecondaryRuntimeLaneState>;
type RunPorts = DeterministicCreateRunFlowPorts<ProvisioningRun, MixedSecondaryRuntimeLaneState>;
type SpawnPorts = DeterministicCreateSpawnFlowPorts<ProvisioningRun>;
type TestService = Pick<TeamProvisioningService, 'createTeam' | 'setDesktopWriterWorkflowLease'> & {
  createDeterministicCreateSetupFlowPorts(): SetupPorts;
  createDeterministicCreateRunFlowPorts(): RunPorts;
  createDeterministicCreateSpawnFlowPorts(
    input: TeamProvisioningCreateDeterministicSpawnFlowBoundaryInput
  ): SpawnPorts;
  runs: Map<string, ProvisioningRun>;
  runWriterAuthority: TeamProvisioningRunWriterAuthority;
};

type Scenario = 'replacement-before-effect' | 'fresh';

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

it.each<Scenario>(['fresh', 'replacement-before-effect'])(
  'fences deterministic create at the provider boundary: %s',
  async (scenario) => {
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
    let leaseFd: number | null = null;
    let boundaryHits = 0;

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

      const realSetup = service.createDeterministicCreateSetupFlowPorts.bind(service);
      service.createDeterministicCreateSetupFlowPorts = () => ({
        ...realSetup(),
        resolveClaudePath: () => Promise.resolve('/synthetic/never-executed'),
        buildProvisioningEnv: () =>
          Promise.resolve({
            env: {},
            authSource: 'none',
            geminiRuntimeAuth: null,
            providerArgs: [],
          }),
        materializeEffectiveTeamMemberSpecs: ({ members }) => Promise.resolve(members),
        resolveOpenCodeMemberWorkspacesForRuntime: ({ members }) => Promise.resolve(members),
        buildCrossProviderMemberArgs: () =>
          Promise.resolve({
            args: [],
            envPatch: {},
            providerArgsByProvider: new Map(),
            usesAnthropicApiKeyHelper: false,
            anthropicApiKeyHelper: null,
          }),
        resolveAndValidateLaunchIdentity: () => Promise.resolve(null),
        resolveWorkspaceTrustFeatureFlags: () => ({
          enabled: false,
          claudePty: false,
          codexArgs: false,
          retry: false,
          fileLock: false,
        }),
        runtimeTurnSettledEnvironmentProvider: () => Promise.resolve({}),
      });
      const realRun = service.createDeterministicCreateRunFlowPorts.bind(service);
      service.createDeterministicCreateRunFlowPorts = () => ({
        ...realRun(),
        prepareWorkspaceTrustForDeterministicRun: () => Promise.resolve(),
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
      if (scenario === 'replacement-before-effect') {
        leaseFd = openSync(root, 'r');
        const st = fstatSync(leaseFd, { bigint: true });
        bindProjectDirectoryLease(request, {
          fd: leaseFd,
          dev: String(st.dev),
          ino: String(st.ino),
          beforeEffect: async () => {
            boundaryHits++;
            await replacePublicDirectories();
          },
        });
      }
      const syntheticSpawn = vi.fn(() => {
        const run = [...service!.runs.values()][0];
        service!.runWriterAuthority.assertCurrent(run);
        return child;
      });
      const realSpawn = service.createDeterministicCreateSpawnFlowPorts.bind(service);
      service.createDeterministicCreateSpawnFlowPorts = (input) => {
        const ports = realSpawn(input);
        return {
          ...ports,
          mcpConfigBuilder: {
            ...ports.mcpConfigBuilder,
            writeConfigFile: async () => {
              const configPath = join(root, 'synthetic-mcp.json');
              await writeFile(configPath, '{}');
              return configPath;
            },
            removeConfigFile: async (configPath) => rm(configPath, { force: true }),
          },
          buildMemberMcpLaunchConfigs: () => Promise.resolve(new Map()),
          validateAgentTeamsMcpRuntime: () => Promise.resolve(),
          spawnCli: syntheticSpawn as SpawnPorts['spawnCli'],
          attachStdoutHandler: () => undefined,
          attachStderrHandler: () => undefined,
          startStallWatchdog: () => undefined,
          startFilesystemMonitor: () => undefined,
        };
      };

      const outcome = await service
        .createTeam(request, () => undefined)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error : new Error(String(error)),
          })
        );
      if (scenario === 'fresh') {
        expect(outcome.ok).toBe(true);
        expect(boundaryHits).toBe(0);
        expect(syntheticSpawn).toHaveBeenCalledOnce();
        expect(JSON.parse(await readFile(join(team, 'team.meta.json'), 'utf8')).cwd).toBe(root);
        return;
      }

      expect(outcome.ok).toBe(false);
      expect(boundaryHits).toBe(1);
      expect(syntheticSpawn).not.toHaveBeenCalled();
      if (!outcome.ok) {
        expect(outcome.error.message).toContain('operator_required:');
        expect(outcome.error.message).toContain('pending reconciliation');
        expect(outcome.error.cause).toBeInstanceOf(Error);
        expect(String(outcome.error.cause)).toContain('run writer authority expired');
      }
      expect(await exists(team)).toBe(true);
      expect(await exists(tasks)).toBe(true);
      expect(await exists(`${team}-old`)).toBe(true);
      expect(await exists(`${tasks}-old`)).toBe(true);
      expect(await readFile(teamMarker, 'utf8')).toBe('replacement-C');
      expect(await readFile(taskMarker, 'utf8')).toBe('replacement-task-C');
      expect(JSON.parse(await readFile(join(team, 'config.json'), 'utf8'))._backupIdentityId).toBe(
        'replacement-C'
      );
    } finally {
      for (const run of service?.runs.values() ?? []) {
        if (run.timeoutHandle) clearTimeout(run.timeoutHandle);
        service?.runWriterAuthority.cleaned(run);
      }
      if (leaseFd !== null) closeSync(leaseFd);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      owner.dispose();
      vi.restoreAllMocks();
      setAppDataBasePath(null);
      setClaudeBasePathOverride(null);
      await rm(root, { recursive: true, force: true });
    }
  }
);
