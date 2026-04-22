import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
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
  execCli: vi.fn(async (_binaryPath: string | null, args: string[]) => {
    if (args[0] === 'model') {
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          providers: {
            anthropic: {
              defaultModel: 'opus[1m]',
              models: [
                { id: 'opus', label: 'Opus 4.7', description: 'Anthropic default family alias' },
                {
                  id: 'opus[1m]',
                  label: 'Opus 4.7 (1M)',
                  description: 'Anthropic long-context default',
                },
              ],
            },
            codex: {
              defaultModel: 'gpt-5.4',
              models: [{ id: 'gpt-5.4', label: 'GPT-5.4', description: 'Codex default' }],
            },
            gemini: {
              defaultModel: 'gemini-2.5-pro',
              models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Default' }],
            },
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'runtime') {
      return {
        stdout: JSON.stringify({
          providers: {
            codex: {
              runtimeCapabilities: {
                modelCatalog: { dynamic: false, source: 'runtime' },
                reasoningEffort: {
                  supported: true,
                  values: ['low', 'medium', 'high'],
                  configPassthrough: false,
                },
              },
            },
          },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }),
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/processKill', () => ({
  killProcessByPid: vi.fn(),
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
import { getTeamBootstrapStatePath } from '@main/services/team/TeamBootstrapStateReader';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { getTeamLaunchStatePath } from '@main/services/team/TeamLaunchStateStore';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime/TeamRuntimeAdapter';
import { spawnCli } from '@main/utils/childProcess';
import { killProcessByPid } from '@main/utils/processKill';
import { encodePath } from '@main/utils/pathDecoder';
import {
  AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
  AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
} from 'agent-teams-controller';
import {
  killTmuxPaneForCurrentPlatformSync,
  listTmuxPanePidsForCurrentPlatform,
} from '@features/tmux-installer/main';
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

function writeBootstrapState(
  teamName: string,
  members: { name: string; status: string; lastAttemptAt?: number; lastObservedAt?: number }[],
  updatedAt = new Date().toISOString()
): void {
  fs.writeFileSync(
    getTeamBootstrapStatePath(teamName),
    `${JSON.stringify(
      {
        version: 1,
        teamName,
        updatedAt,
        phase: 'completed',
        members,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function writeTeamMeta(
  teamName: string,
  overrides: Record<string, unknown> = {}
): void {
  const teamDir = path.join(tempTeamsBase, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: '/Users/test/proj',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        createdAt: Date.now(),
        ...overrides,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function writeMembersMeta(
  teamName: string,
  members: Record<string, unknown>[],
  providerBackendId = 'codex-native'
): void {
  const teamDir = path.join(tempTeamsBase, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        providerBackendId,
        members,
      },
      null,
      2
    )}\n`,
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
    pendingMemberRestarts: new Map(),
    memberSpawnLeadInboxCursorByMember: params?.memberSpawnLeadInboxCursorByMember ?? new Map(),
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

    it('exposes providerBackendId from the live run request when available', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({ providerBackendId: 'adapter' })),
      };
      (svc as any).aliveRunByTeam.set('runtime-team', 'run-1');
      (svc as any).runs.set('run-1', {
        runId: 'run-1',
        child: { pid: 111 },
        request: { model: 'gpt-5.4', providerBackendId: 'codex-native' },
        processKilled: false,
        cancelRequested: false,
        spawnContext: null,
      });
      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
      } as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(snapshot.providerBackendId).toBe('codex-native');
    });

    it('falls back to persisted team meta backend when no live run exists', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({ providerBackendId: 'codex-native' })),
      };

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(snapshot.providerBackendId).toBe('codex-native');
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

    it('falls back to direct agent process lookup when tmux pane pid lookup is unavailable', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.2' },
          ],
        })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'alice',
          agentId: 'alice@nice-team',
          tmuxPaneId: '%0',
          backendType: 'tmux',
        },
      ]);
      (svc as any).aliveRunByTeam.set('nice-team', 'run-1');
      (svc as any).runs.set('run-1', {
        runId: 'run-1',
        child: { pid: 111 },
        request: { model: 'gpt-5.4' },
        processKilled: false,
        cancelRequested: false,
        spawnContext: null,
      });
      (svc as any).readUnixProcessTableRows = vi.fn(() => [
        {
          pid: 333,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id alice@nice-team --agent-name alice --team-name nice-team --model gpt-5.2',
        },
      ]);
      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockResolvedValueOnce(new Map());
      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
        '333': createPidusageStat(333, 456_000_000),
      } as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('nice-team');

      expect(snapshot.members['team-lead']).toMatchObject({
        pid: 111,
        rssBytes: 123_000_000,
      });
      expect(snapshot.members.alice).toMatchObject({
        pid: 333,
        rssBytes: 456_000_000,
        runtimeModel: 'gpt-5.2',
      });
    });

    it('prefers the newest matching agent pid when multiple processes match the same teammate', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.2' },
          ],
        })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'alice',
          agentId: 'alice@nice-team',
          tmuxPaneId: '%0',
          backendType: 'tmux',
        },
      ]);
      (svc as any).aliveRunByTeam.set('nice-team', 'run-1');
      (svc as any).runs.set('run-1', {
        runId: 'run-1',
        child: { pid: 111 },
        request: { model: 'gpt-5.4' },
        processKilled: false,
        cancelRequested: false,
        spawnContext: null,
      });
      (svc as any).readUnixProcessTableRows = vi.fn(() => [
        {
          pid: 222,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id alice@nice-team --agent-name alice --team-name nice-team --model gpt-5.2',
        },
        {
          pid: 333,
          command:
            '/Users/belief/.bun/bin/bun cli.js --team-name nice-team --agent-id alice@nice-team --agent-name alice --model gpt-5.2',
        },
      ]);
      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockResolvedValueOnce(new Map());
      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
        '333': createPidusageStat(333, 456_000_000),
      } as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('nice-team');

      expect(snapshot.members.alice).toMatchObject({
        pid: 333,
        rssBytes: 456_000_000,
      });
    });

    it('excludes removed meta members from runtime snapshot candidate members', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            removedAt: Date.now(),
          },
        ]),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => null),
      };
      vi.mocked(pidusage).mockResolvedValueOnce({} as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(snapshot.members.alice).toBeUndefined();
    });

    it('excludes removed meta members from live runtime metadata resolution', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            agentId: 'alice@runtime-team',
            removedAt: Date.now(),
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'alice',
          agentId: 'alice@runtime-team',
          backendType: 'tmux',
          tmuxPaneId: '%1',
        },
      ]);

      const metadata = await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team');

      expect(metadata.has('alice')).toBe(false);
    });

    it('uses config runtime identity to detect live codex teammates when no persisted launch snapshot exists', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            {
              name: 'alice',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
              agentId: 'alice@signal-ops-6',
              backendType: 'tmux',
              tmuxPaneId: '%0',
            },
            {
              name: 'atlas',
              providerId: 'codex',
              model: 'gpt-5.3-codex',
              agentId: 'atlas@signal-ops-6',
              backendType: 'tmux',
              tmuxPaneId: '%1',
            },
          ],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
          },
          {
            name: 'atlas',
            providerId: 'codex',
            model: 'gpt-5.3-codex',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).findLiveProcessPidByAgentId = vi.fn(
        () =>
          new Map([
            ['alice@signal-ops-6', 17527],
            ['atlas@signal-ops-6', 17528],
          ])
      );
      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockResolvedValueOnce(new Map());

      const metadata = await (svc as any).getLiveTeamAgentRuntimeMetadata('signal-ops-6');

      expect(metadata.get('alice')).toMatchObject({
        alive: true,
        agentId: 'alice@signal-ops-6',
        backendType: 'tmux',
        tmuxPaneId: '%0',
        pid: 17527,
        model: 'gpt-5.4-mini',
      });
      expect(metadata.get('atlas')).toMatchObject({
        alive: true,
        agentId: 'atlas@signal-ops-6',
        backendType: 'tmux',
        tmuxPaneId: '%1',
        pid: 17528,
        model: 'gpt-5.3-codex',
      });
    });

    it('does not let removed base member metadata hide an active suffixed member', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice-2', providerId: 'codex', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            removedAt: Date.now(),
          },
        ]),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => null),
      };
      vi.mocked(pidusage).mockResolvedValueOnce({} as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(snapshot.members['alice-2']).toMatchObject({
        memberName: 'alice-2',
        runtimeModel: 'gpt-5.4-mini',
      });
      expect(snapshot.members.alice).toBeUndefined();
    });

    it('shows RSS for OpenCode secondary lanes through the shared runtime host without exposing a member pid', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', providerId: 'codex', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
        ]),
      };
      const run = createMemberSpawnRun({
        runId: 'run-1',
        teamName: 'runtime-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.request = { providerId: 'codex', model: 'gpt-5.4', members: [] };
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
          runId: 'secondary-run-1',
          state: 'finished',
          result: {
            runId: 'secondary-run-1',
            teamName: 'runtime-team',
            launchPhase: 'active',
            teamLaunchState: 'partial_pending',
            members: {
              bob: {
                memberName: 'bob',
                providerId: 'opencode',
                launchState: 'runtime_pending_bootstrap',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: false,
                hardFailure: false,
                runtimePid: 333,
                diagnostics: [],
              },
            },
            warnings: [],
            diagnostics: [],
          },
          warnings: [],
          diagnostics: [],
        },
      ];
      (svc as any).aliveRunByTeam.set('runtime-team', 'run-1');
      (svc as any).runs.set('run-1', run);
      vi.mocked(pidusage).mockReset();
      vi
        .mocked(pidusage)
        .mockImplementation(async (target: number | string | Array<number | string>) => {
          if (Array.isArray(target)) {
            return {
              '111': createPidusageStat(111, 123_000_000),
            } as any;
          }
        if (target === 333) {
          return createPidusageStat(333, 456_000_000) as any;
        }
        if (target === 111) {
          return createPidusageStat(111, 123_000_000) as any;
        }
        throw new Error(`Unexpected pidusage target: ${String(target)}`);
      });

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(pidusage).toHaveBeenCalledWith([111, 333], { maxage: 0 });
      expect(pidusage).toHaveBeenCalledWith(333, { maxage: 0 });
      expect(snapshot.members.bob).toMatchObject({
        memberName: 'bob',
        alive: true,
        restartable: false,
        pid: 333,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: 456_000_000,
      });
    });
  });

  describe('restartMember', () => {
    it('uses members meta runtime settings when config members are stale or absent', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'edited-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              livenessSource: 'heartbeat',
              firstSpawnAcceptedAt: new Date().toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Edited Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            role: 'Reviewer',
            workflow: 'Use checklist',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            effort: 'high',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('edited-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('edited-team', 'alice');

      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
      const restartCall = sendMessageToRun.mock.calls[0] as unknown as
        | [unknown, string]
        | undefined;
      const restartMessage = restartCall?.[1] ?? '';
      expect(restartMessage).toContain('provider="codex"');
      expect(restartMessage).toContain('model="gpt-5.4-mini"');
      expect(restartMessage).toContain('effort="high"');
      expect(restartMessage).toContain('with role "Reviewer"');
      expect(restartMessage).toContain('Their workflow: Use checklist');
    });

    it('re-reads teammate runtime settings immediately before respawn so stale edit snapshots are not reused', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'edited-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              livenessSource: 'heartbeat',
              firstSpawnAcceptedAt: new Date().toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      const getConfig = vi.fn().mockResolvedValue({
        name: 'Edited Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      });
      const getMembers = vi
        .fn()
        .mockResolvedValueOnce([
          {
            name: 'alice',
            role: 'Reviewer',
            workflow: 'Use checklist',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            effort: 'high',
            agentType: 'general-purpose',
          },
        ])
        .mockResolvedValueOnce([
          {
            name: 'alice',
            role: 'Approver',
            workflow: 'Use the updated checklist',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]);

      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = { getConfig };
      (svc as any).membersMetaStore = { getMembers };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('edited-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('edited-team', 'alice');

      expect(getMembers).toHaveBeenCalledTimes(2);
      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
      const restartCall = sendMessageToRun.mock.calls[0] as unknown as
        | [unknown, string]
        | undefined;
      const restartMessage = restartCall?.[1] ?? '';
      expect(restartMessage).toContain('provider="codex"');
      expect(restartMessage).toContain('model="gpt-5.4"');
      expect(restartMessage).toContain('effort="medium"');
      expect(restartMessage).toContain('with role "Approver"');
      expect(restartMessage).toContain('Their workflow: Use the updated checklist');
    });

    it('does not let removed base-member metadata override a suffixed teammate during restart', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'edited-team',
        expectedMembers: ['alice-2'],
        memberSpawnStatuses: new Map([
          [
            'alice-2',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              livenessSource: 'heartbeat',
              firstSpawnAcceptedAt: new Date().toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Edited Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            removedAt: Date.now(),
          },
          {
            name: 'alice-2',
            role: 'Reviewer',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            effort: 'high',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('edited-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('edited-team', 'alice-2');

      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
      const restartCall = sendMessageToRun.mock.calls[0] as unknown as
        | [unknown, string]
        | undefined;
      const restartMessage = restartCall?.[1] ?? '';
      expect(restartMessage).toContain('provider="codex"');
      expect(restartMessage).toContain('model="gpt-5.4-mini"');
      expect(restartMessage).toContain('effort="high"');
      expect(restartMessage).not.toContain('nemotron-3-super-free');
    });

  it('requires the OpenCode runtime adapter before restarting a secondary-lane teammate', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:alice',
          providerId: 'opencode',
          member: {
            name: 'alice',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: 'opencode-run-1',
          state: 'launching',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Mixed Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({ providerId: 'codex' })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('mixed-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await expect(svc.restartMember('mixed-team', 'alice')).rejects.toThrow(
        'OpenCode runtime adapter is not available for controlled lane reattach.'
      );
    });

  it('still allows restarting a primary-lane teammate when another mixed secondary lane exists', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: 'opencode-run-1',
          state: 'launching',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Mixed Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'high',
            agentType: 'general-purpose',
          },
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({ providerId: 'codex' })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('mixed-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('mixed-team', 'alice');

      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
      expect(run.pendingMemberRestarts.has('alice')).toBe(true);
    });

    it('aborts restart if the teammate is removed before respawn is requested', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'edited-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              livenessSource: 'heartbeat',
              firstSpawnAcceptedAt: new Date().toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      const getConfig = vi.fn().mockResolvedValue({
        name: 'Edited Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      });
      const getMembers = vi
        .fn()
        .mockResolvedValueOnce([
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            effort: 'high',
            agentType: 'general-purpose',
          },
        ])
        .mockResolvedValueOnce([
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            effort: 'high',
            agentType: 'general-purpose',
            removedAt: new Date().toISOString(),
          },
        ]);

      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = { getConfig };
      (svc as any).membersMetaStore = { getMembers };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('edited-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await expect(svc.restartMember('edited-team', 'alice')).rejects.toThrow(
        'Member "alice" was removed while restart was in progress'
      );

      expect(sendMessageToRun).not.toHaveBeenCalled();
      expect(run.pendingMemberRestarts.has('alice')).toBe(false);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'offline',
        launchState: 'starting',
        runtimeAlive: false,
      });
    });

    it('aborts restart if team config disappears before respawn is requested', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'edited-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              livenessSource: 'heartbeat',
              firstSpawnAcceptedAt: new Date().toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      const getConfig = vi
        .fn()
        .mockResolvedValueOnce({
          name: 'Edited Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })
        .mockResolvedValueOnce(null);
      const getMembers = vi.fn(async () => [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'high',
          agentType: 'general-purpose',
        },
      ]);

      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = { getConfig };
      (svc as any).membersMetaStore = { getMembers };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('edited-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await expect(svc.restartMember('edited-team', 'alice')).rejects.toThrow(
        'Team "edited-team" configuration disappeared while restart was in progress'
      );

      expect(sendMessageToRun).not.toHaveBeenCalled();
      expect(run.pendingMemberRestarts.has('alice')).toBe(false);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'offline',
        launchState: 'starting',
        runtimeAlive: false,
      });
    });

    it('treats duplicate_skipped already_running as a failed codex restart because the old runtime is still active', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Codex Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.2',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('codex-team', 'bob');

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
      });
      expect(sendMessageToRun).toHaveBeenCalledWith(
        run,
        expect.stringContaining('provider="codex", model="gpt-5.2", effort="medium"')
      );

      run.activeToolCalls.set('tool-agent-1', {
        memberName: 'bob',
        toolUseId: 'tool-agent-1',
        toolName: 'Agent',
        preview: 'Spawn teammate bob',
        startedAt: new Date().toISOString(),
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-agent-1', 'bob');

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-agent-1',
        [
          {
            type: 'text',
            text: 'status: duplicate_skipped\nreason: already_running\nname: bob\nteam_name: codex-team',
          },
        ],
        false
      );

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        hardFailure: true,
        hardFailureReason:
          'Restart for teammate "bob" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
      });
      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
    });

    it('keeps a codex teammate restart pending instead of failed when lead reports duplicate_skipped bootstrap_pending', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      (svc as any).sendMessageToRun = vi.fn(async () => {});
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Codex Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.2',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('codex-team', 'bob');

      run.activeToolCalls.set('tool-agent-1', {
        memberName: 'bob',
        toolUseId: 'tool-agent-1',
        toolName: 'Agent',
        preview: 'Spawn teammate bob',
        startedAt: new Date().toISOString(),
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-agent-1', 'bob');

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-agent-1',
        [
          {
            type: 'text',
            text: 'status: duplicate_skipped\nreason: bootstrap_pending\nname: bob\nteam_name: codex-team',
          },
        ],
        false
      );

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        agentToolAccepted: true,
        hardFailure: false,
        hardFailureReason: undefined,
      });
      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
    });

    it('fails a codex teammate restart immediately when Agent returns duplicate_skipped without a reason', async () => {
      allowConsoleLogs();
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['jack'],
        memberSpawnStatuses: new Map([
          [
            'jack',
            createMemberSpawnStatusEntry({
              launchState: 'failed_to_start',
              hardFailure: true,
              hardFailureReason: 'Teammate was never spawned during launch.',
              error: 'Teammate was never spawned during launch.',
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      (svc as any).sendMessageToRun = vi.fn(async () => {});
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Codex Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'jack',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('codex-team', 'jack');

      run.activeToolCalls.set('tool-agent-1', {
        memberName: 'jack',
        toolUseId: 'tool-agent-1',
        toolName: 'Agent',
        preview: 'Spawn teammate jack',
        startedAt: new Date().toISOString(),
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-agent-1', 'jack');

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-agent-1',
        [
          {
            type: 'text',
            text: 'status: duplicate_skipped\nname: jack\nteam_name: codex-team',
          },
        ],
        false
      );

      expect(run.pendingMemberRestarts.has('jack')).toBe(false);
      expect(run.memberSpawnStatuses.get('jack')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        hardFailure: true,
        hardFailureReason:
          'Restart for teammate "jack" could not be confirmed and may not have applied. Agent returned duplicate_skipped without a reason.',
      });
    });

    it('waits for a killed tmux pane to disappear before sending a restart request', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'tmux-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Tmux Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'forge',
          agentId: 'forge@tmux-team',
          backendType: 'tmux',
          tmuxPaneId: '%2',
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('tmux-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      vi.mocked(listTmuxPanePidsForCurrentPlatform)
        .mockResolvedValueOnce(new Map([['%2', 999]]))
        .mockResolvedValueOnce(new Map());

      const restartPromise = svc.restartMember('tmux-team', 'forge');
      await Promise.resolve();

      expect(sendMessageToRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await restartPromise;

      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
    });

    it('uses secondary-lane pending copy instead of bootstrap-only pending copy for mixed teams', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              runtimeAlive: true,
              bootstrapConfirmed: true,
            }),
          ],
        ]),
      });
      run.isLaunch = true;
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: 'opencode-run-1',
          state: 'launching',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      const message = (svc as any).buildAggregatePendingLaunchMessage(
        'Finishing launch',
        run,
        {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        {
          version: 2,
          teamName: 'mixed-team',
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'starting',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_pending',
        }
      );

      expect(message).toBe('Finishing launch - waiting for secondary runtime lane: bob');
    });

    it('treats missing secondary-lane snapshot members as still pending', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              runtimeAlive: true,
              bootstrapConfirmed: true,
            }),
          ],
        ]),
      });
      run.isLaunch = true;
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: 'opencode-run-1',
          state: 'launching',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      const message = (svc as any).buildAggregatePendingLaunchMessage(
        'Finishing launch',
        run,
        {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        {
          version: 2,
          teamName: 'mixed-team',
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_pending',
        }
      );

      expect(message).toBe('Finishing launch - waiting for secondary runtime lane: bob');
    });

    it('uses permission-pending copy when the remaining mixed-team member is awaiting approval', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              runtimeAlive: true,
              bootstrapConfirmed: true,
            }),
          ],
        ]),
      });
      run.isLaunch = true;
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: 'opencode-run-1',
          state: 'launching',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      const message = (svc as any).buildAggregatePendingLaunchMessage(
        'Finishing launch',
        run,
        {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
        {
          version: 2,
          teamName: 'mixed-team',
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'runtime_pending_permission',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: false,
              hardFailure: false,
              pendingPermissionRequestIds: ['perm-1'],
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 1,
          },
          teamLaunchState: 'partial_pending',
        }
      );

      expect(message).toBe('Finishing launch — 1 teammate awaiting permission approval');
    });

    it('keeps launch pending when the only remaining teammate is permission-blocked but already online', () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'runtime_pending_permission',
              runtimeAlive: true,
              agentToolAccepted: true,
              bootstrapConfirmed: false,
              pendingPermissionRequestIds: ['perm-1'],
            }),
          ],
        ]),
      });
      const launchSummary = (svc as any).getMemberLaunchSummary(run);

      expect((svc as any).hasPendingLaunchMembers(run, launchSummary, null)).toBe(true);
      expect((svc as any).buildPendingBootstrapStatusMessage('Finishing launch', run, launchSummary)).toBe(
        'Finishing launch — 1 teammate awaiting permission approval'
      );
    });

    it('trusts persisted snapshot permission state for pure teams when live run statuses are absent', () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'pure-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map(),
      });

      const message = (svc as any).buildAggregatePendingLaunchMessage(
        'Finishing launch',
        run,
        {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
        {
          version: 2,
          teamName: 'pure-team',
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['alice'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'opencode',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'opencode',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: false,
              hardFailure: false,
              pendingPermissionRequestIds: ['perm-1'],
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 0,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 1,
          },
          teamLaunchState: 'partial_pending',
        }
      );

      expect(message).toBe('Finishing launch — 1 teammate awaiting permission approval');
    });

    it('launches the OpenCode secondary lane with side-lane provider and member runtime identity', async () => {
      const svc = new TeamProvisioningService();
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => ({
        runId: String(input.runId),
        teamName: String(input.teamName),
        launchPhase: 'finished',
        teamLaunchState: 'clean_success',
        members: {
          bob: {
            memberName: 'bob',
            providerId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            diagnostics: [],
          },
        },
        warnings: [],
        diagnostics: [],
      }));

      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: adapterLaunch,
          reconcile: vi.fn(),
          stop: vi.fn(),
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };

      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              runtimeAlive: true,
              bootstrapConfirmed: true,
            }),
          ],
        ]),
      });
      run.isLaunch = true;
      run.request = {
        teamName: 'mixed-team',
        cwd: '/tmp/mixed-team',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        skipPermissions: true,
      };
      run.effectiveMembers = [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.4',
          effort: 'high',
        },
      ];
      run.detectedSessionId = 'lead-session-1';
      run.launchIdentity = null;
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: null,
          state: 'queued',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(() => {
        expect(adapterLaunch).toHaveBeenCalledTimes(1);
      });
      expect(adapterLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          effort: 'medium',
          cwd: '/tmp/mixed-team',
          expectedMembers: [
            expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
              effort: 'medium',
              cwd: '/tmp/mixed-team',
            }),
          ],
        })
      );
    });

    it('starts all queued OpenCode secondary lanes without letting the first in-flight lane block its siblings', async () => {
      const svc = new TeamProvisioningService();
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      const persistLaunchStateSnapshot = vi
        .spyOn(svc as any, 'persistLaunchStateSnapshot')
        .mockResolvedValue(null);

      let resolveFirstLaunch: () => void = () => {};
      const firstLaunch = new Promise<void>((resolve) => {
        resolveFirstLaunch = resolve;
      });
      const launchSingleMixedSecondaryLane = vi
        .spyOn(svc as any, 'launchSingleMixedSecondaryLane')
        .mockImplementationOnce(async () => {
          await firstLaunch;
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
      });
      run.isLaunch = true;
      run.request = {
        teamName: 'mixed-team',
        cwd: '/tmp/mixed-team',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        skipPermissions: true,
      };
      run.effectiveMembers = [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.4',
          effort: 'high',
        },
      ];
      run.mixedSecondaryLanes = [
        {
          laneId: 'secondary:opencode:tom',
          providerId: 'opencode',
          member: {
            name: 'tom',
            role: 'Developer',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            effort: 'medium',
          },
          runId: null,
          state: 'queued',
          result: null,
          warnings: [],
          diagnostics: [],
        },
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          runId: null,
          state: 'queued',
          result: null,
          warnings: [],
          diagnostics: [],
        },
        {
          laneId: 'secondary:opencode:jack',
          providerId: 'opencode',
          member: {
            name: 'jack',
            role: 'Developer',
            providerId: 'opencode',
            model: 'ling-2.6-flash-free',
            effort: 'medium',
          },
          runId: null,
          state: 'queued',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ];

      const resultPromise = (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await Promise.resolve();
      await Promise.resolve();

      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(3);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'launching',
        'launching',
        'launching',
      ]);

      await expect(resultPromise).resolves.toBeNull();
      expect(persistLaunchStateSnapshot).toHaveBeenCalledTimes(1);

      resolveFirstLaunch();
      await Promise.resolve();
    });

    it('preserves mixed lane metadata when OpenCode runtime liveness updates a secondary lane member', async () => {
      const svc = new TeamProvisioningService();
      const previousSnapshot = {
        version: 2 as const,
        teamName: 'mixed-team',
        updatedAt: '2026-04-22T12:00:00.000Z',
        launchPhase: 'active' as const,
        expectedMembers: ['alice', 'bob'],
        bootstrapExpectedMembers: ['alice'],
        members: {
          alice: {
            name: 'alice',
            providerId: 'codex' as const,
            laneId: 'primary',
            laneKind: 'primary' as const,
            laneOwnerProviderId: 'codex' as const,
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
          bob: {
            name: 'bob',
            providerId: 'opencode' as const,
            model: 'minimax-m2.5-free',
            effort: 'medium' as const,
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary' as const,
            laneOwnerProviderId: 'opencode' as const,
            launchIdentity: {
              providerId: 'opencode' as const,
              providerBackendId: null,
              selectedModel: 'minimax-m2.5-free',
              selectedModelKind: 'explicit' as const,
              resolvedLaunchModel: 'minimax-m2.5-free',
              catalogId: 'minimax-m2.5-free',
              catalogSource: 'runtime' as const,
              catalogFetchedAt: '2026-04-22T12:00:00.000Z',
              selectedEffort: 'medium' as const,
              resolvedEffort: 'medium' as const,
              selectedFastMode: null,
              resolvedFastMode: null,
              fastResolutionReason: null,
            },
            launchState: 'runtime_pending_bootstrap' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
        teamLaunchState: 'partial_pending' as const,
      };
      const write = vi.fn(async () => {});

      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write,
      };

      await (svc as any).updateOpenCodeRuntimeMemberLiveness({
        teamName: 'mixed-team',
        runId: 'run-member-spawn-1',
        memberName: 'bob',
        runtimeSessionId: 'session-bob',
        observedAt: '2026-04-22T12:05:00.000Z',
        diagnostics: ['native heartbeat'],
        reason: 'OpenCode runtime heartbeat accepted',
      });

      expect(write).toHaveBeenCalledTimes(1);
      const writtenSnapshot = (write.mock.calls[0] as unknown as [string, Record<string, unknown>] | undefined)?.[1] as
        | { members?: Record<string, unknown> }
        | undefined;
      expect(writtenSnapshot?.members?.bob).toMatchObject({
        name: 'bob',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
        effort: 'medium',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchIdentity: {
          providerId: 'opencode',
          selectedModel: 'minimax-m2.5-free',
          resolvedLaunchModel: 'minimax-m2.5-free',
        },
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
    });

    it('accepts secondary OpenCode lane evidence using the lane run id instead of the lead run id', async () => {
      const svc = new TeamProvisioningService();

      (svc as any).aliveRunByTeam.set('mixed-team', 'lead-run');
      (svc as any).runs.set('lead-run', {
        runId: 'lead-run',
        teamName: 'mixed-team',
        request: {
          providerId: 'codex',
        },
      });
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'mixed-team',
        runId: 'opencode-run-1',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/tmp/mixed-team',
      });

      await expect(
        (svc as any).assertOpenCodeRuntimeEvidenceAccepted({
          teamName: 'mixed-team',
          runId: 'opencode-run-1',
          laneId: 'secondary:opencode:bob',
          evidenceKind: 'heartbeat',
        })
      ).resolves.toBeUndefined();
    });

    it('uses the secondary lane run id for OpenCode runtime delivery journal acceptance', async () => {
      const svc = new TeamProvisioningService();
      const delivered = new Map<string, { kind: 'member_inbox'; teamName: string; memberName: string; messageId: string }>();

      (svc as any).aliveRunByTeam.set('mixed-team', 'lead-run');
      (svc as any).runs.set('lead-run', {
        runId: 'lead-run',
        teamName: 'mixed-team',
        request: {
          providerId: 'codex',
        },
      });
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'mixed-team',
        runId: 'opencode-run-1',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/tmp/mixed-team',
      });
      (svc as any).createOpenCodeRuntimeDeliveryPorts = vi.fn(() => [
        {
          kind: 'member_inbox',
          write: vi.fn(async ({ envelope, destinationMessageId }) => {
            const location = {
              kind: 'member_inbox' as const,
              teamName: envelope.teamName,
              memberName:
                typeof envelope.to === 'object' && 'memberName' in envelope.to
                  ? envelope.to.memberName
                  : 'unknown',
              messageId: destinationMessageId,
            };
            delivered.set(destinationMessageId, location);
            return location;
          }),
          verify: vi.fn(async ({ destinationMessageId }) => {
            const location = delivered.get(destinationMessageId) ?? null;
            return {
              found: location !== null,
              location,
              diagnostics: [],
            };
          }),
          buildChangeEvent: vi.fn(() => null),
        },
      ]);

      const delivery = (svc as any).createOpenCodeRuntimeDeliveryService(
        'mixed-team',
        'secondary:opencode:bob'
      );
      const ack = await delivery.deliver({
        idempotencyKey: 'delivery-1',
        runId: 'opencode-run-1',
        teamName: 'mixed-team',
        fromMemberName: 'bob',
        providerId: 'opencode',
        runtimeSessionId: 'session-bob',
        to: { memberName: 'alice' },
        text: 'hi',
        createdAt: '2026-04-22T12:05:00.000Z',
      });

      expect(ack).toMatchObject({
        ok: true,
        delivered: true,
        reason: null,
      });
    });

    it('recovers OpenCode delivery journals from canonical launch snapshot when lane index is missing', async () => {
      const svc = new TeamProvisioningService();

      (svc as any).launchStateStore = {
        read: vi.fn(async () => ({
          version: 2,
          teamName: 'mixed-team',
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['alice', 'bob', 'tom'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            tom: {
              name: 'tom',
              providerId: 'opencode',
              laneId: 'secondary:opencode:tom',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 2,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 1,
          },
          teamLaunchState: 'partial_pending',
        })),
      };

      await expect(
        (svc as any).getOpenCodeRuntimeRecoveryLaneIds('mixed-team', {})
      ).resolves.toEqual(['secondary:opencode:bob', 'secondary:opencode:tom']);
    });

    it('routes runtime deliveries to the persisted secondary OpenCode lane after in-memory tracking is lost', async () => {
      const svc = new TeamProvisioningService();
      const observedLaneIds: string[] = [];

      (svc as any).launchStateStore = {
        read: vi.fn(async () => ({
          version: 2,
          teamName: 'mixed-team',
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 2,
            pendingCount: 0,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'ready',
        })),
      };
      (svc as any).assertOpenCodeRuntimeEvidenceAccepted = vi.fn(async ({ laneId }) => {
        observedLaneIds.push(`evidence:${laneId}`);
      });
      (svc as any).createOpenCodeRuntimeDeliveryService = vi.fn((_teamName, laneId) => {
        observedLaneIds.push(`delivery:${laneId}`);
        return {
          deliver: vi.fn(async () => ({
            ok: true,
            delivered: true,
            idempotencyKey: 'delivery-1',
            location: {
              kind: 'member_inbox' as const,
              teamName: 'mixed-team',
              memberName: 'alice',
              messageId: 'msg-1',
            },
            reason: null,
          })),
        };
      });

      const ack = await svc.deliverOpenCodeRuntimeMessage({
        idempotencyKey: 'delivery-1',
        teamName: 'mixed-team',
        runId: 'opencode-run-1',
        fromMemberName: 'bob',
        runtimeSessionId: 'session-bob',
        to: { memberName: 'alice' },
        text: 'hi',
        createdAt: '2026-04-22T12:05:00.000Z',
      });

      expect(ack).toMatchObject({
        ok: true,
        state: 'delivered',
        teamName: 'mixed-team',
        runId: 'opencode-run-1',
      });
      expect(observedLaneIds).toEqual([
        'evidence:secondary:opencode:bob',
        'delivery:secondary:opencode:bob',
      ]);
    });

    it('removes lane index entries when mixed secondary lanes are stopped without an OpenCode adapter', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'mixed-team';

      (svc as any).setSecondaryRuntimeRun({
        teamName,
        runId: 'opencode-run-1',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/tmp/mixed-team',
      });
      (svc as any).setSecondaryRuntimeRun({
        teamName,
        runId: 'opencode-run-2',
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: '/tmp/mixed-team',
      });

      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });
      await fsPromises.mkdir(
        path.dirname(
          getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath: tempTeamsBase,
            teamName,
            laneId: 'secondary:opencode:bob',
            fileName: 'opencode-delivery-journal.json',
          })
        ),
        { recursive: true }
      );
      await fsPromises.writeFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempTeamsBase,
          teamName,
          laneId: 'secondary:opencode:bob',
          fileName: 'opencode-delivery-journal.json',
        }),
        '{"records":[]}\n',
        'utf8'
      );

      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
      };

      await (svc as any).stopMixedSecondaryRuntimeLanes(teamName);

      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fsPromises.stat(
          path.dirname(
            getOpenCodeLaneScopedRuntimeFilePath({
              teamsBasePath: tempTeamsBase,
              teamName,
              laneId: 'secondary:opencode:bob',
              fileName: 'opencode-delivery-journal.json',
            })
          )
        )
      ).rejects.toThrow();
    });

    it('clears provider-local lane storage when a single mixed secondary lane is stopped during controlled reattach', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'mixed-team',
        expectedMembers: ['alice'],
      });
      run.request = {
        providerId: 'codex',
        cwd: '/tmp/mixed-team',
        members: [],
      };
      const lane = {
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode' as const,
        member: {
          name: 'bob',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
        },
        runId: 'opencode-run-1',
        state: 'active',
        result: null,
        warnings: [],
        diagnostics: [],
      };

      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName: run.teamName,
        laneId: lane.laneId,
        state: 'active',
      });
      await fsPromises.mkdir(
        path.dirname(
          getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath: tempTeamsBase,
            teamName: run.teamName,
            laneId: lane.laneId,
            fileName: 'opencode-permissions.json',
          })
        ),
        { recursive: true }
      );
      await fsPromises.writeFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempTeamsBase,
          teamName: run.teamName,
          laneId: lane.laneId,
          fileName: 'opencode-permissions.json',
        }),
        '{"requests":[]}\n',
        'utf8'
      );

      await (svc as any).stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch');

      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, run.teamName)).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fsPromises.stat(
          path.dirname(
            getOpenCodeLaneScopedRuntimeFilePath({
              teamsBasePath: tempTeamsBase,
              teamName: run.teamName,
              laneId: lane.laneId,
              fileName: 'opencode-permissions.json',
            })
          )
        )
      ).rejects.toThrow();
      expect(lane.runId).toBeNull();
      expect(lane.state).toBe('finished');
    });

    it('removes the primary lane index entry when a pure OpenCode team is stopped without an adapter', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'opencode-team';

      (svc as any).runtimeAdapterRunByTeam.set(teamName, {
        runId: 'opencode-run-1',
        providerId: 'opencode',
        cwd: '/tmp/opencode-team',
      });
      (svc as any).aliveRunByTeam.set(teamName, 'opencode-run-1');
      (svc as any).provisioningRunByTeam.set(teamName, 'opencode-run-1');
      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
      };

      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      await fsPromises.mkdir(
        path.dirname(
          getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath: tempTeamsBase,
            teamName,
            laneId: 'primary',
            fileName: 'opencode-delivery-journal.json',
          })
        ),
        { recursive: true }
      );
      await fsPromises.writeFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempTeamsBase,
          teamName,
          laneId: 'primary',
          fileName: 'opencode-delivery-journal.json',
        }),
        '{"records":[]}\n',
        'utf8'
      );

      await (svc as any).stopOpenCodeRuntimeAdapterTeam(teamName, 'opencode-run-1');

      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fsPromises.stat(
          path.dirname(
            getOpenCodeLaneScopedRuntimeFilePath({
              teamsBasePath: tempTeamsBase,
              teamName,
              laneId: 'primary',
              fileName: 'opencode-delivery-journal.json',
            })
          )
        )
      ).rejects.toThrow();
      expect((svc as any).runtimeAdapterRunByTeam.has(teamName)).toBe(false);
      expect((svc as any).aliveRunByTeam.has(teamName)).toBe(false);
      expect((svc as any).provisioningRunByTeam.has(teamName)).toBe(false);
    });

    it('clears primary lane storage when OpenCode runtime adapter launch fails', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'opencode-team';
      const adapterLaunch = vi.fn(async () => {
        throw new Error('launch boom');
      });
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: adapterLaunch,
            reconcile: vi.fn(),
            stop: vi.fn(),
          } as any,
        ])
      );

      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      await fsPromises.mkdir(
        path.dirname(
          getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath: tempTeamsBase,
            teamName,
            laneId: 'primary',
            fileName: 'opencode-launch-transaction.json',
          })
        ),
        { recursive: true }
      );
      await fsPromises.writeFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempTeamsBase,
          teamName,
          laneId: 'primary',
          fileName: 'opencode-launch-transaction.json',
        }),
        '{"transactionId":"tx-1"}\n',
        'utf8'
      );

      await expect(
        (svc as any).runOpenCodeTeamRuntimeAdapterLaunch({
          request: {
            teamName,
            cwd: '/tmp/opencode-team',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
            skipPermissions: true,
          },
          members: [
            {
              name: 'alice',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
              effort: 'medium',
            },
          ],
          prompt: 'Launch team',
          onProgress: vi.fn(),
        })
      ).rejects.toThrow('launch boom');

      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fsPromises.stat(
          path.dirname(
            getOpenCodeLaneScopedRuntimeFilePath({
              teamsBasePath: tempTeamsBase,
              teamName,
              laneId: 'primary',
              fileName: 'opencode-launch-transaction.json',
            })
          )
        )
      ).rejects.toThrow();
      expect((svc as any).provisioningRunByTeam.has(teamName)).toBe(false);
    });

    it('does not keep a pure OpenCode team alive when the runtime adapter returns partial_failure', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'opencode-team';
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => ({
        runId: String(input.runId),
        teamName,
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: {
          alice: {
            memberName: 'alice',
            providerId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            diagnostics: ['launch failed'],
          },
        },
        warnings: [],
        diagnostics: ['launch failed'],
      }));
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: adapterLaunch,
            reconcile: vi.fn(),
            stop: vi.fn(),
          } as any,
        ])
      );

      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      await fsPromises.mkdir(
        path.dirname(
          getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath: tempTeamsBase,
            teamName,
            laneId: 'primary',
            fileName: 'opencode-diagnostics.json',
          })
        ),
        { recursive: true }
      );
      await fsPromises.writeFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempTeamsBase,
          teamName,
          laneId: 'primary',
          fileName: 'opencode-diagnostics.json',
        }),
        '{"events":[]}\n',
        'utf8'
      );

      const response = await (svc as any).runOpenCodeTeamRuntimeAdapterLaunch({
        request: {
          teamName,
          cwd: '/tmp/opencode-team',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          effort: 'medium',
          skipPermissions: true,
        },
        members: [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
        ],
        prompt: 'Launch team',
        onProgress: vi.fn(),
      });

      expect(response).toMatchObject({
        runId: expect.any(String),
      });
      expect((svc as any).runtimeAdapterRunByTeam.has(teamName)).toBe(false);
      expect((svc as any).aliveRunByTeam.has(teamName)).toBe(false);
      expect((svc as any).provisioningRunByTeam.has(teamName)).toBe(false);
      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fsPromises.stat(
          path.dirname(
            getOpenCodeLaneScopedRuntimeFilePath({
              teamsBasePath: tempTeamsBase,
              teamName,
              laneId: 'primary',
              fileName: 'opencode-diagnostics.json',
            })
          )
        )
      ).rejects.toThrow();
    });

    it('preserves pending permission request ids for pure OpenCode launch-state members', () => {
      const svc = new TeamProvisioningService();

      const member = (svc as any).toOpenCodePersistedLaunchMember(
        {
          name: 'alice',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          effort: 'medium',
        },
        {
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          hardFailureReason: undefined,
          pendingPermissionRequestIds: [
            'opencode:run-1:perm-1',
            'opencode:run-1:perm-1',
            'opencode:run-1:perm-2',
          ],
          diagnostics: ['waiting for permission approval'],
        }
      );

      expect(member).toMatchObject({
        name: 'alice',
        providerId: 'opencode',
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['opencode:run-1:perm-1', 'opencode:run-1:perm-2'],
        diagnostics: ['waiting for permission approval'],
      });
    });

    it('fails early when the previous tmux pane does not exit before restart', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'tmux-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Tmux Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'forge',
          agentId: 'forge@tmux-team',
          backendType: 'tmux',
          tmuxPaneId: '%2',
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('tmux-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockImplementation(
        async () => new Map([['%2', 999]])
      );

      const restartPromise = expect(svc.restartMember('tmux-team', 'forge')).rejects.toThrow(
        'Restart for teammate "forge" is still waiting for the previous tmux pane to exit (%2).'
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await restartPromise;

      expect(sendMessageToRun).not.toHaveBeenCalled();
    });

    it('still verifies tmux pane exit when pane kill throws, and blocks restart if the pane remains alive', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'tmux-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Tmux Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'forge',
          agentId: 'forge@tmux-team',
          backendType: 'tmux',
          tmuxPaneId: '%2',
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('tmux-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      vi.mocked(killTmuxPaneForCurrentPlatformSync).mockImplementation(() => {
        throw new Error('pane kill failed');
      });
      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockImplementation(
        async () => new Map([['%2', 999]])
      );

      const restartPromise = expect(svc.restartMember('tmux-team', 'forge')).rejects.toThrow(
        'Restart for teammate "forge" is still waiting for the previous tmux pane to exit (%2).'
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await restartPromise;

      expect(sendMessageToRun).not.toHaveBeenCalled();
    });

    it('does not treat tmux pane lookup failures as a successful restart precondition', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'tmux-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Tmux Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'forge',
          agentId: 'forge@tmux-team',
          backendType: 'tmux',
          tmuxPaneId: '%2',
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('tmux-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockRejectedValue(
        new Error('tmux list-panes failed')
      );

      const restartPromise = expect(svc.restartMember('tmux-team', 'forge')).rejects.toThrow(
        'Restart for teammate "forge" could not verify that the previous tmux pane exited: tmux list-panes failed'
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await restartPromise;

      expect(sendMessageToRun).not.toHaveBeenCalled();
    });

    it('treats a dead tmux server as successful pane exit verification after kill', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'tmux-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Tmux Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'forge',
          agentId: 'forge@tmux-team',
          backendType: 'tmux',
          tmuxPaneId: '%2',
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('tmux-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      vi.mocked(listTmuxPanePidsForCurrentPlatform).mockRejectedValue(
        new Error('no server running on /private/tmp/tmux-501/default')
      );

      await svc.restartMember('tmux-team', 'forge');

      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
    });

    it('fails early when the previous process backend runtime does not exit before restart', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'process-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Process Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
        async () =>
          new Map([
            [
              'forge',
              {
                alive: true,
                backendType: 'process',
                pid: process.pid,
                agentId: 'forge@process-team',
              },
            ],
          ])
      );
      (svc as any).aliveRunByTeam.set('process-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      const restartPromise = expect(svc.restartMember('process-team', 'forge')).rejects.toThrow(
        `Restart for teammate "forge" is still waiting for the previous process to exit (${process.pid}).`
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await restartPromise;

      expect(vi.mocked(killProcessByPid)).toHaveBeenCalledWith(process.pid);
      expect(sendMessageToRun).not.toHaveBeenCalled();
    });

    it('bypasses stale live runtime metadata cache before restarting a process backend teammate', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'process-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Process Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'forge',
          agentId: 'forge@process-team',
          backendType: 'process',
        },
      ]);
      (svc as any).findLiveProcessPidByAgentId = vi.fn(
        () => new Map([['forge@process-team', process.pid]])
      );
      (svc as any).liveTeamAgentRuntimeMetadataCache.set('process-team', {
        expiresAtMs: Date.now() + 60_000,
        metadata: new Map([
          [
            'forge',
            {
              alive: false,
              backendType: 'process',
              agentId: 'forge@process-team',
            },
          ],
        ]),
      });
      (svc as any).aliveRunByTeam.set('process-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      const restartPromise = expect(svc.restartMember('process-team', 'forge')).rejects.toThrow(
        `Restart for teammate "forge" is still waiting for the previous process to exit (${process.pid}).`
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await restartPromise;

      expect(vi.mocked(killProcessByPid)).toHaveBeenCalledWith(process.pid);
      expect(sendMessageToRun).not.toHaveBeenCalled();
    });

    it('uses members.meta agentId to detect a live process backend teammate when config runtime identity is stale', async () => {
      vi.useFakeTimers();

      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'process-team',
        expectedMembers: ['forge'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Process Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'forge',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            agentType: 'general-purpose',
            agentId: 'forge@process-team',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).findLiveProcessPidByAgentId = vi.fn(
        () => new Map([['forge@process-team', process.pid]])
      );
      (svc as any).aliveRunByTeam.set('process-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      const restartPromise = expect(svc.restartMember('process-team', 'forge')).rejects.toThrow(
        `Restart for teammate "forge" is still waiting for the previous process to exit (${process.pid}).`
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await restartPromise;

      expect(vi.mocked(killProcessByPid)).toHaveBeenCalledWith(process.pid);
      expect(sendMessageToRun).not.toHaveBeenCalled();
    });

    it('rejects a second restart request while the first restart is still in flight', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map(),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.pendingMemberRestarts.set('bob', {
        requestedAt: new Date().toISOString(),
        desired: {
          name: 'bob',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        },
      });

      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Codex Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.2',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await expect(svc.restartMember('codex-team', 'bob')).rejects.toThrow(
        'Restart for teammate "bob" is already in progress'
      );
    });

    it('clears stale member spawn tool tracking before starting a manual restart', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              firstSpawnAcceptedAt: new Date().toISOString(),
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.activeToolCalls.set('tool-agent-old', {
        memberName: 'bob',
        toolUseId: 'tool-agent-old',
        toolName: 'Agent',
        preview: 'Spawn teammate bob',
        startedAt: new Date().toISOString(),
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-agent-old', 'bob');

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Codex Team',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'codex',
            model: 'gpt-5.2',
            effort: 'medium',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('codex-team', 'bob');

      expect(run.activeToolCalls.has('tool-agent-old')).toBe(false);
      expect(run.memberSpawnToolUseIds.has('tool-agent-old')).toBe(false);
      expect(sendMessageToRun).toHaveBeenCalledTimes(1);

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-agent-old',
        [{ type: 'text', text: 'late stale result' }],
        true
      );

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
      });
      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
    });

    it('marks a pending restart as failed when the teammate never rejoins within the restart grace window', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              firstSpawnAcceptedAt: new Date(Date.now() - 120_000).toISOString(),
            }),
          ],
        ]),
      });
      run.pendingMemberRestarts.set('bob', {
        requestedAt: new Date(Date.now() - 120_000).toISOString(),
        desired: {
          name: 'bob',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        },
      });
      (svc as any).refreshMemberSpawnStatusesFromLeadInbox = vi.fn(async () => {});
      (svc as any).maybeAuditMemberSpawnStatuses = vi.fn(async () => {});

      await (svc as any).reevaluateMemberLaunchStatus(run, 'bob');

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        error: 'Teammate "bob" did not rejoin within the restart grace window.',
        hardFailureReason: 'Teammate "bob" did not rejoin within the restart grace window.',
      });
      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
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

  it('passes official Codex Fast config overrides when launch identity resolves Fast', async () => {
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
      env: { CODEX_API_KEY: 'test' },
      authSource: 'codex_runtime',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);
    (svc as any).resolveAndValidateLaunchIdentity = vi.fn(async () => ({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      selectedModel: 'gpt-5.4',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'gpt-5.4',
      catalogId: 'gpt-5.4',
      catalogSource: 'app-server',
      catalogFetchedAt: '2026-04-21T00:00:00.000Z',
      selectedEffort: 'xhigh',
      resolvedEffort: 'xhigh',
      selectedFastMode: 'on',
      resolvedFastMode: true,
      fastResolutionReason: null,
    }));

    await expect(
      svc.createTeam(
        {
          teamName: 'codex-fast-team',
          cwd: tempClaudeRoot,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'xhigh',
          fastMode: 'on',
          members: [{ name: 'alice' }],
        },
        () => {}
      )
    ).rejects.toThrow('spawn EINVAL');

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toEqual(
      expect.arrayContaining(['-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'])
    );
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

  it('pre-seeds lead bootstrap MCP permissions before createTeam spawn', async () => {
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
      expect.arrayContaining([...AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES])
    );
    expect(settings.permissions?.allow).toContain('mcp__agent-teams__lead_briefing');
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

  it('keeps --resume when a persisted legacy Codex backend normalizes to codex-native', async () => {
    allowConsoleLogs();
    const teamName = 'resume-backend-change-team';
    const leadSessionId = 'lead-session-backend-change';
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
      env: { CODEX_API_KEY: 'test' },
      authSource: 'codex_runtime',
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
    (svc as any).teamMetaStore = {
      getMeta: vi.fn(async () => ({ providerBackendId: 'adapter' })),
      writeMeta: vi.fn(async () => {}),
      deleteMeta: vi.fn(async () => {}),
    };

    await expect(
      svc.launchTeam(
        {
          teamName,
          cwd: tempClaudeRoot,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
        },
        () => {}
      )
    ).rejects.toThrow('launch spawn EINVAL');

    const launchArgs = vi.mocked(spawnCli).mock.calls.at(-1)?.[1] as string[];
    expect(launchArgs).toBeTruthy();
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

  it('treats duplicate_skipped already_running as process-confirmed online', () => {
    const run = createMemberSpawnRun();
    run.activeToolCalls.set('tool-agent-1', {
      memberName: 'alice',
      toolUseId: 'tool-agent-1',
      toolName: 'Agent',
      preview: 'Spawn teammate alice',
      startedAt: new Date().toISOString(),
      state: 'running',
      source: 'runtime',
    });
    run.memberSpawnToolUseIds.set('tool-agent-1', 'alice');

    const svc = new TeamProvisioningService();

    (svc as any).finishRuntimeToolActivity(
      run,
      'tool-agent-1',
      [
        {
          type: 'text',
          text: 'status: duplicate_skipped\nreason: already_running\nname: alice\nteam_name: nice-team',
        },
      ],
      false
    );

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      livenessSource: 'process',
      hardFailure: false,
    });
  });

  it('clears a pending restart when the teammate is confirmed online via process liveness', () => {
    const run = createMemberSpawnRun({
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            firstSpawnAcceptedAt: new Date().toISOString(),
          }),
        ],
      ]),
    });
    run.pendingMemberRestarts.set('alice', {
      requestedAt: new Date().toISOString(),
      desired: {
        name: 'alice',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    });
    const svc = new TeamProvisioningService();

    (svc as any).setMemberSpawnStatus(run, 'alice', 'online', undefined, 'process');

    expect(run.pendingMemberRestarts.has('alice')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      livenessSource: 'process',
    });
  });

  it('treats deterministic already_running as a failed restart when a restart is pending', () => {
    const run = createMemberSpawnRun({
      teamName: 'nice-team',
      expectedMembers: ['alice'],
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            firstSpawnAcceptedAt: new Date().toISOString(),
          }),
        ],
      ]),
    });
    run.pendingMemberRestarts.set('alice', {
      requestedAt: new Date().toISOString(),
      desired: {
        name: 'alice',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    });
    const svc = new TeamProvisioningService();

    const handled = (svc as any).handleDeterministicBootstrapEvent(run, {
      type: 'system',
      subtype: 'team_bootstrap',
      event: 'member_spawn_result',
      member_name: 'alice',
      outcome: 'already_running',
      run_id: run.runId,
      team_name: run.teamName,
      seq: 1,
    });

    expect(handled).toBe(true);
    expect(run.pendingMemberRestarts.has('alice')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason:
        'Restart for teammate "alice" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
    });
  });

  it('clears a pending restart when deterministic spawn reports a hard failure', () => {
    const run = createMemberSpawnRun({
      teamName: 'nice-team',
      expectedMembers: ['alice'],
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            firstSpawnAcceptedAt: new Date().toISOString(),
          }),
        ],
      ]),
    });
    run.pendingMemberRestarts.set('alice', {
      requestedAt: new Date().toISOString(),
      desired: {
        name: 'alice',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    });
    const svc = new TeamProvisioningService();

    const handled = (svc as any).handleDeterministicBootstrapEvent(run, {
      type: 'system',
      subtype: 'team_bootstrap',
      event: 'member_spawn_result',
      member_name: 'alice',
      outcome: 'failed',
      reason: 'spawn failed hard',
      run_id: run.runId,
      team_name: run.teamName,
      seq: 1,
    });

    expect(handled).toBe(true);
    expect(run.pendingMemberRestarts.has('alice')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'spawn failed hard',
    });
  });

  it('clears stale failed_to_start state when live runtime metadata proves the teammate is alive', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              model: 'gpt-5.2',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('beacon-desk-4', {
      bob: createMemberSpawnStatusEntry({
        status: 'error',
        launchState: 'failed_to_start',
        error: 'Teammate did not join within the launch grace window.',
        hardFailure: true,
        hardFailureReason: 'Teammate did not join within the launch grace window.',
      }),
    });

    expect(result.bob).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      runtimeModel: 'gpt-5.2',
      livenessSource: 'process',
    });
  });

  it('does not clear an explicit restart failure just because the old runtime is still alive', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              model: 'gpt-5.3-codex',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('beacon-desk-4', {
      bob: createMemberSpawnStatusEntry({
        status: 'error',
        launchState: 'failed_to_start',
        error:
          'Restart for teammate "bob" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
        hardFailure: true,
        hardFailureReason:
          'Restart for teammate "bob" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
      }),
    });

    expect(result.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: false,
      hardFailure: true,
      hardFailureReason:
        'Restart for teammate "bob" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
      error:
        'Restart for teammate "bob" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
      runtimeModel: 'gpt-5.3-codex',
    });
  });

  it('does not self-clear a failed launch from stale runtimeAlive state when no live pid exists', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      runId: 'run-self-clear-1',
      teamName: 'beacon-desk-4',
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: true,
            livenessSource: 'process',
            bootstrapConfirmed: false,
            hardFailure: true,
            error: 'Teammate did not join within the launch grace window.',
            hardFailureReason: 'Teammate did not join within the launch grace window.',
          }),
        ],
      ]),
    });

    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
    (svc as any).configReader = {
      getConfig: vi.fn(async () => ({
        name: 'Beacon Desk',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          {
            name: 'bob',
            agentType: 'general-purpose',
            providerId: 'codex',
            model: 'gpt-5.3-codex',
          },
        ],
      })),
    };
    (svc as any).membersMetaStore = {
      getMembers: vi.fn(async () => [
        {
          name: 'bob',
          role: 'Developer',
          providerId: 'codex',
          model: 'gpt-5.3-codex',
          effort: 'medium',
          agentType: 'general-purpose',
        },
      ]),
    };
    (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
    (svc as any).findLiveProcessPidByAgentId = vi.fn(() => new Map());

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('beacon-desk-4', {
      bob: createMemberSpawnStatusEntry({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: true,
        livenessSource: 'process',
        bootstrapConfirmed: false,
        hardFailure: true,
        error: 'Teammate did not join within the launch grace window.',
        hardFailureReason: 'Teammate did not join within the launch grace window.',
      }),
    });

    expect(result.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: true,
      hardFailure: true,
      hardFailureReason: 'Teammate did not join within the launch grace window.',
      error: 'Teammate did not join within the launch grace window.',
      runtimeModel: 'gpt-5.3-codex',
    });
  });

  it('does not downgrade an already-online teammate when waiting is reported later', () => {
    const run = createMemberSpawnRun({
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            livenessSource: 'heartbeat',
            bootstrapConfirmed: true,
            lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
          }),
        ],
      ]),
    });
    const svc = new TeamProvisioningService();

    (svc as any).setMemberSpawnStatus(run, 'alice', 'waiting');

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
      bootstrapConfirmed: true,
      lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
    });
  });

  it('clears stale hard failure state when a new spawn attempt starts', () => {
    const staleAcceptedAt = '2026-04-16T10:00:00.000Z';
    const run = createMemberSpawnRun({
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'error',
            launchState: 'failed_to_start',
            error: 'Teammate was never spawned during launch.',
            hardFailure: true,
            hardFailureReason: 'Teammate was never spawned during launch.',
            runtimeAlive: true,
            bootstrapConfirmed: true,
            livenessSource: 'heartbeat',
            firstSpawnAcceptedAt: staleAcceptedAt,
            lastHeartbeatAt: staleAcceptedAt,
          }),
        ],
      ]),
    });
    const svc = new TeamProvisioningService();

    (svc as any).setMemberSpawnStatus(run, 'alice', 'spawning');

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      error: undefined,
      hardFailure: false,
      hardFailureReason: undefined,
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      livenessSource: undefined,
      firstSpawnAcceptedAt: undefined,
      lastHeartbeatAt: undefined,
    });
  });

  it('clears an old member launch grace timer when a new spawn attempt resets acceptance state', () => {
    vi.useFakeTimers();

    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const run = createMemberSpawnRun({
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        ],
      ]),
    });
    const svc = new TeamProvisioningService();
    const timerKey = (svc as any).getMemberLaunchGraceKey(run, 'alice');

    (svc as any).syncMemberLaunchGraceCheck(run, 'alice', run.memberSpawnStatuses.get('alice'));
    expect((svc as any).pendingTimeouts.has(timerKey)).toBe(true);

    (svc as any).setMemberSpawnStatus(run, 'alice', 'offline');
    expect((svc as any).pendingTimeouts.has(timerKey)).toBe(false);

    (svc as any).setMemberSpawnStatus(run, 'alice', 'spawning');
    expect((svc as any).pendingTimeouts.has(timerKey)).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      firstSpawnAcceptedAt: undefined,
      lastHeartbeatAt: undefined,
      error: undefined,
      hardFailureReason: undefined,
      livenessSource: undefined,
    });
  });

  it('reconciles stale never-spawned failures when bootstrap state proves the teammate was registered', async () => {
    const teamName = 'registered-bootstrap-team';
    const leadSessionId = 'lead-session';
    const acceptedAt = new Date(Date.now() - 60_000).toISOString();
    writeLaunchConfig(teamName, '/Users/test/proj', leadSessionId, ['alice']);
    writeLaunchState(teamName, leadSessionId, {
      alice: {
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Teammate was never spawned during launch.',
      },
    });
    writeBootstrapState(
      teamName,
      [
        {
          name: 'alice',
          status: 'registered',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(acceptedAt),
        },
      ],
      new Date(Date.now() - 30_000).toISOString()
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      hardFailure: false,
      hardFailureReason: undefined,
      agentToolAccepted: true,
    });
  });

  it('recovers stale mixed secondary lanes when lanes.json says active but lane state is missing', async () => {
    const teamName = 'signal-ops-6212';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'atlas',
        providerId: 'opencode',
        model: 'opencode/nemotron-3-super-free',
      },
      {
        name: 'bob',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
      {
        name: 'nova',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
      {
        name: 'tom',
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob', 'nova']);
    writeBootstrapState(teamName, [
      { name: 'bob', status: 'registered' },
      { name: 'nova', status: 'registered' },
    ]);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:atlas',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.launchPhase).toBe('reconciled');
    expect(result.expectedMembers).toEqual(expect.arrayContaining(['atlas', 'bob', 'nova', 'tom']));
    expect(result.statuses.atlas).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: expect.stringContaining('no lane state exists on disk'),
    });
    expect(result.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: expect.stringContaining('no lane state exists on disk'),
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:atlas': {
          state: 'degraded',
        },
        'secondary:opencode:tom': {
          state: 'degraded',
        },
      },
    });
    await expect(fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')).resolves.toContain(
      '"secondary:opencode:atlas"'
    );
  });

  it('includes queued OpenCode secondary lanes in live spawn statuses before the final mixed snapshot settles', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'maybeAuditMemberSpawnStatuses').mockResolvedValue(undefined);

    const run = createMemberSpawnRun({
      teamName: 'mixed-live-team',
      runId: 'run-mixed-live-1',
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
            livenessSource: 'heartbeat',
          }),
        ],
      ]),
    });
    run.isLaunch = true;
    run.request = {
      teamName: 'mixed-live-team',
      cwd: '/tmp/mixed-live-team',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      members: [],
    };
    run.effectiveMembers = [
      {
        name: 'bob',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
    ];
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:atlas',
        providerId: 'opencode',
        member: {
          name: 'atlas',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ];
    run.detectedSessionId = 'lead-session';

    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    const result = await svc.getMemberSpawnStatuses(run.teamName);

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.expectedMembers).toEqual(expect.arrayContaining(['bob', 'atlas']));
    expect(result.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(result.statuses.atlas).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
    });
  });

  it('includes queued OpenCode secondary lanes in live spawn statuses during createTeam runs', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'maybeAuditMemberSpawnStatuses').mockResolvedValue(undefined);

    const run = createMemberSpawnRun({
      teamName: 'mixed-create-team',
      runId: 'run-mixed-create-1',
      expectedMembers: ['alice'],
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
            livenessSource: 'heartbeat',
          }),
        ],
      ]),
    });
    run.isLaunch = false;
    run.request = {
      teamName: 'mixed-create-team',
      cwd: '/tmp/mixed-create-team',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      members: [],
    };
    run.effectiveMembers = [
      {
        name: 'alice',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
      },
    ];
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode',
        member: {
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/big-pickle',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
      {
        laneId: 'secondary:opencode:tom',
        providerId: 'opencode',
        member: {
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ];
    run.detectedSessionId = 'lead-session';

    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    const result = await svc.getMemberSpawnStatuses(run.teamName);

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.expectedMembers).toEqual(expect.arrayContaining(['alice', 'bob', 'tom']));
    expect(result.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(result.statuses.bob).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
    });
    expect(result.statuses.tom).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
    });
  });
});
