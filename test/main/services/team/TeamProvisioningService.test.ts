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
  listRuntimeProcessesForCurrentTmuxPlatform: vi.fn(async () => []),
  listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
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
  getOpenCodeRuntimeManifestPath,
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { createDefaultRuntimeStoreManifest } from '@main/services/team/opencode/store/RuntimeStoreManifest';
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
  listRuntimeProcessesForCurrentTmuxPlatform,
  listTmuxPanePidsForCurrentPlatform,
  listTmuxPaneRuntimeInfoForCurrentPlatform,
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

function writeTeamMeta(teamName: string, overrides: Record<string, unknown> = {}): void {
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
    vi.mocked(killTmuxPaneForCurrentPlatformSync).mockReset();
    vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockReset();
    vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValue([]);
    vi.mocked(listTmuxPanePidsForCurrentPlatform).mockReset();
    vi.mocked(listTmuxPanePidsForCurrentPlatform).mockResolvedValue(new Map());
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockReset();
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValue(new Map());
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
      vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValueOnce(
        new Map([
          [
            '%1',
            {
              paneId: '%1',
              panePid: 222,
              currentCommand: 'codex',
            },
          ],
        ])
      );

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
      vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValueOnce(
        new Map([
          [
            '%1',
            {
              paneId: '%1',
              panePid: 222,
              currentCommand: 'codex',
            },
          ],
        ])
      );

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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        {
          pid: 333,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id alice@nice-team --agent-name alice --team-name nice-team --model gpt-5.2',
        },
      ]);
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

    it('keeps RSS visible for bootstrap-confirmed Anthropic teammates with a verified process', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', providerId: 'anthropic', model: 'claude-sonnet-4-6' },
          ],
        })),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'alice',
          agentId: 'alice@nice-team',
          backendType: 'tmux',
        },
      ]);
      const run = createMemberSpawnRun({
        teamName: 'nice-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              runtimeAlive: true,
              bootstrapConfirmed: true,
              lastHeartbeatAt: '2026-04-24T12:00:00.000Z',
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.request = { model: 'claude-opus-4-6' };
      run.processKilled = false;
      run.cancelRequested = false;
      (svc as any).aliveRunByTeam.set('nice-team', run.runId);
      (svc as any).runs.set(run.runId, run);
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        {
          pid: 333,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id alice@nice-team --agent-name alice --team-name nice-team --model claude-sonnet-4-6',
        },
      ]);
      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
        '333': createPidusageStat(333, 456_000_000),
      } as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('nice-team');

      expect(pidusage).toHaveBeenCalledWith([111, 333], { maxage: 0 });
      expect(snapshot.members.alice).toMatchObject({
        alive: true,
        providerId: 'anthropic',
        pid: 333,
        pidSource: 'agent_process_table',
        rssBytes: 456_000_000,
        runtimeModel: 'claude-sonnet-4-6',
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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        {
          pid: 222,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id alice@nice-team --agent-name alice --team-name nice-team --model gpt-5.2',
        },
        {
          pid: 333,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --team-name nice-team --agent-id alice@nice-team --agent-name alice --model gpt-5.2',
        },
      ]);
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

    it('keeps historical bootstrap separate from current runtime liveness', async () => {
      const teamName = 'pure-opencode-runtime-team-strict';
      const projectPath = '/Users/test/project';
      writeLaunchConfig(teamName, projectPath, 'lead-session', ['alice']);
      writeLaunchState(teamName, 'lead-session', {
        alice: {
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          hardFailureReason: undefined,
        },
      });

      const svc = new TeamProvisioningService();
      (svc as any).runtimeAdapterRunByTeam.set(teamName, {
        runId: 'opencode-runtime-run',
        providerId: 'opencode',
        cwd: projectPath,
      });
      (svc as any).aliveRunByTeam.set(teamName, 'opencode-runtime-run');

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(snapshot.members.alice).toMatchObject({
        alive: false,
        historicalBootstrapConfirmed: true,
        providerId: 'opencode',
        runtimeModel: 'opencode/big-pickle',
      });
    });

    it('does not treat a reused OpenCode runtime pid as live', async () => {
      const teamName = 'pure-opencode-reused-pid-team';
      const projectPath = '/Users/test/project';
      writeLaunchConfig(teamName, projectPath, 'lead-session', ['alice']);
      writeLaunchState(teamName, 'lead-session', {
        alice: {
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          hardFailureReason: undefined,
          runtimePid: 333,
          runtimeSessionId: 'session-alice',
        },
      });
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        { pid: 333, ppid: 1, command: 'node unrelated-worker.js' },
      ]);
      vi.mocked(pidusage).mockResolvedValueOnce({
        '333': createPidusageStat(333, 456_000_000),
      } as any);

      const svc = new TeamProvisioningService();
      (svc as any).runtimeAdapterRunByTeam.set(teamName, {
        runId: 'opencode-runtime-run',
        providerId: 'opencode',
        cwd: projectPath,
      });
      (svc as any).aliveRunByTeam.set(teamName, 'opencode-runtime-run');

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(snapshot.members.alice).toMatchObject({
        alive: false,
        livenessKind: 'runtime_process_candidate',
        pidSource: 'opencode_bridge',
        runtimeDiagnostic: 'OpenCode runtime pid is alive, but process identity is unverified',
        pid: 333,
        providerId: 'opencode',
      });
    });

    it('does not carry stale persisted runtimeAlive through launch-state reconcile', async () => {
      const teamName = 'persisted-stale-runtime-status-team';
      const projectPath = '/Users/test/project';
      const acceptedAt = new Date(Date.now() - 120_000).toISOString();
      writeLaunchConfig(teamName, projectPath, 'lead-session', ['alice']);
      writeLaunchState(teamName, 'lead-session', {
        alice: {
          providerId: 'codex',
          model: 'gpt-5.4',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          hardFailureReason: undefined,
          firstSpawnAcceptedAt: acceptedAt,
          runtimePid: 333,
          livenessKind: 'runtime_process',
          pidSource: 'agent_process_table',
        },
      });

      const svc = new TeamProvisioningService();

      const result = await svc.getMemberSpawnStatuses(teamName);
      const persisted = JSON.parse(fs.readFileSync(getTeamLaunchStatePath(teamName), 'utf8'));

      expect(result.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        livenessSource: undefined,
        livenessKind: 'stale_metadata',
        hardFailure: true,
        hardFailureReason: 'Teammate did not join within the launch grace window.',
      });
      expect(result.summary).toMatchObject({
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      });
      expect(persisted.members.alice.runtimeAlive).toBe(false);
      expect(persisted.members.alice.sources?.processAlive).toBeUndefined();
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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        {
          pid: 17527,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id alice@signal-ops-6 --agent-name alice --team-name signal-ops-6 --model gpt-5.4-mini',
        },
        {
          pid: 17528,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --agent-id atlas@signal-ops-6 --agent-name atlas --team-name signal-ops-6 --model gpt-5.3-codex',
        },
      ]);

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

    it('includes persisted launch members that only exist in launchSnapshot.members when expectedMembers is stale', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => []),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => null),
      };
      (svc as any).launchStateStore = {
        read: vi.fn(async () =>
          createPersistedLaunchSnapshot({
            teamName: 'runtime-team',
            leadSessionId: 'lead-session',
            launchPhase: 'active',
            expectedMembers: ['alice'],
            members: {
              bob: {
                name: 'bob',
                providerId: 'codex',
                providerBackendId: 'codex-native',
                model: 'gpt-5.4-mini',
                effort: 'high',
                launchState: 'runtime_pending_bootstrap',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          })
        ),
      };
      vi.mocked(pidusage).mockResolvedValueOnce({} as any);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(snapshot.members.bob).toMatchObject({
        memberName: 'bob',
        runtimeModel: 'gpt-5.4-mini',
        providerBackendId: 'codex-native',
      });
    });

    it('shows RSS for OpenCode secondary lane host pids without treating pre-bootstrap runtime as alive', async () => {
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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValue([
        { pid: 333, ppid: 1, command: 'opencode runtime host' },
      ]);
      vi.mocked(pidusage).mockReset();
      vi.mocked(pidusage).mockImplementation(
        async (target: number | string | Array<number | string>) => {
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
        }
      );

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(pidusage).toHaveBeenCalledWith([111, 333], { maxage: 0 });
      expect(pidusage).toHaveBeenCalledWith(333, { maxage: 0 });
      expect(snapshot.members.bob).toMatchObject({
        memberName: 'bob',
        alive: false,
        restartable: false,
        pid: 333,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: 456_000_000,
        livenessKind: 'runtime_process_candidate',
      });
    });

    it('shows RSS for persisted OpenCode secondary lane host pids without treating historical bootstrap as live', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
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
      (svc as any).launchStateStore = {
        read: vi.fn(async () =>
          createPersistedLaunchSnapshot({
            teamName: 'runtime-team',
            expectedMembers: ['bob'],
            launchPhase: 'finished',
            members: {
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                runtimePid: 333,
                lastEvaluatedAt: '2026-04-23T12:26:31.563Z',
              },
            },
            updatedAt: '2026-04-23T12:26:31.563Z',
          })
        ),
      };
      vi.mocked(pidusage).mockReset();
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValue([
        { pid: 333, ppid: 1, command: 'opencode runtime host' },
      ]);
      vi.mocked(pidusage).mockImplementation(
        async (target: number | string | Array<number | string>) => {
          if (Array.isArray(target)) {
            return {
              '333': createPidusageStat(333, 456_000_000),
            } as any;
          }
          if (target === 333) {
            return createPidusageStat(333, 456_000_000) as any;
          }
          throw new Error(`Unexpected pidusage target: ${String(target)}`);
        }
      );

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(pidusage).toHaveBeenCalledWith([333], { maxage: 0 });
      expect(snapshot.members.bob).toMatchObject({
        memberName: 'bob',
        alive: false,
        restartable: false,
        pid: 333,
        providerId: 'opencode',
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: 456_000_000,
        historicalBootstrapConfirmed: true,
        livenessKind: 'runtime_process_candidate',
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

    it('retries a failed teammate without live runtime by resetting spawn status to spawning', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'error',
              launchState: 'failed_to_start',
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate "bob" failed to start: spawn failed',
              error: 'Teammate "bob" failed to start: spawn failed',
              agentToolAccepted: false,
              firstSpawnAcceptedAt: undefined,
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
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        error: undefined,
        agentToolAccepted: false,
      });
      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
      expect(sendMessageToRun).toHaveBeenCalledTimes(1);
      expect(sendMessageToRun).toHaveBeenCalledWith(
        run,
        expect.stringContaining('Teammate "bob" with role "Developer" was restarted from the UI.')
      );
    });

    it('skips a failed teammate for the current launch without marking it alive', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'error',
              launchState: 'failed_to_start',
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate "bob" failed to start: spawn failed',
              error: 'Teammate "bob" failed to start: spawn failed',
              agentToolAccepted: false,
              firstSpawnAcceptedAt: undefined,
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.isLaunch = true;

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
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.skipMemberForLaunch('codex-team', 'bob');

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'skipped',
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        error: undefined,
        agentToolAccepted: false,
      });
      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
      expect(sendMessageToRun).toHaveBeenCalledWith(
        run,
        expect.stringContaining('Teammate "bob" was skipped for this launch')
      );
    });

    it('rejects skipping a failed teammate while a retry is already in progress', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'error',
              launchState: 'failed_to_start',
              hardFailure: true,
              hardFailureReason: 'spawn failed',
              error: 'spawn failed',
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.pendingMemberRestarts.set('bob', {
        requestedAt: new Date().toISOString(),
        desired: { name: 'bob', role: 'Developer' },
      });

      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Codex Team',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'bob', role: 'Developer' },
          ],
        })),
      };
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      (svc as any).aliveRunByTeam.set('codex-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await expect(svc.skipMemberForLaunch('codex-team', 'bob')).rejects.toThrow(
        'already in progress'
      );
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
          runtimeProcessPendingCount: 1,
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
      expect(
        (svc as any).buildPendingBootstrapStatusMessage('Finishing launch', run, launchSummary)
      ).toBe('Finishing launch — 1 teammate awaiting permission approval');
    });

    it('counts registered-only liveness as no-runtime pending in launch summaries', () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              livenessKind: 'registered_only',
              runtimeDiagnostic: 'registered runtime metadata without live process',
            }),
          ],
        ]),
      });

      const launchSummary = (svc as any).getMemberLaunchSummary(run);

      expect(launchSummary).toMatchObject({
        pendingCount: 1,
        noRuntimePendingCount: 1,
      });
      expect(
        (svc as any).buildPendingBootstrapStatusMessage('Finishing launch', run, launchSummary)
      ).toContain('1 waiting for runtime');
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
          runtimeProcessPendingCount: 1,
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

    it('uses persisted expected member count instead of stale run expected members for pure launch copy', () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'pure-team',
        expectedMembers: [],
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
          runtimeProcessPendingCount: 1,
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
              livenessKind: 'runtime_process',
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 0,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 1,
            runtimeProcessPendingCount: 1,
          },
          teamLaunchState: 'partial_pending',
        }
      );

      expect(message).toBe('Finishing launch — teammates online');
      expect(message).not.toContain('/0');
    });

    it('does not use legacy runtimeAlivePendingCount as online launch copy evidence', () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'pure-team',
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map(),
      });

      const message = (svc as any).buildAggregatePendingLaunchMessage('Finishing launch', run, {
        confirmedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 1,
      });

      expect(message).toBe('Finishing launch — teammates are still starting');
    });

    it('uses the union of persisted expected members and persisted member entries for pending launch copy', () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'pure-team',
        expectedMembers: [],
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
          expectedMembers: [],
          bootstrapExpectedMembers: [],
          members: {
            alice: {
              name: 'alice',
              providerId: 'opencode',
              laneId: 'primary',
              laneKind: 'primary',
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

    it('delivers direct messages to OpenCode secondary lanes with the lane run id', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePid: 456,
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-1',
        })
      ).resolves.toEqual({
        delivered: true,
        diagnostics: [],
      });
      expect(sendMessageToMember).toHaveBeenCalledWith({
        runId: 'opencode-run-bob',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
        text: 'hello bob',
        messageId: 'msg-1',
      });
    });

    it('delivers OpenCode secondary-lane messages to the member worktree cwd after restart', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        diagnostics: [],
      }));
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: vi.fn(),
            reconcile: vi.fn(),
            stop: vi.fn(),
            sendMessageToMember,
          } as any,
        ])
      );

      (svc as any).getTrackedRunId = vi.fn(() => null);
      (svc as any).resolveCurrentOpenCodeRuntimeRunId = vi.fn(async () => 'opencode-run-bob');
      (svc as any).isOpenCodeRuntimeLaneIndexActive = vi.fn(async () => true);
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            isolation: 'worktree',
            cwd: '/repo/.agent-team-worktrees/bob',
          },
        ]),
      };

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-1',
        })
      ).resolves.toMatchObject({ delivered: true });

      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'opencode-run-bob',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          cwd: '/repo/.agent-team-worktrees/bob',
        })
      );
    });

    it('observes accepted OpenCode prompt delivery before sending the same inbox row again', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'pending',
          deliveredUserMessageId: 'oc-user-1',
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'assistant_response_pending',
        },
        diagnostics: [],
      }));
      const observeMessageDelivery = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        responseObservation: {
          state: 'responded_plain_text',
          deliveredUserMessageId: 'oc-user-1',
          assistantMessageId: 'oc-assistant-1',
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
          observeMessageDelivery,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-ledger-1',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'pending',
      });
      const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: tempTeamsBase,
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        fileName: 'opencode-prompt-delivery-ledger.json',
      });
      const ledgerEnvelope = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as {
        data: Array<{ nextAttemptAt: string | null }>;
      };
      ledgerEnvelope.data[0].nextAttemptAt = '2000-01-01T00:00:00.000Z';
      await fsPromises.writeFile(ledgerPath, JSON.stringify(ledgerEnvelope, null, 2), 'utf8');

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-ledger-1',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: false,
        responseState: 'responded_plain_text',
      });

      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
      expect(observeMessageDelivery).toHaveBeenCalledTimes(1);
      expect(observeMessageDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-ledger-1',
          prePromptCursor: 'cursor-before',
        })
      );
    });

    it('retries due stale OpenCode sessions instead of observing forever', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: `cursor-${sendMessageToMember.mock.calls.length}`,
        responseObservation: {
          state: 'pending',
          deliveredUserMessageId: `oc-user-${sendMessageToMember.mock.calls.length}`,
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'assistant_response_pending',
        },
        diagnostics: [],
      }));
      const observeMessageDelivery = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        responseObservation: {
          state: 'session_stale',
          deliveredUserMessageId: null,
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'resolved_behavior_changed:old->new',
        },
        diagnostics: ['OpenCode session reconcile skipped because the stored session is stale'],
      }));
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: vi.fn(),
            reconcile: vi.fn(),
            stop: vi.fn(),
            sendMessageToMember,
            observeMessageDelivery,
          } as any,
        ])
      );

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-stale-session',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'pending',
      });

      const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: tempTeamsBase,
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        fileName: 'opencode-prompt-delivery-ledger.json',
      });
      const ledgerEnvelope = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as {
        data: Array<{
          status: string;
          responseState: string;
          nextAttemptAt: string | null;
          lastReason: string | null;
        }>;
      };
      Object.assign(ledgerEnvelope.data[0], {
        status: 'accepted',
        responseState: 'session_stale',
        nextAttemptAt: '2000-01-01T00:00:00.000Z',
        lastReason: 'resolved_behavior_changed:old->new',
      });
      await fsPromises.writeFile(ledgerPath, JSON.stringify(ledgerEnvelope, null, 2), 'utf8');

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-stale-session',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
      });

      expect(observeMessageDelivery).toHaveBeenCalledTimes(1);
      expect(sendMessageToMember).toHaveBeenCalledTimes(2);
      expect(sendMessageToMember.mock.calls[1]?.[0]).toMatchObject({
        runId: 'opencode-run-bob',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
        messageId: 'msg-stale-session',
      });
    });

    it('keeps OpenCode ack-only plain-text responses pending instead of committing read', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'responded_plain_text',
          deliveredUserMessageId: 'oc-user-ack',
          assistantMessageId: 'oc-assistant-ack',
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: 'Понял',
          reason: null,
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Please answer directly.',
          messageId: 'msg-ack-only',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'responded_plain_text',
        reason: 'plain_text_ack_only_still_requires_answer',
      });

      const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: tempTeamsBase,
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        fileName: 'opencode-prompt-delivery-ledger.json',
      });
      const ledgerEnvelope = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as {
        data: Array<{ lastReason: string | null; nextAttemptAt: string | null }>;
      };
      expect(ledgerEnvelope.data[0]).toMatchObject({
        lastReason: 'plain_text_ack_only_still_requires_answer',
      });
      expect(ledgerEnvelope.data[0].nextAttemptAt).toBeTruthy();
    });

    it('treats OpenCode send bridge timeouts as acceptance-unknown observe-first records', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: false,
        providerId: 'opencode',
        memberName: String(input.memberName),
        diagnostics: ['OpenCode message bridge failed: OpenCode bridge command timed out'],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
          observeMessageDelivery: vi.fn(),
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Please handle this.',
          messageId: 'msg-timeout-unknown',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: false,
        responsePending: true,
        acceptanceUnknown: true,
        reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
      });

      const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: tempTeamsBase,
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        fileName: 'opencode-prompt-delivery-ledger.json',
      });
      const ledgerEnvelope = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as {
        data: Array<{
          acceptanceUnknown: boolean;
          status: string;
          lastReason: string | null;
          nextAttemptAt: string | null;
        }>;
      };
      expect(ledgerEnvelope.data[0]).toMatchObject({
        acceptanceUnknown: true,
        status: 'failed_retryable',
        lastReason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
      });
      expect(ledgerEnvelope.data[0].nextAttemptAt).toBeTruthy();
    });

    it('marks OpenCode payload hash mismatch terminal without sending a duplicate prompt', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'pending',
          deliveredUserMessageId: 'oc-user-payload',
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'assistant_response_pending',
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Original text.',
          messageId: 'msg-payload-mismatch',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
      });

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Changed text under the same message id.',
          messageId: 'msg-payload-mismatch',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responsePending: false,
        reason: 'opencode_prompt_delivery_payload_mismatch',
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
    });

    it('accepts visible OpenCode replies written to the configured lead inbox for lead aliases', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn();
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'team-lead.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'team-lead',
              text: 'Here is the concrete answer.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-lead-1',
              relayOfMessageId: 'msg-lead-alias',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Please answer the lead.',
          messageId: 'msg-lead-alias',
          replyRecipient: 'lead',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        visibleReplyMessageId: 'reply-lead-1',
        visibleReplyCorrelation: 'relayOfMessageId',
        diagnostics: [],
      });
      expect(sendMessageToMember).not.toHaveBeenCalled();
    });

    it('accepts observed visible OpenCode user replies for lead-delegated inbox messages', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'responded_visible_message',
          deliveredUserMessageId: 'oc-user-1',
          assistantMessageId: 'oc-assistant-1',
          toolCallNames: ['message_send'],
          visibleMessageToolCallId: 'call-1',
          visibleReplyMessageId: 'reply-user-1',
          visibleReplyCorrelation: 'relayOfMessageId',
          latestAssistantPreview: null,
          reason: 'visible_message_sent',
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'Here is the concrete answer for the user.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-1',
              relayOfMessageId: 'msg-lead-delegated',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Please answer the user.',
          messageId: 'msg-lead-delegated',
          replyRecipient: 'team-lead',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        visibleReplyMessageId: 'reply-user-1',
        visibleReplyCorrelation: 'relayOfMessageId',
        diagnostics: [],
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          replyRecipient: 'team-lead',
          messageId: 'msg-lead-delegated',
        })
      );
    });

    it('accepts exact observed OpenCode user replies for custom configured lead recipients', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'captain', providerId: 'codex', agentType: 'team-lead', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'Old reply with the same relay id must not be accepted.',
              timestamp: '2026-04-25T10:00:02.000Z',
              read: false,
              messageId: 'reply-user-stale',
              relayOfMessageId: 'msg-custom-lead',
              source: 'runtime_delivery',
            },
            {
              from: 'bob',
              to: 'user',
              text: 'Here is the observed answer for the user.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-custom',
              relayOfMessageId: 'msg-custom-lead',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const proof = await (svc as any).findOpenCodeVisibleReplyByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead',
        expectedMessageId: 'reply-user-custom',
      });

      expect(proof).toMatchObject({
        inboxName: 'user',
        message: {
          messageId: 'reply-user-custom',
          relayOfMessageId: 'msg-custom-lead',
          from: 'bob',
          to: 'user',
        },
        missingRuntimeDeliverySource: false,
      });
    });

    it('uses the exact observed message id for direct OpenCode user replies', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', agentType: 'team-lead', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'Old duplicate for the same delivery.',
              timestamp: '2026-04-25T10:00:02.000Z',
              read: false,
              messageId: 'reply-user-stale',
              relayOfMessageId: 'msg-direct-user',
              source: 'runtime_delivery',
            },
            {
              from: 'bob',
              to: 'user',
              text: 'Current observed reply.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-current',
              relayOfMessageId: 'msg-direct-user',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const proof = await (svc as any).findOpenCodeVisibleReplyByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'user',
        from: 'bob',
        relayOfMessageId: 'msg-direct-user',
        expectedMessageId: 'reply-user-current',
      });

      expect(proof).toMatchObject({
        inboxName: 'user',
        message: {
          messageId: 'reply-user-current',
          relayOfMessageId: 'msg-direct-user',
          from: 'bob',
          to: 'user',
        },
      });
    });

    it('accepts a unique OpenCode user fallback reply when relay correlation has no exact id', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'captain', providerId: 'codex', agentType: 'team-lead', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'alice',
              to: 'user',
              text: 'Different sender should not affect Bob proof.',
              timestamp: '2026-04-25T10:00:01.000Z',
              read: false,
              messageId: 'reply-user-alice',
              relayOfMessageId: 'msg-custom-lead-no-id',
              source: 'runtime_delivery',
            },
            {
              from: 'bob',
              to: 'user',
              text: 'Here is the only Bob reply for this relay.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: ' reply-user-single ',
              relayOfMessageId: 'msg-custom-lead-no-id',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const proof = await (svc as any).findOpenCodeVisibleReplyByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead-no-id',
        allowUserFallbackForLeadRecipient: true,
      });

      expect(proof).toMatchObject({
        inboxName: 'user',
        message: {
          messageId: 'reply-user-single',
          relayOfMessageId: 'msg-custom-lead-no-id',
          from: 'bob',
          to: 'user',
        },
        missingRuntimeDeliverySource: false,
      });
    });

    it('does not use OpenCode user fallback for lead recipients without confirmed relay correlation', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'captain', providerId: 'codex', agentType: 'team-lead', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'This exists, but the caller did not confirm relay correlation.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-single',
              relayOfMessageId: 'msg-custom-lead-no-correlation',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const proof = await (svc as any).findOpenCodeVisibleReplyByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead-no-correlation',
      });

      expect(proof).toBeNull();
    });

    it('rejects ambiguous OpenCode user fallback replies when relay correlation has no exact id', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'captain', providerId: 'codex', agentType: 'team-lead', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'First candidate.',
              timestamp: '2026-04-25T10:00:02.000Z',
              read: false,
              messageId: 'reply-user-1',
              relayOfMessageId: 'msg-custom-lead-ambiguous',
              source: 'runtime_delivery',
            },
            {
              from: 'bob',
              to: 'user',
              text: 'Second candidate.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-2',
              relayOfMessageId: 'msg-custom-lead-ambiguous',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const proof = await (svc as any).findOpenCodeVisibleReplyByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead-ambiguous',
        allowUserFallbackForLeadRecipient: true,
      });

      expect(proof).toBeNull();
    });

    it('rejects custom lead user fallback replies without the exact observed message id', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'captain', providerId: 'codex', agentType: 'team-lead', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'This is not the observed reply for the current delivery.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-stale',
              relayOfMessageId: 'msg-custom-lead',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const proof = await (svc as any).findOpenCodeVisibleReplyByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead',
        expectedMessageId: 'reply-user-expected',
      });

      expect(proof).toBeNull();
    });

    it('uses legacy OpenCode prompt acceptance semantics when the watchdog is disabled', async () => {
      const previous = process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG;
      process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG = '0';
      try {
        const svc = new TeamProvisioningService();
        const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
          ok: true,
          providerId: 'opencode',
          memberName: String(input.memberName),
          sessionId: 'oc-session-bob',
          responseObservation: {
            state: 'pending',
            deliveredUserMessageId: 'oc-user-disabled',
            assistantMessageId: null,
            toolCallNames: [],
            visibleMessageToolCallId: null,
            visibleReplyMessageId: null,
            visibleReplyCorrelation: null,
            latestAssistantPreview: null,
            reason: 'assistant_response_pending',
          },
          diagnostics: [],
        }));
        const registry = new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: vi.fn(),
            reconcile: vi.fn(),
            stop: vi.fn(),
            sendMessageToMember,
          } as any,
        ]);
        svc.setRuntimeAdapterRegistry(registry);

        (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
        (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
        (svc as any).setSecondaryRuntimeRun({
          teamName: 'team-a',
          runId: 'opencode-run-bob',
          providerId: 'opencode',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          cwd: '/repo',
        });
        (svc as any).configReader = {
          getConfig: vi.fn(async () => ({
            projectPath: '/repo',
            members: [
              { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
              { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
            ],
          })),
        };
        (svc as any).teamMetaStore = {
          getMeta: vi.fn(async () => ({
            launchIdentity: { providerId: 'codex' },
            providerId: 'codex',
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

        await expect(
          svc.deliverOpenCodeMemberMessage('team-a', {
            memberName: 'bob',
            text: 'Please answer eventually.',
            messageId: 'msg-watchdog-disabled',
            replyRecipient: 'user',
            actionMode: 'ask',
            source: 'watcher',
            inboxTimestamp: '2026-04-25T10:00:00.000Z',
          })
        ).resolves.toMatchObject({
          delivered: true,
          accepted: true,
          responsePending: false,
          responseState: 'pending',
          diagnostics: [],
        });
        expect(sendMessageToMember).toHaveBeenCalledTimes(1);
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG;
        } else {
          process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG = previous;
        }
      }
    });

    it('retries OpenCode direct asks after non-visible tool activity with an explicit retry header', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: sendMessageToMember.mock.calls.length === 1 ? 'responded_non_visible_tool' : 'pending',
          deliveredUserMessageId: 'oc-user-ask',
          assistantMessageId: sendMessageToMember.mock.calls.length === 1 ? 'oc-assistant-read' : null,
          toolCallNames: sendMessageToMember.mock.calls.length === 1 ? ['read'] : [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: sendMessageToMember.mock.calls.length === 1 ? null : 'assistant_response_pending',
        },
        diagnostics: [],
      }));
      const observeMessageDelivery = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        responseObservation: {
          state: 'responded_non_visible_tool',
          deliveredUserMessageId: 'oc-user-ask',
          assistantMessageId: 'oc-assistant-read',
          toolCallNames: ['read'],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
          observeMessageDelivery,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'What did you find?',
          messageId: 'msg-visible-required',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'responded_non_visible_tool',
        reason: 'visible_reply_still_required',
      });

      const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: tempTeamsBase,
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        fileName: 'opencode-prompt-delivery-ledger.json',
      });
      const ledgerEnvelope = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as {
        data: Array<{ nextAttemptAt: string | null }>;
      };
      ledgerEnvelope.data[0].nextAttemptAt = '2000-01-01T00:00:00.000Z';
      await fsPromises.writeFile(ledgerPath, JSON.stringify(ledgerEnvelope, null, 2), 'utf8');

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'What did you find?',
          messageId: 'msg-visible-required',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
      });

      expect(observeMessageDelivery).toHaveBeenCalledTimes(1);
      expect(sendMessageToMember).toHaveBeenCalledTimes(2);
      expect(sendMessageToMember.mock.calls[1]?.[0]).toMatchObject({
        messageId: 'msg-visible-required',
        text: expect.stringContaining('<opencode_delivery_retry>'),
      });
      const retryText = String(sendMessageToMember.mock.calls[1]?.[0].text ?? '');
      expect(retryText).toContain('relayOfMessageId="msg-visible-required"');
      expect(retryText).toContain('agent-teams_message_send');
      expect(retryText).toContain('What did you find?');
    });

    it('keeps OpenCode task delivery pending after read-only non-visible tool activity', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'responded_non_visible_tool' as const,
          deliveredUserMessageId: 'oc-user-task',
          assistantMessageId: 'oc-assistant-read',
          toolCallNames: ['read', 'bash'],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
          observeMessageDelivery: vi.fn(),
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Start task #task-1 now.',
          messageId: 'msg-task-read-only',
          replyRecipient: 'team-lead',
          actionMode: 'do',
          taskRefs: [
            {
              taskId: 'task-1',
              displayId: 'task-1',
              teamName: 'team-a',
            },
          ],
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'retry_scheduled',
        reason: 'non_visible_tool_without_task_progress',
      });
    });

    it('marks OpenCode delivery terminal after max attempts instead of leaving it pending', async () => {
      const svc = new TeamProvisioningService();
      const emptyResponseObservation = {
        state: 'empty_assistant_turn' as const,
        deliveredUserMessageId: 'oc-user-empty',
        assistantMessageId: 'oc-assistant-empty',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'empty_assistant_turn',
      };
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: emptyResponseObservation,
        diagnostics: [],
      }));
      const observeMessageDelivery = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        responseObservation: emptyResponseObservation,
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
          observeMessageDelivery,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      const deliver = () =>
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Please answer.',
          messageId: 'msg-max-attempts',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        });
      const forceDue = async () => {
        const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempTeamsBase,
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          fileName: 'opencode-prompt-delivery-ledger.json',
        });
        const ledgerEnvelope = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as {
          data: Array<{ nextAttemptAt: string | null }>;
        };
        ledgerEnvelope.data[0].nextAttemptAt = '2000-01-01T00:00:00.000Z';
        await fsPromises.writeFile(ledgerPath, JSON.stringify(ledgerEnvelope, null, 2), 'utf8');
      };

      await expect(deliver()).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'empty_assistant_turn',
      });
      await forceDue();
      await expect(deliver()).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'empty_assistant_turn',
      });
      await forceDue();
      await expect(deliver()).resolves.toMatchObject({
        delivered: false,
        accepted: true,
        responsePending: false,
        responseState: 'empty_assistant_turn',
        ledgerStatus: 'failed_terminal',
        reason: 'empty_assistant_turn',
      });
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'Late but valid answer.',
              timestamp: '2026-04-25T10:00:04.000Z',
              read: false,
              messageId: 'reply-after-terminal',
              relayOfMessageId: 'msg-max-attempts',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      await expect(deliver()).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        ledgerStatus: 'responded',
        visibleReplyMessageId: 'reply-after-terminal',
        visibleReplyCorrelation: 'relayOfMessageId',
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(3);
      expect(observeMessageDelivery).toHaveBeenCalledTimes(2);
    });

    it('queues newer OpenCode deliveries behind one active unresolved member delivery', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'pending' as const,
          deliveredUserMessageId: 'oc-user-pending',
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'assistant_response_pending',
        },
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'First prompt.',
          messageId: 'msg-active-old',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'pending',
      });

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Second prompt.',
          messageId: 'msg-active-new',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:05.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: false,
        responsePending: true,
        queuedBehindMessageId: 'msg-active-old',
        reason: 'opencode_delivery_response_pending',
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
    });

    it('unblocks newer OpenCode deliveries when the previous pending delivery now has visible proof', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'empty_assistant_turn' as const,
          deliveredUserMessageId: 'oc-user-empty',
          assistantMessageId: 'oc-assistant-empty',
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'empty_assistant_turn',
        },
        diagnostics: [],
      }));
      const observeMessageDelivery = vi.fn(async () => ({
        ok: true,
        providerId: 'opencode',
        memberName: 'bob',
        responseObservation: {
          state: 'empty_assistant_turn' as const,
          deliveredUserMessageId: 'oc-user-empty',
          assistantMessageId: 'oc-assistant-empty',
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'empty_assistant_turn',
        },
        diagnostics: [],
      }));
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: vi.fn(),
            reconcile: vi.fn(),
            stop: vi.fn(),
            sendMessageToMember,
            observeMessageDelivery,
          } as any,
        ])
      );

      (svc as any).getTrackedRunId = vi.fn(() => 'run-1');
      (svc as any).provisioningRunByTeam.set('team-a', 'run-1');
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'First prompt.',
          messageId: 'msg-active-old',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'empty_assistant_turn',
      });

      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'Delayed but sufficient answer.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-old-1',
              relayOfMessageId: 'msg-active-old',
              source: 'runtime_delivery',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Second prompt.',
          messageId: 'msg-active-new',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:05.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'empty_assistant_turn',
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(2);
      expect(observeMessageDelivery).not.toHaveBeenCalled();
    });

    it('uses lane-scoped manifest activeRunId for OpenCode member delivery after restart', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'team-a';
      const laneId = 'secondary:opencode:bob';
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId,
        state: 'active',
      });
      const manifestPath = getOpenCodeRuntimeManifestPath(tempTeamsBase, teamName, laneId);
      await fsPromises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fsPromises.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...createDefaultRuntimeStoreManifest(teamName, '2026-04-22T12:00:00.000Z'),
            activeRunId: 'opencode-run-durable',
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'hello after restart',
          messageId: 'msg-after-restart',
        })
      ).resolves.toEqual({
        delivered: true,
        diagnostics: [],
      });
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'opencode-run-durable',
          teamName,
          laneId,
          memberName: 'bob',
          cwd: '/repo',
          text: 'hello after restart',
          messageId: 'msg-after-restart',
        })
      );
    });

    it('falls back to lane manifest when a tracked primary run lacks the secondary lane snapshot', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'team-a';
      const laneId = 'secondary:opencode:bob';
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        diagnostics: [],
      }));
      const registry = new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ]);
      svc.setRuntimeAdapterRegistry(registry);

      (svc as any).resolveDeliverableTrackedRuntimeRunId = vi.fn(() => 'run-1');
      (svc as any).runs.set('run-1', {
        mixedSecondaryLanes: [],
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
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
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId,
        state: 'active',
      });
      const manifestPath = getOpenCodeRuntimeManifestPath(tempTeamsBase, teamName, laneId);
      await fsPromises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fsPromises.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...createDefaultRuntimeStoreManifest(teamName, '2026-04-22T12:00:00.000Z'),
            activeRunId: 'opencode-run-from-manifest',
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'hello via manifest fallback',
          messageId: 'msg-manifest-fallback',
        })
      ).resolves.toEqual({
        delivered: true,
        diagnostics: [],
      });
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'opencode-run-from-manifest',
          teamName,
          laneId,
          memberName: 'bob',
          cwd: '/repo',
          text: 'hello via manifest fallback',
          messageId: 'msg-manifest-fallback',
        })
      );
    });

    it('marks an OpenCode secondary lane degraded when readiness fails before runtime materializes', async () => {
      const teamName = 'mixed-prelaunch-failure';
      const svc = new TeamProvisioningService();
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => ({
        runId: String(input.runId),
        teamName: String(input.teamName),
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: {
          bob: {
            memberName: 'bob',
            providerId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'unknown_error',
            diagnostics: [
              'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
              'opencode_bridge_unknown_outcome: OpenCode bridge command timed out',
            ],
          },
        },
        warnings: [],
        diagnostics: [
          'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
        ],
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
        teamName,
        expectedMembers: ['alice'],
      });
      run.isLaunch = true;
      run.request = {
        teamName,
        cwd: '/tmp/mixed-prelaunch-failure',
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
      const manifestPath = getOpenCodeRuntimeManifestPath(
        tempTeamsBase,
        teamName,
        'secondary:opencode:bob'
      );
      await fsPromises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fsPromises.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...createDefaultRuntimeStoreManifest(teamName, '2026-04-22T10:00:00.000Z'),
            activeRunId: 'stale-run',
            highWatermark: 2,
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(async () => {
        expect(adapterLaunch).toHaveBeenCalledTimes(1);
        const launchInput = adapterLaunch.mock.calls[0]?.[0] as { runId?: string } | undefined;
        expect(launchInput?.runId).toEqual(expect.any(String));
        await expect(
          new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempTeamsBase }).read(
            teamName,
            'secondary:opencode:bob'
          )
        ).resolves.toMatchObject({
          activeRunId: launchInput?.runId,
          highWatermark: 0,
        });
        await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
          lanes: {
            'secondary:opencode:bob': {
              state: 'degraded',
              diagnostics: expect.arrayContaining([
                'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
              ]),
            },
          },
        });
      });
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
      const writtenSnapshot = (
        write.mock.calls[0] as unknown as [string, Record<string, unknown>] | undefined
      )?.[1] as { members?: Record<string, unknown> } | undefined;
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

    it('persists sanitized runtime tool metadata diagnostics on OpenCode liveness updates', async () => {
      const svc = new TeamProvisioningService();
      const previousSnapshot = {
        version: 2 as const,
        teamName: 'mixed-team',
        updatedAt: '2026-04-22T12:00:00.000Z',
        launchPhase: 'active' as const,
        expectedMembers: ['bob'],
        members: {
          bob: {
            name: 'bob',
            providerId: 'opencode' as const,
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary' as const,
            laneOwnerProviderId: 'opencode' as const,
            launchState: 'runtime_pending_bootstrap' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            diagnostics: ['existing diagnostic'],
          },
        },
        summary: {
          confirmedCount: 0,
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
        metadata: {
          runtimePid: 4321,
          processCommand: 'opencode runtime --token super-secret --safe ok',
          runtimeVersion: '1.2.3',
          hostPid: 987,
          cwd: '/tmp/project',
        },
        reason: 'OpenCode runtime heartbeat accepted',
      });

      expect(write).toHaveBeenCalledTimes(1);
      const writtenSnapshot = (
        write.mock.calls[0] as unknown as [string, Record<string, unknown>] | undefined
      )?.[1] as { members?: Record<string, { diagnostics?: string[] }> } | undefined;
      const diagnostics = writtenSnapshot?.members?.bob?.diagnostics ?? [];
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          'existing diagnostic',
          'native heartbeat',
          'runtime pid: 4321',
          'runtime process command: opencode runtime --token [redacted] --safe ok',
          'runtime version: 1.2.3',
          'runtime host pid: 987',
          'runtime cwd: /tmp/project',
          'OpenCode runtime heartbeat accepted',
        ])
      );
      expect(diagnostics.join('\n')).not.toContain('super-secret');
    });

    it('preserves richer persisted expectedMembers when OpenCode runtime liveness updates a stale snapshot', async () => {
      const svc = new TeamProvisioningService();
      const previousSnapshot = {
        version: 2 as const,
        teamName: 'mixed-team',
        updatedAt: '2026-04-22T12:00:00.000Z',
        launchPhase: 'active' as const,
        expectedMembers: ['bob'],
        members: {
          alice: {
            name: 'alice',
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
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary' as const,
            laneOwnerProviderId: 'opencode' as const,
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
      const writtenSnapshot = (
        write.mock.calls[0] as unknown as [string, Record<string, unknown>] | undefined
      )?.[1] as { expectedMembers?: string[] } | undefined;
      expect(writtenSnapshot?.expectedMembers).toEqual(['bob', 'alice']);
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
      const delivered = new Map<
        string,
        { kind: 'member_inbox'; teamName: string; memberName: string; messageId: string }
      >();

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

    it('maps runtime delivery local data.detail to public TeamChangeEvent.detail', async () => {
      const svc = new TeamProvisioningService();
      const emitted: Array<Record<string, unknown>> = [];
      const delivered = new Map<
        string,
        {
          kind: 'member_inbox';
          teamName: string;
          memberName: string;
          messageId: string;
        }
      >();

      svc.setTeamChangeEmitter((event) => {
        emitted.push(event as unknown as Record<string, unknown>);
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
          buildChangeEvent: vi.fn(({ teamName, location }) => ({
            type: 'inbox',
            teamName,
            data: {
              detail:
                location.kind === 'member_inbox'
                  ? `inboxes/${location.memberName}.json`
                  : 'inboxes',
            },
          })),
        },
      ]);

      const delivery = (svc as any).createOpenCodeRuntimeDeliveryService(
        'mixed-team',
        'secondary:opencode:bob'
      );
      const ack = await delivery.deliver({
        idempotencyKey: 'delivery-event-shape-1',
        runId: 'opencode-run-1',
        teamName: 'mixed-team',
        fromMemberName: 'bob',
        providerId: 'opencode',
        runtimeSessionId: 'session-bob',
        to: { memberName: 'alice' },
        text: 'hi',
        createdAt: '2026-04-22T12:05:00.000Z',
      });

      expect(ack).toMatchObject({ ok: true, delivered: true });
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: 'inbox',
          teamName: 'mixed-team',
          detail: 'inboxes/alice.json',
        })
      );
      expect(emitted[0]).not.toHaveProperty('data');
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

      await expect(
        readOpenCodeRuntimeLaneIndex(tempTeamsBase, run.teamName)
      ).resolves.toMatchObject({
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
        new Error('error connecting to /private/tmp/tmux-501/default (No such file or directory)')
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
      await vi.waitFor(() => {
        expect(vi.mocked(killProcessByPid)).toHaveBeenCalledWith(process.pid);
      });
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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        {
          pid: process.pid,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --team-name process-team --agent-id forge@process-team --agent-name forge --model gpt-5.4',
        },
      ]);
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
      await vi.waitFor(() => {
        expect(vi.mocked(killProcessByPid)).toHaveBeenCalledWith(process.pid);
      });
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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([
        {
          pid: process.pid,
          ppid: 1,
          command:
            '/Users/belief/.bun/bin/bun cli.js --team-name process-team --agent-id forge@process-team --agent-name forge --model gpt-5.4',
        },
      ]);
      (svc as any).aliveRunByTeam.set('process-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      const restartPromise = expect(svc.restartMember('process-team', 'forge')).rejects.toThrow(
        `Restart for teammate "forge" is still waiting for the previous process to exit (${process.pid}).`
      );
      await vi.waitFor(() => {
        expect(vi.mocked(killProcessByPid)).toHaveBeenCalledWith(process.pid);
      });
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

    it('does not let stale runtimeAlive bypass launch timeout when live metadata is weak', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: true,
              livenessSource: 'process',
              bootstrapConfirmed: false,
              firstSpawnAcceptedAt: new Date(Date.now() - 120_000).toISOString(),
            }),
          ],
        ]),
      });
      (svc as any).refreshMemberSpawnStatusesFromLeadInbox = vi.fn(async () => {});
      (svc as any).maybeAuditMemberSpawnStatuses = vi.fn(async () => {});
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
        async () =>
          new Map([
            [
              'bob',
              {
                alive: false,
                livenessKind: 'shell_only',
                runtimeDiagnostic: 'tmux pane foreground command is zsh',
                runtimeDiagnosticSeverity: 'warning',
              },
            ],
          ])
      );

      await (svc as any).reevaluateMemberLaunchStatus(run, 'bob');

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        livenessSource: undefined,
        bootstrapConfirmed: false,
        livenessKind: 'shell_only',
        runtimeDiagnostic: 'tmux pane foreground command is zsh',
        error: 'tmux pane foreground command is zsh',
      });
    });

    it('keeps verified runtime pending with a warning after the bootstrap stall window', async () => {
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
              runtimeAlive: false,
              bootstrapConfirmed: false,
              firstSpawnAcceptedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
            }),
          ],
        ]),
      });
      (svc as any).refreshMemberSpawnStatusesFromLeadInbox = vi.fn(async () => {});
      (svc as any).maybeAuditMemberSpawnStatuses = vi.fn(async () => {});
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
        async () =>
          new Map([
            [
              'bob',
              {
                alive: true,
                livenessKind: 'runtime_process',
                runtimeDiagnostic: 'verified runtime process detected',
              },
            ],
          ])
      );

      await (svc as any).reevaluateMemberLaunchStatus(run, 'bob');

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        bootstrapConfirmed: false,
        livenessSource: 'process',
        livenessKind: 'runtime_process',
        runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
        runtimeDiagnosticSeverity: 'warning',
        hardFailure: false,
      });
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

  describe('safe app launch matrix', () => {
    function createSafeLaunchService(options?: {
      memberWorktreeManager?: { ensureMemberWorktree: ReturnType<typeof vi.fn> };
    }) {
      const mcpConfigBuilder = {
        writeConfigFile: vi.fn(async () => path.join(tempClaudeRoot, 'mcp-config.json')),
        removeConfigFile: vi.fn(async () => {}),
      };
      const membersMetaStore = {
        writeMembers: vi.fn(async () => {}),
        getMembers: vi.fn(async () => []),
        getMeta: vi.fn(async () => null),
      };
      const teamMetaStore = {
        writeMeta: vi.fn(async () => {}),
        deleteMeta: vi.fn(async () => {}),
        getMeta: vi.fn(async () => null),
      };
      const svc = new TeamProvisioningService(
        undefined,
        undefined,
        membersMetaStore as any,
        undefined,
        mcpConfigBuilder as any,
        teamMetaStore as any,
        undefined,
        undefined,
        options?.memberWorktreeManager as any
      );

      (svc as any).buildProvisioningEnv = vi.fn(async () => ({
        env: { CODEX_API_KEY: 'test' },
        authSource: 'codex_runtime',
      }));
      (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
      (svc as any).pathExists = vi.fn(async () => false);
      (svc as any).startFilesystemMonitor = vi.fn();
      (svc as any).stopFilesystemMonitor = vi.fn();
      (svc as any).startStallWatchdog = vi.fn();
      (svc as any).stopStallWatchdog = vi.fn();
      (svc as any).attachStdoutHandler = vi.fn();
      (svc as any).attachStderrHandler = vi.fn();
      (svc as any).resolveAndValidateLaunchIdentity = vi.fn(async () => ({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedModel: 'gpt-5.4',
        selectedModelKind: 'explicit',
        resolvedLaunchModel: 'gpt-5.4',
        catalogId: 'gpt-5.4',
        catalogSource: 'test',
        catalogFetchedAt: '2026-04-23T00:00:00.000Z',
        selectedEffort: 'medium',
        resolvedEffort: 'medium',
        selectedFastMode: null,
        resolvedFastMode: null,
        fastResolutionReason: null,
      }));

      return { svc, mcpConfigBuilder, membersMetaStore, teamMetaStore };
    }

    function readBootstrapSpecFromSpawnArgs(spawnArgs: string[]) {
      const specIdx = spawnArgs.indexOf('--team-bootstrap-spec');
      expect(specIdx).toBeGreaterThanOrEqual(0);
      return JSON.parse(fs.readFileSync(spawnArgs[specIdx + 1], 'utf8')) as {
        mode: string;
        team: { name: string; cwd: string };
        members: Array<{
          name: string;
          provider?: string;
          model?: string;
          effort?: string;
          role?: string;
        }>;
      };
    }

    it('starts a pure Codex team through the app createTeam path without a real CLI process', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);

      const { svc, membersMetaStore } = createSafeLaunchService();
      const progress: string[] = [];
      const { runId } = await svc.createTeam(
        {
          teamName: 'safe-codex-only-launch',
          cwd: tempClaudeRoot,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          members: [
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
              effort: 'low',
            },
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
              effort: 'medium',
            },
          ],
        },
        (event) => progress.push(event.state)
      );

      const spawnCall = vi.mocked(spawnCli).mock.calls[0];
      expect(spawnCall?.[0]).toBe('/mock/claude');
      expect(spawnCall?.[2]).toMatchObject({
        cwd: tempClaudeRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const spawnArgs = spawnCall?.[1] as string[];
      expect(spawnArgs).toEqual(
        expect.arrayContaining(['--model', 'gpt-5.4', '--effort', 'medium'])
      );

      const bootstrapSpec = readBootstrapSpecFromSpawnArgs(spawnArgs);
      expect(bootstrapSpec).toMatchObject({
        mode: 'create',
        team: { name: 'safe-codex-only-launch', cwd: tempClaudeRoot },
      });
      expect(bootstrapSpec.members).toEqual([
        expect.objectContaining({
          name: 'alice',
          provider: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'low',
          role: 'Reviewer',
        }),
        expect.objectContaining({
          name: 'bob',
          provider: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          role: 'Developer',
        }),
      ]);

      const run = (svc as any).runs.get(runId);
      expect(run.expectedMembers).toEqual(['alice', 'bob']);
      expect(run.allEffectiveMembers.map((member: { name: string }) => member.name)).toEqual([
        'alice',
        'bob',
      ]);
      expect(run.mixedSecondaryLanes).toEqual([]);
      expect(membersMetaStore.writeMembers).toHaveBeenCalledWith(
        'safe-codex-only-launch',
        expect.arrayContaining([
          expect.objectContaining({ name: 'alice', providerId: 'codex' }),
          expect.objectContaining({ name: 'bob', providerId: 'codex' }),
        ]),
        expect.objectContaining({ providerBackendId: 'codex-native' })
      );
      expect(progress).toEqual(expect.arrayContaining(['validating', 'spawning', 'configuring']));

      await svc.cancelProvisioning(runId);
    });

    it('routes a pure OpenCode team directly through the runtime adapter without spawning the CLI lane', async () => {
      allowConsoleLogs();
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => {
        const expectedMembers = input.expectedMembers as Array<{ name: string }>;
        return {
          runId: String(input.runId),
          teamName: String(input.teamName),
          launchPhase: 'finished',
          teamLaunchState: 'clean_success',
          leadSessionId: 'opencode-lead-session',
          members: Object.fromEntries(
            expectedMembers.map((member) => [
              member.name,
              {
                memberName: member.name,
                providerId: 'opencode',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                diagnostics: [],
              },
            ])
          ),
          warnings: [],
          diagnostics: [],
        };
      });

      const { svc, membersMetaStore } = createSafeLaunchService();
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
      const progress: string[] = [];

      const { runId } = await svc.createTeam(
        {
          teamName: 'safe-opencode-only-launch',
          cwd: tempClaudeRoot,
          providerId: 'opencode',
          providerBackendId: 'adapter',
          model: 'big-pickle',
          effort: 'medium',
          members: [
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            },
            {
              name: 'tom',
              role: 'Developer',
              providerId: 'opencode',
              model: 'nemotron-3-super-free',
            },
          ],
        },
        (event) => progress.push(event.state)
      );

      expect(runId).toEqual(expect.any(String));
      expect(spawnCli).not.toHaveBeenCalled();
      expect(ClaudeBinaryResolver.resolve).not.toHaveBeenCalled();
      expect(adapterLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: 'primary',
          providerId: 'opencode',
          model: 'big-pickle',
          effort: 'medium',
          cwd: tempClaudeRoot,
          expectedMembers: [
            expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            }),
            expect.objectContaining({
              name: 'tom',
              providerId: 'opencode',
              model: 'nemotron-3-super-free',
            }),
          ],
        })
      );
      expect(membersMetaStore.writeMembers).toHaveBeenCalledWith(
        'safe-opencode-only-launch',
        expect.arrayContaining([
          expect.objectContaining({ name: 'bob', providerId: 'opencode' }),
          expect.objectContaining({ name: 'tom', providerId: 'opencode' }),
        ]),
        expect.objectContaining({ providerBackendId: 'adapter' })
      );

      const config = JSON.parse(
        fs.readFileSync(
          path.join(tempTeamsBase, 'safe-opencode-only-launch', 'config.json'),
          'utf8'
        )
      ) as { members: Array<{ name: string; providerId?: string; model?: string }> };
      expect(config.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'team-lead',
            providerId: 'opencode',
            model: 'big-pickle',
          }),
          expect.objectContaining({
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
          }),
          expect.objectContaining({
            name: 'tom',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
          }),
        ])
      );

      const publicStatuses = await svc.getMemberSpawnStatuses('safe-opencode-only-launch');
      expect(publicStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(publicStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(publicStatuses.teamLaunchState).toBe('clean_success');
      expect(progress).toEqual(expect.arrayContaining(['validating', 'spawning', 'ready']));
    });

    it('keeps Codex in the primary CLI lane and starts OpenCode teammates as secondary runtime lanes', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);

      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => {
        const expectedMembers = input.expectedMembers as Array<{ name: string }>;
        const memberName = expectedMembers[0]?.name ?? 'unknown';
        return {
          runId: String(input.runId),
          teamName: String(input.teamName),
          launchPhase: 'finished',
          teamLaunchState: 'clean_success',
          members: {
            [memberName]: {
              memberName,
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
        };
      });
      const adapterStop = vi.fn(async () => {});

      const { svc, membersMetaStore } = createSafeLaunchService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          {
            providerId: 'opencode',
            prepare: vi.fn(),
            launch: adapterLaunch,
            reconcile: vi.fn(),
            stop: adapterStop,
          } as any,
        ])
      );

      const { runId } = await svc.createTeam(
        {
          teamName: 'safe-mixed-codex-opencode-launch',
          cwd: tempClaudeRoot,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          members: [
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
              effort: 'low',
            },
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            },
            {
              name: 'tom',
              role: 'Developer',
              providerId: 'opencode',
              model: 'nemotron-3-super-free',
            },
          ],
        },
        () => {}
      );

      const spawnArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
      const bootstrapSpec = readBootstrapSpecFromSpawnArgs(spawnArgs);
      expect(bootstrapSpec.members).toEqual([
        expect.objectContaining({
          name: 'alice',
          provider: 'codex',
          model: 'gpt-5.4-mini',
        }),
      ]);

      const run = (svc as any).runs.get(runId);
      expect(run.expectedMembers).toEqual(['alice']);
      expect(run.effectiveMembers.map((member: { name: string }) => member.name)).toEqual([
        'alice',
      ]);
      expect(run.allEffectiveMembers.map((member: { name: string }) => member.name)).toEqual([
        'alice',
        'bob',
        'tom',
      ]);
      expect(run.mixedSecondaryLanes).toEqual([
        expect.objectContaining({
          laneId: 'secondary:opencode:bob',
          state: 'queued',
          member: expect.objectContaining({
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
          }),
        }),
        expect.objectContaining({
          laneId: 'secondary:opencode:tom',
          state: 'queued',
          member: expect.objectContaining({
            name: 'tom',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
          }),
        }),
      ]);
      expect(membersMetaStore.writeMembers).toHaveBeenCalledWith(
        'safe-mixed-codex-opencode-launch',
        expect.arrayContaining([
          expect.objectContaining({ name: 'alice', providerId: 'codex' }),
          expect.objectContaining({ name: 'bob', providerId: 'opencode' }),
          expect.objectContaining({ name: 'tom', providerId: 'opencode' }),
        ]),
        expect.objectContaining({ providerBackendId: 'codex-native' })
      );

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(() => expect(adapterLaunch).toHaveBeenCalledTimes(2));
      expect(adapterLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          cwd: tempClaudeRoot,
          expectedMembers: [
            expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            }),
          ],
        })
      );
      expect(adapterLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: 'secondary:opencode:tom',
          providerId: 'opencode',
          model: 'nemotron-3-super-free',
          cwd: tempClaudeRoot,
          expectedMembers: [
            expect.objectContaining({
              name: 'tom',
              providerId: 'opencode',
              model: 'nemotron-3-super-free',
            }),
          ],
        })
      );
      await vi.waitFor(() => {
        expect(run.mixedSecondaryLanes).toEqual([
          expect.objectContaining({
            laneId: 'secondary:opencode:bob',
            state: 'finished',
            result: expect.objectContaining({ teamLaunchState: 'clean_success' }),
          }),
          expect.objectContaining({
            laneId: 'secondary:opencode:tom',
            state: 'finished',
            result: expect.objectContaining({ teamLaunchState: 'clean_success' }),
          }),
        ]);
      });
      const publicStatuses = await svc.getMemberSpawnStatuses('safe-mixed-codex-opencode-launch');
      expect(publicStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(publicStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(publicStatuses.expectedMembers).toEqual(
        expect.arrayContaining(['alice', 'bob', 'tom'])
      );

      await svc.cancelProvisioning(runId);
    });

    it('restores missing OpenCode teammates into config before post-launch registration audit', async () => {
      allowConsoleLogs();
      const teamName = 'mixed-opencode-post-launch-config';
      const teamDir = path.join(tempTeamsBase, teamName);
      const jackWorktree = path.join(tempClaudeRoot, 'worktrees', 'jack');
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        `${JSON.stringify(
          {
            name: teamName,
            projectPath: '/old/project',
            leadSessionId: 'old-lead-session',
            members: [{ name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' }],
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      const { svc } = createSafeLaunchService();
      await (svc as any).updateConfigPostLaunch(
        teamName,
        tempClaudeRoot,
        'new-lead-session',
        undefined,
        {
          providerId: 'codex',
          model: 'gpt-5.4',
          effort: 'medium',
          members: [
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
            },
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              model: 'openrouter/google/gemini-2.5-flash',
            },
            {
              name: 'jack',
              role: 'Developer',
              workflow: 'Work in the isolated checkout.',
              providerId: 'opencode',
              model: 'openrouter/qwen/qwen3-coder',
              isolation: 'worktree',
              cwd: jackWorktree,
            },
          ],
        }
      );

      const config = JSON.parse(
        fs.readFileSync(path.join(teamDir, 'config.json'), 'utf8')
      ) as {
        leadSessionId?: string;
        projectPath?: string;
        members: Array<{
          name: string;
          agentId?: string;
          agentType?: string;
          providerId?: string;
          model?: string;
          role?: string;
          workflow?: string;
          isolation?: string;
          cwd?: string;
        }>;
      };

      expect(config.leadSessionId).toBe('new-lead-session');
      expect(config.projectPath).toBe(tempClaudeRoot);
      expect(config.members).toEqual([
        expect.objectContaining({
          name: 'team-lead',
          providerId: 'codex',
          model: 'gpt-5.4',
        }),
        expect.objectContaining({
          name: 'bob',
          agentId: `bob@${teamName}`,
          agentType: 'general-purpose',
          role: 'Developer',
          providerId: 'opencode',
          model: 'openrouter/google/gemini-2.5-flash',
        }),
        expect.objectContaining({
          name: 'jack',
          agentId: `jack@${teamName}`,
          agentType: 'general-purpose',
          role: 'Developer',
          workflow: 'Work in the isolated checkout.',
          providerId: 'opencode',
          model: 'openrouter/qwen/qwen3-coder',
          isolation: 'worktree',
          cwd: jackWorktree,
        }),
      ]);
      expect(config.members.some((member) => member.name === 'alice')).toBe(false);
    });

    it('launches isolated OpenCode side lanes from the resolved member worktree cwd', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);

      const bobWorktree = path.join(tempClaudeRoot, 'worktrees', 'bob');
      const worktreeManager = {
        ensureMemberWorktree: vi.fn(async () => ({
          baseRepoPath: tempClaudeRoot,
          worktreePath: bobWorktree,
          branchName: 'agent-teams/test/bob',
        })),
      };
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => {
        const expectedMembers = input.expectedMembers as Array<{ name: string }>;
        const memberName = expectedMembers[0]?.name ?? 'unknown';
        return {
          runId: String(input.runId),
          teamName: String(input.teamName),
          launchPhase: 'finished',
          teamLaunchState: 'clean_success',
          members: {
            [memberName]: {
              memberName,
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
        };
      });

      const { svc, membersMetaStore } = createSafeLaunchService({ memberWorktreeManager: worktreeManager });
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

      const { runId } = await svc.createTeam(
        {
          teamName: 'safe-mixed-opencode-worktree-launch',
          cwd: tempClaudeRoot,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          members: [
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
            },
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
              isolation: 'worktree',
            },
          ],
        },
        () => {}
      );

      expect(worktreeManager.ensureMemberWorktree).toHaveBeenCalledWith({
        teamName: 'safe-mixed-opencode-worktree-launch',
        memberName: 'bob',
        baseCwd: tempClaudeRoot,
      });
      expect(membersMetaStore.writeMembers).toHaveBeenCalledWith(
        'safe-mixed-opencode-worktree-launch',
        expect.arrayContaining([
          expect.objectContaining({
            name: 'bob',
            providerId: 'opencode',
            isolation: 'worktree',
            cwd: bobWorktree,
          }),
        ]),
        expect.objectContaining({ providerBackendId: 'codex-native' })
      );

      const run = (svc as any).runs.get(runId);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(() => expect(adapterLaunch).toHaveBeenCalledTimes(1));
      expect(adapterLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: 'secondary:opencode:bob',
          cwd: bobWorktree,
          expectedMembers: [
            expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              isolation: 'worktree',
              cwd: bobWorktree,
            }),
          ],
        })
      );

      await svc.cancelProvisioning(runId);
    });

    it('rejects multi-member pure OpenCode worktree isolation instead of sharing one projectPath', async () => {
      allowConsoleLogs();
      const adapterLaunch = vi.fn();
      const { svc } = createSafeLaunchService();
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

      await expect(
        svc.createTeam(
          {
            teamName: 'blocked-opencode-multi-worktree',
            cwd: tempClaudeRoot,
            providerId: 'opencode',
            providerBackendId: 'adapter',
            model: 'big-pickle',
            members: [
              {
                name: 'bob',
                providerId: 'opencode',
                model: 'minimax-m2.5-free',
                isolation: 'worktree',
              },
              {
                name: 'tom',
                providerId: 'opencode',
                model: 'nemotron-3-super-free',
              },
            ],
          },
          () => {}
        )
      ).rejects.toThrow('Multiple OpenCode members in one lane cannot use separate worktrees yet');
      expect(adapterLaunch).not.toHaveBeenCalled();
    });
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

  it('marks persisted bootstrap as confirmed when member transcript shows successful member_briefing', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-transcript-success';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'alice-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['alice', 'bob']);
    writeLaunchState(teamName, leadSessionId, {
      alice: {
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        firstSpawnAcceptedAt: acceptedAt,
      },
      bob: {
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
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "alice".`,
          },
        }),
        JSON.stringify({
          timestamp: successAt,
          teamName,
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'item_1',
                content: `Member briefing for alice on team "${teamName}" (${teamName}).\nTask briefing for alice:\nNo actionable tasks.`,
                is_error: false,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              livenessKind: 'runtime_process',
              runtimeDiagnostic: 'verified runtime process detected',
            },
          ],
        ])
    );

    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
    });
    expect(result.statuses.alice?.error).toBeUndefined();
  });

  it('does not classify the bootstrap instruction prompt as a member launch failure', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-prompt-not-failure';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'alice-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['alice']);

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: acceptedAt,
        teamName,
        agentName: 'alice',
        type: 'user',
        message: {
          role: 'user',
          content: `You are bootstrapping into team "${teamName}" as member "alice".\nYour first action is to call the MCP tool member_briefing on the agent-teams server with teamName="${teamName}" and memberName="alice".\nIf member_briefing is still unavailable after that one retry, send exactly one short SendMessage to "team-lead" with the exact error text, then stop this turn and wait.`,
        },
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const reason = await (svc as any).findBootstrapTranscriptFailureReason(
      teamName,
      'alice',
      Date.parse(acceptedAt) - 1
    );

    expect(reason).toBeNull();
  });

  it('clears a stale persisted bootstrap-prompt failure when member_briefing later succeeds', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-stale-prompt-failure';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'alice-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    const staleReason = `You are bootstrapping into team "${teamName}" as member "alice".\nYour first action is to call the MCP tool member_briefing on the agent-teams server with teamName="${teamName}" and memberName="alice".\nIf tool search shows only the prefixed MCP name, use mcp__agent-teams__member_briefing.`;

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['alice', 'bob']);
    writeLaunchState(teamName, leadSessionId, {
      alice: {
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: staleReason,
        firstSpawnAcceptedAt: acceptedAt,
      },
      bob: {
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
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
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: staleReason,
          },
        }),
        JSON.stringify({
          timestamp: successAt,
          teamName,
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'item_1',
                content: `Member briefing for alice on team "${teamName}" (${teamName}).\nTask briefing for alice:\nNo actionable tasks.`,
                is_error: false,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(result.statuses.alice?.hardFailureReason).toBeUndefined();
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

  it('marks a live teammate bootstrap as confirmed when transcript shows successful member_briefing', async () => {
    allowConsoleLogs();
    const teamName = 'zz-live-bootstrap-transcript-success';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'alice-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['alice']);

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: acceptedAt,
          teamName,
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "alice".`,
          },
        }),
        JSON.stringify({
          timestamp: successAt,
          teamName,
          agentName: 'alice',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Bootstrap выполнен для \`alice\` в команде \`${teamName}\`.`,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const run = {
      runId: 'run-live-success-1',
      teamName,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      request: {
        members: [],
      },
      expectedMembers: ['alice'],
      memberSpawnStatuses: new Map([
        [
          'alice',
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

    await (svc as any).reconcileBootstrapTranscriptSuccesses(run);

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(run.provisioningOutputParts.join('\n')).toContain('bootstrap confirmed via transcript');
  });

  it('marks a live teammate bootstrap as confirmed from transcript even when runtime discovery is stale', async () => {
    allowConsoleLogs();
    const teamName = 'zz-live-bootstrap-transcript-success-without-runtime';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'atlas-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['atlas']);

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: acceptedAt,
          teamName,
          agentName: 'atlas',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "atlas".`,
          },
        }),
        JSON.stringify({
          timestamp: successAt,
          teamName,
          agentName: 'atlas',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Bootstrap выполнен для \`atlas\` в команде \`${teamName}\`.`,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const run = {
      runId: 'run-live-success-2',
      teamName,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      request: {
        members: [],
      },
      expectedMembers: ['atlas'],
      memberSpawnStatuses: new Map([
        [
          'atlas',
          {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            error: undefined,
            updatedAt: acceptedAt,
            runtimeAlive: false,
            livenessSource: undefined,
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

    await (svc as any).reconcileBootstrapTranscriptSuccesses(run);

    expect(run.memberSpawnStatuses.get('atlas')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: false,
      bootstrapConfirmed: true,
    });
    expect(run.provisioningOutputParts.join('\n')).toContain('bootstrap confirmed via transcript');
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

    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
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

  it('maps suffixed teammate heartbeats back onto the expected member during live refresh', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      startedAt: '2026-04-16T09:00:00.000Z',
      expectedMembers: ['alice'],
    });

    vi.spyOn((svc as any).inboxReader, 'getMessagesFor').mockResolvedValue([
      {
        from: 'alice-2',
        text: '{"type":"heartbeat","timestamp":"2026-04-16T10:00:00.000Z"}',
        timestamp: '2026-04-16T10:00:00.000Z',
        messageId: 'msg-suffixed',
        read: false,
      },
    ]);

    await (svc as any).refreshMemberSpawnStatusesFromLeadInbox(run);

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
    });
    expect(run.memberSpawnLeadInboxCursorByMember.get('alice')).toEqual({
      timestamp: '2026-04-16T10:00:00.000Z',
      messageId: 'msg-suffixed',
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

  it('keeps duplicate_skipped already_running pending without strong evidence', () => {
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
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
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
              livenessKind: 'runtime_process',
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

  it('does not clear OpenCode bridge launch failure from process-only liveness', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob',
            {
              alive: false,
              model: 'openrouter/google/gemini-2.5-flash',
              livenessKind: 'runtime_process_candidate',
              providerId: 'opencode',
              runtimeDiagnostic:
                'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
              runtimeDiagnosticSeverity: 'warning',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('12vector-room-10', {
      bob: createMemberSpawnStatusEntry({
        status: 'error',
        launchState: 'failed_to_start',
        error: 'OpenCode bridge reported member launch failure',
        hardFailure: true,
        hardFailureReason: 'OpenCode bridge reported member launch failure',
      }),
    });

    expect(result.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: false,
      hardFailure: true,
      hardFailureReason: 'OpenCode bridge reported member launch failure',
      error: 'OpenCode bridge reported member launch failure',
      runtimeModel: 'openrouter/google/gemini-2.5-flash',
      livenessKind: 'runtime_process_candidate',
      runtimeDiagnostic:
        'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
      runtimeDiagnosticSeverity: 'warning',
      livenessSource: undefined,
    });
  });

  it('maps suffixed live runtime metadata keys back onto canonical spawn statuses', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob-2',
            {
              alive: true,
              model: 'gpt-5.2',
              livenessKind: 'runtime_process',
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

  it('downgrades stale process liveness to pending when live metadata is weak', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob',
            {
              alive: false,
              livenessKind: 'runtime_process_candidate',
              runtimeDiagnostic:
                'OpenCode runtime pid is alive, but process identity is unverified',
              runtimeDiagnosticSeverity: 'warning',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('beacon-desk-4', {
      bob: createMemberSpawnStatusEntry({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        livenessSource: 'process',
        bootstrapConfirmed: false,
        hardFailure: false,
      }),
    });

    expect(result.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      livenessSource: undefined,
      livenessKind: 'runtime_process_candidate',
      runtimeDiagnostic: 'OpenCode runtime pid is alive, but process identity is unverified',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('keeps process table diagnostics visible when live metadata has no primary diagnostic', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob',
            {
              alive: false,
              livenessKind: 'not_found',
              runtimeDiagnosticSeverity: 'warning',
              diagnostics: ['process table is unavailable'],
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('beacon-desk-4', {
      bob: createMemberSpawnStatusEntry({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      }),
    });

    expect(result.bob).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      livenessKind: 'not_found',
      runtimeDiagnostic: 'process table unavailable',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('classifies process table unavailable launch diagnostics with natural wording', () => {
    const svc = new TeamProvisioningService();
    const onProgress = vi.fn();
    const run = createMemberSpawnRun({
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            livenessKind: 'shell_only',
            runtimeDiagnostic: 'tmux pane foreground command is zsh; process table is unavailable',
          }),
        ],
      ]),
    });
    run.isLaunch = true;
    run.progress = {
      runId: run.runId,
      teamName: run.teamName,
      status: 'running',
      updatedAt: '2026-04-22T12:00:00.000Z',
    };
    run.onProgress = onProgress;

    (svc as any).setMemberSpawnStatus(run, 'bob', 'online', undefined, 'process');

    expect(run.progress.launchDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberName: 'bob',
          code: 'process_table_unavailable',
          severity: 'warning',
          detail: 'tmux pane foreground command is zsh; process table is unavailable',
        }),
      ])
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        launchDiagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'process_table_unavailable' }),
        ]),
      })
    );
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
      hardFailure: true,
      hardFailureReason: 'Teammate did not join within the launch grace window.',
      error: 'Teammate did not join within the launch grace window.',
      runtimeModel: 'gpt-5.3-codex',
    });
  });

  it('does not resurrect a skipped teammate when live runtime metadata is strong', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              livenessKind: 'runtime_process',
              pid: 123,
              providerId: 'codex',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('codex-team', {
      bob: createMemberSpawnStatusEntry({
        status: 'skipped',
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        agentToolAccepted: false,
        skipReason: 'Skipped by user after launch failure: spawn failed',
      }),
    });

    expect(result.bob).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      error: undefined,
      livenessSource: undefined,
    });
  });

  it('does not resurrect a skipped teammate during spawn status audit', async () => {
    const run = createMemberSpawnRun({
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'skipped',
            launchState: 'skipped_for_launch',
            skippedForLaunch: true,
            skipReason: 'Skipped by user after launch failure: spawn failed',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            firstSpawnAcceptedAt: undefined,
          }),
        ],
      ]),
    });
    const svc = new TeamProvisioningService();
    (svc as any).getRegisteredTeamMemberNames = vi.fn(async () => new Set(['bob']));
    (svc as any).getLiveTeamAgentNames = vi.fn(async () => new Set(['bob']));

    await (svc as any).auditMemberSpawnStatuses(run);

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('does not convert a skipped teammate to failed during final missing-member reconciliation', async () => {
    const run = createMemberSpawnRun({
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'skipped',
            launchState: 'skipped_for_launch',
            skippedForLaunch: true,
            skipReason: 'Skipped by user after launch failure: spawn failed',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            firstSpawnAcceptedAt: undefined,
          }),
        ],
      ]),
    });
    const svc = new TeamProvisioningService();
    (svc as any).getRegisteredTeamMemberNames = vi.fn(async () => new Set());

    await (svc as any).finalizeMissingRegisteredMembersAsFailed(run);

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
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

  it('reconciles extra persisted launch members when bootstrap state proves they were registered', async () => {
    const teamName = 'registered-bootstrap-extra-member-team';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify(
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'active',
          expectedMembers: ['alice', 'bob'],
          members: {
            alice: {
              name: 'alice',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: new Date().toISOString(),
            },
            bob: {
              name: 'bob',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate was never spawned during launch.',
              lastEvaluatedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date().toISOString(),
        })
      ),
      'utf8'
    );
    writeBootstrapState(
      teamName,
      [
        {
          name: 'bob',
          status: 'registered',
          lastAttemptAt: Date.now() - 60_000,
          lastObservedAt: Date.now() - 60_000,
        },
      ],
      new Date(Date.now() - 30_000).toISOString()
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.expectedMembers).toEqual(['alice', 'bob']);
    expect(result.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      hardFailure: false,
      hardFailureReason: undefined,
      agentToolAccepted: true,
    });
  });

  it('keeps suffixed weak runtime metadata pending during persisted launch reconcile', async () => {
    const teamName = 'suffixed-live-runtime-team';
    const leadSessionId = 'lead-session';
    writeLaunchConfig(teamName, '/Users/test/proj', leadSessionId, ['alice']);
    writeLaunchState(teamName, leadSessionId, {
      alice: {
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        firstSpawnAcceptedAt: new Date(Date.now() - 5_000).toISOString(),
      },
    });

    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'alice-2',
            {
              alive: false,
              livenessKind: 'registered_only',
              runtimeDiagnostic: 'registered runtime metadata without live process',
            },
          ],
        ])
    );

    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
    });
  });

  it('treats suffixed persisted heartbeat senders as the expected member during reconcile', async () => {
    const teamName = 'suffixed-heartbeat-reconcile-team';
    const svc = new TeamProvisioningService();
    (svc as any).launchStateStore = {
      read: vi.fn(async () =>
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'active',
          expectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              hardFailureReason: undefined,
              firstSpawnAcceptedAt: '2026-04-16T09:55:00.000Z',
              lastEvaluatedAt: '2026-04-16T09:55:00.000Z',
            },
            bob: {
              name: 'bob',
              launchState: 'starting',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-16T09:55:00.000Z',
            },
          },
          updatedAt: '2026-04-16T09:55:00.000Z',
        })
      ),
      write: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    fs.mkdirSync(path.join(tempTeamsBase, teamName, 'inboxes'), { recursive: true });
    fs.writeFileSync(
      path.join(tempTeamsBase, teamName, 'inboxes', 'team-lead.json'),
      JSON.stringify(
        [
          {
            from: 'alice-2',
            text: 'heartbeat',
            timestamp: '2026-04-16T10:00:00.000Z',
            messageId: 'msg-suffixed-reconcile',
            read: false,
          },
        ],
        null,
        2
      )
    );
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());

    const result = await (svc as any).reconcilePersistedLaunchState(teamName);

    expect(result.snapshot.members.alice).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      lastHeartbeatAt: '2026-04-16T10:00:00.000Z',
    });
    expect(result.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('returns persisted expectedMembers as the union of expected and materialized launch members', async () => {
    const teamName = 'persisted-union-member-spawn-team';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify(
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'active',
          expectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
            bob: {
              name: 'bob',
              launchState: 'runtime_pending_permission',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: false,
              hardFailure: false,
              pendingPermissionRequestIds: ['perm-bob'],
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
          },
          updatedAt: '2026-04-23T10:00:00.000Z',
        })
      ),
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.expectedMembers).toEqual(['alice', 'bob']);
    expect(result.statuses.bob).toMatchObject({
      launchState: 'runtime_pending_permission',
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

  it('recovers stale mixed secondary lanes from live OpenCode runtime reconcile before degrading them', async () => {
    const teamName = 'relay-works-7';
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

    const adapterReconcile = vi.fn(async (input: Record<string, unknown>) => {
      const member = (input.expectedMembers as Array<{ name: string }>)[0]?.name;
      return {
        runId: String(input.runId),
        teamName,
        launchPhase: 'reconciled',
        teamLaunchState: 'clean_success',
        members: member
          ? {
              [member]: {
                memberName: member,
                providerId: 'opencode',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                diagnostics: ['bootstrap confirmed'],
              },
            }
          : {},
        snapshot: null,
        warnings: [],
        diagnostics: [],
      };
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: adapterReconcile,
          stop: vi.fn(),
        } as any,
      ])
    );

    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(adapterReconcile).toHaveBeenCalledTimes(2);
    expect(adapterReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        laneId: 'secondary:opencode:atlas',
        reason: 'startup_recovery',
        expectedMembers: [
          expect.objectContaining({
            name: 'atlas',
            providerId: 'opencode',
            cwd: '/Users/test/proj',
          }),
        ],
      })
    );
    expect(adapterReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        laneId: 'secondary:opencode:tom',
        reason: 'startup_recovery',
        expectedMembers: [
          expect.objectContaining({
            name: 'tom',
            providerId: 'opencode',
            cwd: '/Users/test/proj',
          }),
        ],
      })
    );
    expect(result.expectedMembers).toEqual(expect.arrayContaining(['atlas', 'bob', 'nova', 'tom']));
    expect(result.statuses.atlas).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(result.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:atlas': {
          state: 'active',
        },
        'secondary:opencode:tom': {
          state: 'active',
        },
      },
    });
  });

  it('reconciles stale persisted mixed pending OpenCode lanes instead of keeping them pending forever', async () => {
    const teamName = 'signal-ops-7';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'alice',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
      },
      {
        name: 'jack',
        providerId: 'opencode',
        model: 'opencode/ling-2.6-flash-free',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['alice']);
    writeBootstrapState(teamName, [{ name: 'alice', status: 'registered' }]);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:jack',
      state: 'active',
    });

    fs.writeFileSync(
      getTeamLaunchStatePath(teamName),
      `${JSON.stringify(
        {
          version: 2,
          teamName,
          updatedAt: '2026-04-23T10:00:00.000Z',
          expectedMembers: ['alice', 'jack'],
          bootstrapExpectedMembers: ['alice'],
          leadSessionId: 'lead-session',
          launchPhase: 'finished',
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
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
            jack: {
              name: 'jack',
              providerId: 'opencode',
              model: 'opencode/ling-2.6-flash-free',
              laneId: 'secondary:opencode:jack',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'starting',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              diagnostics: ['Launching through OpenCode secondary lane.'],
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_pending',
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.statuses.jack).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: expect.stringContaining('no lane state exists on disk'),
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:jack': {
          state: 'degraded',
        },
      },
    });
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

  it('keeps finished OpenCode secondary lanes pending when runtime evidence has not materialized yet', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'maybeAuditMemberSpawnStatuses').mockResolvedValue(undefined);

    const run = createMemberSpawnRun({
      teamName: 'mixed-live-finished-no-evidence',
      runId: 'run-mixed-live-2',
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
      teamName: 'mixed-live-finished-no-evidence',
      cwd: '/tmp/mixed-live-finished-no-evidence',
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
        runId: 'lane-run-atlas',
        state: 'finished',
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
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      hardFailure: false,
      hardFailureReason: undefined,
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

  it('syncs stale live mixed-lane failures from a healthier persisted snapshot', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      teamName: 'forge-labs-4',
      runId: 'run-mixed-sync-1',
      expectedMembers: ['alice', 'jack'],
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        ],
        [
          'jack',
          createMemberSpawnStatusEntry({
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            error: 'Teammate was never spawned during launch.',
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
        ],
      ]),
    });
    run.isLaunch = true;

    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'forge-labs-4',
      leadSessionId: 'lead-session',
      launchPhase: 'finished',
      expectedMembers: ['alice', 'jack'],
      members: {
        alice: {
          name: 'alice',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-23T08:08:27.067Z',
        },
        jack: {
          name: 'jack',
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-23T08:08:27.067Z',
        },
      },
      updatedAt: '2026-04-23T08:08:27.067Z',
    });

    vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(svc as any, 'isCurrentTrackedRun').mockReturnValue(true);

    await (svc as any).publishMixedSecondaryLaneStatusChange(run, {
      laneId: 'secondary:opencode:jack',
      providerId: 'opencode',
      member: {
        name: 'jack',
        providerId: 'opencode',
        model: 'opencode/ling-2.6-flash-free',
      },
      runId: 'lane-run-jack',
      state: 'finished',
      result: null,
      warnings: [],
      diagnostics: [],
    });

    expect(run.memberSpawnStatuses.get('jack')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      bootstrapConfirmed: true,
      runtimeAlive: true,
    });
    expect(run.expectedMembers).toEqual(['alice', 'jack']);
  });
});
