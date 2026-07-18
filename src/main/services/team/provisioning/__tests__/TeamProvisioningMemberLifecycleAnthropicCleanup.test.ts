import {
  listTmuxPaneRuntimeInfoForCurrentPlatform,
  sendKeysToTmuxPaneForCurrentPlatform,
} from '@features/tmux-installer/main';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import {
  TeamProvisioningMemberLifecycleController,
  type TeamProvisioningMemberLifecycleHost,
} from '@main/services/team/provisioning/TeamProvisioningMemberLifecycle';
import { spawnCli } from '@main/utils/childProcess';
import { killProcessByPid } from '@main/utils/processKill';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DirectProcessRestartInput = Parameters<
  TeamProvisioningMemberLifecycleController['launchDirectProcessMemberRestartInternal']
>[0];
type DirectTmuxRestartInput = Omit<DirectProcessRestartInput, 'operation'> & { paneId: string };
type DirectTmuxRestartController = {
  launchDirectTmuxMemberRestart(input: DirectTmuxRestartInput): Promise<void>;
};

const hoisted = vi.hoisted(() => ({ teamsBase: '' }));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
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

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
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
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
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

  function createHost(helperDirectory: string) {
    return {
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
    };
  }

  it('removes pending helper material when direct process preparation fails', async () => {
    const helperDirectory = createHelperDirectory();
    const host = createHost(helperDirectory);
    host.materializeEffectiveTeamMemberSpecs.mockRejectedValueOnce(
      new Error('member materialization failed')
    );
    const controller = new TeamProvisioningMemberLifecycleController(
      host as unknown as TeamProvisioningMemberLifecycleHost
    );

    await expect(
      controller.launchDirectProcessMemberRestartInternal(createInput())
    ).rejects.toThrow('member materialization failed');

    expect(fs.existsSync(helperDirectory)).toBe(false);
  });

  it('removes pending helper material when direct tmux preparation fails', async () => {
    const helperDirectory = createHelperDirectory();
    const host = createHost(helperDirectory);
    host.materializeEffectiveTeamMemberSpecs.mockRejectedValueOnce(
      new Error('member materialization failed')
    );
    const controller = new TeamProvisioningMemberLifecycleController(
      host as unknown as TeamProvisioningMemberLifecycleHost
    );
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValueOnce(
      new Map([['%7', { paneId: '%7', panePid: 777, currentCommand: 'zsh' }]])
    );

    await expect(
      (controller as unknown as DirectTmuxRestartController).launchDirectTmuxMemberRestart({
        ...createInput(),
        paneId: '%7',
      })
    ).rejects.toThrow('member materialization failed');

    expect(fs.existsSync(helperDirectory)).toBe(false);
    expect(sendKeysToTmuxPaneForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('retains helper material after a direct tmux restart command is delivered', async () => {
    const helperDirectory = createHelperDirectory();
    const host = createHost(helperDirectory);
    const controller = new TeamProvisioningMemberLifecycleController(
      host as unknown as TeamProvisioningMemberLifecycleHost
    );
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValueOnce(
      new Map([['%8', { paneId: '%8', panePid: 778, currentCommand: 'zsh' }]])
    );

    await (controller as unknown as DirectTmuxRestartController).launchDirectTmuxMemberRestart({
      ...createInput(),
      paneId: '%8',
    });

    expect(sendKeysToTmuxPaneForCurrentPlatform).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(helperDirectory)).toBe(true);
  });

  it('removes helper material when a spawned direct process is rolled back', async () => {
    const helperDirectory = createHelperDirectory();
    const host = createHost(helperDirectory);
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
    const controller = new TeamProvisioningMemberLifecycleController(
      host as unknown as TeamProvisioningMemberLifecycleHost
    );

    await expect(
      controller.launchDirectProcessMemberRestartInternal(createInput())
    ).rejects.toThrow('runtime event persistence failed');

    expect(killProcessByPid).toHaveBeenCalledWith(4567);
    expect(fs.existsSync(helperDirectory)).toBe(false);
  });
});
