import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  paths: {
    claudeRoot: '',
    teamsBase: '',
    tasksBase: '',
    projectsBase: '',
  },
}));

let tempClaudeRoot = '';
let tempTeamsBase = '';
let tempTasksBase = '';
let tempProjectsBase = '';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/services/team/TeamTaskReader', () => ({
  TeamTaskReader: class {
    async getTasks() {
      return [];
    }
  },
}));

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getAutoDetectedClaudeBasePath: () => hoisted.paths.claudeRoot,
    getClaudeBasePath: () => hoisted.paths.claudeRoot,
    getHomeDir: () => hoisted.paths.claudeRoot,
    getProjectsBasePath: () => hoisted.paths.projectsBase,
    getTasksBasePath: () => hoisted.paths.tasksBase,
    getTeamsBasePath: () => hoisted.paths.teamsBase,
  };
});

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { getTeamLaunchStatePath } from '@main/services/team/TeamLaunchStateStore';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { spawnCli } from '@main/utils/childProcess';
import { AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES } from 'agent-teams-controller';

function allowConsoleLogs() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function createFakeChild(exitCode: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: null,
    stderr: null,
    stdin: null,
  }) as unknown as ChildProcess;
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

function createRunningChild() {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: {
      writable: true,
      write: vi.fn(() => true),
      end: vi.fn(),
    },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

function writeLaunchConfig(
  teamName: string,
  projectPath: string,
  leadSessionId: string,
  members: string[]
): void {
  const teamDir = path.join(tempTeamsBase, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      projectPath,
      leadSessionId,
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        ...members.map((name) => ({ name })),
      ],
    }),
    'utf8'
  );
}

function writeLaunchState(
  teamName: string,
  leadSessionId: string,
  members: Record<string, Record<string, unknown>>
): void {
  const snapshot = createPersistedLaunchSnapshot({
    teamName,
    leadSessionId,
    launchPhase: 'finished',
    expectedMembers: Object.keys(members),
    members: Object.fromEntries(
      Object.entries(members).map(([name, member]) => [
        name,
        {
          name,
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Teammate was never spawned during launch.',
          lastEvaluatedAt: new Date().toISOString(),
          ...member,
        },
      ])
    ) as any,
  });
  fs.writeFileSync(
    getTeamLaunchStatePath(teamName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
}

describe('TeamProvisioningService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempClaudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-provisioning-'));
    tempTeamsBase = path.join(tempClaudeRoot, 'teams');
    tempTasksBase = path.join(tempClaudeRoot, 'tasks');
    tempProjectsBase = path.join(tempClaudeRoot, 'projects');
    hoisted.paths.claudeRoot = tempClaudeRoot;
    hoisted.paths.teamsBase = tempTeamsBase;
    hoisted.paths.tasksBase = tempTasksBase;
    hoisted.paths.projectsBase = tempProjectsBase;
    fs.mkdirSync(tempTeamsBase, { recursive: true });
    fs.mkdirSync(tempTasksBase, { recursive: true });
    fs.mkdirSync(tempProjectsBase, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(tempClaudeRoot, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failures
    }
    hoisted.paths.claudeRoot = '';
    hoisted.paths.teamsBase = '';
    hoisted.paths.tasksBase = '';
    hoisted.paths.projectsBase = '';
  });

  describe('warmup', () => {
    it('does not throw when spawnCli rejects', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('C:\\path\\claude');
      let callCount = 0;
      vi.mocked(spawnCli).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('spawn EINVAL');
        }
        return createFakeChild(0);
      });

      const svc = new TeamProvisioningService();
      await expect(svc.warmup()).resolves.not.toThrow();
      expect(spawnCli).toHaveBeenCalled();
    });
  });

  it('removes generated MCP config when createTeam spawn fails synchronously', async () => {
    allowConsoleLogs();
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    vi.mocked(spawnCli).mockImplementation(() => {
      throw new Error('spawn EINVAL');
    });

    const mcpConfigBuilder = {
      writeConfigFile: vi.fn(async () => '/mock/mcp-config-create.json'),
      removeConfigFile: vi.fn(async () => {}),
    };
    const membersMetaStore = {
      writeMembers: vi.fn(async () => {}),
    };
    const teamMetaStore = {
      writeMeta: vi.fn(async () => {}),
      deleteMeta: vi.fn(async () => {}),
    };

    const svc = new TeamProvisioningService(
      undefined,
      undefined,
      membersMetaStore as any,
      undefined,
      mcpConfigBuilder as any,
      teamMetaStore as any
    );
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);

    await expect(
      svc.createTeam(
        {
          teamName: 'cleanup-team',
          cwd: tempClaudeRoot,
          members: [{ name: 'alice' }],
        },
        () => {}
      )
    ).rejects.toThrow('spawn EINVAL');

    expect(mcpConfigBuilder.writeConfigFile).toHaveBeenCalledWith(tempClaudeRoot);
    expect(mcpConfigBuilder.removeConfigFile).toHaveBeenCalledWith('/mock/mcp-config-create.json');
    expect(teamMetaStore.deleteMeta).toHaveBeenCalledWith('cleanup-team');
  });

  it('removes generated MCP config when launchTeam spawn fails synchronously', async () => {
    allowConsoleLogs();
    const teamName = 'launch-cleanup-team';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath: tempClaudeRoot,
        members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'alice' }],
      }),
      'utf8'
    );

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    vi.mocked(spawnCli).mockImplementation(() => {
      throw new Error('launch spawn EINVAL');
    });

    const mcpConfigBuilder = {
      writeConfigFile: vi.fn(async () => '/mock/mcp-config-launch.json'),
      removeConfigFile: vi.fn(async () => {}),
    };
    const restorePrelaunchConfig = vi.fn(async () => {});

    const svc = new TeamProvisioningService(
      undefined,
      undefined,
      undefined,
      undefined,
      mcpConfigBuilder as any
    );
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice' }],
      source: 'members-meta',
      warning: undefined,
    }));
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = restorePrelaunchConfig;
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);

    await expect(svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {})).rejects.toThrow(
      'launch spawn EINVAL'
    );

    expect(mcpConfigBuilder.writeConfigFile).toHaveBeenCalledWith(tempClaudeRoot);
    expect(mcpConfigBuilder.removeConfigFile).toHaveBeenCalledWith('/mock/mcp-config-launch.json');
    expect(restorePrelaunchConfig).toHaveBeenCalledWith(teamName);
  });

  it('regenerates a missing --mcp-config before auth-failure respawn', async () => {
    vi.useFakeTimers();
    allowConsoleLogs();
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');

    const firstChild = createRunningChild();
    const secondChild = createRunningChild();
    vi.mocked(spawnCli)
      .mockImplementationOnce(() => firstChild as any)
      .mockImplementationOnce(() => secondChild as any);

    const mcpConfigBuilder = {
      writeConfigFile: vi
        .fn()
        .mockResolvedValueOnce('/missing/original-mcp-config.json')
        .mockResolvedValueOnce('/regenerated/mcp-config.json'),
      removeConfigFile: vi.fn(async () => {}),
    };
    const membersMetaStore = {
      writeMembers: vi.fn(async () => {}),
    };
    const teamMetaStore = {
      writeMeta: vi.fn(async () => {}),
      deleteMeta: vi.fn(async () => {}),
    };

    const svc = new TeamProvisioningService(
      undefined,
      undefined,
      membersMetaStore as any,
      undefined,
      mcpConfigBuilder as any,
      teamMetaStore as any
    );
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).stopFilesystemMonitor = vi.fn();
    (svc as any).startStallWatchdog = vi.fn();
    (svc as any).stopStallWatchdog = vi.fn();
    (svc as any).attachStdoutHandler = vi.fn();
    (svc as any).attachStderrHandler = vi.fn();

    const { runId } = await svc.createTeam(
      {
        teamName: 'retry-team',
        cwd: tempClaudeRoot,
        members: [{ name: 'alice' }],
      },
      () => {}
    );

    const run = (svc as any).runs.get(runId);
    expect(run).toBeTruthy();

    const mcpFlagIdx = run.spawnContext.args.indexOf('--mcp-config');
    expect(mcpFlagIdx).toBeGreaterThanOrEqual(0);
    run.spawnContext.args[mcpFlagIdx + 1] = path.join(tempClaudeRoot, 'deleted-mcp-config.json');
    run.mcpConfigPath = run.spawnContext.args[mcpFlagIdx + 1];
    run.authRetryInProgress = true;

    const respawnPromise = (svc as any).respawnAfterAuthFailure(run);
    await vi.advanceTimersByTimeAsync(2000);
    await respawnPromise;

    expect(mcpConfigBuilder.writeConfigFile).toHaveBeenNthCalledWith(2, tempClaudeRoot);
    expect(run.spawnContext.args[mcpFlagIdx + 1]).toBe('/regenerated/mcp-config.json');
    expect(run.mcpConfigPath).toBe('/regenerated/mcp-config.json');
    expect(vi.mocked(spawnCli)).toHaveBeenNthCalledWith(
      2,
      '/mock/claude',
      run.spawnContext.args,
      expect.objectContaining({
        cwd: tempClaudeRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    expect(run.child).toBe(secondChild);

    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
  });

  it('pre-seeds teammate operational MCP permissions before createTeam spawn', async () => {
    allowConsoleLogs();
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    vi.mocked(spawnCli).mockImplementation(() => {
      throw new Error('spawn EINVAL');
    });

    const mcpConfigBuilder = {
      writeConfigFile: vi.fn(async () => '/mock/mcp-config-create.json'),
      removeConfigFile: vi.fn(async () => {}),
    };
    const membersMetaStore = {
      writeMembers: vi.fn(async () => {}),
    };
    const teamMetaStore = {
      writeMeta: vi.fn(async () => {}),
      deleteMeta: vi.fn(async () => {}),
    };

    const svc = new TeamProvisioningService(
      undefined,
      undefined,
      membersMetaStore as any,
      undefined,
      mcpConfigBuilder as any,
      teamMetaStore as any
    );
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);

    await expect(
      svc.createTeam(
        {
          teamName: 'seeded-team',
          cwd: tempClaudeRoot,
          members: [{ name: 'alice' }],
          skipPermissions: false,
        },
        () => {}
      )
    ).rejects.toThrow('spawn EINVAL');

    const settingsPath = path.join(tempClaudeRoot, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toEqual(
      expect.arrayContaining([...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES])
    );
    expect(settings.permissions?.allow).not.toContain('mcp__agent-teams__team_stop');
    expect(settings.permissions?.allow).not.toContain('mcp__agent-teams__kanban_clear');
  });

  it('expands teammate permission suggestions to the operational tool set only', async () => {
    allowConsoleLogs();
    const svc = new TeamProvisioningService({
      getConfig: vi.fn(async () => ({
        projectPath: tempClaudeRoot,
        members: [{ cwd: tempClaudeRoot }],
      })),
    } as any);

    await (svc as any).respondToTeammatePermission(
      { teamName: 'ops-team' },
      'alice',
      'req-1',
      true,
      undefined,
      [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'mcp__agent-teams__task_get' }],
        },
      ]
    );

    const settingsPath = path.join(tempClaudeRoot, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toEqual(
      expect.arrayContaining([...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES])
    );
    expect(settings.permissions?.allow).not.toContain('mcp__agent-teams__team_stop');
    expect(settings.permissions?.allow).not.toContain('mcp__agent-teams__kanban_clear');
  });

  it('does not broaden admin/runtime teammate permission suggestions', async () => {
    allowConsoleLogs();
    const svc = new TeamProvisioningService({
      getConfig: vi.fn(async () => ({
        projectPath: tempClaudeRoot,
        members: [{ cwd: tempClaudeRoot }],
      })),
    } as any);

    await (svc as any).respondToTeammatePermission(
      { teamName: 'ops-team' },
      'alice',
      'req-2',
      true,
      undefined,
      [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'mcp__agent-teams__team_stop' }],
        },
      ]
    );

    const settingsPath = path.join(tempClaudeRoot, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toEqual(['mcp__agent-teams__team_stop']);
  });

  it('uses a non-alarming cloud delay message before 2 minutes of silence', () => {
    const svc = new TeamProvisioningService();

    expect((svc as any).buildStallProgressMessage(90, '1m 30s')).toBe(
      'Waiting on Cloud response for 1m 30s — logs can be delayed, this is still OK'
    );

    expect(
      (svc as any).buildStallWarningText(90, {
        request: { model: 'sonnet' },
      })
    ).toContain('Logs can sometimes show up after 1-1.5 minutes, and that is still okay.');
  });

  it('marks a cloud wait as unusual after 2 minutes of silence', () => {
    const svc = new TeamProvisioningService();

    expect((svc as any).buildStallProgressMessage(120, '2m')).toBe(
      'Still waiting on Cloud response for 2m — this is unusual'
    );

    expect(
      (svc as any).buildStallWarningText(120, {
        request: { model: 'sonnet' },
      })
    ).toContain('but no logs for 2m is already unusual.');
  });

  it('formats AskUserQuestion approvals with readable question text', () => {
    const svc = new TeamProvisioningService();

    expect(
      (svc as any).formatToolApprovalBody('AskUserQuestion', {
        questions: [
          {
            question:
              'Я испытываю технические трудности с отправкой сообщений с помощью инструмента `SendMessage`.',
          },
        ],
      })
    ).toBe(
      'Question: Я испытываю технические трудности с отправкой сообщений с помощью инструмента `SendMessage`.'
    );
  });

  it('formats AskUserQuestion approvals with a compact multi-question summary', () => {
    const svc = new TeamProvisioningService();

    expect(
      (svc as any).formatToolApprovalBody('AskUserQuestion', {
        questions: [
          { question: '  First question with   extra spacing.  ' },
          { question: 'Second question.' },
        ],
      })
    ).toBe('Questions (2): First question with extra spacing.');
  });

  it('skips --resume when the persisted launch state shows no teammate ever spawned', async () => {
    allowConsoleLogs();
    const teamName = 'resume-skip-team';
    const leadSessionId = 'lead-session-skip';
    writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice', 'bob']);
    writeLaunchState(teamName, leadSessionId, {
      alice: {
        launchState: 'failed_to_start',
      },
      bob: {
        launchState: 'starting',
        hardFailure: false,
      },
    });

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    vi.mocked(spawnCli).mockImplementation(() => {
      throw new Error('launch spawn EINVAL');
    });

    const svc = new TeamProvisioningService(undefined, undefined, undefined, undefined, {
      writeConfigFile: vi.fn(async () => '/mock/mcp-config-launch.json'),
      removeConfigFile: vi.fn(async () => {}),
    } as any);
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice' }, { name: 'bob' }],
      source: 'members-meta',
      warning: undefined,
    }));
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async (targetPath: string) =>
      targetPath.endsWith(`${leadSessionId}.jsonl`)
    );

    await expect(svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {})).rejects.toThrow(
      'launch spawn EINVAL'
    );

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toBeTruthy();
    expect(launchArgs).not.toContain('--resume');
    expect(launchArgs).not.toContain(leadSessionId);
  });

  it('keeps --resume when a teammate had an accepted spawn before failing bootstrap', async () => {
    allowConsoleLogs();
    const teamName = 'resume-keep-team';
    const leadSessionId = 'lead-session-keep';
    const acceptedAt = '2026-04-14T12:00:00.000Z';
    writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice']);
    writeLaunchState(teamName, leadSessionId, {
      alice: {
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        firstSpawnAcceptedAt: acceptedAt,
        hardFailureReason: 'Teammate did not join within the launch grace window.',
      },
    });

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    vi.mocked(spawnCli).mockImplementation(() => {
      throw new Error('launch spawn EINVAL');
    });

    const svc = new TeamProvisioningService(undefined, undefined, undefined, undefined, {
      writeConfigFile: vi.fn(async () => '/mock/mcp-config-launch.json'),
      removeConfigFile: vi.fn(async () => {}),
    } as any);
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice' }],
      source: 'members-meta',
      warning: undefined,
    }));
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async (targetPath: string) =>
      targetPath.endsWith(`${leadSessionId}.jsonl`)
    );

    await expect(svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {})).rejects.toThrow(
      'launch spawn EINVAL'
    );

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain('--resume');
    expect(launchArgs).toContain(leadSessionId);
  });
});
