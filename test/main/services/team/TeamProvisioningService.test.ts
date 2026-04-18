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

vi.mock('@features/tmux-installer/main', () => ({
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
  listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
  isTmuxRuntimeReadyForCurrentPlatform: vi.fn(async () => true),
}));

vi.mock('pidusage', () => {
  const pidusageMock = vi.fn();
  return {
    default: pidusageMock,
  };
});

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
import {
  clearAutoResumeService,
  getAutoResumeService,
  initializeAutoResumeService,
} from '@main/services/team/AutoResumeService';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { getTeamLaunchStatePath } from '@main/services/team/TeamLaunchStateStore';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { spawnCli } from '@main/utils/childProcess';
import { encodePath } from '@main/utils/pathDecoder';
import { AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES } from 'agent-teams-controller';
import { listTmuxPanePidsForCurrentPlatform } from '@features/tmux-installer/main';
import pidusage from 'pidusage';

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

function createPidusageStat(pid: number, memory: number) {
  return {
    cpu: 0,
    memory,
    ppid: 1,
    pid,
    ctime: 0,
    elapsed: 0,
    timestamp: Date.now(),
  };
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

function createMemberSpawnStatusEntry(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    error: undefined,
    updatedAt: new Date().toISOString(),
    runtimeAlive: false,
    livenessSource: undefined,
    bootstrapConfirmed: false,
    hardFailure: false,
    agentToolAccepted: true,
    firstSpawnAcceptedAt: new Date().toISOString(),
    lastHeartbeatAt: undefined,
    ...overrides,
  };
}

function createMemberSpawnRun(params?: {
  runId?: string;
  teamName?: string;
  startedAt?: string;
  expectedMembers?: string[];
  memberSpawnStatuses?: Map<string, Record<string, unknown>>;
  memberSpawnLeadInboxCursorByMember?: Map<string, { timestamp: string; messageId: string }>;
}) {
  const teamName = params?.teamName ?? 'member-spawn-team';
  const expectedMembers = params?.expectedMembers ?? ['alice'];
  const memberSpawnStatuses =
    params?.memberSpawnStatuses ??
    new Map([
      [
        expectedMembers[0]!,
        createMemberSpawnStatusEntry({
          firstSpawnAcceptedAt: new Date(Date.now() - 5_000).toISOString(),
        }),
      ],
    ]);

  return {
    runId: params?.runId ?? 'run-member-spawn-1',
    teamName,
    startedAt: params?.startedAt ?? new Date(Date.now() - 60_000).toISOString(),
    request: {
      members: [],
    },
    expectedMembers,
    memberSpawnStatuses,
    memberSpawnToolUseIds: new Map(),
    memberSpawnLeadInboxCursorByMember:
      params?.memberSpawnLeadInboxCursorByMember ?? new Map(),
    provisioningOutputParts: [],
    activeToolCalls: new Map(),
    isLaunch: false,
    provisioningComplete: false,
  } as any;
}

function createClaudeLogsRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-logs-1',
    teamName: 'logs-team',
    startedAt: '2026-04-19T10:00:00.000Z',
    isLaunch: false,
    provisioningComplete: true,
    processKilled: false,
    cancelRequested: false,
    timeoutHandle: null,
    fsMonitorHandle: null,
    stallCheckHandle: null,
    silentUserDmForwardClearHandle: null,
    child: null,
    leadActivityState: 'idle',
    activeToolCalls: new Map(),
    pendingDirectCrossTeamSendRefresh: false,
    memberSpawnStatuses: new Map(),
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
    pendingApprovals: new Map(),
    mcpConfigPath: null,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    claudeLogLines: ['[stdout]', 'first line', '[stderr]', 'boom'],
    claudeLogsUpdatedAt: '2026-04-19T10:00:01.000Z',
    progress: {
      updatedAt: '2026-04-19T10:00:01.000Z',
      state: 'ready',
    },
    ...overrides,
  } as any;
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
    clearAutoResumeService();
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

  describe('getClaudeLogs', () => {
    it('retains the last logs after cleanupRun removes the live run', async () => {
      const svc = new TeamProvisioningService();
      const run = createClaudeLogsRun();

      (svc as any).runs.set(run.runId, run);
      (svc as any).aliveRunByTeam.set(run.teamName, run.runId);

      await expect(svc.getClaudeLogs(run.teamName)).resolves.toEqual({
        lines: ['boom', '[stderr]', 'first line', '[stdout]'],
        total: 4,
        hasMore: false,
        updatedAt: '2026-04-19T10:00:01.000Z',
      });

      (svc as any).cleanupRun(run);

      await expect(svc.getClaudeLogs(run.teamName)).resolves.toEqual({
        lines: ['boom', '[stderr]', 'first line', '[stdout]'],
        total: 4,
        hasMore: false,
        updatedAt: '2026-04-19T10:00:01.000Z',
      });
    });

    it('falls back to the persisted lead transcript when no live run exists', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'offline-logs-team';
      const projectPath = '/tmp/offline-logs-project';
      const leadSessionId = 'lead-session-1';
      const projectDir = path.join(tempProjectsBase, encodePath(projectPath));

      writeLaunchConfig(teamName, projectPath, leadSessionId, []);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `${leadSessionId}.jsonl`),
        [
          '{"type":"user","message":{"role":"user","content":"first"}}',
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}',
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"third"}]}}',
        ].join('\n') + '\n',
        'utf8'
      );

      await expect(svc.getClaudeLogs(teamName)).resolves.toEqual({
        lines: [
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"third"}]}}',
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}',
          '{"type":"user","message":{"role":"user","content":"first"}}',
        ],
        total: 3,
        hasMore: false,
        updatedAt: expect.any(String),
      });
    });

    it('clears retained logs when a new run starts for the same team', async () => {
      const svc = new TeamProvisioningService();

      (svc as any).retainedClaudeLogsByTeam.set('logs-team', {
        lines: ['[stdout]', 'stale line'],
        updatedAt: '2026-04-19T10:00:01.000Z',
      });

      (svc as any).resetTeamScopedTransientStateForNewRun('logs-team');

      await expect(svc.getClaudeLogs('logs-team')).resolves.toEqual({
        lines: [],
        total: 0,
        hasMore: false,
      });
    });
  });

  describe('getTeamAgentRuntimeSnapshot', () => {
    it('uses batched pidusage rss values for lead and teammates', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'alice',
          agentId: 'alice@runtime-team',
          tmuxPaneId: '%1',
          backendType: 'tmux',
        },
      ]);
      (svc as any).aliveRunByTeam.set('runtime-team', 'run-1');
      (svc as any).runs.set('run-1', {
        runId: 'run-1',
        child: { pid: 111 },
        request: { model: 'gpt-5.4' },
        processKilled: false,
        cancelRequested: false,
        spawnContext: null,
      });
      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockResolvedValueOnce(new Map([['%1', 222]]));

      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
        '222': createPidusageStat(222, 456_000_000),
      } as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(pidusage).toHaveBeenCalledWith([111, 222], { maxage: 0 });
      expect(snapshot.members['team-lead']).toMatchObject({
        pid: 111,
        rssBytes: 123_000_000,
        runtimeModel: 'gpt-5.4',
      });
      expect(snapshot.members.alice).toMatchObject({
        pid: 222,
        rssBytes: 456_000_000,
        runtimeModel: 'gpt-5.4-mini',
      });
    });

    it('falls back to per-pid pidusage reads when batched sampling fails', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'alice',
          agentId: 'alice@runtime-team',
          tmuxPaneId: '%1',
          backendType: 'tmux',
        },
      ]);
      (svc as any).aliveRunByTeam.set('runtime-team', 'run-1');
      (svc as any).runs.set('run-1', {
        runId: 'run-1',
        child: { pid: 111 },
        request: { model: 'gpt-5.4' },
        processKilled: false,
        cancelRequested: false,
        spawnContext: null,
      });
      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockResolvedValueOnce(new Map([['%1', 222]]));

      vi.mocked(pidusage)
        .mockRejectedValueOnce(new Error('ps: process exited'))
        .mockResolvedValueOnce(createPidusageStat(111, 123_000_000) as any)
        .mockResolvedValueOnce(createPidusageStat(222, 456_000_000) as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(pidusage).toHaveBeenNthCalledWith(1, [111, 222], { maxage: 0 });
      expect(pidusage).toHaveBeenNthCalledWith(2, 111, { maxage: 0 });
      expect(pidusage).toHaveBeenNthCalledWith(3, 222, { maxage: 0 });
      expect(snapshot.members['team-lead']?.rssBytes).toBe(123_000_000);
      expect(snapshot.members.alice?.rssBytes).toBe(456_000_000);
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

  it('seeds the current lead session id immediately when launch resumes an existing session', async () => {
    allowConsoleLogs();
    const teamName = 'resume-seed-session-team';
    const leadSessionId = 'lead-session-seeded';
    writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice']);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    const child = createRunningChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

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
    (svc as any).persistLaunchStateSnapshot = vi.fn(async () => {});
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async (targetPath: string) =>
      targetPath.endsWith(`${leadSessionId}.jsonl`)
    );

    const { runId } = await svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {});

    expect(svc.getCurrentLeadSessionId(teamName)).toBe(leadSessionId);

    await svc.cancelProvisioning(runId);
  });

  it('clears stale team-scoped transient state before starting a new launch run', async () => {
    allowConsoleLogs();
    vi.useFakeTimers();

    const teamName = 'launch-clears-stale-runtime-state';
    const leadSessionId = 'lead-session-stale-state';
    writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice']);

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

    const autoResumeProvisioning = {
      getCurrentRunId: vi.fn(() => 'run-1' as string | null),
      isTeamAlive: vi.fn(() => true),
      sendMessageToTeam: vi.fn(async () => undefined),
    };
    initializeAutoResumeService(autoResumeProvisioning);

    const configManagerModule = await import('@main/services/infrastructure/ConfigManager');
    const configManager = configManagerModule.ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      getAutoResumeService().handleRateLimitMessage(
        teamName,
        "You've hit your limit. Resets in 5 minutes.",
        new Date('2026-04-17T12:00:00.000Z')
      );

      (svc as any).relayedLeadInboxMessageIds.set(teamName, new Set(['stale-msg']));
      (svc as any).liveLeadProcessMessages.set(teamName, [
        {
          from: 'team-lead',
          text: 'Old transient message',
          timestamp: '2026-04-17T12:00:00.000Z',
          read: true,
          source: 'lead_process',
          messageId: 'lead-turn-old-run-1',
        },
      ]);
      (svc as any).pendingTimeouts.set(
        `same-team-deferred:${teamName}`,
        setTimeout(() => undefined, 60_000)
      );

      await expect(svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {})).rejects.toThrow(
        'launch spawn EINVAL'
      );

      expect((svc as any).relayedLeadInboxMessageIds.has(teamName)).toBe(false);
      expect((svc as any).liveLeadProcessMessages.has(teamName)).toBe(false);
      expect((svc as any).pendingTimeouts.has(`same-team-deferred:${teamName}`)).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30 * 1000 + 100);
      expect(autoResumeProvisioning.sendMessageToTeam).not.toHaveBeenCalled();
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('marks persisted bootstrap as failed when member transcript shows an unsupported model error', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-unsupported-model';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    writeLaunchState(teamName, leadSessionId, {
      jack: {
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        firstSpawnAcceptedAt: acceptedAt,
      },
    });

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        teamName,
        type: 'user',
        message: { role: 'user', content: 'Lead bootstrap context' },
      })}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: acceptedAt,
          teamName,
          agentName: 'jack',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "jack".`,
          },
        }),
        JSON.stringify({
          timestamp: errorAt,
          teamName,
          agentName: 'jack',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `API Error: 400 {"type":"error","error":{"type":"api_error","message":"Codex API error (400): {\\"detail\\":\\"The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.\\"}"}}`,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack?.status).toBe('error');
    expect(result.statuses.jack?.launchState).toBe('failed_to_start');
    expect(result.statuses.jack?.error).toContain('gpt-5.2-codex');
    expect(result.statuses.jack?.hardFailureReason).toContain('not supported');
    expect(result.teamLaunchState).toBe('partial_failure');
  });

  it('marks an online teammate bootstrap as failed when transcript shows model unavailability', async () => {
    allowConsoleLogs();
    const teamName = 'zz-live-bootstrap-model-unavailable';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: acceptedAt,
          teamName,
          agentName: 'jack',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "jack".`,
          },
        }),
        JSON.stringify({
          timestamp: errorAt,
          teamName,
          agentName: 'jack',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'API Error: 400 {"detail":"The requested model is not available for your account."}',
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const run = {
      runId: 'run-live-1',
      teamName,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      request: {
        members: [],
      },
      expectedMembers: ['jack'],
      memberSpawnStatuses: new Map([
        [
          'jack',
          {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            error: undefined,
            updatedAt: acceptedAt,
            runtimeAlive: true,
            livenessSource: 'process',
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
            firstSpawnAcceptedAt: acceptedAt,
            lastHeartbeatAt: undefined,
          },
        ],
      ]),
      provisioningOutputParts: [],
      activeToolCalls: new Map(),
      isLaunch: false,
    } as any;

    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(teamName, run.runId);

    await (svc as any).reconcileBootstrapTranscriptFailures(run);

    expect(run.memberSpawnStatuses.get('jack')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(run.memberSpawnStatuses.get('jack')?.error).toContain(
      'requested model is not available'
    );
    expect(run.provisioningOutputParts.join('\n')).toContain('requested model is not available');
  });

  it('marks a persisted online teammate bootstrap as failed when transcript shows model unavailability', async () => {
    allowConsoleLogs();
    const teamName = 'zz-persisted-live-bootstrap-model-unavailable';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    writeLaunchState(teamName, leadSessionId, {
      jack: {
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        firstSpawnAcceptedAt: acceptedAt,
      },
    });

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: acceptedAt,
          teamName,
          agentName: 'jack',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "jack".`,
          },
        }),
        JSON.stringify({
          timestamp: errorAt,
          teamName,
          agentName: 'jack',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'API Error: 400 {"detail":"The requested model is not available for your account."}',
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentNames = vi.fn(() => new Set(['jack']));

    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: true,
    });
    expect(result.statuses.jack?.error).toContain('requested model is not available');
    expect(result.statuses.jack?.hardFailureReason).toContain('requested model is not available');
    expect(result.teamLaunchState).toBe('partial_failure');
  });

  it('does not reprocess already-seen teammate lead inbox messages', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T09:00:00.000Z',
      memberSpawnLeadInboxCursorByMember: new Map([
        [
          'alice',
          {
            timestamp: '2026-04-16T10:00:00.000Z',
            messageId: 'msg-2',
          },
        ],
      ]),
    });

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice',
        text: 'heartbeat',
        timestamp: '2026-04-16T10:00:00.000Z',
        messageId: 'msg-1',
        read: false,
      },
      {
        from: 'alice',
        text: 'heartbeat',
        timestamp: '2026-04-16T10:00:00.000Z',
        messageId: 'msg-2',
        read: false,
      },
    ]);

    const applySignalSpy = vi.spyOn(svc as any, 'applyLeadInboxSpawnSignal');

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(applySignalSpy).not.toHaveBeenCalled();
  });

  it('processes an unseen teammate heartbeat on the first refresh', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T09:00:00.000Z',
    });

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice',
        text: '{"type":"heartbeat","timestamp":"2026-04-16T10:00:00.000Z"}',
        timestamp: '2026-04-16T10:00:00.000Z',
        messageId: 'msg-1',
        read: false,
      },
    ]);

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
    });
    expect(run.memberSpawnLeadInboxCursorByMember.get('alice')).toEqual({
      timestamp: '2026-04-16T10:00:00.000Z',
      messageId: 'msg-1',
    });
  });

  it('ignores teammate lead inbox signals that predate the current run', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T10:00:00.000Z',
    });

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice',
        text: '{"type":"heartbeat","timestamp":"2026-04-16T09:59:59.000Z"}',
        timestamp: '2026-04-16T09:59:59.000Z',
        messageId: 'msg-early',
        read: false,
      },
    ]);

    const applySignalSpy = vi.spyOn(svc as any, 'applyLeadInboxSpawnSignal');

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(applySignalSpy).not.toHaveBeenCalled();
    expect(run.memberSpawnLeadInboxCursorByMember.size).toBe(0);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
    });
  });

  it('ignores an unseen older lead inbox signal without replaying older state', async () => {
    const latestHeartbeatAt = '2026-04-16T10:05:00.000Z';
    const existingEntry = createMemberSpawnStatusEntry({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
      bootstrapConfirmed: true,
      lastHeartbeatAt: latestHeartbeatAt,
    });
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T09:00:00.000Z',
      memberSpawnStatuses: new Map([['alice', existingEntry]]),
      memberSpawnLeadInboxCursorByMember: new Map([
        [
          'alice',
          {
            timestamp: latestHeartbeatAt,
            messageId: 'msg-3',
          },
        ],
      ]),
    });
    const svc = new TeamProvisioningService();

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice',
        text: 'Bootstrap failed: unsupported model',
        timestamp: '2026-04-16T10:04:00.000Z',
        messageId: 'msg-2b',
        read: false,
      },
      {
        from: 'alice',
        text: 'heartbeat',
        timestamp: latestHeartbeatAt,
        messageId: 'msg-3',
        read: false,
      },
    ]);

    const applySignalSpy = vi.spyOn(svc as any, 'applyLeadInboxSpawnSignal');

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(applySignalSpy).not.toHaveBeenCalled();
    expect(run.memberSpawnStatuses.get('alice')).toBe(existingEntry);
    expect(run.memberSpawnLeadInboxCursorByMember.get('alice')).toEqual({
      timestamp: latestHeartbeatAt,
      messageId: 'msg-3',
    });
  });

  it('applies an unseen newer failure signal and transitions the member to failed_to_start', async () => {
    const latestHeartbeatAt = '2026-04-16T10:00:00.000Z';
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T09:00:00.000Z',
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            livenessSource: 'heartbeat',
            bootstrapConfirmed: true,
            lastHeartbeatAt: latestHeartbeatAt,
          }),
        ],
      ]),
      memberSpawnLeadInboxCursorByMember: new Map([
        [
          'alice',
          {
            timestamp: latestHeartbeatAt,
            messageId: 'msg-1',
          },
        ],
      ]),
    });
    const svc = new TeamProvisioningService();

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice',
        text: 'Bootstrap failed: unsupported model',
        timestamp: '2026-04-16T10:01:00.000Z',
        messageId: 'msg-2',
        read: false,
      },
    ]);

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(run.memberSpawnLeadInboxCursorByMember.get('alice')).toEqual({
      timestamp: '2026-04-16T10:01:00.000Z',
      messageId: 'msg-2',
    });
  });

  it('applies an unseen same-timestamp signal with a greater messageId and advances the cursor', async () => {
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T09:00:00.000Z',
      memberSpawnLeadInboxCursorByMember: new Map([
        [
          'alice',
          {
            timestamp: '2026-04-16T10:00:00.000Z',
            messageId: 'msg-2',
          },
        ],
      ]),
    });
    const svc = new TeamProvisioningService();

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice',
        text: 'heartbeat',
        timestamp: '2026-04-16T10:00:00.000Z',
        messageId: 'msg-2',
        read: false,
      },
      {
        from: 'alice',
        text: 'heartbeat',
        timestamp: '2026-04-16T10:00:00.000Z',
        messageId: 'msg-3',
        read: false,
      },
    ]);

    const applySignalSpy = vi.spyOn(svc as any, 'applyLeadInboxSpawnSignal');

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(applySignalSpy).toHaveBeenCalledTimes(1);
    expect(applySignalSpy).toHaveBeenCalledWith(
      run,
      'alice',
      expect.objectContaining({ messageId: 'msg-3' })
    );
    expect(run.memberSpawnLeadInboxCursorByMember.get('alice')).toEqual({
      timestamp: '2026-04-16T10:00:00.000Z',
      messageId: 'msg-3',
    });
  });

  it('does not bump lastHeartbeatAt for an equal heartbeat timestamp', () => {
    const existingEntry = createMemberSpawnStatusEntry({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
      bootstrapConfirmed: true,
      lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
    });
    const run = createMemberSpawnRun({
      memberSpawnStatuses: new Map([['alice', existingEntry]]),
    });
    const svc = new TeamProvisioningService();

    (svc as any).setMemberSpawnStatus(
      run,
      'alice',
      'online',
      undefined,
      'heartbeat',
      '2026-04-16T10:00:00.000Z'
    );

    expect(run.memberSpawnStatuses.get('alice')).toBe(existingEntry);
  });

  it('does not bump lastHeartbeatAt for an older heartbeat timestamp', () => {
    const existingEntry = createMemberSpawnStatusEntry({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
      bootstrapConfirmed: true,
      lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
    });
    const run = createMemberSpawnRun({
      memberSpawnStatuses: new Map([['alice', existingEntry]]),
    });
    const svc = new TeamProvisioningService();

    (svc as any).setMemberSpawnStatus(
      run,
      'alice',
      'online',
      undefined,
      'heartbeat',
      '2026-04-16T09:59:59.000Z'
    );

    expect(run.memberSpawnStatuses.get('alice')).toBe(existingEntry);
  });

});
