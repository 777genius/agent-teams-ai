import {
  listTmuxPaneRuntimeInfoForCurrentPlatform,
  sendKeysToTmuxPaneForCurrentPlatform,
} from '@features/tmux-installer/main';
import { spawnCli } from '@main/utils/childProcess';
import { killProcessByPid } from '@main/utils/processKill';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningMemberLifecycleController } from '../TeamProvisioningMemberLifecycle';

import type { TeamProvisioningMemberLifecycleHost } from '../TeamProvisioningMemberLifecycleHostPorts';
import type { TeamProvisioningMemberLifecycleOperationUseCases } from '../TeamProvisioningMemberLifecycleOperationUseCases';
import type * as PathDecoderModule from '@main/utils/pathDecoder';

type DirectProcessRestartInput = Parameters<
  TeamProvisioningMemberLifecycleController['launchDirectProcessMemberRestartInternal']
>[0];
type DirectTmuxRestartInput = Omit<DirectProcessRestartInput, 'operation'> & { paneId: string };
interface DirectTmuxRestartController {
  launchDirectTmuxMemberRestart(input: DirectTmuxRestartInput): Promise<void>;
}

type LifecycleHostMock = TeamProvisioningMemberLifecycleHost & {
  materializeEffectiveTeamMemberSpecs: ReturnType<typeof vi.fn>;
  appendDirectProcessRuntimeEvent: ReturnType<typeof vi.fn>;
  updateDirectTmuxRestartMemberConfig: ReturnType<typeof vi.fn>;
};

const immediateOperationUseCases: TeamProvisioningMemberLifecycleOperationUseCases = {
  isMemberLifecycleOperationActive: () => false,
  async runMemberLifecycleOperation(_teamName, _memberName, _kind, operation) {
    return operation();
  },
};

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
  resolveClaudeBinary: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: hoisted.resolveClaudeBinary },
}));

vi.mock('@features/tmux-installer/main', () => ({
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
  listRuntimeProcessTableForCurrentPlatform: vi.fn(async () => []),
  listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
  sendKeysToTmuxPaneForCurrentPlatform: vi.fn(async () => undefined),
}));

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
}));

vi.mock('@main/utils/processKill', () => ({
  killProcessByPid: vi.fn(),
}));

vi.mock('@main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder', () => ({
  buildNativeAppManagedBootstrapSpecs: vi.fn(async ({ members }) => {
    return new Map(
      members.map((member: { name: string }) => [
        member.name,
        {
          mode: 'startup_context_file',
          contextText:
            '<agent_teams_native_bootstrap_context>test</agent_teams_native_bootstrap_context>',
          contextHash: 'a'.repeat(64),
          briefingHash: 'b'.repeat(64),
          generatedAt: new Date().toISOString(),
        },
      ])
    );
  }),
}));

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof PathDecoderModule>();
  return {
    ...actual,
    getTeamsBasePath: () => hoisted.teamsBase,
  };
});

describe('TeamProvisioningMemberLifecycle Anthropic helper cleanup', () => {
  let testRoot = '';

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-lifecycle-anthropic-cleanup-'));
    hoisted.teamsBase = path.join(testRoot, 'teams');
    fs.mkdirSync(hoisted.teamsBase, { recursive: true });
    hoisted.resolveClaudeBinary.mockResolvedValue('/mock/claude');
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockReset();
    vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockReset();
    vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockResolvedValue(undefined);
    vi.mocked(spawnCli).mockReset();
    vi.mocked(killProcessByPid).mockReset();
  });

  afterEach(() => {
    for (const [, command] of vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mock.calls) {
      if (command?.startsWith("/bin/sh '") && command.endsWith("'")) {
        const scriptPath = command.slice(9, -1).replace(/'\\''/g, "'");
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
      }
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function createHelperDirectory(): string {
    const helperDirectory = fs.mkdtempSync(path.join(testRoot, 'helper-'));
    fs.writeFileSync(path.join(helperDirectory, 'helper.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(helperDirectory, 'key'), 'test-key\n');
    fs.writeFileSync(path.join(helperDirectory, 'settings.json'), '{}\n');
    return helperDirectory;
  }

  function createInput(): DirectProcessRestartInput {
    const configuredMember = {
      name: 'alice',
      role: 'Developer',
      providerId: 'anthropic' as const,
      model: 'sonnet',
    };
    const run = {
      runId: 'run-anthropic-restart',
      request: { providerId: 'anthropic' as const, members: [configuredMember] },
      spawnContext: { claudePath: '/mock/claude' },
      detectedSessionId: 'lead-session',
      memberMcpConfigPaths: [],
    };
    return {
      run,
      teamName: 'anthropic-restart-team',
      displayName: 'Anthropic Restart Team',
      leadName: 'team-lead',
      memberName: configuredMember.name,
      config: {
        name: 'Anthropic Restart Team',
        projectPath: testRoot,
        leadSessionId: 'lead-session',
        members: [{ name: 'team-lead', agentType: 'team-lead' }, configuredMember],
      },
      configuredMember,
      persistedRuntimeMembers: [],
    } as unknown as DirectProcessRestartInput;
  }

  function createHost(
    helperDirectory: string,
    run: DirectProcessRestartInput['run']
  ): LifecycleHostMock {
    return {
      runs: new Map([[run.runId, run]]),
      getAliveRunId: () => run.runId,
      isCurrentTrackedRun: (candidateRun: DirectProcessRestartInput['run']) => candidateRun === run,
      getRunTrackedCwd: () => testRoot,
      buildPrimaryOwnedMemberSpecForRuntime: ({
        configuredMember,
      }: Parameters<
        TeamProvisioningMemberLifecycleHost['buildPrimaryOwnedMemberSpecForRuntime']
      >[0]) => configuredMember,
      buildProvisioningEnv: vi.fn(async () => ({
        env: {},
        providerArgs: [],
        anthropicApiKeyHelper: { directory: helperDirectory },
      })),
      materializeEffectiveTeamMemberSpecs: vi.fn(
        async ({
          members,
        }: Parameters<
          TeamProvisioningMemberLifecycleHost['materializeEffectiveTeamMemberSpecs']
        >[0]) => members
      ),
      resolveDirectMemberLaunchIdentity: vi.fn(async () => null),
      mcpConfigBuilder: {
        writeConfigFile: vi.fn(async () => path.join(testRoot, 'mcp.json')),
      },
      buildTeamRuntimeLaunchArgsPlan: vi.fn(async () => ({
        settingsArgs: [],
        fastModeArgs: [],
        runtimeTurnSettledHookArgs: [],
        providerArgs: [],
        appManagedSettingsPath: null,
      })),
      updateDirectTmuxRestartMemberConfig: vi.fn(async () => undefined),
      enqueueDirectRestartPrompt: vi.fn(),
      appendDirectProcessRuntimeEvent: vi.fn(async () => undefined),
      appendMemberBootstrapDiagnostic: vi.fn(),
      setMemberSpawnStatus: vi.fn(),
      upsertRunAllEffectiveMember: vi.fn(),
    } as unknown as LifecycleHostMock;
  }

  function createController(
    host: ReturnType<typeof createHost>
  ): TeamProvisioningMemberLifecycleController {
    return new TeamProvisioningMemberLifecycleController(host, immediateOperationUseCases, {
      restart: {
        appendDirectProcessRuntimeEvent: host.appendDirectProcessRuntimeEvent,
        updateDirectTmuxRestartMemberConfig: host.updateDirectTmuxRestartMemberConfig,
      },
    });
  }

  it('removes pending helper material when direct process preparation fails', async () => {
    const helperDirectory = createHelperDirectory();
    const input = createInput();
    const host = createHost(helperDirectory, input.run);
    host.materializeEffectiveTeamMemberSpecs.mockRejectedValueOnce(
      new Error('member materialization failed')
    );
    const controller = createController(host);

    await expect(controller.launchDirectProcessMemberRestartInternal(input)).rejects.toThrow(
      'member materialization failed'
    );

    expect(host.buildProvisioningEnv).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(helperDirectory)).toBe(false);
  });

  it('removes pending helper material when direct tmux preparation fails', async () => {
    const helperDirectory = createHelperDirectory();
    const input = createInput();
    const host = createHost(helperDirectory, input.run);
    host.materializeEffectiveTeamMemberSpecs.mockRejectedValueOnce(
      new Error('member materialization failed')
    );
    const controller = createController(host);
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValueOnce(
      new Map([['%7', { paneId: '%7', panePid: 777, currentCommand: 'zsh' }]])
    );

    await expect(
      (controller as unknown as DirectTmuxRestartController).launchDirectTmuxMemberRestart({
        ...input,
        paneId: '%7',
      })
    ).rejects.toThrow('member materialization failed');

    expect(host.buildProvisioningEnv).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(helperDirectory)).toBe(false);
    expect(sendKeysToTmuxPaneForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('retains helper material after a direct tmux restart command is delivered', async () => {
    const helperDirectory = createHelperDirectory();
    const input = createInput();
    const host = createHost(helperDirectory, input.run);
    const controller = createController(host);
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValueOnce(
      new Map([['%8', { paneId: '%8', panePid: 778, currentCommand: 'zsh' }]])
    );

    await (controller as unknown as DirectTmuxRestartController).launchDirectTmuxMemberRestart({
      ...input,
      paneId: '%8',
    });

    expect(sendKeysToTmuxPaneForCurrentPlatform).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(helperDirectory)).toBe(true);
  });

  it('removes helper material when a spawned direct process is rolled back', async () => {
    const helperDirectory = createHelperDirectory();
    const input = createInput();
    const host = createHost(helperDirectory, input.run);
    host.appendDirectProcessRuntimeEvent.mockRejectedValueOnce(
      new Error('runtime event persistence failed')
    );
    const child = Object.assign(new EventEmitter(), {
      pid: 4567,
      stdin: Object.assign(new EventEmitter(), { unref: vi.fn() }),
      stdout: { pipe: vi.fn(), unref: vi.fn() },
      stderr: { pipe: vi.fn(), unref: vi.fn() },
      unref: vi.fn(),
    });
    vi.mocked(spawnCli).mockReturnValue(child as never);
    const controller = createController(host);

    await expect(controller.launchDirectProcessMemberRestartInternal(input)).rejects.toThrow(
      'runtime event persistence failed'
    );

    expect(killProcessByPid).toHaveBeenCalledWith(4567);
    expect(fs.existsSync(helperDirectory)).toBe(false);
  });

  it('queues the native bootstrap marker when a direct process restart has app-managed context', async () => {
    const helperDirectory = createHelperDirectory();
    const input = createInput();
    const host = createHost(helperDirectory, input.run);
    fs.mkdirSync(path.join(hoisted.teamsBase, 'anthropic-restart-team', 'runtime'), {
      recursive: true,
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 5678,
      stdin: Object.assign(new EventEmitter(), { unref: vi.fn() }),
      stdout: { pipe: vi.fn(), unref: vi.fn() },
      stderr: { pipe: vi.fn(), unref: vi.fn() },
      unref: vi.fn(),
    });
    vi.mocked(spawnCli).mockReturnValue(child as never);
    const controller = createController(host);

    await controller.launchDirectProcessMemberRestartInternal(input);

    await vi.waitFor(() => {
      expect(
        fs.existsSync(
          path.join(hoisted.teamsBase, 'anthropic-restart-team', 'runtime', 'alice.stdout.log')
        )
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(hoisted.teamsBase, 'anthropic-restart-team', 'runtime', 'alice.stderr.log')
        )
      ).toBe(true);
    });
    expect(host.enqueueDirectRestartPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: 'alice',
        prompt: [
          '<agent_teams_native_app_managed_bootstrap_check>',
          '</agent_teams_native_app_managed_bootstrap_check>',
        ].join('\n'),
      })
    );
    child.emit('close', 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
