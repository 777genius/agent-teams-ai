import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspaceTrustPathCandidates } from '@features/workspace-trust/main';

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
  sendKeysToTmuxPaneForCurrentPlatform: vi.fn(async () => undefined),
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

import {
  getMixedLaunchFallbackRecoveryError,
  TeamProvisioningService,
} from '@main/services/team/TeamProvisioningService';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';
import {
  clearAutoResumeService,
  getAutoResumeService,
  initializeAutoResumeService,
} from '@main/services/team/AutoResumeService';
import { getTeamBootstrapStatePath } from '@main/services/team/TeamBootstrapStateReader';
import {
  createPersistedLaunchSnapshot,
  snapshotFromRuntimeMemberStatuses,
} from '@main/services/team/TeamLaunchStateEvaluator';
import {
  getTeamLaunchStatePath,
  getTeamLaunchSummaryPath,
} from '@main/services/team/TeamLaunchStateStore';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeRuntimeManifestPath,
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createDefaultRuntimeStoreManifest,
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreBatchWriter,
} from '@main/services/team/opencode/store/RuntimeStoreManifest';
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
  sendKeysToTmuxPaneForCurrentPlatform,
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  members: Record<string, Record<string, unknown>>,
  options?: {
    launchPhase?: 'active' | 'finished';
    updatedAt?: string;
  }
): void {
  const snapshot = createPersistedLaunchSnapshot({
    teamName,
    leadSessionId,
    launchPhase: options?.launchPhase ?? 'finished',
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
    ...(options?.updatedAt ? { updatedAt: options.updatedAt } : {}),
  });
  fs.writeFileSync(
    getTeamLaunchStatePath(teamName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
}

function writeBootstrapState(
  teamName: string,
  members: {
    name: string;
    status: string;
    lastAttemptAt?: number;
    lastObservedAt?: number;
    failureReason?: string;
  }[],
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

function writeAliveProcessRegistry(teamName: string): void {
  const teamDir = path.join(tempTeamsBase, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'processes.json'),
    `${JSON.stringify(
      [
        {
          id: 'lead-process',
          label: 'Team Lead',
          pid: process.pid,
          registeredAt: '2026-04-23T10:00:00.000Z',
        },
      ],
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

async function writeCommittedOpenCodeSessionStore(input: {
  teamName: string;
  laneId: string;
  runId: string;
  sessions: unknown[];
}): Promise<void> {
  const descriptor = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
    (candidate) => candidate.schemaName === 'opencode.sessionStore'
  );
  if (!descriptor) throw new Error('session descriptor missing');
  const manifestPath = getOpenCodeRuntimeManifestPath(tempTeamsBase, input.teamName, input.laneId);
  const runtimeDirectory = path.dirname(manifestPath);
  await fsPromises.mkdir(runtimeDirectory, { recursive: true });
  const writer = new RuntimeStoreBatchWriter(
    runtimeDirectory,
    createRuntimeStoreManifestStore({ filePath: manifestPath, teamName: input.teamName }),
    createRuntimeStoreReceiptStore({
      filePath: path.join(runtimeDirectory, 'opencode-runtime-receipts.json'),
    }),
    {
      clock: () => new Date('2026-04-22T12:00:00.000Z'),
      batchIdFactory: () => `batch-${input.runId}`,
      receiptIdFactory: () => `receipt-${input.runId}`,
    }
  );
  await writer.writeBatch({
    teamName: input.teamName,
    runId: input.runId,
    capabilitySnapshotId: null,
    behaviorFingerprint: null,
    reason: 'launch_checkpoint',
    writes: [{ descriptor, data: { sessions: input.sessions } }],
  });
}

async function writeDefaultBobOpenCodeBootstrapEvidence(): Promise<void> {
  await writeCommittedOpenCodeSessionStore({
    teamName: 'team-a',
    laneId: 'secondary:opencode:bob',
    runId: 'opencode-run-bob',
    sessions: [
      {
        id: 'oc-session-bob',
        teamName: 'team-a',
        memberName: 'bob',
        laneId: 'secondary:opencode:bob',
        runId: 'opencode-run-bob',
        source: 'runtime_bootstrap_checkin',
      },
    ],
  });
}

async function configureOpenCodeBobDeliveryService(input: {
  svc: TeamProvisioningService;
  sendMessageToMember: ReturnType<typeof vi.fn>;
  observeMessageDelivery?: ReturnType<typeof vi.fn>;
  memberModel?: string;
}): Promise<void> {
  const registry = new TeamRuntimeAdapterRegistry([
    {
      providerId: 'opencode',
      prepare: vi.fn(),
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
      sendMessageToMember: input.sendMessageToMember,
      observeMessageDelivery: input.observeMessageDelivery ?? vi.fn(),
    } as any,
  ]);
  input.svc.setRuntimeAdapterRegistry(registry);

  (input.svc as any).getTrackedRunId = vi.fn(() => 'run-1');
  (input.svc as any).provisioningRunByTeam.set('team-a', 'run-1');
  (input.svc as any).setSecondaryRuntimeRun({
    teamName: 'team-a',
    runId: 'opencode-run-bob',
    providerId: 'opencode',
    laneId: 'secondary:opencode:bob',
    memberName: 'bob',
    cwd: '/repo',
  });
  await writeDefaultBobOpenCodeBootstrapEvidence();
  (input.svc as any).configReader = {
    getConfig: vi.fn(async () => ({
      projectPath: '/repo',
      members: [
        { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
        {
          name: 'bob',
          providerId: 'opencode',
          model: input.memberModel ?? 'minimax-m2.5-free',
        },
      ],
    })),
  };
  (input.svc as any).teamMetaStore = {
    getMeta: vi.fn(async () => ({
      launchIdentity: { providerId: 'codex' },
      providerId: 'codex',
    })),
  };
  (input.svc as any).membersMetaStore = {
    getMembers: vi.fn(async () => [
      {
        name: 'bob',
        providerId: 'opencode',
        model: input.memberModel ?? 'opencode/minimax-m2.5-free',
      },
    ]),
  };
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
  mixedSecondaryLanes?: Array<{ providerId: string; member: { name: string } }>;
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
    mixedSecondaryLanes: params?.mixedSecondaryLanes ?? [],
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

const TEST_OPENCODE_APP_MANAGED_BOOTSTRAP_PROMPT = [
  'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
  '<agent_teams_app_managed_briefing_source>',
  'Test app-managed member briefing.',
  '</agent_teams_app_managed_briefing_source>',
].join('\n');

function stubOpenCodeAppManagedLaunchPrompt(svc: TeamProvisioningService) {
  return vi
    .spyOn(svc as any, 'buildOpenCodeSecondaryAppManagedLaunchPrompt')
    .mockImplementation(async (_run: unknown, lane: unknown) => {
      const memberName =
        lane &&
        typeof lane === 'object' &&
        'member' in lane &&
        lane.member &&
        typeof lane.member === 'object' &&
        'name' in lane.member &&
        typeof lane.member.name === 'string'
          ? lane.member.name
          : 'unknown';
      return `${TEST_OPENCODE_APP_MANAGED_BOOTSTRAP_PROMPT}\nmember=${memberName}`;
    });
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

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
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
    vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockReset();
    vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockResolvedValue(undefined);
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
    writeAliveProcessRegistry('team-a');
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

  describe('OpenCode runtime delivery user-visible impact', () => {
    it('treats policy none as authoritative over raw failed delivery facts', () => {
      const svc = new TeamProvisioningService();

      expect(
        svc.buildOpenCodeRuntimeDeliveryUserVisibleImpact({
          delivered: false,
          responsePending: false,
          ledgerStatus: 'failed_terminal',
          reason: 'empty_assistant_turn',
          diagnostics: ['empty_assistant_turn'],
          policyImpact: { state: 'none' },
        })
      ).toEqual({ state: 'none' });
    });
  });

  describe('team launch notifications', () => {
    it('fires team launched when the last pending teammate joins after ready', async () => {
      const { NotificationManager } =
        await import('@main/services/infrastructure/NotificationManager');
      const addTeamNotification = vi.fn(async (_payload: unknown) => undefined);
      NotificationManager.setInstance({ addTeamNotification } as never);

      try {
        const svc = new TeamProvisioningService();
        const run = {
          runId: 'run-late-all-joined',
          teamName: 'late-all-joined-team',
          isLaunch: true,
          provisioningComplete: true,
          processKilled: false,
          cancelRequested: false,
          progress: { state: 'ready' },
          request: {
            cwd: tempClaudeRoot,
            displayName: 'late-all-joined-team',
          },
          expectedMembers: ['alice', 'bob'],
          allEffectiveMembers: [{ name: 'alice' }, { name: 'bob' }],
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
            [
              'bob',
              createMemberSpawnStatusEntry({
                status: 'waiting',
                launchState: 'runtime_pending_bootstrap',
                runtimeAlive: true,
                bootstrapConfirmed: false,
              }),
            ],
          ]),
        };
        (svc as any).runs.set(run.runId, run);
        (svc as any).aliveRunByTeam.set(run.teamName, run.runId);

        (svc as any).emitMemberSpawnChange(run, 'bob');
        expect(addTeamNotification).not.toHaveBeenCalled();

        run.memberSpawnStatuses.set(
          'bob',
          createMemberSpawnStatusEntry({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
          })
        );

        (svc as any).emitMemberSpawnChange(run, 'bob');
        await Promise.resolve();

        expect(addTeamNotification).toHaveBeenCalledTimes(1);
        expect(addTeamNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            teamEventType: 'team_launched',
            teamName: 'late-all-joined-team',
            dedupeKey: 'team_launched:late-all-joined-team:run-late-all-joined',
            body: 'Team "late-all-joined-team" has been launched - all 2 teammates joined and are ready for tasks.',
          })
        );

        (svc as any).emitMemberSpawnChange(run, 'bob');
        await Promise.resolve();
        expect(addTeamNotification).toHaveBeenCalledTimes(1);
      } finally {
        NotificationManager.resetInstance();
      }
    });

    it('does not fire incomplete notification for pending-only teammates still joining', async () => {
      const { NotificationManager } =
        await import('@main/services/infrastructure/NotificationManager');
      const addTeamNotification = vi.fn(async (_payload: unknown) => undefined);
      NotificationManager.setInstance({ addTeamNotification } as never);

      try {
        const svc = new TeamProvisioningService();
        const run = {
          runId: 'run-beacon-desk-15',
          teamName: 'beacon-desk-15',
          isLaunch: true,
          request: {
            cwd: tempClaudeRoot,
            displayName: 'beacon-desk-15',
          },
          expectedMembers: ['alice', 'bob', 'jack', 'tom'],
          allEffectiveMembers: [
            { name: 'alice' },
            { name: 'bob' },
            { name: 'jack' },
            { name: 'tom' },
          ],
          memberSpawnStatuses: new Map(
            ['alice', 'bob', 'jack', 'tom'].map((name) => [
              name,
              createMemberSpawnStatusEntry({
                status: 'waiting',
                launchState: 'runtime_pending_bootstrap',
                runtimeAlive: true,
                bootstrapConfirmed: false,
                hardFailure: false,
              }),
            ])
          ),
        };
        const pendingSnapshot = {
          expectedMembers: ['alice', 'bob', 'jack', 'tom'],
          members: Object.fromEntries(
            ['alice', 'bob', 'jack', 'tom'].map((name) => [
              name,
              {
                name,
                launchState: 'runtime_pending_bootstrap',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: false,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-13T10:00:00.000Z',
              },
            ])
          ),
          summary: {
            confirmedCount: 0,
            pendingCount: 4,
            failedCount: 0,
            runtimeAlivePendingCount: 4,
          },
        };

        await (svc as any).fireTeamLaunchIncompleteNotification(
          run,
          [],
          pendingSnapshot.summary,
          pendingSnapshot
        );
      } finally {
        NotificationManager.resetInstance();
      }

      expect(addTeamNotification).not.toHaveBeenCalled();
    });

    it('ignores stale failed summary without concrete failed member evidence', async () => {
      const { NotificationManager } =
        await import('@main/services/infrastructure/NotificationManager');
      const addTeamNotification = vi.fn(async (_payload: unknown) => undefined);
      NotificationManager.setInstance({ addTeamNotification } as never);

      try {
        const svc = new TeamProvisioningService();
        const run = {
          runId: 'run-stale-summary',
          teamName: 'stale-summary-team',
          isLaunch: true,
          request: {
            cwd: tempClaudeRoot,
            displayName: 'stale-summary-team',
          },
          expectedMembers: ['alice'],
          allEffectiveMembers: [{ name: 'alice' }],
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
          ]),
        };
        const staleSnapshot = {
          expectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-13T10:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 0,
            pendingCount: 0,
            failedCount: 1,
            runtimeAlivePendingCount: 0,
          },
        };

        await (svc as any).fireTeamLaunchIncompleteNotification(
          run,
          [],
          staleSnapshot.summary,
          staleSnapshot
        );
      } finally {
        NotificationManager.resetInstance();
      }

      expect(addTeamNotification).not.toHaveBeenCalled();
    });

    it('prefers live confirmed evidence over stale persisted failed member evidence', async () => {
      const { NotificationManager } =
        await import('@main/services/infrastructure/NotificationManager');
      const addTeamNotification = vi.fn(async (_payload: unknown) => undefined);
      NotificationManager.setInstance({ addTeamNotification } as never);

      try {
        const svc = new TeamProvisioningService();
        const run = {
          runId: 'run-live-confirmed',
          teamName: 'live-confirmed-team',
          isLaunch: true,
          request: {
            cwd: tempClaudeRoot,
            displayName: 'live-confirmed-team',
          },
          expectedMembers: ['alice'],
          allEffectiveMembers: [{ name: 'alice' }],
          memberSpawnStatuses: new Map([
            [
              'alice',
              createMemberSpawnStatusEntry({
                status: 'online',
                launchState: 'confirmed_alive',
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
              }),
            ],
          ]),
        };
        const staleSnapshot = {
          expectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'stale failure',
              lastEvaluatedAt: '2026-04-13T10:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 0,
            pendingCount: 0,
            failedCount: 1,
            runtimeAlivePendingCount: 0,
          },
        };

        await (svc as any).fireTeamLaunchIncompleteNotification(
          run,
          [],
          staleSnapshot.summary,
          staleSnapshot
        );
      } finally {
        NotificationManager.resetInstance();
      }

      expect(addTeamNotification).not.toHaveBeenCalled();
    });

    it('uses live member evidence instead of stale summary for incomplete launch copy', async () => {
      const { NotificationManager } =
        await import('@main/services/infrastructure/NotificationManager');
      const addTeamNotification = vi.fn(async (_payload: unknown) => undefined);
      NotificationManager.setInstance({ addTeamNotification } as never);

      try {
        const svc = new TeamProvisioningService();
        const run = {
          runId: 'run-relay-works-18',
          teamName: 'relay-works-18',
          isLaunch: true,
          request: {
            cwd: tempClaudeRoot,
            displayName: 'relay-works-18',
          },
          expectedMembers: ['bob', 'jack', 'alice', 'tom'],
          allEffectiveMembers: [
            { name: 'bob' },
            { name: 'jack' },
            { name: 'alice' },
            { name: 'tom' },
          ],
          memberSpawnStatuses: new Map([
            [
              'bob',
              createMemberSpawnStatusEntry({
                status: 'online',
                launchState: 'confirmed_alive',
                runtimeAlive: true,
                bootstrapConfirmed: true,
              }),
            ],
            [
              'jack',
              createMemberSpawnStatusEntry({
                status: 'online',
                launchState: 'confirmed_alive',
                runtimeAlive: true,
                bootstrapConfirmed: true,
              }),
            ],
            [
              'alice',
              createMemberSpawnStatusEntry({
                status: 'error',
                launchState: 'failed_to_start',
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'Insufficient credits',
              }),
            ],
            [
              'tom',
              createMemberSpawnStatusEntry({
                status: 'waiting',
                launchState: 'runtime_pending_bootstrap',
                runtimeAlive: true,
                bootstrapConfirmed: false,
              }),
            ],
          ]),
        };
        const staleSnapshot = {
          expectedMembers: ['bob', 'jack', 'alice', 'tom'],
          members: Object.fromEntries(
            ['bob', 'jack', 'alice', 'tom'].map((name) => [
              name,
              {
                name,
                launchState: 'runtime_pending_bootstrap',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-13T10:00:00.000Z',
              },
            ])
          ),
          summary: {
            confirmedCount: 0,
            pendingCount: 4,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
        };

        await (svc as any).fireTeamLaunchIncompleteNotification(
          run,
          [{ name: 'alice' }],
          staleSnapshot.summary,
          staleSnapshot
        );
      } finally {
        NotificationManager.resetInstance();
      }

      expect(addTeamNotification).toHaveBeenCalledTimes(1);
      const payload = addTeamNotification.mock.calls[0]![0] as { body: string };
      expect(payload.body).toBe('2/4 joined · failed: @alice · still joining: @tom');
      expect(payload.body).not.toContain('0/4');
      expect(payload.body).not.toContain('did not join');
    });

    it('does not report persisted bootstrap-confirmed primary members as failed from a stale failed list', async () => {
      const { NotificationManager } =
        await import('@main/services/infrastructure/NotificationManager');
      const addTeamNotification = vi.fn(async (_payload: unknown) => undefined);
      NotificationManager.setInstance({ addTeamNotification } as never);

      try {
        const svc = new TeamProvisioningService();
        const run = {
          runId: 'run-forge-labs-15',
          teamName: 'forge-labs-15',
          isLaunch: true,
          request: {
            cwd: tempClaudeRoot,
            displayName: 'forge-labs-15',
          },
          expectedMembers: ['bob', 'jack', 'alice', 'tom'],
          allEffectiveMembers: [
            { name: 'bob' },
            { name: 'jack' },
            { name: 'alice' },
            { name: 'tom' },
          ],
          memberSpawnStatuses: new Map([
            [
              'bob',
              createMemberSpawnStatusEntry({
                status: 'error',
                launchState: 'failed_to_start',
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'Teammate was never spawned during launch.',
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
                hardFailureReason: 'Teammate was never spawned during launch.',
              }),
            ],
            [
              'alice',
              createMemberSpawnStatusEntry({
                status: 'waiting',
                launchState: 'runtime_pending_bootstrap',
                runtimeAlive: false,
                bootstrapConfirmed: false,
              }),
            ],
            [
              'tom',
              createMemberSpawnStatusEntry({
                status: 'online',
                launchState: 'confirmed_alive',
                runtimeAlive: true,
                bootstrapConfirmed: true,
              }),
            ],
          ]),
        };
        const reconciledSnapshot = {
          expectedMembers: ['bob', 'jack', 'alice', 'tom'],
          members: {
            bob: {
              name: 'bob',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-05-04T19:32:37.000Z',
            },
            jack: {
              name: 'jack',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-05-04T19:32:30.000Z',
            },
            alice: {
              name: 'alice',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastEvaluatedAt: '2026-05-04T19:35:49.000Z',
            },
            tom: {
              name: 'tom',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-05-04T19:35:49.000Z',
            },
          },
          summary: {
            confirmedCount: 3,
            pendingCount: 1,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
        };

        await (svc as any).fireTeamLaunchIncompleteNotification(
          run,
          [{ name: 'bob' }, { name: 'jack' }],
          reconciledSnapshot.summary,
          reconciledSnapshot
        );
      } finally {
        NotificationManager.resetInstance();
      }

      expect(addTeamNotification).not.toHaveBeenCalled();
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

    it('writes a launch failure artifact pack when cleanup finalizes failed launch state', async () => {
      allowConsoleLogs();
      const svc = new TeamProvisioningService();
      const teamName = 'launch-artifact-cleanup-team';
      const runId = 'run-launch-artifact-cleanup';
      const startedAt = '2026-05-09T00:25:00.000Z';
      const run = createClaudeLogsRun({
        runId,
        teamName,
        startedAt,
        isLaunch: true,
        provisioningComplete: false,
        cancelRequested: false,
        deterministicBootstrap: true,
        expectedMembers: ['bob'],
        allEffectiveMembers: [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'anthropic',
            model: 'opus',
          },
        ],
        request: {
          cwd: '/repo',
          providerId: 'anthropic',
          model: 'opus',
          members: [
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'anthropic',
              model: 'opus',
            },
          ],
        },
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'spawning',
              launchState: 'runtime_pending_bootstrap',
              runtimeAlive: true,
              firstSpawnAcceptedAt: '2026-05-09T00:25:05.000Z',
              updatedAt: '2026-05-09T00:25:05.000Z',
            }),
          ],
        ]),
        progress: {
          runId,
          teamName,
          state: 'failed',
          message: 'Launch failed',
          startedAt,
          updatedAt: '2026-05-09T00:26:00.000Z',
          error:
            'Teammate process bob@signal-ops did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: bootstrap_submit_rejected: submit rejected by local prompt handler retryable=true Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
        },
        claudeLogLines: [
          '[stderr]',
          'Warning: no stdin data received in 3s, proceeding without it.',
        ],
        provisioningOutputParts: [],
      });

      (svc as any).runs.set(run.runId, run);
      (svc as any).aliveRunByTeam.set(run.teamName, run.runId);
      (svc as any).cleanupRun(run);

      const latestPath = path.join(
        tempTeamsBase,
        teamName,
        'launch-failure-artifacts',
        'latest.json'
      );
      await waitForFile(latestPath);
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as { manifestPath: string };
      const manifest = JSON.parse(fs.readFileSync(latest.manifestPath, 'utf8')) as {
        reason: string;
        classification: { code: string };
        bootstrapTransportBreadcrumb: {
          submitRejected: boolean;
          noStdinWarning: boolean;
          retryable: boolean | null;
        };
      };

      expect(manifest.reason).toBe('launch_progress_failed');
      expect(manifest.classification.code).toBe('transport_rejected');
      expect(manifest.bootstrapTransportBreadcrumb).toMatchObject({
        submitRejected: true,
        noStdinWarning: true,
        retryable: true,
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

  describe('provisioning status', () => {
    it('retains final progress after cleanupRun removes the live run', async () => {
      const svc = new TeamProvisioningService();
      const run = createClaudeLogsRun({
        runId: 'run-retained-progress',
        teamName: 'retained-progress-team',
        provisioningComplete: false,
        progress: {
          runId: 'run-retained-progress',
          teamName: 'retained-progress-team',
          state: 'failed',
          message: 'CLI exited quickly',
          startedAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-04-19T10:00:01.000Z',
          error: 'bootstrap failed',
          warnings: ['retry is safe'],
        },
      });

      (svc as any).runs.set(run.runId, run);
      (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

      (svc as any).cleanupRun(run);

      expect((svc as any).runs.has(run.runId)).toBe(false);
      await expect(svc.getProvisioningStatus(run.runId)).resolves.toMatchObject({
        runId: run.runId,
        teamName: run.teamName,
        state: 'failed',
        message: 'CLI exited quickly',
        error: 'bootstrap failed',
        warnings: ['retry is safe'],
      });
    });

    it('treats result.success as a fallback provisioning completion signal', () => {
      const svc = new TeamProvisioningService();
      const run = createClaudeLogsRun({
        runId: 'run-success-fallback',
        teamName: 'success-fallback-team',
        provisioningComplete: false,
        progress: {
          runId: 'run-success-fallback',
          teamName: 'success-fallback-team',
          state: 'configuring',
          message: 'Waiting for CLI result',
          startedAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-04-19T10:00:01.000Z',
        },
      });
      const complete = vi
        .spyOn(svc as any, 'handleProvisioningTurnComplete')
        .mockResolvedValue(undefined);

      (svc as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

      expect(complete).toHaveBeenCalledWith(run);
    });

    it('finalizes unconfirmed launch members as failed before cleanup removes the run', () => {
      allowConsoleLogs();
      const svc = new TeamProvisioningService();
      const run = createClaudeLogsRun({
        runId: 'run-cleanup-finalizes-launch',
        teamName: 'cleanup-finalizes-launch-team',
        isLaunch: true,
        provisioningComplete: false,
        cancelRequested: false,
        expectedMembers: ['alice', 'bob'],
        provisioningOutputParts: [],
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
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: false,
              livenessSource: 'process',
            }),
          ],
        ]),
      });
      const persist = vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(null);

      (svc as any).runs.set(run.runId, run);
      (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

      (svc as any).cleanupRun(run);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
      });
      expect((svc as any).buildLiveLaunchSnapshotForRun(run, 'finished')).toMatchObject({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 1,
        },
      });
      expect(persist).toHaveBeenCalledWith(run, 'finished');
    });

    it('preserves specific member launch failures when cleanup applies its fallback reason', () => {
      allowConsoleLogs();
      const svc = new TeamProvisioningService();
      const timeoutReason = 'Teammate was registered but did not bootstrap-confirm before timeout.';
      const specificReason = 'OpenCode bridge reported member launch failure';
      const run = createClaudeLogsRun({
        runId: 'run-cleanup-preserves-specific-launch-failure',
        teamName: 'cleanup-preserves-specific-launch-failure-team',
        isLaunch: true,
        provisioningComplete: false,
        cancelRequested: false,
        expectedMembers: ['bob', 'carol'],
        provisioningOutputParts: [],
        progress: {
          runId: 'run-cleanup-preserves-specific-launch-failure',
          teamName: 'cleanup-preserves-specific-launch-failure-team',
          state: 'failed',
          message: 'Deterministic bootstrap failed',
          startedAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-04-19T10:00:01.000Z',
          error: timeoutReason,
        },
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'error',
              launchState: 'failed_to_start',
              error: specificReason,
              hardFailure: true,
              hardFailureReason: specificReason,
              bootstrapConfirmed: false,
              runtimeAlive: true,
              livenessSource: 'process',
            }),
          ],
          [
            'carol',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
            }),
          ],
        ]),
      });
      vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(null);

      (svc as any).runs.set(run.runId, run);
      (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

      (svc as any).cleanupRun(run);

      const bobStatus = run.memberSpawnStatuses.get('bob');
      expect(bobStatus).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailureReason: specificReason,
        runtimeAlive: false,
        runtimeDiagnostic:
          'Bootstrap failed before teammate check-in; launch-owned runtime cleanup requested.',
        runtimeDiagnosticSeverity: 'warning',
      });
      expect(bobStatus?.livenessSource).toBeUndefined();
      expect(run.memberSpawnStatuses.get('carol')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailureReason: timeoutReason,
      });
    });

    it('does not treat non-terminal error text as an existing launch failure during cleanup', () => {
      allowConsoleLogs();
      const svc = new TeamProvisioningService();
      const timeoutReason = 'Teammate was registered but did not bootstrap-confirm before timeout.';
      const run = createClaudeLogsRun({
        runId: 'run-cleanup-non-terminal-error-text',
        teamName: 'cleanup-non-terminal-error-text-team',
        isLaunch: true,
        provisioningComplete: false,
        cancelRequested: false,
        expectedMembers: ['bob'],
        provisioningOutputParts: [],
        progress: {
          runId: 'run-cleanup-non-terminal-error-text',
          teamName: 'cleanup-non-terminal-error-text-team',
          state: 'failed',
          message: 'Deterministic bootstrap failed',
          startedAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-04-19T10:00:01.000Z',
          error: timeoutReason,
        },
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              error: 'Transient runtime diagnostic, not terminal launch failure',
              agentToolAccepted: true,
              bootstrapConfirmed: false,
            }),
          ],
        ]),
      });
      vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(null);

      (svc as any).runs.set(run.runId, run);
      (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

      (svc as any).cleanupRun(run);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: timeoutReason,
        error: timeoutReason,
      });
    });
  });

  describe('member spawn status launch reads', () => {
    it('coalesces concurrent active launch status reads and serves a short cached follow-up', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-cache-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
      });
      run.isLaunch = true;
      run.progress = {
        teamName,
        state: 'launching',
        message: 'Launching',
        updatedAt: '2026-05-02T10:00:00.000Z',
      };
      run.onProgress = vi.fn();
      (svc as any).aliveRunByTeam.set(teamName, run.runId);
      (svc as any).runs.set(run.runId, run);
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      const refreshDeferred = createDeferred<void>();
      const refreshLeadInbox = vi
        .spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox')
        .mockImplementation(async () => refreshDeferred.promise);
      const auditStatuses = vi
        .spyOn(svc as any, 'maybeAuditMemberSpawnStatuses')
        .mockResolvedValue(undefined);
      const persistSnapshot = vi
        .spyOn(svc as any, 'persistLaunchStateSnapshot')
        .mockResolvedValue(null);

      const first = svc.getMemberSpawnStatuses(teamName);
      const second = svc.getMemberSpawnStatuses(teamName);
      await Promise.resolve();

      expect(refreshLeadInbox).toHaveBeenCalledTimes(1);
      refreshDeferred.resolve();
      const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

      expect(firstSnapshot).toEqual(secondSnapshot);
      expect(auditStatuses).toHaveBeenCalledTimes(1);
      expect(persistSnapshot).toHaveBeenCalledTimes(1);

      await svc.getMemberSpawnStatuses(teamName);

      expect(refreshLeadInbox).toHaveBeenCalledTimes(1);
      expect(auditStatuses).toHaveBeenCalledTimes(1);
      expect(persistSnapshot).toHaveBeenCalledTimes(1);
    });

    it('invalidates the short status cache when a real member-spawn change is emitted', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-cache-invalidated-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
      });
      run.isLaunch = true;
      run.progress = {
        teamName,
        state: 'launching',
        message: 'Launching',
        updatedAt: '2026-05-02T10:00:00.000Z',
      };
      run.onProgress = vi.fn();
      (svc as any).aliveRunByTeam.set(teamName, run.runId);
      (svc as any).runs.set(run.runId, run);
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      const refreshLeadInbox = vi
        .spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox')
        .mockResolvedValue(undefined);
      vi.spyOn(svc as any, 'maybeAuditMemberSpawnStatuses').mockResolvedValue(undefined);
      vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(null);

      await svc.getMemberSpawnStatuses(teamName);
      expect(refreshLeadInbox).toHaveBeenCalledTimes(1);

      (svc as any).setMemberSpawnStatus(
        run,
        'alice',
        'online',
        undefined,
        'heartbeat',
        '2026-05-02T10:00:05.000Z'
      );
      await svc.getMemberSpawnStatuses(teamName);

      expect(refreshLeadInbox).toHaveBeenCalledTimes(2);
    });

    it('pauses member task intervals at last runtime evidence plus grace when runtime goes offline', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:05:00.000Z'));
      const pauseSpy = vi
        .spyOn(TeamTaskActivityIntervalService.prototype, 'pauseActiveIntervalsForMember')
        .mockReturnValue({ changedTasks: 0 });
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-runtime-offline-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            {
              status: 'online',
              launchState: 'confirmed_alive',
              updatedAt: '2026-05-02T10:00:02.000Z',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              livenessSource: 'heartbeat',
              lastHeartbeatAt: '2026-05-02T10:00:00.000Z',
              livenessLastCheckedAt: '2026-05-02T10:00:01.000Z',
            },
          ],
        ]),
      });

      (svc as any).setMemberSpawnStatus(run, 'alice', 'offline');

      expect(pauseSpy).toHaveBeenCalledWith(teamName, 'alice', '2026-05-02T10:00:06.000Z');
    });

    it('pauses member task intervals when snapshot sync observes runtime loss', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:05:00.000Z'));
      const pauseSpy = vi
        .spyOn(TeamTaskActivityIntervalService.prototype, 'pauseActiveIntervalsForMember')
        .mockReturnValue({ changedTasks: 0 });
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-runtime-snapshot-offline-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            {
              status: 'online',
              launchState: 'confirmed_alive',
              updatedAt: '2026-05-02T10:00:02.000Z',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              livenessSource: 'heartbeat',
              lastHeartbeatAt: '2026-05-02T10:00:00.000Z',
              livenessLastCheckedAt: '2026-05-02T10:00:01.000Z',
            },
          ],
        ]),
      });
      const snapshot = createPersistedLaunchSnapshot({
        teamName,
        expectedMembers: ['alice'],
        launchPhase: 'finished',
        members: {
          alice: {
            name: 'alice',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Runtime disappeared before finalization.',
            lastEvaluatedAt: '2026-05-02T10:04:00.000Z',
          },
        },
      });

      (svc as any).syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);

      expect(pauseSpy).toHaveBeenCalledWith(teamName, 'alice', '2026-05-02T10:00:06.000Z');
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'error',
        runtimeAlive: false,
        launchState: 'failed_to_start',
      });
    });

    it('resumes member task intervals at the heartbeat evidence time when runtime comes online', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:05:00.000Z'));
      const resumeSpy = vi
        .spyOn(TeamTaskActivityIntervalService.prototype, 'resumeActiveIntervalsForMember')
        .mockReturnValue({ changedTasks: 0 });
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-runtime-online-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            {
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              updatedAt: '2026-05-02T09:59:00.000Z',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
            },
          ],
        ]),
      });

      (svc as any).setMemberSpawnStatus(
        run,
        'alice',
        'online',
        undefined,
        'heartbeat',
        '2026-05-02T10:00:00.000Z'
      );

      expect(resumeSpy).toHaveBeenCalledWith(teamName, 'alice', '2026-05-02T10:00:00.000Z');
    });

    it('does not resume member task intervals from a stale heartbeat older than offline status', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:05:00.000Z'));
      const resumeSpy = vi
        .spyOn(TeamTaskActivityIntervalService.prototype, 'resumeActiveIntervalsForMember')
        .mockReturnValue({ changedTasks: 0 });
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-runtime-stale-heartbeat-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            {
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              updatedAt: '2026-05-02T10:04:00.000Z',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              lastHeartbeatAt: '2026-05-02T10:00:00.000Z',
            },
          ],
        ]),
      });

      (svc as any).setMemberSpawnStatus(
        run,
        'alice',
        'online',
        undefined,
        'heartbeat',
        '2026-05-02T10:00:30.000Z'
      );

      expect(resumeSpy).toHaveBeenCalledWith(teamName, 'alice', '2026-05-02T10:05:00.000Z');
    });

    it('does not resume member task intervals from stale direct runtime evidence', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:05:00.000Z'));
      const resumeSpy = vi
        .spyOn(TeamTaskActivityIntervalService.prototype, 'resumeActiveIntervalsForMember')
        .mockReturnValue({ changedTasks: 0 });
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-runtime-stale-direct-evidence-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
      });
      const previous = {
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        updatedAt: '2026-05-02T10:04:00.000Z',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      };
      const next = {
        ...previous,
        status: 'online',
        launchState: 'confirmed_alive',
        updatedAt: '2026-05-02T10:03:00.000Z',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      };

      (svc as any).syncMemberTaskActivityForRuntimeTransition(
        run,
        'alice',
        previous,
        next,
        '2026-05-02T10:00:30.000Z'
      );

      expect(resumeSpy).toHaveBeenCalledWith(teamName, 'alice', '2026-05-02T10:05:00.000Z');
    });

    it('retries the owner status request when a member-spawn change lands while it is building', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'spawn-cache-owner-retry-team';
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
      });
      run.isLaunch = true;
      run.progress = {
        teamName,
        state: 'launching',
        message: 'Launching',
        updatedAt: '2026-05-02T10:00:00.000Z',
      };
      run.onProgress = vi.fn();
      (svc as any).aliveRunByTeam.set(teamName, run.runId);
      (svc as any).runs.set(run.runId, run);
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      const firstRefresh = createDeferred<void>();
      const refreshLeadInbox = vi
        .spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox')
        .mockImplementationOnce(async () => firstRefresh.promise)
        .mockResolvedValue(undefined);
      vi.spyOn(svc as any, 'maybeAuditMemberSpawnStatuses').mockResolvedValue(undefined);
      vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(null);

      const pending = svc.getMemberSpawnStatuses(teamName);
      await Promise.resolve();
      expect(refreshLeadInbox).toHaveBeenCalledTimes(1);

      (svc as any).setMemberSpawnStatus(
        run,
        'alice',
        'online',
        undefined,
        'heartbeat',
        '2026-05-02T10:00:05.000Z'
      );
      firstRefresh.resolve();
      const result = await pending;

      expect(refreshLeadInbox).toHaveBeenCalledTimes(2);
      expect(result.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
      });
    });
  });

  describe('launch-state no-op persistence guard', () => {
    it('does not clear persisted launch state for an expected run after tracking is gone', () => {
      const svc = new TeamProvisioningService();

      expect(
        (svc as any).canClearPersistedLaunchStateForRun(
          'workspace-trust-stale-clear-team',
          'run-stale'
        )
      ).toBe(false);
    });

    it('does not rewrite launch-state or invalidate runtime cache for a recent semantic no-op', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:00:05.000Z'));
      const svc = new TeamProvisioningService();
      const teamName = 'launch-state-noop-team';
      const status = createMemberSpawnStatusEntry({
        updatedAt: '2026-05-02T10:00:00.000Z',
        firstSpawnAcceptedAt: '2026-05-02T10:00:00.000Z',
      });
      const previousSnapshot = snapshotFromRuntimeMemberStatuses({
        teamName,
        expectedMembers: ['alice'],
        launchPhase: 'active',
        updatedAt: '2026-05-02T10:00:02.000Z',
        statuses: { alice: status as any },
      });
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([['alice', status]]),
      });
      run.isLaunch = true;
      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).launchStateWrittenRunIdByTeam.set(teamName, run.runId);
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      const invalidateRuntime = vi.spyOn(svc as any, 'invalidateRuntimeSnapshotCaches');

      const result = await (svc as any).persistLaunchStateSnapshotNow(run, 'active');

      expect(result).toBe(previousSnapshot);
      expect((svc as any).launchStateStore.write).not.toHaveBeenCalled();
      expect(invalidateRuntime).not.toHaveBeenCalled();
    });

    it('keeps a bounded launch-state heartbeat for unchanged active snapshots', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:00:20.000Z'));
      const svc = new TeamProvisioningService();
      const teamName = 'launch-state-heartbeat-team';
      const status = createMemberSpawnStatusEntry({
        updatedAt: '2026-05-02T10:00:00.000Z',
        firstSpawnAcceptedAt: '2026-05-02T10:00:00.000Z',
      });
      const previousSnapshot = snapshotFromRuntimeMemberStatuses({
        teamName,
        expectedMembers: ['alice'],
        launchPhase: 'active',
        updatedAt: '2026-05-02T10:00:00.000Z',
        statuses: { alice: status as any },
      });
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([['alice', status]]),
      });
      run.isLaunch = true;
      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      const invalidateRuntime = vi.spyOn(svc as any, 'invalidateRuntimeSnapshotCaches');

      const result = await (svc as any).persistLaunchStateSnapshotNow(run, 'active');

      expect(result.updatedAt).toBe('2026-05-02T10:00:20.000Z');
      expect((svc as any).launchStateStore.write).toHaveBeenCalledTimes(1);
      expect(invalidateRuntime).toHaveBeenCalledTimes(1);
    });

    it('does not skip the first service-owned launch-state write for an existing snapshot', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:00:05.000Z'));
      const svc = new TeamProvisioningService();
      const teamName = 'launch-state-first-write-team';
      const status = createMemberSpawnStatusEntry({
        updatedAt: '2026-05-02T10:00:00.000Z',
        firstSpawnAcceptedAt: '2026-05-02T10:00:00.000Z',
      });
      const previousSnapshot = snapshotFromRuntimeMemberStatuses({
        teamName,
        expectedMembers: ['alice'],
        launchPhase: 'active',
        updatedAt: '2026-05-02T10:00:02.000Z',
        statuses: { alice: status as any },
      });
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([['alice', status]]),
      });
      run.isLaunch = true;
      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      const invalidateRuntime = vi.spyOn(svc as any, 'invalidateRuntimeSnapshotCaches');

      await (svc as any).persistLaunchStateSnapshotNow(run, 'active');

      expect((svc as any).launchStateStore.write).toHaveBeenCalledTimes(1);
      expect(invalidateRuntime).toHaveBeenCalledTimes(1);
    });

    it('does not skip the first write for a new run even when the previous snapshot is semantically equal', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:00:05.000Z'));
      const svc = new TeamProvisioningService();
      const teamName = 'launch-state-new-run-team';
      const status = createMemberSpawnStatusEntry({
        updatedAt: '2026-05-02T10:00:00.000Z',
        firstSpawnAcceptedAt: '2026-05-02T10:00:00.000Z',
      });
      const previousSnapshot = snapshotFromRuntimeMemberStatuses({
        teamName,
        expectedMembers: ['alice'],
        launchPhase: 'active',
        updatedAt: '2026-05-02T10:00:02.000Z',
        statuses: { alice: status as any },
      });
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([['alice', status]]),
      });
      run.isLaunch = true;
      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).launchStateWrittenRunIdByTeam.set(teamName, 'previous-run-id');
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      const invalidateRuntime = vi.spyOn(svc as any, 'invalidateRuntimeSnapshotCaches');

      const result = await (svc as any).persistLaunchStateSnapshotNow(run, 'active');

      expect(result.updatedAt).toBe('2026-05-02T10:00:05.000Z');
      expect((svc as any).launchStateStore.write).toHaveBeenCalledTimes(1);
      expect(invalidateRuntime).toHaveBeenCalledTimes(1);
    });

    it('writes and invalidates runtime cache when launch-state semantics change', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:00:05.000Z'));
      const svc = new TeamProvisioningService();
      const teamName = 'launch-state-change-team';
      const previousStatus = createMemberSpawnStatusEntry({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        updatedAt: '2026-05-02T10:00:00.000Z',
        firstSpawnAcceptedAt: '2026-05-02T10:00:00.000Z',
      });
      const nextStatus = createMemberSpawnStatusEntry({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        livenessSource: 'heartbeat',
        updatedAt: '2026-05-02T10:00:05.000Z',
        firstSpawnAcceptedAt: '2026-05-02T10:00:00.000Z',
        lastHeartbeatAt: '2026-05-02T10:00:05.000Z',
      });
      const previousSnapshot = snapshotFromRuntimeMemberStatuses({
        teamName,
        expectedMembers: ['alice'],
        launchPhase: 'active',
        updatedAt: '2026-05-02T10:00:02.000Z',
        statuses: { alice: previousStatus as any },
      });
      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['alice'],
        memberSpawnStatuses: new Map([['alice', nextStatus]]),
      });
      run.isLaunch = true;
      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };
      (svc as any).membersMetaStore = { getMembers: vi.fn(async () => []) };
      const invalidateRuntime = vi.spyOn(svc as any, 'invalidateRuntimeSnapshotCaches');

      const result = await (svc as any).persistLaunchStateSnapshotNow(run, 'active');

      expect(result.members.alice?.launchState).toBe('confirmed_alive');
      expect((svc as any).launchStateStore.write).toHaveBeenCalledTimes(1);
      expect(invalidateRuntime).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTeamAgentRuntimeSnapshot', () => {
    it('dedupes concurrent runtime snapshot probes for the same team', async () => {
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
      const paneInfo = createDeferred<Map<string, { paneId: string; panePid: number }>>();
      vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockReturnValueOnce(
        paneInfo.promise as ReturnType<typeof listTmuxPaneRuntimeInfoForCurrentPlatform>
      );
      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
        '222': createPidusageStat(222, 456_000_000),
      } as any);

      const first = svc.getTeamAgentRuntimeSnapshot('runtime-team');
      const second = svc.getTeamAgentRuntimeSnapshot('runtime-team');
      paneInfo.resolve(
        new Map([
          [
            '%1',
            {
              paneId: '%1',
              panePid: 222,
            },
          ],
        ])
      );
      const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

      expect(listTmuxPaneRuntimeInfoForCurrentPlatform).toHaveBeenCalledTimes(1);
      expect(pidusage).toHaveBeenCalledTimes(1);
      expect(firstSnapshot.members.alice?.pid).toBe(222);
      expect(secondSnapshot.members.alice?.pid).toBe(222);
    });

    it('does not cache live runtime metadata when invalidated while the probe is in flight', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      const processRows =
        createDeferred<Awaited<ReturnType<typeof listRuntimeProcessesForCurrentTmuxPlatform>>>();
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform)
        .mockReturnValueOnce(processRows.promise)
        .mockResolvedValueOnce([]);

      const first = (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team') as Promise<
        Map<string, unknown>
      >;
      (svc as any).invalidateRuntimeSnapshotCaches('runtime-team');
      processRows.resolve([]);
      await first;

      await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team');

      expect(listRuntimeProcessesForCurrentTmuxPlatform).toHaveBeenCalledTimes(2);
    });

    it('returns cloned live runtime metadata maps from cache', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValueOnce([]);

      const first = (await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team')) as Map<
        string,
        unknown
      >;
      expect(first.has('alice')).toBe(true);
      first.delete('alice');

      const second = (await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team')) as Map<
        string,
        unknown
      >;

      expect(second.has('alice')).toBe(true);
      expect(listRuntimeProcessesForCurrentTmuxPlatform).toHaveBeenCalledTimes(1);
    });

    it('clears runtime probe caches when starting a new run for the team', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team');
      (svc as any).resetTeamScopedTransientStateForNewRun('runtime-team');
      await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team');

      expect(listRuntimeProcessesForCurrentTmuxPlatform).toHaveBeenCalledTimes(2);
    });

    it('does not cache a probe that started before runtime adapter evidence was installed', async () => {
      const svc = new TeamProvisioningService();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', providerId: 'opencode', model: 'gpt-5.4-mini' },
          ],
        })),
      };
      (svc as any).provisioningRunByTeam.set('runtime-team', 'run-1');
      const processRows =
        createDeferred<Awaited<ReturnType<typeof listRuntimeProcessesForCurrentTmuxPlatform>>>();
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform)
        .mockReturnValueOnce(processRows.promise)
        .mockResolvedValueOnce([]);

      const first = (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team') as Promise<
        Map<string, unknown>
      >;
      (svc as any).runtimeAdapterRunByTeam.set('runtime-team', {
        runId: 'run-1',
        providerId: 'opencode',
        cwd: '/tmp/runtime-project',
        members: {
          alice: {
            providerId: 'opencode',
            runtimeAlive: true,
            bootstrapConfirmed: false,
            runtimePid: 333,
            livenessKind: 'runtime_process',
            pidSource: 'agent_process_table',
          },
        },
      });
      (svc as any).invalidateRuntimeSnapshotCaches('runtime-team');
      processRows.resolve([]);
      await first;

      await (svc as any).getLiveTeamAgentRuntimeMetadata('runtime-team');

      expect(listRuntimeProcessesForCurrentTmuxPlatform).toHaveBeenCalledTimes(2);
    });

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

    it('does not send legacy process backend pane markers to tmux liveness lookup', async () => {
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
          tmuxPaneId: 'process:4242',
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
      vi.mocked(pidusage).mockResolvedValueOnce({
        '111': createPidusageStat(111, 123_000_000),
      } as any);

      await svc.getTeamAgentRuntimeSnapshot('runtime-team');

      expect(listTmuxPaneRuntimeInfoForCurrentPlatform).not.toHaveBeenCalled();
      expect(listTmuxPanePidsForCurrentPlatform).not.toHaveBeenCalled();
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
      const acceptedAt = new Date(Date.now() - 220_000).toISOString();
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

    it('projects a pending restart as bootstrap-pending in finished launch snapshots without mutating live state', () => {
      const requestedAt = new Date().toISOString();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'spawning',
              launchState: 'starting',
              agentToolAccepted: false,
              firstSpawnAcceptedAt: requestedAt,
              runtimeDiagnostic: undefined,
              runtimeDiagnosticSeverity: undefined,
            }),
          ],
        ]),
      });
      run.isLaunch = true;
      run.provisioningComplete = true;
      run.pendingMemberRestarts.set('bob', {
        requestedAt,
        desired: {
          name: 'bob',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        },
      });
      const svc = new TeamProvisioningService();

      const projected = (svc as any).buildRuntimeSpawnStatusRecord(run);

      expect(projected.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        error: undefined,
        runtimeDiagnostic: 'Manual restart is already in progress; waiting for teammate bootstrap.',
        runtimeDiagnosticSeverity: 'info',
      });
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        hardFailure: false,
      });
    });

    it('does not sync a stale never-spawned launch snapshot over a pending restart', () => {
      const requestedAt = new Date().toISOString();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'spawning',
              launchState: 'starting',
              agentToolAccepted: false,
              firstSpawnAcceptedAt: requestedAt,
              hardFailure: false,
              hardFailureReason: undefined,
              error: undefined,
            }),
          ],
        ]),
      });
      run.pendingMemberRestarts.set('bob', {
        requestedAt,
        desired: {
          name: 'bob',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        },
      });
      const snapshot = createPersistedLaunchSnapshot({
        teamName: run.teamName,
        expectedMembers: ['bob'],
        launchPhase: 'finished',
        members: {
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
      });
      const svc = new TeamProvisioningService();

      (svc as any).syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        hardFailure: false,
        hardFailureReason: undefined,
        error: undefined,
      });
    });

    it('does not mark a pending restart as failed during bootstrap cleanup projection', () => {
      const requestedAt = new Date().toISOString();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['alice', 'bob'],
        memberSpawnStatuses: new Map([
          [
            'alice',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
            }),
          ],
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'spawning',
              launchState: 'starting',
              agentToolAccepted: false,
              firstSpawnAcceptedAt: requestedAt,
              hardFailure: false,
              hardFailureReason: undefined,
              error: undefined,
            }),
          ],
        ]),
      });
      run.pendingMemberRestarts.set('bob', {
        requestedAt,
        desired: {
          name: 'bob',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        },
      });
      const svc = new TeamProvisioningService();

      (svc as any).markUnconfirmedBootstrapMembersFailed(run, 'launch cleanup requested', {
        cleanupRequested: true,
      });

      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'launch cleanup requested',
      });
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        hardFailure: false,
        hardFailureReason: undefined,
        error: undefined,
      });
    });

    it('restarts a tmux teammate directly in its shell-only pane after the runtime process disappeared', async () => {
      const teamName = 'forge-labs-10';
      const teamDir = path.join(tempTeamsBase, teamName);
      const projectPath = path.join(tempClaudeRoot, 'forge-project');
      fs.mkdirSync(teamDir, { recursive: true });
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify(
          {
            name: 'Forge Labs 10',
            projectPath,
            leadSessionId: 'lead-session-1',
            members: [
              { name: 'team-lead', agentType: 'team-lead' },
              {
                name: 'bob',
                role: 'Developer',
                providerId: 'codex',
                model: 'gpt-5.4',
                effort: 'high',
                agentType: 'general-purpose',
                tmuxPaneId: '%1',
                backendType: 'tmux',
              },
            ],
          },
          null,
          2
        ),
        'utf8'
      );

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValue(
        new Map([
          [
            '%1',
            {
              paneId: '%1',
              panePid: 4242,
              currentCommand: 'zsh',
              currentPath: projectPath,
            },
          ],
        ])
      );

      const svc = new TeamProvisioningService(undefined, undefined, undefined, undefined, {
        writeConfigFile: vi.fn(async () => '/mock/mcp-config.json'),
      } as any);
      const run = createMemberSpawnRun({
        teamName,
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
              hardFailureReason: 'Teammate was never spawned during launch.',
              error: 'Teammate was never spawned during launch.',
              agentToolAccepted: false,
              firstSpawnAcceptedAt: undefined,
            }),
          ],
        ]),
      });
      run.child = { pid: 111 };
      run.processKilled = false;
      run.cancelRequested = false;
      run.detectedSessionId = 'lead-session-1';
      run.request = { providerId: 'codex', skipPermissions: true };

      const sendMessageToRun = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).buildProvisioningEnv = vi.fn(async () => ({
        env: { OPENAI_API_KEY: 'test-openai-key' },
        authSource: 'openai_api_key',
        providerArgs: [],
      }));
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Forge Labs 10',
          projectPath,
          leadSessionId: 'lead-session-1',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'codex',
              model: 'gpt-5.4',
              effort: 'high',
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
            model: 'gpt-5.4',
            effort: 'high',
            agentType: 'general-purpose',
          },
        ]),
      };
      (svc as any).readPersistedRuntimeMembers = vi.fn(() => [
        {
          name: 'bob',
          agentId: 'bob@forge-labs-10',
          backendType: 'tmux',
          tmuxPaneId: '%1',
          cwd: projectPath,
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set(teamName, run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember(teamName, 'bob');

      expect(killTmuxPaneForCurrentPlatformSync).not.toHaveBeenCalled();
      expect(sendMessageToRun).not.toHaveBeenCalled();
      expect(sendKeysToTmuxPaneForCurrentPlatform).toHaveBeenCalledTimes(1);
      const [paneId, command] = vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mock.calls[0] ?? [];
      expect(paneId).toBe('%1');
      expect(command).toContain("cd '");
      expect(command).toContain(projectPath);
      expect(command).toContain("'/mock/claude'");
      expect(command).toContain("'--agent-id' 'bob@forge-labs-10'");
      expect(command).toContain("'--team-name' 'forge-labs-10'");
      expect(command).toContain("'--parent-session-id' 'lead-session-1'");
      expect(command).toContain("'--mcp-config' '/mock/mcp-config.json'");
      expect(command).toContain("'--model' 'gpt-5.4'");
      expect(command).toContain("'--effort' 'high'");
      expect(command).toContain('__CLAUDE_TEAMMATE_EXIT__');
      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        hardFailure: false,
      });

      const updatedConfig = JSON.parse(
        fs.readFileSync(path.join(teamDir, 'config.json'), 'utf8')
      ) as { members: Array<Record<string, unknown>> };
      expect(updatedConfig.members.find((member) => member.name === 'bob')).toMatchObject({
        agentId: 'bob@forge-labs-10',
        tmuxPaneId: '%1',
        backendType: 'tmux',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
      });
      const inbox = JSON.parse(
        fs.readFileSync(path.join(teamDir, 'inboxes', 'bob.json'), 'utf8')
      ) as Array<Record<string, unknown>>;
      expect(inbox.at(-1)).toMatchObject({
        from: 'team-lead',
        to: 'bob',
        source: 'system_notification',
        leadSessionId: 'lead-session-1',
      });
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

    it('restarts a pure OpenCode member through the app-owned runtime adapter without a tracked lead run', async () => {
      const svc = new TeamProvisioningService();
      const adapterLaunch = vi.fn();
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

      (svc as any).runtimeAdapterRunByTeam.set('pure-opencode-team', {
        runId: 'opencode-run-1',
        providerId: 'opencode',
        cwd: '/repo',
        members: {},
      });
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          name: 'Pure OpenCode Team',
          projectPath: '/repo',
          members: [
            { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' },
            {
              name: 'alice',
              role: 'Reviewer',
              providerId: 'opencode',
              model: 'openai/gpt-5.4-mini',
              agentType: 'general-purpose',
            },
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              model: 'openai/gpt-5.4-mini',
              agentType: 'general-purpose',
            },
          ],
        })),
      };
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          version: 1,
          cwd: '/repo',
          providerId: 'opencode',
          model: 'openai/gpt-5.4-mini',
          createdAt: Date.now(),
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            agentType: 'general-purpose',
          },
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            agentType: 'general-purpose',
          },
        ]),
      };
      vi.spyOn(svc as any, 'resolveOpenCodeMemberWorkspacesForRuntime').mockImplementation(
        async (input: any) =>
          (input.members as Array<Record<string, unknown>>).map((member) => ({
            ...member,
            cwd: '/repo',
          }))
      );
      const persistRestartMessage = vi
        .spyOn(svc as any, 'persistOpenCodeMemberRestartSystemMessage')
        .mockImplementation(() => undefined);
      const runtimeRelaunch = vi
        .spyOn(svc as any, 'runOpenCodeTeamRuntimeAdapterLaunch')
        .mockResolvedValue({ runId: 'opencode-run-2' });

      await svc.restartMember('pure-opencode-team', 'alice');

      expect(runtimeRelaunch).toHaveBeenCalledTimes(1);
      const relaunchInput = runtimeRelaunch.mock.calls[0]?.[0] as any;
      expect(relaunchInput.request).toMatchObject({
        teamName: 'pure-opencode-team',
        cwd: '/repo',
        providerId: 'opencode',
        model: 'openai/gpt-5.4-mini',
      });
      expect(relaunchInput.members.map((member: { name: string }) => member.name).sort()).toEqual([
        'alice',
        'bob',
      ]);
      expect(relaunchInput.sourceWarning).toContain('OpenCode-only member restart refreshes');
      expect(persistRestartMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'pure-opencode-team',
          leadName: 'team-lead',
          member: expect.objectContaining({ name: 'alice' }),
          reason: 'manual_restart',
        })
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
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => {
        const teamName = String(input.teamName);
        const laneId = String(input.laneId);
        const runId = String(input.runId);
        await writeCommittedOpenCodeSessionStore({
          teamName,
          laneId,
          runId,
          sessions: [
            {
              id: 'oc-session-bob',
              teamName,
              memberName: 'bob',
              laneId,
              runId,
              source: 'runtime_bootstrap_checkin',
            },
          ],
        });
        return {
          runId,
          teamName,
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
        };
      });

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
      stubOpenCodeAppManagedLaunchPrompt(svc);

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
          runtimeOnly: true,
          prompt: expect.stringContaining('AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1'),
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
      expect(adapterLaunch.mock.calls[0]?.[0]).not.toHaveProperty('skipReadinessPreflight');
    });

    it('does not trust OpenCode secondary bootstrap success without committed lane evidence', async () => {
      const svc = new TeamProvisioningService();
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName: 'mixed-team-no-committed-evidence',
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempTeamsBase,
        teamName: 'mixed-team-no-committed-evidence',
        laneId: 'secondary:opencode:bob',
        runId: 'lane-run-bob',
      });

      const result = await (svc as any).guardCommittedOpenCodeSecondaryLaneEvidence({
        teamName: 'mixed-team-no-committed-evidence',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        result: {
          runId: 'lane-run-bob',
          teamName: 'mixed-team-no-committed-evidence',
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
        },
      });

      expect(result.teamLaunchState).toBe('partial_pending');
      expect(result.launchPhase).toBe('active');
      expect(result.members.bob).toMatchObject({
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        livenessKind: 'registered_only',
        runtimeDiagnostic:
          'OpenCode bootstrap confirmation was not committed to lane runtime evidence.',
      });
      expect(result.members.bob.diagnostics).toContain(
        'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.'
      );
    });

    it('delivers direct messages to OpenCode secondary lanes with the lane run id', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_direct_lane',
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'opencode-run-bob',
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          cwd: '/repo',
          text: 'hello bob',
          messageId: 'msg-1',
        })
      );
    });

    it('does not deliver direct OpenCode messages when recovery leaves the lane inactive', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_direct_lane',
        runtimePid: 456,
        diagnostics: [],
      }));
      await configureOpenCodeBobDeliveryService({ svc, sendMessageToMember });
      (svc as any).deleteSecondaryRuntimeRun('team-a', 'secondary:opencode:bob');
      vi.spyOn(svc as any, 'tryRecoverOpenCodeRuntimeLaneBeforeDelivery').mockResolvedValue(false);
      const committedRecoverySpy = vi
        .spyOn(svc as any, 'tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery')
        .mockResolvedValue(true);

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-1',
        })
      ).resolves.toMatchObject({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });

      expect(committedRecoverySpy).toHaveBeenCalled();
      expect(sendMessageToMember).not.toHaveBeenCalled();
    });

    it('persists verified OpenCode bridge runtime pids so member cards can show memory', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_verified_pid',
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
      vi.spyOn(svc as any, 'readProcessCommandByPid').mockReturnValue(
        '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 45678'
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
      writeLaunchState('team-a', 'lead-session', {
        bob: {
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
          runtimeRunId: 'opencode-run-bob',
          runtimeSessionId: 'oc-session-bob',
          livenessKind: 'confirmed_bootstrap',
        },
      });
      await writeDefaultBobOpenCodeBootstrapEvidence();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'opencode/minimax-m2.5-free' },
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
      vi.mocked(listRuntimeProcessesForCurrentTmuxPlatform).mockResolvedValue([
        {
          pid: 456,
          ppid: 1,
          command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 45678',
        },
      ]);
      vi.mocked(pidusage).mockReset();
      vi.mocked(pidusage).mockImplementation(
        async (target: number | string | Array<number | string>) => {
          if (Array.isArray(target)) {
            return {
              '456': createPidusageStat(456, 456_000_000),
            } as any;
          }
          if (target === 456) {
            return createPidusageStat(456, 456_000_000) as any;
          }
          throw new Error(`Unexpected pidusage target: ${String(target)}`);
        }
      );

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-1',
        })
      ).resolves.toMatchObject({ delivered: true });

      const persisted = JSON.parse(fs.readFileSync(getTeamLaunchStatePath('team-a'), 'utf8'));
      expect(persisted.members.bob).toMatchObject({
        runtimePid: 456,
        pidSource: 'opencode_bridge',
        runtimeSessionId: 'oc-session-bob',
      });

      const snapshot = await svc.getTeamAgentRuntimeSnapshot('team-a');
      expect(snapshot.members.bob).toMatchObject({
        memberName: 'bob',
        providerId: 'opencode',
        pid: 456,
        runtimePid: 456,
        rssBytes: 456_000_000,
        livenessKind: 'runtime_process_candidate',
      });
    });

    it('does not persist OpenCode bridge runtime pids when process identity is not verified', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_unverified_pid',
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
      vi.spyOn(svc as any, 'readProcessCommandByPid').mockReturnValue('/usr/bin/yes');

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
      writeLaunchState('team-a', 'lead-session', {
        bob: {
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
          runtimeRunId: 'opencode-run-bob',
          runtimeSessionId: 'oc-session-bob',
          livenessKind: 'confirmed_bootstrap',
        },
      });
      await writeDefaultBobOpenCodeBootstrapEvidence();
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
            { name: 'bob', providerId: 'opencode', model: 'opencode/minimax-m2.5-free' },
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
      ).resolves.toMatchObject({ delivered: true });

      const persisted = JSON.parse(fs.readFileSync(getTeamLaunchStatePath('team-a'), 'utf8'));
      expect(persisted.members.bob.runtimePid).toBeUndefined();
      expect(persisted.members.bob.pidSource).toBeUndefined();
    });

    it('uses snapshot config reads for OpenCode member delivery routing', async () => {
      const getConfig = vi.fn(async () => {
        throw new Error('verified config read should not be used for delivery routing');
      });
      const getConfigSnapshot = vi.fn(async () => ({
        projectPath: '/repo',
        members: [
          { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
          { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
        ],
      }));
      const svc = new TeamProvisioningService({
        getConfig,
        getConfigSnapshot,
      } as any);
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_snapshot_config',
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
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          { name: 'bob', providerId: 'opencode', model: 'opencode/minimax-m2.5-free' },
        ]),
      };
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
      });
      await writeDefaultBobOpenCodeBootstrapEvidence();

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'hello bob',
          messageId: 'msg-1',
        })
      ).resolves.toMatchObject({ delivered: true });

      expect(getConfigSnapshot).toHaveBeenCalledWith('team-a');
      expect(getConfig).not.toHaveBeenCalled();
    });

    it('resolves OpenCode runtime lane members from one snapshot directory read', async () => {
      const getConfig = vi.fn(async () => {
        throw new Error('verified config read should not be used for lane member resolution');
      });
      const getConfigSnapshot = vi.fn(async () => ({
        projectPath: '/repo',
        members: [
          { name: 'team-lead', providerId: 'codex', model: 'gpt-5.4' },
          { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
          { name: 'alice', providerId: 'codex', model: 'gpt-5.4' },
        ],
      }));
      const svc = new TeamProvisioningService({
        getConfig,
        getConfigSnapshot,
      } as any);
      (svc as any).teamMetaStore = {
        getMeta: vi.fn(async () => ({
          launchIdentity: { providerId: 'codex' },
          providerId: 'codex',
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => [
          { name: 'bob', providerId: 'opencode', model: 'opencode/minimax-m2.5-free' },
        ]),
      };

      await expect(
        (svc as any).resolveOpenCodeMembersForRuntimeLane('team-a', 'secondary:opencode:bob')
      ).resolves.toEqual(['bob']);

      expect(getConfigSnapshot).toHaveBeenCalledTimes(1);
      expect(getConfig).not.toHaveBeenCalled();
    });

    it('delivers OpenCode secondary-lane messages to the member worktree cwd after restart', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_worktree_cwd',
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
      (svc as any).canDeliverToOpenCodeRuntimeForTeam = vi.fn(() => true);
      (svc as any).setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'opencode-run-bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo/.agent-team-worktrees/bob',
      });
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
          latestAssistantPreview: 'Answer after observe.',
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
        visibleReplyCorrelation: 'plain_assistant_text',
      });

      const userInbox = JSON.parse(
        await fsPromises.readFile(
          path.join(tempTeamsBase, 'team-a', 'inboxes', 'user.json'),
          'utf8'
        )
      ) as Array<Record<string, unknown>>;
      expect(userInbox).toHaveLength(1);
      expect(userInbox[0]).toMatchObject({
        from: 'bob',
        to: 'user',
        text: 'Answer after observe.',
        relayOfMessageId: 'msg-ledger-1',
        source: 'runtime_delivery',
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

    it('emits a narrow task-log signal when OpenCode prompt delivery records exact session evidence', async () => {
      const svc = new TeamProvisioningService();
      const emitter = vi.fn();
      svc.setTeamChangeEmitter(emitter);
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
          messageId: 'msg-ledger-session',
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
          taskRefs: [
            {
              taskId: 'task-a',
              displayId: 'task-a',
              teamName: 'team-a',
            },
          ],
        })
      ).resolves.toMatchObject({
        delivered: true,
        responsePending: true,
        responseState: 'pending',
      });

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task-log-change',
          teamName: 'team-a',
          runId: 'opencode-run-bob',
          taskId: 'task-a',
          detail: 'opencode-prompt-delivery-session-evidence',
          taskSignalKind: 'log',
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
        runtimePromptMessageId: `msg_prompt_${sendMessageToMember.mock.calls.length}`,
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      expect(observeMessageDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'oc-session-bob',
          runtimePromptMessageId: 'msg_prompt_1',
          prePromptCursor: 'cursor-1',
        })
      );
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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

    it('materializes plain-text fallback after OpenCode message_send tool errors', async () => {
      const svc = new TeamProvisioningService();
      const taskRef = {
        taskId: 'task-tool-error-fallback',
        displayId: 'toolerr1',
        teamName: 'team-a',
      };
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'tool_error',
          deliveredUserMessageId: 'oc-user-tool-error',
          assistantMessageId: 'oc-assistant-tool-error',
          toolCallNames: ['agent-teams_message_send'],
          visibleMessageToolCallId: 'call-message-send',
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: 'GAUNTLET_CONCURRENT_TOM_OK_1',
          reason: 'message_send_tool_error_without_visible_reply_proof',
        },
        diagnostics: ['OpenCode tool failed without output'],
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
          text: 'Concurrent check. Reply to user with GAUNTLET_CONCURRENT_TOM_OK_1.',
          messageId: 'msg-tool-error-fallback',
          replyRecipient: 'user',
          actionMode: 'ask',
          taskRefs: [taskRef],
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_plain_text',
        visibleReplyCorrelation: 'plain_assistant_text',
        diagnostics: expect.arrayContaining([
          'opencode_message_send_tool_error_plain_text_reply_materialized',
          'opencode_plain_text_reply_materialized_to_user_inbox',
        ]),
      });

      const userInbox = JSON.parse(
        await fsPromises.readFile(
          path.join(tempTeamsBase, 'team-a', 'inboxes', 'user.json'),
          'utf8'
        )
      ) as Array<Record<string, unknown>>;
      expect(userInbox).toHaveLength(1);
      expect(userInbox[0]).toMatchObject({
        from: 'bob',
        to: 'user',
        text: 'GAUNTLET_CONCURRENT_TOM_OK_1',
        relayOfMessageId: 'msg-tool-error-fallback',
        source: 'runtime_delivery',
        taskRefs: [taskRef],
      });
    });

    it('waits through delayed OpenCode message_send tool-error fallback inline', async () => {
      const svc = new TeamProvisioningService();
      const taskRef = {
        taskId: 'task-tool-error-observe-first',
        displayId: 'obsfirst',
        teamName: 'team-a',
      };
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before-tool-error',
        responseObservation: {
          state: 'tool_error',
          deliveredUserMessageId: 'oc-user-tool-error-observe',
          assistantMessageId: 'oc-assistant-tool-error-observe',
          toolCallNames: ['agent-teams_message_send'],
          visibleMessageToolCallId: 'call-message-send-observe',
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'message_send_tool_error_without_visible_reply_proof',
        },
        diagnostics: ['OpenCode tool failed without output'],
      }));
      let observeAttempts = 0;
      const opencodeAdapter = {
        providerId: 'opencode',
        prepare: vi.fn(),
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
        sendMessageToMember,
        observeMessageDelivery: vi.fn(async function (
          this: unknown,
          input: Record<string, unknown>
        ) {
          expect(this).toBe(opencodeAdapter);
          observeAttempts += 1;
          return {
            ok: true,
            providerId: 'opencode',
            memberName: String(input.memberName),
            sessionId: 'oc-session-bob',
            responseObservation:
              observeAttempts === 1
                ? {
                    state: 'pending',
                    deliveredUserMessageId: 'oc-user-tool-error-observe',
                    assistantMessageId: null,
                    toolCallNames: ['agent-teams_message_send'],
                    visibleMessageToolCallId: 'call-message-send-observe',
                    visibleReplyMessageId: null,
                    visibleReplyCorrelation: null,
                    latestAssistantPreview: null,
                    reason: 'assistant_reply_not_visible_yet',
                  }
                : {
                    state: 'responded_plain_text',
                    deliveredUserMessageId: 'oc-user-tool-error-observe',
                    assistantMessageId: 'oc-assistant-plain-fallback',
                    toolCallNames: ['agent-teams_message_send'],
                    visibleMessageToolCallId: 'call-message-send-observe',
                    visibleReplyMessageId: null,
                    visibleReplyCorrelation: 'plain_assistant_text',
                    latestAssistantPreview: 'GAUNTLET_OBSERVE_FIRST_OK_1',
                    reason: 'assistant_replied_with_plain_text',
                  },
            diagnostics: [
              observeAttempts === 1
                ? 'OpenCode assistant reply not visible yet'
                : 'Observed OpenCode plain-text fallback after message_send tool error',
            ],
          };
        }),
      } as any;
      const observeMessageDelivery = opencodeAdapter.observeMessageDelivery;
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([opencodeAdapter]));

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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
          text: 'Reply to user with GAUNTLET_OBSERVE_FIRST_OK_1.',
          messageId: 'msg-tool-error-observe-first',
          replyRecipient: 'user',
          actionMode: 'ask',
          taskRefs: [taskRef],
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_plain_text',
        visibleReplyCorrelation: 'plain_assistant_text',
        diagnostics: expect.arrayContaining([
          'opencode_message_send_tool_error_inline_observe',
          'opencode_direct_user_delivery_inline_observe_attempt_2',
          'opencode_plain_text_reply_materialized_to_user_inbox',
        ]),
      });

      const userInbox = JSON.parse(
        await fsPromises.readFile(
          path.join(tempTeamsBase, 'team-a', 'inboxes', 'user.json'),
          'utf8'
        )
      ) as Array<Record<string, unknown>>;
      expect(userInbox).toHaveLength(1);
      expect(userInbox[0]).toMatchObject({
        from: 'bob',
        to: 'user',
        text: 'GAUNTLET_OBSERVE_FIRST_OK_1',
        relayOfMessageId: 'msg-tool-error-observe-first',
        source: 'runtime_delivery',
        taskRefs: [taskRef],
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
      expect(observeMessageDelivery).toHaveBeenCalledTimes(2);
      expect(observeMessageDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-tool-error-observe-first',
          prePromptCursor: 'cursor-before-tool-error',
        })
      );
    }, 15_000);

    it('keeps accepted OpenCode delivery retryable when inline observe throws', async () => {
      const svc = new TeamProvisioningService();
      const taskRef = {
        taskId: 'task-tool-error-observe-throws',
        displayId: 'obsthrow',
        teamName: 'team-a',
      };
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before-observe-throws',
        responseObservation: {
          state: 'tool_error',
          deliveredUserMessageId: 'oc-user-observe-throws',
          assistantMessageId: 'oc-assistant-observe-throws',
          toolCallNames: ['agent-teams_message_send'],
          visibleMessageToolCallId: 'call-message-send-observe-throws',
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'message_send_tool_error_without_visible_reply_proof',
        },
        diagnostics: ['OpenCode tool failed without output'],
      }));
      const observeMessageDelivery = vi.fn(async () => {
        throw new Error('observe bridge fs write failed');
      });
      await configureOpenCodeBobDeliveryService({
        svc,
        sendMessageToMember,
        observeMessageDelivery,
      });

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Reply to user with GAUNTLET_OBSERVE_THROW_OK_1.',
          messageId: 'msg-tool-error-observe-throws',
          replyRecipient: 'user',
          actionMode: 'ask',
          taskRefs: [taskRef],
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'reconcile_failed',
        ledgerStatus: 'retry_scheduled',
        reason: expect.stringContaining('opencode_direct_user_delivery_inline_observe_failed'),
        diagnostics: expect.arrayContaining([
          'opencode_direct_user_delivery_inline_observe_attempt_1',
          expect.stringContaining('observe bridge fs write failed'),
        ]),
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
      expect(observeMessageDelivery).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('resolves stored attachment payloads for OpenCode inbox relay before delivery', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        responseObservation: {
          state: 'responded_plain_text',
          deliveredUserMessageId: 'oc-user-attachment',
          assistantMessageId: 'oc-assistant-attachment',
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: 'I reviewed the attached image and can proceed.',
          reason: 'assistant_replied_with_plain_text',
        },
        diagnostics: [],
      }));
      await configureOpenCodeBobDeliveryService({
        svc,
        sendMessageToMember,
        memberModel: 'openai/gpt-5.4-mini',
      });
      await (svc as any).attachmentStore.saveAttachments('team-a', 'msg-image-attachment', [
        {
          id: 'att-1',
          filename: 'diagram.png',
          mimeType: 'image/png',
          size: 5,
          data: 'aW1nMQ==',
        },
      ]);
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'team-lead',
              to: 'bob',
              text: 'Review this image.',
              timestamp: '2026-04-25T10:00:00.000Z',
              read: false,
              messageId: 'msg-image-attachment',
              attachments: [
                {
                  id: 'att-1',
                  filename: 'diagram.png',
                  mimeType: 'image/png',
                  size: 5,
                },
              ],
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.relayOpenCodeMemberInboxMessages('team-a', 'bob', {
          onlyMessageId: 'msg-image-attachment',
        })
      ).resolves.toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        relayed: 1,
      });
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-image-attachment',
          fileParts: [
            {
              type: 'file',
              mime: 'image/png',
              url: 'data:image/png;base64,aW1nMQ==',
              filename: 'diagram.png',
            },
          ],
        })
      );
    });

    it('keeps OpenCode inbox relay unread and surfaces a clear reason when the model is not vision-capable', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn();
      await configureOpenCodeBobDeliveryService({
        svc,
        sendMessageToMember,
        memberModel: 'openrouter/z-ai/glm-5.1',
      });
      await (svc as any).attachmentStore.saveAttachments('team-a', 'msg-unsupported-image-model', [
        {
          id: 'att-unsupported-model',
          filename: 'diagram.png',
          mimeType: 'image/png',
          size: 5,
          data: 'aW1nMQ==',
        },
      ]);
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'team-lead',
              to: 'bob',
              text: 'Review this image.',
              timestamp: '2026-04-25T10:00:00.000Z',
              read: false,
              messageId: 'msg-unsupported-image-model',
              attachments: [
                {
                  id: 'att-unsupported-model',
                  filename: 'diagram.png',
                  mimeType: 'image/png',
                  size: 5,
                },
              ],
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      const relay = await svc.relayOpenCodeMemberInboxMessages('team-a', 'bob', {
        onlyMessageId: 'msg-unsupported-image-model',
      });

      expect(relay).toMatchObject({
        attempted: 1,
        delivered: 0,
        failed: 1,
        relayed: 0,
        lastDelivery: {
          delivered: false,
          reason: 'attachment_model_unsupported',
          userVisibleImpact: {
            state: 'error',
            reasonCode: 'backend_error',
            message:
              'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.',
          },
        },
      });
      expect(relay.diagnostics?.join('\n')).toContain(
        'opencode_attachment_delivery_prepare_failed: This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
      );
      expect(sendMessageToMember).not.toHaveBeenCalled();
      const rows = JSON.parse(
        await fsPromises.readFile(path.join(inboxDir, 'bob.json'), 'utf8')
      ) as Array<{ read?: boolean }>;
      expect(rows[0]?.read).toBe(false);
    });

    it('keeps OpenCode inbox relay unread when attachment payload data is unavailable', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn();
      await configureOpenCodeBobDeliveryService({ svc, sendMessageToMember });
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'team-lead',
              to: 'bob',
              text: 'Review this image.',
              timestamp: '2026-04-25T10:00:00.000Z',
              read: false,
              messageId: 'msg-missing-attachment',
              attachments: [
                {
                  id: 'missing-att',
                  filename: 'missing.png',
                  mimeType: 'image/png',
                  size: 5,
                },
              ],
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.relayOpenCodeMemberInboxMessages('team-a', 'bob', {
          onlyMessageId: 'msg-missing-attachment',
        })
      ).resolves.toMatchObject({
        attempted: 1,
        delivered: 0,
        failed: 1,
        relayed: 0,
        lastDelivery: {
          delivered: false,
          reason: 'opencode_inbox_attachment_payload_unavailable: missing-att',
        },
      });
      expect(sendMessageToMember).not.toHaveBeenCalled();

      const inbox = JSON.parse(await fsPromises.readFile(path.join(inboxDir, 'bob.json'), 'utf8'));
      expect(inbox[0]).toMatchObject({
        messageId: 'msg-missing-attachment',
        read: false,
      });
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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

    it('keeps accepted OpenCode responses without exact prompt identity acceptance-unknown', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
          messageId: 'msg-accepted-missing-prompt-id',
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
        reason: 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id',
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
          runtimePromptMessageId: string | null;
          lastReason: string | null;
          diagnostics: string[];
        }>;
      };
      expect(ledgerEnvelope.data[0]).toMatchObject({
        acceptanceUnknown: true,
        status: 'failed_retryable',
        runtimePromptMessageId: null,
        lastReason: 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id',
      });
      expect(ledgerEnvelope.data[0].diagnostics).toContain(
        'opencode_prompt_acceptance_missing_runtime_prompt_id'
      );
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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

    it('inherits taskRefs from the OpenCode delivery ledger for exact visible replies', async () => {
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, 'user.json'),
        `${JSON.stringify(
          [
            {
              from: 'bob',
              to: 'user',
              text: 'Here is the concrete answer for #abcd1234.',
              timestamp: '2026-04-25T10:00:03.000Z',
              read: false,
              messageId: 'reply-user-task-1',
              relayOfMessageId: 'msg-task-refs-1',
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
          text: 'Please answer for #abcd1234.',
          messageId: 'msg-task-refs-1',
          replyRecipient: 'user',
          actionMode: 'ask',
          taskRefs: [taskRef],
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        visibleReplyMessageId: 'reply-user-task-1',
        visibleReplyCorrelation: 'relayOfMessageId',
      });

      const userInbox = JSON.parse(
        await fsPromises.readFile(path.join(inboxDir, 'user.json'), 'utf8')
      ) as Array<Record<string, unknown>>;
      expect(userInbox[0]).toMatchObject({
        messageId: 'reply-user-task-1',
        taskRefs: [taskRef],
      });
      expect(sendMessageToMember).not.toHaveBeenCalled();
    });

    it('repairs OpenCode visible replies that used a wrong relayOfMessageId but returned a messageId', async () => {
      const svc = new TeamProvisioningService();
      const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' };
      const inboxDir = path.join(tempTeamsBase, 'team-a', 'inboxes');
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => {
        await fsPromises.mkdir(inboxDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(inboxDir, 'user.json'),
          `${JSON.stringify(
            [
              {
                from: 'bob',
                to: 'user',
                text: 'Here is the concrete answer for #abcd1234.',
                timestamp: '2026-04-25T10:00:03.000Z',
                read: false,
                messageId: 'reply-wrong-relay-1',
                relayOfMessageId: 'hallucinated-inbound-id',
                source: 'runtime_delivery',
                taskRefs: [taskRef],
              },
            ],
            null,
            2
          )}\n`,
          'utf8'
        );
        return {
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
            visibleReplyMessageId: 'reply-wrong-relay-1',
            visibleReplyCorrelation: 'direct_child_message_send',
            visibleReplyMissingRelayOfMessageId: true,
            latestAssistantPreview: null,
            reason: 'visible_reply_missing_relayOfMessageId',
          },
          diagnostics: [],
        };
      });
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
          text: 'Please answer for #abcd1234.',
          messageId: 'msg-wrong-relay-1',
          replyRecipient: 'user',
          actionMode: 'ask',
          taskRefs: [taskRef],
          source: 'watcher',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        visibleReplyMessageId: 'reply-wrong-relay-1',
        visibleReplyCorrelation: 'relayOfMessageId',
        diagnostics: expect.arrayContaining([
          'opencode_visible_reply_recovered_by_observed_message_id',
          'opencode_visible_reply_relayOfMessageId_repaired',
        ]),
      });

      const userInbox = JSON.parse(
        await fsPromises.readFile(path.join(inboxDir, 'user.json'), 'utf8')
      ) as Array<Record<string, unknown>>;
      expect(userInbox).toHaveLength(1);
      expect(userInbox[0]).toMatchObject({
        messageId: 'reply-wrong-relay-1',
        relayOfMessageId: 'msg-wrong-relay-1',
        taskRefs: [taskRef],
      });
      expect(sendMessageToMember).toHaveBeenCalledTimes(1);
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
        await writeDefaultBobOpenCodeBootstrapEvidence();
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
          state:
            sendMessageToMember.mock.calls.length === 1 ? 'responded_non_visible_tool' : 'pending',
          deliveredUserMessageId: 'oc-user-ask',
          assistantMessageId:
            sendMessageToMember.mock.calls.length === 1 ? 'oc-assistant-read' : null,
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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

    it('accepts member work sync report as OpenCode delivery response proof', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'responded_non_visible_tool' as const,
          deliveredUserMessageId: 'oc-user-work-sync',
          assistantMessageId: 'oc-assistant-work-sync-report',
          toolCallNames: ['member_work_sync_status', 'member_work_sync_report'],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        diagnostics: [],
      }));
      await configureOpenCodeBobDeliveryService({ svc, sendMessageToMember });
      svc.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Work sync check for #task-1.',
          messageId: 'msg-work-sync-report',
          replyRecipient: 'team-lead',
          actionMode: 'do',
          messageKind: 'member_work_sync_nudge',
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
        responsePending: false,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'responded',
      });
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          controlUrl: 'http://127.0.0.1:43123',
        })
      );
    });

    it('accepts review workflow tools as review pickup delivery response proof', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'responded_non_visible_tool' as const,
          deliveredUserMessageId: 'oc-user-review-pickup',
          assistantMessageId: 'oc-assistant-review-start',
          toolCallNames: ['review_start'],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        diagnostics: [],
      }));
      await configureOpenCodeBobDeliveryService({ svc, sendMessageToMember });

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Review pickup required for #task-1.',
          messageId: 'msg-review-pickup-start',
          replyRecipient: 'team-lead',
          actionMode: 'do',
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: 'review_pickup',
          workSyncReviewRequestEventIds: ['evt-review-request'],
          taskRefs: [
            {
              taskId: 'task-1',
              displayId: 'task-1',
              teamName: 'team-a',
            },
          ],
          source: 'member-work-sync-review-pickup',
          inboxTimestamp: '2026-04-25T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'responded',
      });
    });

    it('keeps member work sync status-only OpenCode deliveries pending', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'responded_non_visible_tool' as const,
          deliveredUserMessageId: 'oc-user-work-sync-status',
          assistantMessageId: 'oc-assistant-work-sync-status',
          toolCallNames: ['member_work_sync_status'],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        diagnostics: [],
      }));
      await configureOpenCodeBobDeliveryService({ svc, sendMessageToMember });

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Work sync check for #task-1.',
          messageId: 'msg-work-sync-status-only',
          replyRecipient: 'team-lead',
          actionMode: 'do',
          messageKind: 'member_work_sync_nudge',
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

    it('treats OpenCode empty assistant turns with prompt proof as pending delivery', async () => {
      const svc = new TeamProvisioningService();
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: false,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        prePromptCursor: 'cursor-before',
        responseObservation: {
          state: 'empty_assistant_turn' as const,
          deliveredUserMessageId: 'oc-user-empty',
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: 'empty_assistant_turn',
        },
        diagnostics: ['empty_assistant_turn'],
      }));
      await configureOpenCodeBobDeliveryService({ svc, sendMessageToMember });

      await expect(
        svc.deliverOpenCodeMemberMessage('team-a', {
          memberName: 'bob',
          text: 'Work sync check for #task-1.',
          messageId: 'msg-empty-assistant-pending',
          replyRecipient: 'team-lead',
          actionMode: 'do',
          messageKind: 'member_work_sync_nudge',
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
        responseState: 'prompt_delivered_no_assistant_message',
        ledgerStatus: 'retry_scheduled',
        reason: 'prompt_delivered_no_assistant_message',
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
      await writeDefaultBobOpenCodeBootstrapEvidence();
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
        runtimePromptMessageId: 'msg_prompt_after_restart',
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
      await writeCommittedOpenCodeSessionStore({
        teamName,
        laneId,
        runId: 'opencode-run-durable',
        sessions: [
          {
            id: 'oc-session-bob',
            teamName,
            memberName: 'bob',
            laneId,
            runId: 'opencode-run-durable',
            source: 'runtime_bootstrap_checkin',
          },
        ],
      });

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

    it('prefers live secondary lane runId over the primary tracked runId for OpenCode member delivery', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'team-a';
      const laneId = 'secondary:opencode:bob';
      const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        providerId: 'opencode',
        memberName: String(input.memberName),
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_live_lane',
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

      (svc as any).aliveRunByTeam.set(teamName, 'primary-run');
      (svc as any).runs.set('primary-run', {
        runId: 'primary-run',
        teamName,
        processKilled: false,
        cancelRequested: false,
        progress: { state: 'ready' },
        request: { providerId: 'codex', cwd: '/repo' },
        mixedSecondaryLanes: [
          {
            laneId,
            providerId: 'opencode',
            member: { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
            runId: 'opencode-run-live',
            state: 'finished',
            result: {
              members: {
                bob: {
                  bootstrapConfirmed: true,
                  launchState: 'confirmed_alive',
                  sessionId: 'oc-session-bob',
                },
              },
            },
            warnings: [],
            diagnostics: [],
          },
        ],
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
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'hello live lane',
          messageId: 'msg-live-lane',
        })
      ).resolves.toMatchObject({
        delivered: true,
        diagnostics: [],
      });
      expect(sendMessageToMember).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'opencode-run-live',
          teamName,
          laneId,
          memberName: 'bob',
        })
      );
      expect(sendMessageToMember).not.toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'primary-run' })
      );
    });

    it('blocks OpenCode secondary delivery when runtime session exists but bootstrap did not check in', async () => {
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
          { name: 'bob', providerId: 'opencode', model: 'opencode/minimax-m2.5-free' },
        ]),
      };
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId,
        state: 'active',
      });
      await writeCommittedOpenCodeSessionStore({
        teamName,
        laneId,
        runId: 'opencode-run-pending-bootstrap',
        sessions: [],
      });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must wait for bootstrap',
          messageId: 'msg-before-bootstrap-checkin',
        })
      ).resolves.toMatchObject({
        delivered: false,
        reason: 'opencode_runtime_not_active',
        diagnostics: [
          expect.stringContaining('OpenCode runtime bootstrap is not confirmed for bob'),
        ],
      });
      expect(sendMessageToMember).not.toHaveBeenCalled();
      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {
          [laneId]: {
            state: 'active',
          },
        },
      });
    });

    it('rejects stale active lane manifest without runtime evidence before delivery', async () => {
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
            activeRunId: 'opencode-run-stale-empty',
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not deliver to empty durable lane',
          messageId: 'msg-stale-empty-manifest',
        })
      ).resolves.toMatchObject({
        delivered: false,
        reason: 'opencode_runtime_not_active',
        diagnostics: [
          expect.stringContaining('runtime manifest has no committed runtime evidence'),
        ],
      });
      expect(sendMessageToMember).not.toHaveBeenCalled();
      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {
          [laneId]: {
            state: 'degraded',
          },
        },
      });
    });

    it('waits for OpenCode runtime evidence before delivering to a fresh active secondary lane', async () => {
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
      const now = new Date().toISOString();
      const manifestPath = getOpenCodeRuntimeManifestPath(tempTeamsBase, teamName, laneId);
      await fsPromises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fsPromises.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...createDefaultRuntimeStoreManifest(teamName, now),
            activeRunId: 'opencode-run-starting-empty',
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'wait until runtime check-in',
          messageId: 'msg-fresh-empty-manifest',
        })
      ).resolves.toMatchObject({
        delivered: false,
        reason: 'opencode_runtime_not_active',
        diagnostics: [
          expect.stringContaining('OpenCode runtime bootstrap evidence is not ready for bob'),
        ],
      });
      expect(sendMessageToMember).not.toHaveBeenCalled();
      await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
        lanes: {
          [laneId]: {
            state: 'active',
          },
        },
      });
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
        runtimePromptMessageId: 'msg_prompt_manifest_fallback',
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
      await writeCommittedOpenCodeSessionStore({
        teamName,
        laneId,
        runId: 'opencode-run-from-manifest',
        sessions: [
          {
            id: 'oc-session-bob',
            teamName,
            memberName: 'bob',
            laneId,
            runId: 'opencode-run-from-manifest',
            source: 'runtime_bootstrap_checkin',
          },
        ],
      });

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
      stubOpenCodeAppManagedLaunchPrompt(svc);

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
      await vi.waitFor(
        async () => {
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
          await expect(
            readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)
          ).resolves.toMatchObject({
            lanes: {
              'secondary:opencode:bob': {
                state: 'degraded',
                diagnostics: expect.arrayContaining([
                  'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
                  expect.stringMatching(
                    /^OpenCode secondary lane timing: member=bob queueWaitMs=\d+ms launchMs=\d+ms totalMs=\d+ms$/
                  ),
                ]),
              },
            },
          });
        },
        { timeout: 5000 }
      );
    });

    it('does not keep an OpenCode secondary lane active from prompt acceptance without runtime evidence', async () => {
      const teamName = 'mixed-accepted-without-runtime-evidence';
      const svc = new TeamProvisioningService();
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => ({
        runId: String(input.runId),
        teamName: String(input.teamName),
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: {
          tom: {
            memberName: 'tom',
            providerId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'OpenCode bridge reported member launch failure',
            diagnostics: ['runtime_bootstrap_checkin failed: MCP Not connected'],
          },
        },
        warnings: [],
        diagnostics: ['OpenCode bridge reported member launch failure'],
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
      stubOpenCodeAppManagedLaunchPrompt(svc);
      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };

      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['bob'],
      });
      run.isLaunch = true;
      run.request = {
        teamName,
        cwd: '/tmp/mixed-accepted-without-runtime-evidence',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        skipPermissions: true,
      };
      run.effectiveMembers = [
        {
          name: 'bob',
          role: 'Developer',
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
      await vi.waitFor(
        async () => {
          await expect(
            readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)
          ).resolves.toMatchObject({
            lanes: {
              'secondary:opencode:tom': {
                state: 'degraded',
                diagnostics: expect.not.arrayContaining([
                  'opencode_bootstrap_pending_after_materialized_session',
                ]),
              },
            },
          });
          expect(run.mixedSecondaryLanes?.[0]?.result?.members.tom).toMatchObject({
            launchState: 'failed_to_start',
            hardFailure: true,
          });
        },
        { timeout: 5000 }
      );
    });

    it('keeps an OpenCode secondary lane active when bootstrap is pending after runtime materializes', async () => {
      const teamName = 'mixed-runtime-materialized-failure';
      const svc = new TeamProvisioningService();
      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => ({
        runId: String(input.runId),
        teamName: String(input.teamName),
        launchPhase: 'active',
        teamLaunchState: 'partial_failure',
        members: {
          tom: {
            memberName: 'tom',
            providerId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'OpenCode bridge reported member launch failure',
            sessionId: 'ses_tom_materialized_without_bootstrap',
            runtimePid: 71388,
            livenessKind: 'runtime_process',
            diagnostics: [
              'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
            ],
          },
        },
        warnings: [],
        diagnostics: ['OpenCode bridge reported member launch failure'],
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
      stubOpenCodeAppManagedLaunchPrompt(svc);
      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      };

      const run = createMemberSpawnRun({
        teamName,
        expectedMembers: ['bob'],
      });
      run.isLaunch = true;
      run.request = {
        teamName,
        cwd: '/tmp/mixed-runtime-materialized-failure',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        skipPermissions: true,
      };
      run.effectiveMembers = [
        {
          name: 'bob',
          role: 'Developer',
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
      await vi.waitFor(
        async () => {
          expect(adapterLaunch).toHaveBeenCalledTimes(1);
          const launchInput = adapterLaunch.mock.calls[0]?.[0] as { runId?: string } | undefined;
          await expect(
            new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempTeamsBase }).read(
              teamName,
              'secondary:opencode:tom'
            )
          ).resolves.toMatchObject({
            activeRunId: launchInput?.runId,
          });
          await expect(
            readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)
          ).resolves.toMatchObject({
            lanes: {
              'secondary:opencode:tom': {
                state: 'active',
                diagnostics: expect.arrayContaining([
                  'OpenCode bridge reported member launch failure',
                  'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
                  'opencode_bootstrap_pending_after_materialized_session',
                ]),
              },
            },
          });
          expect(run.mixedSecondaryLanes?.[0]?.result?.members.tom).toMatchObject({
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            livenessKind: 'runtime_process',
          });
          expect(run.mixedSecondaryLanes?.[0]?.result?.teamLaunchState).toBe('partial_pending');
        },
        { timeout: 5000 }
      );
    });

    it('starts queued OpenCode secondary lanes sequentially without blocking launch progress', async () => {
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

      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(1);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'launching',
        'queued',
        'queued',
      ]);

      await expect(resultPromise).resolves.toBeNull();
      expect(persistLaunchStateSnapshot).toHaveBeenCalledTimes(1);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await Promise.resolve();
      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(1);
      expect(persistLaunchStateSnapshot).toHaveBeenCalledTimes(2);

      resolveFirstLaunch();
      await Promise.resolve();
      await vi.waitFor(() => expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(3));
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
        runtimeRunId: 'run-member-spawn-1',
        runtimeSessionId: 'session-bob',
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

    it('emits member-spawn when OpenCode runtime liveness first confirms a pending member', async () => {
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
            runtimeRunId: 'run-member-spawn-1',
            runtimeSessionId: 'session-bob',
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
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
      const events: Array<{ type: string; teamName: string; runId?: string; detail?: string }> = [];

      svc.setTeamChangeEmitter((event) => {
        events.push(event);
      });
      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
      };

      await (svc as any).updateOpenCodeRuntimeMemberLiveness({
        teamName: 'mixed-team',
        runId: 'run-member-spawn-1',
        memberName: 'bob',
        runtimeSessionId: 'session-bob',
        observedAt: '2026-04-22T12:05:00.000Z',
        diagnostics: ['native heartbeat'],
        metadata: { runtimePid: 4321 },
        reason: 'OpenCode runtime heartbeat accepted',
      });

      expect(events).toEqual([
        {
          type: 'member-spawn',
          teamName: 'mixed-team',
          runId: 'run-member-spawn-1',
          detail: 'bob',
        },
      ]);
    });

    it('does not emit member-spawn for routine OpenCode heartbeat from the same live session', async () => {
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
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimePid: 4321,
            runtimeRunId: 'run-member-spawn-1',
            runtimeSessionId: 'session-bob',
            livenessKind: 'confirmed_bootstrap' as const,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'ready' as const,
      };
      const events: Array<{ type: string; teamName: string; runId?: string; detail?: string }> = [];
      const write = vi.fn(async () => {});

      svc.setTeamChangeEmitter((event) => {
        events.push(event);
      });
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
        metadata: { runtimePid: 4321 },
        reason: 'OpenCode runtime heartbeat accepted',
      });

      expect(write).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
    });

    it('does not carry a stale OpenCode runtime pid into a fresh runtime run check-in', async () => {
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
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimePid: 1111,
            runtimeRunId: 'opencode-run-old',
            runtimeSessionId: 'session-bob-old',
            livenessKind: 'confirmed_bootstrap' as const,
            pidSource: 'runtime_bootstrap' as const,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'ready' as const,
      };
      const write = vi.fn(async () => {});

      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write,
      };

      await (svc as any).updateOpenCodeRuntimeMemberLiveness({
        teamName: 'mixed-team',
        runId: 'opencode-run-new',
        memberName: 'bob',
        runtimeSessionId: 'session-bob-new',
        observedAt: '2026-04-22T12:05:00.000Z',
        diagnostics: [],
        reason: 'OpenCode runtime bootstrap check-in accepted',
      });

      const writtenSnapshot = (
        write.mock.calls[0] as unknown as [string, Record<string, unknown>] | undefined
      )?.[1] as { members?: Record<string, Record<string, unknown>> } | undefined;
      expect(writtenSnapshot?.members?.bob).toMatchObject({
        runtimeRunId: 'opencode-run-new',
        runtimeSessionId: 'session-bob-new',
        launchState: 'confirmed_alive',
      });
      expect(writtenSnapshot?.members?.bob?.runtimePid).toBeUndefined();
      expect(writtenSnapshot?.members?.bob?.pidSource).toBeUndefined();
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

    it('accepts duplicate OpenCode bootstrap check-ins for the same runtime session and refreshes liveness', async () => {
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
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeRunId: 'opencode-run-1',
            runtimeSessionId: 'session-bob',
            livenessKind: 'confirmed_bootstrap' as const,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'ready' as const,
      };
      const updateLiveness = vi.spyOn(svc as any, 'updateOpenCodeRuntimeMemberLiveness');

      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
      };
      (svc as any).resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'secondary:opencode:bob');
      (svc as any).assertOpenCodeRuntimeEvidenceAccepted = vi.fn(async () => {});

      const ack = await svc.recordOpenCodeRuntimeBootstrapCheckin({
        teamName: 'mixed-team',
        runId: 'opencode-run-1',
        memberName: 'bob',
        runtimeSessionId: 'session-bob',
        observedAt: '2026-04-22T12:05:00.000Z',
      });

      expect(ack).toMatchObject({
        ok: true,
        state: 'accepted',
        diagnostics: ['opencode_bootstrap_checkin_duplicate_accepted'],
        runtimeSessionId: 'session-bob',
      });
      expect(updateLiveness).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'mixed-team',
          runId: 'opencode-run-1',
          memberName: 'bob',
          runtimeSessionId: 'session-bob',
        })
      );
    });

    it('keeps OpenCode bootstrap check-in allowlist on verified config reads', async () => {
      const getConfig = vi.fn(async () => ({
        teamName: 'mixed-team',
        members: [{ name: 'bob', providerId: 'opencode' }],
      }));
      const getConfigSnapshot = vi.fn(async () => {
        throw new Error('snapshot config read should not be used for bootstrap check-in guards');
      });
      const svc = new TeamProvisioningService({
        getConfig,
        getConfigSnapshot,
      } as any);
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => []),
      };

      await expect(
        (svc as any).assertOpenCodeRuntimeMemberCheckinAllowed({
          teamName: 'mixed-team',
          memberName: 'bob',
        })
      ).resolves.toBeUndefined();

      expect(getConfig).toHaveBeenCalledWith('mixed-team');
      expect(getConfigSnapshot).not.toHaveBeenCalled();
    });

    it('rejects duplicate OpenCode bootstrap check-ins for members removed after the first check-in', async () => {
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
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeRunId: 'opencode-run-1',
            runtimeSessionId: 'session-bob',
            livenessKind: 'confirmed_bootstrap' as const,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'ready' as const,
      };
      const updateLiveness = vi.spyOn(svc as any, 'updateOpenCodeRuntimeMemberLiveness');

      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
      };
      (svc as any).resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'secondary:opencode:bob');
      (svc as any).assertOpenCodeRuntimeEvidenceAccepted = vi.fn(async () => {});
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          teamName: 'mixed-team',
          members: [{ name: 'bob', providerId: 'opencode', removedAt: 123 }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => []),
      };

      await expect(
        svc.recordOpenCodeRuntimeBootstrapCheckin({
          teamName: 'mixed-team',
          runId: 'opencode-run-1',
          memberName: 'bob',
          runtimeSessionId: 'session-bob',
          observedAt: '2026-04-22T12:05:00.000Z',
        })
      ).rejects.toMatchObject({
        name: 'RuntimeStaleEvidenceError',
      });
      expect(updateLiveness).not.toHaveBeenCalled();
    });

    it('rejects conflicting OpenCode bootstrap check-ins for an already confirmed runtime session', async () => {
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
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeRunId: 'opencode-run-1',
            runtimeSessionId: 'session-bob-1',
            livenessKind: 'confirmed_bootstrap' as const,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'ready' as const,
      };
      const updateLiveness = vi.spyOn(svc as any, 'updateOpenCodeRuntimeMemberLiveness');

      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
      };
      (svc as any).resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'secondary:opencode:bob');
      (svc as any).assertOpenCodeRuntimeEvidenceAccepted = vi.fn(async () => {});

      await expect(
        svc.recordOpenCodeRuntimeBootstrapCheckin({
          teamName: 'mixed-team',
          runId: 'opencode-run-1',
          memberName: 'bob',
          runtimeSessionId: 'session-bob-2',
          observedAt: '2026-04-22T12:05:00.000Z',
        })
      ).rejects.toMatchObject({
        name: 'RuntimeStaleEvidenceError',
        message: expect.stringContaining('opencode_bootstrap_checkin_session_conflict'),
      });
      expect(updateLiveness).not.toHaveBeenCalled();
    });

    it('does not let stale confirmed OpenCode evidence from an older run block a fresh check-in', async () => {
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
            launchState: 'confirmed_alive' as const,
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeRunId: 'opencode-run-old',
            runtimeSessionId: 'session-bob-old',
            livenessKind: 'confirmed_bootstrap' as const,
            lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'ready' as const,
      };
      const updateLiveness = vi
        .spyOn(svc as any, 'updateOpenCodeRuntimeMemberLiveness')
        .mockResolvedValue(undefined);

      (svc as any).launchStateStore = {
        read: vi.fn(async () => previousSnapshot),
        write: vi.fn(async () => {}),
      };
      (svc as any).resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'secondary:opencode:bob');
      (svc as any).assertOpenCodeRuntimeEvidenceAccepted = vi.fn(async () => {});
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          teamName: 'mixed-team',
          members: [{ name: 'bob', providerId: 'opencode' }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => []),
      };

      await expect(
        svc.recordOpenCodeRuntimeBootstrapCheckin({
          teamName: 'mixed-team',
          runId: 'opencode-run-new',
          memberName: 'bob',
          runtimeSessionId: 'session-bob-new',
          observedAt: '2026-04-22T12:05:00.000Z',
        })
      ).resolves.toMatchObject({
        ok: true,
        state: 'accepted',
        runtimeSessionId: 'session-bob-new',
      });
      expect(updateLiveness).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'opencode-run-new',
          runtimeSessionId: 'session-bob-new',
        })
      );
    });

    it('rejects OpenCode bootstrap check-ins for removed members before writing runtime evidence', async () => {
      const svc = new TeamProvisioningService();
      const updateLiveness = vi.spyOn(svc as any, 'updateOpenCodeRuntimeMemberLiveness');

      (svc as any).launchStateStore = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
      };
      (svc as any).resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'secondary:opencode:bob');
      (svc as any).assertOpenCodeRuntimeEvidenceAccepted = vi.fn(async () => {});
      (svc as any).configReader = {
        getConfig: vi.fn(async () => ({
          teamName: 'mixed-team',
          members: [{ name: 'bob', providerId: 'opencode', removedAt: 123 }],
        })),
      };
      (svc as any).membersMetaStore = {
        getMembers: vi.fn(async () => []),
      };

      await expect(
        svc.recordOpenCodeRuntimeBootstrapCheckin({
          teamName: 'mixed-team',
          runId: 'opencode-run-1',
          memberName: 'bob',
          runtimeSessionId: 'session-bob',
        })
      ).rejects.toMatchObject({
        name: 'RuntimeStaleEvidenceError',
      });
      expect(updateLiveness).not.toHaveBeenCalled();
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

    it('commits lane-scoped OpenCode session evidence when bootstrap check-in is accepted', async () => {
      const svc = new TeamProvisioningService();
      const teamName = 'mixed-team';
      const laneId = 'secondary:opencode:bob';
      const runId = 'opencode-run-1';
      const teamDir = path.join(tempTeamsBase, teamName);
      await fsPromises.mkdir(teamDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(teamDir, 'config.json'),
        `${JSON.stringify({
          name: teamName,
          projectPath: '/tmp/mixed-team',
          members: [
            { name: 'team-lead', providerId: 'codex' },
            { name: 'bob', providerId: 'opencode' },
          ],
        })}\n`,
        'utf8'
      );

      (svc as any).aliveRunByTeam.set(teamName, 'lead-run');
      (svc as any).runs.set('lead-run', {
        runId: 'lead-run',
        teamName,
        request: {
          providerId: 'codex',
        },
      });
      (svc as any).setSecondaryRuntimeRun({
        teamName,
        runId,
        providerId: 'opencode',
        laneId,
        memberName: 'bob',
        cwd: '/tmp/mixed-team',
      });

      await expect(
        svc.recordOpenCodeRuntimeBootstrapCheckin({
          teamName,
          runId,
          memberName: 'bob',
          runtimeSessionId: 'session-bob',
          observedAt: '2026-04-22T12:05:00.000Z',
        })
      ).resolves.toMatchObject({
        ok: true,
        state: 'accepted',
        runtimeSessionId: 'session-bob',
      });

      const manifestPath = getOpenCodeRuntimeManifestPath(tempTeamsBase, teamName, laneId);
      const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8')) as {
        data: { entries: Array<{ schemaName: string; relativePath: string; runId: string }> };
      };
      expect(manifest.data.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaName: 'opencode.sessionStore',
            relativePath: 'opencode-sessions.json',
            runId,
          }),
        ])
      );
      const sessionStore = JSON.parse(
        await fsPromises.readFile(
          path.join(path.dirname(manifestPath), 'opencode-sessions.json'),
          'utf8'
        )
      ) as {
        data: {
          sessions: Array<{ id: string; memberName: string; runId: string; laneId: string }>;
        };
      };
      expect(sessionStore.data.sessions).toEqual([
        expect.objectContaining({
          id: 'session-bob',
          memberName: 'bob',
          runId,
          laneId,
        }),
      ]);
    });

    it('updates the live mixed OpenCode lane when bootstrap check-in arrives after launch command completion', async () => {
      const svc = new TeamProvisioningService();
      const persistLaunchStateSnapshot = vi.spyOn(svc as any, 'persistLaunchStateSnapshot');
      const teamName = 'mixed-live-checkin-team';
      const laneId = 'secondary:opencode:tom';
      const runId = 'opencode-run-tom';
      const run = createMemberSpawnRun({
        runId: 'lead-run',
        teamName,
        expectedMembers: ['bob', 'tom'],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'online',
              launchState: 'confirmed_alive',
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
            }),
          ],
          [
            'tom',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
            }),
          ],
        ]),
      });
      Object.assign(run, {
        isLaunch: true,
        request: { providerId: 'codex', members: [] },
        effectiveMembers: [{ name: 'bob', providerId: 'codex', model: 'gpt-5.5' }],
        allEffectiveMembers: [
          { name: 'bob', providerId: 'codex', model: 'gpt-5.5' },
          { name: 'tom', providerId: 'opencode', model: 'openrouter/minimax/minimax-m2.5' },
        ],
        mixedSecondaryLanes: [
          {
            laneId,
            providerId: 'opencode',
            member: {
              name: 'tom',
              providerId: 'opencode',
              model: 'openrouter/minimax/minimax-m2.5',
            },
            runId,
            state: 'finished',
            result: {
              runId,
              teamName,
              launchPhase: 'active',
              teamLaunchState: 'partial_pending',
              members: {
                tom: {
                  memberName: 'tom',
                  providerId: 'opencode',
                  launchState: 'runtime_pending_bootstrap',
                  agentToolAccepted: true,
                  runtimeAlive: false,
                  bootstrapConfirmed: false,
                  hardFailure: false,
                  livenessKind: 'registered_only',
                  diagnostics: ['registered runtime metadata without live process'],
                },
              },
              warnings: [],
              diagnostics: ['registered runtime metadata without live process'],
            },
            warnings: [],
            diagnostics: ['registered runtime metadata without live process'],
          },
        ],
      });
      (svc as any).aliveRunByTeam.set(teamName, 'lead-run');
      (svc as any).runs.set('lead-run', run);

      await (svc as any).updateOpenCodeRuntimeMemberLiveness({
        teamName,
        runId,
        memberName: 'tom',
        runtimeSessionId: 'ses_tom_live',
        observedAt: '2026-04-22T12:05:00.000Z',
        diagnostics: undefined,
        metadata: undefined,
        reason: 'OpenCode runtime bootstrap check-in accepted',
      });

      expect(run.memberSpawnStatuses.get('tom')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        livenessKind: 'confirmed_bootstrap',
      });
      expect(run.mixedSecondaryLanes[0]?.result?.members.tom).toMatchObject({
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        sessionId: 'ses_tom_live',
      });
      expect(persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'finished');
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

    it('restarts a process backend teammate directly without asking the lead to respawn it', async () => {
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
      const directProcessRestart = vi.fn(async () => {});
      (svc as any).sendMessageToRun = sendMessageToRun;
      (svc as any).launchDirectProcessMemberRestart = directProcessRestart;
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
          tmuxPaneId: 'process:1234',
          runtimePid: 1234,
        },
      ]);
      (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      (svc as any).aliveRunByTeam.set('process-team', run.runId);
      (svc as any).runs.set(run.runId, run);

      await svc.restartMember('process-team', 'forge');

      expect(directProcessRestart).toHaveBeenCalledTimes(1);
      expect(sendMessageToRun).not.toHaveBeenCalled();
      expect(run.pendingMemberRestarts.has('forge')).toBe(true);
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
        mixedSecondaryLanes: [{ providerId: 'opencode', member: { name: 'bob' } }],
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
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        bootstrapConfirmed: false,
        livenessSource: undefined,
        livenessKind: 'runtime_process',
        runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
        runtimeDiagnosticSeverity: 'warning',
        bootstrapStalled: true,
        hardFailure: false,
      });
    });

    it('keeps OpenCode runtime process pending before the bootstrap stall window', async () => {
      const svc = new TeamProvisioningService();
      const run = createMemberSpawnRun({
        teamName: 'codex-team',
        expectedMembers: ['bob'],
        mixedSecondaryLanes: [{ providerId: 'opencode', member: { name: 'bob' } }],
        memberSpawnStatuses: new Map([
          [
            'bob',
            createMemberSpawnStatusEntry({
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              firstSpawnAcceptedAt: new Date(Date.now() - 60_000).toISOString(),
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
                runtimeDiagnostic: 'OpenCode runtime process detected',
              },
            ],
          ])
      );

      await (svc as any).reevaluateMemberLaunchStatus(run, 'bob');

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        bootstrapConfirmed: false,
        livenessSource: undefined,
        livenessKind: 'runtime_process',
        runtimeDiagnostic: 'OpenCode runtime process detected',
        runtimeDiagnosticSeverity: 'info',
        bootstrapStalled: undefined,
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
    it('does not wait for OpenCode secondary inboxes before completing primary filesystem readiness', async () => {
      const teamName = 'mixed-secondary-fs-readiness';
      const teamDir = path.join(tempTeamsBase, teamName);
      fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        `${JSON.stringify(
          {
            name: teamName,
            members: [
              { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
              { name: 'alice', providerId: 'codex' },
            ],
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      fs.writeFileSync(path.join(teamDir, 'inboxes', 'alice.json'), '[]\n', 'utf8');

      const svc = new TeamProvisioningService();
      const complete = vi
        .spyOn(svc as any, 'handleProvisioningTurnComplete')
        .mockResolvedValue(undefined);
      const run = {
        runId: 'run-mixed-secondary-fs-readiness',
        teamName,
        cancelRequested: false,
        processKilled: false,
        provisioningComplete: false,
        deterministicBootstrap: true,
        fsPhase: 'waiting_members',
        effectiveMembers: [{ name: 'alice', providerId: 'codex' }],
        progress: { state: 'assembling' },
        onProgress: vi.fn(),
        fsMonitorHandle: null,
      } as any;

      (svc as any).startFilesystemMonitor(run, {
        teamName,
        cwd: tempClaudeRoot,
        providerId: 'codex',
        model: 'gpt-5.4',
        members: [
          { name: 'alice', providerId: 'codex' },
          { name: 'tom', providerId: 'opencode' },
        ],
      });

      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
      expect(run.fsPhase).toBe('all_files_found');
      expect(run.onProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Prepared communication channels for 1/2 members',
        })
      );

      (svc as any).stopFilesystemMonitor(run);
    });

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
      stubOpenCodeAppManagedLaunchPrompt(svc);

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

    it('materializes members.meta.json before config normalization for a repairable legacy launch', async () => {
      allowConsoleLogs();
      const teamName = 'legacy-pure-launch-repair';
      const leadSessionId = 'legacy-pure-launch-session';
      writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice', 'bob']);
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);

      const { svc, membersMetaStore } = createSafeLaunchService();
      const normalizeSpy = vi.spyOn(svc as any, 'normalizeTeamConfigForLaunch');

      const { runId } = await svc.launchTeam(
        {
          teamName,
          cwd: tempClaudeRoot,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
        },
        vi.fn()
      );

      expect(membersMetaStore.writeMembers).toHaveBeenCalledWith(
        teamName,
        expect.arrayContaining([
          expect.objectContaining({ name: 'alice' }),
          expect.objectContaining({ name: 'bob' }),
        ]),
        expect.objectContaining({ providerBackendId: 'codex-native' })
      );
      expect(membersMetaStore.writeMembers.mock.invocationCallOrder[0]).toBeLessThan(
        normalizeSpy.mock.invocationCallOrder[0]
      );

      await svc.cancelProvisioning(runId);
    });

    it('blocks unsafe old mixed OpenCode launches before config normalization or launch-state cleanup', async () => {
      allowConsoleLogs();
      const teamName = 'legacy-mixed-unsafe-launch';
      const teamDir = path.join(tempTeamsBase, teamName);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        `${JSON.stringify(
          {
            name: teamName,
            projectPath: tempClaudeRoot,
            leadSessionId: 'legacy-mixed-unsafe-session',
            members: [
              { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
              { name: 'jack', role: 'Developer', providerId: 'opencode' },
            ],
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);

      const { svc, membersMetaStore } = createSafeLaunchService();
      const normalizeSpy = vi.spyOn(svc as any, 'normalizeTeamConfigForLaunch');
      const clearLaunchStateSpy = vi.spyOn(svc as any, 'clearPersistedLaunchState');

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
      ).rejects.toThrow(getMixedLaunchFallbackRecoveryError());

      expect(membersMetaStore.writeMembers).not.toHaveBeenCalled();
      expect(normalizeSpy).not.toHaveBeenCalled();
      expect(clearLaunchStateSpy).not.toHaveBeenCalled();
      expect(spawnCli).not.toHaveBeenCalled();
    });

    it('invalidates config cache after writing OpenCode team config', async () => {
      const teamName = 'opencode-config-cache-prime';
      fs.mkdirSync(path.join(tempTeamsBase, teamName), { recursive: true });
      const invalidateSpy = vi.spyOn(TeamConfigReader, 'invalidateTeam');
      const { svc } = createSafeLaunchService();

      await (svc as any).writeOpenCodeTeamConfig(
        {
          teamName,
          displayName: 'OpenCode Config Cache Prime',
          cwd: tempClaudeRoot,
          providerId: 'opencode',
          model: 'openrouter/test/model',
          effort: 'medium',
        },
        [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'openrouter/test/model',
          },
        ]
      );

      expect(invalidateSpy).toHaveBeenCalledWith(teamName);
      expect((await new TeamConfigReader().getConfigSnapshot(teamName))?.name).toBe(
        'OpenCode Config Cache Prime'
      );
      invalidateSpy.mockRestore();
    });

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
        const teamName = String(input.teamName);
        const laneId = String(input.laneId);
        const runId = String(input.runId);
        await writeCommittedOpenCodeSessionStore({
          teamName,
          laneId,
          runId,
          sessions: [
            {
              id: `oc-session-${memberName}`,
              teamName,
              memberName,
              laneId,
              runId,
              source: 'runtime_bootstrap_checkin',
            },
          ],
        });
        return {
          runId,
          teamName,
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
      await vi.waitFor(() => expect(adapterLaunch).toHaveBeenCalledTimes(2), { timeout: 5_000 });
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
      await vi.waitFor(
        () => {
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
        },
        { timeout: 5_000 }
      );
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

    it('resets stale OpenCode lane manifests before launch and retries exact stale watermark once', async () => {
      allowConsoleLogs();
      const teamName = 'safe-mixed-opencode-stale-manifest-recovery';
      const laneId = 'secondary:opencode:bob';
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);
      await writeCommittedOpenCodeSessionStore({
        teamName,
        laneId,
        runId: 'old-opencode-run',
        sessions: [
          {
            id: 'old-session-bob',
            teamName,
            memberName: 'bob',
            laneId,
            runId: 'old-opencode-run',
            source: 'runtime_bootstrap_checkin',
          },
        ],
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId,
        runId: 'old-opencode-run',
      });

      const adapterLaunch = vi.fn(async (input: Record<string, unknown>) => {
        const runId = String(input.runId);
        const manifest = await createRuntimeStoreManifestStore({
          filePath: getOpenCodeRuntimeManifestPath(tempTeamsBase, teamName, laneId),
          teamName,
        }).read();
        expect(manifest).toMatchObject({
          activeRunId: runId,
          highWatermark: 0,
          entries: [],
        });

        if (adapterLaunch.mock.calls.length === 1) {
          throw new Error(
            'OpenCode bridge failed: Bridge server runtime manifest high watermark is stale'
          );
        }

        await writeCommittedOpenCodeSessionStore({
          teamName,
          laneId,
          runId,
          sessions: [
            {
              id: 'fresh-session-bob',
              teamName,
              memberName: 'bob',
              laneId,
              runId,
              source: 'runtime_bootstrap_checkin',
            },
          ],
        });
        return {
          runId,
          teamName,
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
        };
      });

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

      const { runId } = await svc.createTeam(
        {
          teamName,
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
              model: 'minimax/m2.5',
            },
          ],
        },
        () => {}
      );

      const run = (svc as any).runs.get(runId);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(() => expect(adapterLaunch).toHaveBeenCalledTimes(2), { timeout: 5_000 });

      await vi.waitFor(
        async () => {
          const publicStatuses = await svc.getMemberSpawnStatuses(teamName);
          expect(publicStatuses.statuses.bob).toMatchObject({
            status: 'online',
            launchState: 'confirmed_alive',
          });
        },
        { timeout: 5_000 }
      );

      await svc.cancelProvisioning(runId);
    });

    it('keeps stale OpenCode lane manifest recovery bounded when the bridge stays stale', async () => {
      allowConsoleLogs();
      const teamName = 'safe-mixed-opencode-stale-manifest-terminal';
      const laneId = 'secondary:opencode:bob';
      const staleWatermarkError =
        'OpenCode bridge failed: Bridge server runtime manifest high watermark is stale';
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);
      await writeCommittedOpenCodeSessionStore({
        teamName,
        laneId,
        runId: 'old-opencode-run',
        sessions: [
          {
            id: 'old-session-bob',
            teamName,
            memberName: 'bob',
            laneId,
            runId: 'old-opencode-run',
            source: 'runtime_bootstrap_checkin',
          },
        ],
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempTeamsBase,
        teamName,
        laneId,
        runId: 'old-opencode-run',
      });

      const adapterLaunch = vi.fn(async () => {
        throw new Error(staleWatermarkError);
      });
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

      const { runId } = await svc.createTeam(
        {
          teamName,
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
              model: 'minimax/m2.5',
            },
          ],
        },
        () => {}
      );

      const run = (svc as any).runs.get(runId);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(() => expect(adapterLaunch).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      await vi.waitFor(
        async () => {
          const publicStatuses = await svc.getMemberSpawnStatuses(teamName);
          expect(publicStatuses.statuses.bob).toMatchObject({
            status: 'error',
            launchState: 'failed_to_start',
          });
          expect(JSON.stringify(publicStatuses.statuses.bob)).toContain(staleWatermarkError);
        },
        { timeout: 5_000 }
      );

      await svc.cancelProvisioning(runId);
    });

    it('does not retry non-stale OpenCode provider launch failures as manifest recovery', async () => {
      allowConsoleLogs();
      const teamName = 'safe-mixed-opencode-provider-failure-no-stale-retry';
      const providerError =
        'OpenCode quota exhausted. This request requires more credits, or fewer max_tokens.';
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
      vi.mocked(spawnCli).mockReturnValue(createRunningChild() as any);

      const adapterLaunch = vi.fn(async () => {
        throw new Error(providerError);
      });
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

      const { runId } = await svc.createTeam(
        {
          teamName,
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
              model: 'minimax/m2.5',
            },
          ],
        },
        () => {}
      );

      const run = (svc as any).runs.get(runId);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await vi.waitFor(() => expect(adapterLaunch).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      await vi.waitFor(
        async () => {
          const publicStatuses = await svc.getMemberSpawnStatuses(teamName);
          expect(publicStatuses.statuses.bob).toMatchObject({
            status: 'error',
            launchState: 'failed_to_start',
          });
          expect(JSON.stringify(publicStatuses.statuses.bob)).toContain(providerError);
        },
        { timeout: 5_000 }
      );

      await svc.cancelProvisioning(runId);
    });

    it('restores missing OpenCode teammates into config before post-launch registration audit', async () => {
      allowConsoleLogs();
      const teamName = 'mixed-opencode-post-launch-config';
      const teamDir = path.join(tempTeamsBase, teamName);
      const jackWorktree = path.join(tempClaudeRoot, 'worktrees', 'jack');
      const invalidateSpy = vi.spyOn(TeamConfigReader, 'invalidateTeam');
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

      const config = JSON.parse(fs.readFileSync(path.join(teamDir, 'config.json'), 'utf8')) as {
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
      expect(invalidateSpy).toHaveBeenCalledWith(teamName);
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
      invalidateSpy.mockRestore();
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
        const teamName = String(input.teamName);
        const laneId = String(input.laneId);
        const runId = String(input.runId);
        await writeCommittedOpenCodeSessionStore({
          teamName,
          laneId,
          runId,
          sessions: [
            {
              id: `oc-session-${memberName}`,
              teamName,
              memberName,
              laneId,
              runId,
              source: 'runtime_bootstrap_checkin',
            },
          ],
        });
        return {
          runId,
          teamName,
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

      const { svc, membersMetaStore } = createSafeLaunchService({
        memberWorktreeManager: worktreeManager,
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
    const getConfig = vi.fn(async () => ({
      projectPath: tempClaudeRoot,
      members: [{ cwd: tempClaudeRoot }],
    }));
    const getConfigSnapshot = vi.fn(async () => {
      throw new Error('snapshot config read should not be used for permission writes');
    });
    const svc = new TeamProvisioningService({
      getConfig,
      getConfigSnapshot,
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
    expect(getConfig).toHaveBeenCalledWith('ops-team');
    expect(getConfigSnapshot).not.toHaveBeenCalled();
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

  it('uses a non-alarming model delay message before 2 minutes of silence', () => {
    const svc = new TeamProvisioningService();

    expect((svc as any).buildStallProgressMessage(90, '1m 30s')).toBe(
      'Waiting for model response for 1m 30s - logs can be delayed, this is still OK'
    );

    expect(
      (svc as any).buildStallWarningText(90, {
        request: { model: 'sonnet' },
      })
    ).toContain('Logs can sometimes show up after 1-1.5 minutes, and that is still okay.');
  });

  it('marks a model wait as unusual after 2 minutes of silence', () => {
    const svc = new TeamProvisioningService();

    expect((svc as any).buildStallProgressMessage(120, '2m')).toBe(
      'Still waiting for model response for 2m - this is unusual'
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

  it('skips --resume for deterministic bootstrap when previous launch state has no spawned teammates', async () => {
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

  it('skips --resume for deterministic bootstrap when previous active launch is stale', async () => {
    allowConsoleLogs();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:03:00.000Z'));

    const teamName = 'resume-skip-stale-active-team';
    const leadSessionId = 'lead-session-skip-stale-active';
    writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice', 'bob']);
    writeLaunchState(
      teamName,
      leadSessionId,
      {
        alice: {
          launchState: 'starting',
          hardFailure: false,
        },
        bob: {
          launchState: 'starting',
          hardFailure: false,
        },
      },
      {
        launchPhase: 'active',
        updatedAt: '2026-05-03T12:00:00.000Z',
      }
    );

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

  it('skips --resume for deterministic bootstrap when stale active launch has no live teammates', async () => {
    allowConsoleLogs();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:03:00.000Z'));

    const teamName = 'resume-skip-stale-active-dead-team';
    const leadSessionId = 'lead-session-skip-stale-active-dead';
    writeLaunchConfig(teamName, tempClaudeRoot, leadSessionId, ['alice', 'bob']);
    writeLaunchState(
      teamName,
      leadSessionId,
      {
        alice: {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-05-03T12:00:15.000Z',
          hardFailure: false,
        },
        bob: {
          launchState: 'starting',
          hardFailure: false,
        },
      },
      {
        launchPhase: 'active',
        updatedAt: '2026-05-03T12:00:00.000Z',
      }
    );

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

  it('skips --resume with deterministic bootstrap even after an accepted failed spawn', async () => {
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
    expect(launchArgs).not.toContain('--resume');
    expect(launchArgs).not.toContain(leadSessionId);
  });

  it('skips --resume with deterministic bootstrap after Codex backend normalization', async () => {
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
    expect(launchArgs).not.toContain('--resume');
    expect(launchArgs).not.toContain(leadSessionId);
  });

  it('does not seed the previous lead session id when deterministic bootstrap skips resume', async () => {
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

    const launchArgs = vi.mocked(spawnCli).mock.calls.at(-1)?.[1] as string[];
    expect(launchArgs).not.toContain('--resume');
    expect((svc as any).pathExists).not.toHaveBeenCalled();
    expect(svc.getCurrentLeadSessionId(teamName)).toBeNull();

    await svc.cancelProvisioning(runId);
  });

  it('waits for child close before handling launch process exit so stream-json can drain', async () => {
    allowConsoleLogs();
    const teamName = 'launch-close-drains-stdout-team';
    const leadSessionId = 'lead-session-close-drain';
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
    const handleProcessExit = vi
      .spyOn(svc as any, 'handleProcessExit')
      .mockResolvedValue(undefined);

    const { runId } = await svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {});

    child.emit('exit', 0);
    await Promise.resolve();
    expect(handleProcessExit).not.toHaveBeenCalled();

    child.emit('close', 0);
    await vi.waitFor(() => expect(handleProcessExit).toHaveBeenCalledTimes(1));
    expect(handleProcessExit.mock.calls[0]?.[1]).toBe(0);

    await svc.cancelProvisioning(runId);
  });

  it('flushes a final newline-less bootstrap completion event before handling launch close', async () => {
    allowConsoleLogs();
    const teamName = 'launch-close-flushes-final-json-team';
    const leadSessionId = 'lead-session-final-json-flush';
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
    const complete = vi
      .spyOn(svc as any, 'handleProvisioningTurnComplete')
      .mockImplementation(async (run: any) => {
        run.provisioningComplete = true;
      });

    const { runId } = await svc.launchTeam({ teamName, cwd: tempClaudeRoot }, () => {});

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'system',
          subtype: 'team_bootstrap',
          event: 'completed',
          run_id: runId,
          team_name: teamName,
          seq: 1,
          failed_members: [],
        }),
        'utf8'
      )
    );
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();

    child.emit('close', 0);

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  it('recovers ready progress when deterministic create finalization stalls after completed bootstrap-state', async () => {
    allowConsoleLogs();
    vi.useFakeTimers();
    const teamName = 'create-completed-bootstrap-finalization-stall';
    const child = createRunningChild();
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/claude');
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const mcpConfigBuilder = {
      writeConfigFile: vi.fn(async () => '/mock/mcp-config-create.json'),
      removeConfigFile: vi.fn(async () => {}),
    };
    const membersMetaStore = {
      writeMembers: vi.fn(async () => {}),
      getMembers: vi.fn(async () => []),
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
      teamMetaStore as any
    );
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { CODEX_API_KEY: 'test' },
      authSource: 'codex_runtime',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).startStallWatchdog = vi.fn();
    (svc as any).stopStallWatchdog = vi.fn();
    (svc as any).resolveAndValidateLaunchIdentity = vi.fn(async () => ({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      selectedModel: 'gpt-5.5',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'gpt-5.5',
      catalogId: 'gpt-5.5',
      catalogSource: 'test',
      catalogFetchedAt: '2026-05-07T00:00:00.000Z',
      selectedEffort: 'medium',
      resolvedEffort: 'medium',
      selectedFastMode: null,
      resolvedFastMode: null,
      fastResolutionReason: null,
    }));
    const waitForValidConfig = vi.fn(() => new Promise(() => {}));
    (svc as any).waitForValidConfig = waitForValidConfig;

    const progressStates: string[] = [];
    const { runId } = await svc.createTeam(
      {
        teamName,
        cwd: tempClaudeRoot,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.5',
        members: [{ name: 'alice' }, { name: 'tom' }],
      },
      (progress) => {
        progressStates.push(progress.state);
      }
    );
    const run = (svc as any).runs.get(runId);
    expect(run).toBeTruthy();
    run.deterministicBootstrap = true;
    const scheduleRecovery = vi.spyOn(
      svc as any,
      'scheduleDeterministicBootstrapCompletionRecovery'
    );

    writeBootstrapState(
      teamName,
      [
        { name: 'alice', status: 'bootstrap_confirmed' },
        { name: 'tom', status: 'bootstrap_confirmed' },
      ],
      new Date(Date.now() + 1_000).toISOString()
    );

    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'system',
          subtype: 'team_bootstrap',
          event: 'completed',
          run_id: runId,
          team_name: teamName,
          seq: 1,
          failed_members: [],
        })}\n`,
        'utf8'
      )
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(waitForValidConfig).toHaveBeenCalledTimes(1);
    expect(scheduleRecovery).toHaveBeenCalledWith(run);
    expect(progressStates.at(-1)).not.toBe('ready');

    await (svc as any).recoverDeterministicBootstrapCompletion(run);
    expect(progressStates.at(-1)).toBe('ready');
    expect((svc as any).provisioningRunByTeam.has(teamName)).toBe(false);
    expect((svc as any).aliveRunByTeam.get(teamName)).toBe(runId);
  });

  it('does not verify provisioning again after flushing a final newline-less error result', async () => {
    allowConsoleLogs();
    const teamName = 'launch-close-flushes-final-error-team';
    const leadSessionId = 'lead-session-final-error-flush';
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
    const waitForValidConfig = vi
      .spyOn(svc as any, 'waitForValidConfig')
      .mockResolvedValue({ ok: false });
    const progressStates: string[] = [];

    await svc.launchTeam({ teamName, cwd: tempClaudeRoot }, (progress) => {
      progressStates.push(progress.state);
    });

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'result',
          subtype: 'error',
          error: 'runtime failed before bootstrap completed',
        }),
        'utf8'
      )
    );
    child.emit('close', 1);

    await Promise.resolve();
    expect(waitForValidConfig).not.toHaveBeenCalled();
    expect(progressStates).toContain('failed');
    expect(progressStates).not.toContain('verifying');
  });

  it('does not verify provisioning while auth retry is scheduled from final newline-less output', async () => {
    allowConsoleLogs();
    const teamName = 'launch-close-flushes-final-auth-team';
    const leadSessionId = 'lead-session-final-auth-flush';
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
    const waitForValidConfig = vi
      .spyOn(svc as any, 'waitForValidConfig')
      .mockResolvedValue({ ok: false });
    const respawnAfterAuthFailure = vi
      .spyOn(svc as any, 'respawnAfterAuthFailure')
      .mockResolvedValue(undefined);
    const progressStates: string[] = [];

    const { runId } = await svc.launchTeam({ teamName, cwd: tempClaudeRoot }, (progress) => {
      progressStates.push(progress.state);
    });
    const run = (svc as any).runs.get(runId);

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'invalid api key' }],
        }),
        'utf8'
      )
    );
    child.emit('close', 1);

    await Promise.resolve();
    expect(run.authRetryInProgress).toBe(true);
    expect(respawnAfterAuthFailure).toHaveBeenCalledWith(run);
    expect(waitForValidConfig).not.toHaveBeenCalled();
    expect(progressStates).not.toContain('verifying');
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

  it('heals terminal bootstrap-state failures when transcript shows successful member_briefing', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-state-transcript-heals';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const successAt = new Date(Date.now() - 60_000).toISOString();
    const failureAt = new Date(Date.now() - 30_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'failed',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(failureAt),
          failureReason: 'Teammate was registered but did not bootstrap-confirm before timeout.',
        },
      ],
      failureAt
    );

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
          timestamp: successAt,
          teamName,
          agentName: 'jack',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'item_1',
                content: `Member briefing for jack on team "${teamName}" (${teamName}).\nTask briefing for jack:\nNo actionable tasks.`,
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

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.statuses.jack).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      error: undefined,
    });
  });

  it('heals terminal bootstrap-state failures when runtime proof confirms member_briefing', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-state-runtime-proof-heals';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const proofAt = new Date(Date.now() - 60_000).toISOString();
    const failureAt = new Date(Date.now() - 30_000).toISOString();
    const proofToken = 'proof-token-jack';
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapProofToken: proofToken,
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'failed',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(failureAt),
          failureReason: 'Teammate was registered but did not bootstrap-confirm before timeout.',
        },
      ],
      failureAt
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      `${JSON.stringify({
        version: 1,
        type: 'bootstrap_confirmed',
        timestamp: proofAt,
        pid: 1234,
        teamName,
        agentName: 'jack',
        agentId: `jack@${teamName}`,
        source: 'member_briefing_tool_success',
        bootstrapProofToken: proofToken,
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.statuses.jack).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      hardFailure: false,
      error: undefined,
    });
  });

  it('heals terminal bootstrap-state failures when native app-managed proof matches token and hashes', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-state-native-runtime-proof-heals';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const proofAt = new Date(Date.now() - 60_000).toISOString();
    const failureAt = new Date(Date.now() - 30_000).toISOString();
    const proofToken = 'proof-token-jack-native';
    const bootstrapRunId = 'run-native-proof';
    const contextHash = 'a'.repeat(64);
    const briefingHash = 'b'.repeat(64);
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapProofToken: proofToken,
            bootstrapRunId,
            bootstrapProofMode: 'native_app_managed_context',
            bootstrapContextHash: contextHash,
            bootstrapBriefingHash: briefingHash,
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'failed',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(failureAt),
          failureReason: 'Teammate was registered but did not bootstrap-confirm before timeout.',
        },
      ],
      failureAt
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      `${JSON.stringify({
        version: 1,
        type: 'bootstrap_confirmed',
        timestamp: proofAt,
        pid: 1234,
        teamName,
        agentName: 'jack',
        agentId: `jack@${teamName}`,
        runId: bootstrapRunId,
        source: 'native_app_managed_bootstrap_private_turn',
        bootstrapProofToken: proofToken,
        contextHash,
        briefingHash,
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.statuses.jack).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      hardFailure: false,
      error: undefined,
    });
  });

  it('does not heal terminal bootstrap-state failures from native app-managed proof with mismatched hashes', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-state-native-runtime-proof-hash-mismatch';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const proofAt = new Date(Date.now() - 60_000).toISOString();
    const failureAt = new Date(Date.now() - 30_000).toISOString();
    const proofToken = 'proof-token-jack-native';
    const bootstrapRunId = 'run-native-proof';
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapProofToken: proofToken,
            bootstrapRunId,
            bootstrapProofMode: 'native_app_managed_context',
            bootstrapContextHash: 'a'.repeat(64),
            bootstrapBriefingHash: 'b'.repeat(64),
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'failed',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(failureAt),
          failureReason: 'Teammate was registered but did not bootstrap-confirm before timeout.',
        },
      ],
      failureAt
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      `${JSON.stringify({
        version: 1,
        type: 'bootstrap_confirmed',
        timestamp: proofAt,
        pid: 1234,
        teamName,
        agentName: 'jack',
        agentId: `jack@${teamName}`,
        runId: bootstrapRunId,
        source: 'native_app_managed_bootstrap_private_turn',
        bootstrapProofToken: proofToken,
        contextHash: 'c'.repeat(64),
        briefingHash: 'b'.repeat(64),
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.statuses.jack).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      hardFailure: true,
    });
  });

  it('does not heal bootstrap-state failures from stale runtime proof before spawn acceptance', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-state-stale-runtime-proof-ignored';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const proofAt = new Date(Date.now() - 120_000).toISOString();
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const failureAt = new Date(Date.now() - 30_000).toISOString();
    const proofToken = 'proof-token-jack';
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapProofToken: proofToken,
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'failed',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(failureAt),
          failureReason: 'Teammate was registered but did not bootstrap-confirm before timeout.',
        },
      ],
      failureAt
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      `${JSON.stringify({
        version: 1,
        type: 'bootstrap_confirmed',
        timestamp: proofAt,
        pid: 1234,
        teamName,
        agentName: 'jack',
        agentId: `jack@${teamName}`,
        source: 'member_briefing_tool_success',
        bootstrapProofToken: proofToken,
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.statuses.jack).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      hardFailure: true,
    });
  });

  it('does not heal bootstrap-state failures from stale pre-launch transcript success', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-state-stale-transcript-ignored';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const staleSuccessAt = new Date(Date.now() - 180_000).toISOString();
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const failureAt = new Date(Date.now() - 30_000).toISOString();

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'failed',
          lastAttemptAt: Date.parse(acceptedAt),
          lastObservedAt: Date.parse(failureAt),
          failureReason: 'Teammate was registered but did not bootstrap-confirm before timeout.',
        },
      ],
      failureAt
    );

    const projectRoot = path.join(tempProjectsBase, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      JSON.stringify({
        timestamp: staleSuccessAt,
        teamName,
        agentName: 'jack',
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'item_1',
              content: `Member briefing for jack on team "${teamName}" (${teamName}).\nTask briefing for jack:\nNo actionable tasks.`,
              is_error: false,
            },
          ],
        },
      }) + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.statuses.jack).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      hardFailure: true,
    });
  });

  it('keeps active process bootstrap transport progress pending without turning retryable rejection into failure', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-process-bootstrap-transport-pending';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const acceptedAt = new Date(Date.now() - 15_000).toISOString();
    const bootstrapRunId = 'run-process-transport-pending';
    const runtimePid = 1234;
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            backendType: 'process',
            tmuxPaneId: `process:${runtimePid}`,
            runtimePid,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapRunId,
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeLaunchState(
      teamName,
      leadSessionId,
      {
        jack: {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          runtimePid,
          runtimeRunId: bootstrapRunId,
          tmuxPaneId: `process:${runtimePid}`,
          backendType: 'process',
          bootstrapConfirmed: false,
          hardFailure: false,
          hardFailureReason: undefined,
          firstSpawnAcceptedAt: acceptedAt,
        },
      },
      { launchPhase: 'active' }
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      [
        {
          version: 1,
          type: 'runtime_ready',
          timestamp: acceptedAt,
          pid: runtimePid,
          teamName,
          agentName: 'jack',
          agentId: `jack@${teamName}`,
          bootstrapRunId,
          detail: 'ready',
        },
        {
          version: 1,
          type: 'bootstrap_submit_rejected',
          timestamp: new Date(Date.now() - 10_000).toISOString(),
          pid: runtimePid,
          teamName,
          agentName: 'jack',
          agentId: `jack@${teamName}`,
          bootstrapRunId,
          retryable: true,
          detail: 'cooldown before retry',
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(result.statuses.jack?.runtimeDiagnostic).toContain(
      'Bootstrap prompt has not been submitted yet. Last transport stage: bootstrap submit rejected'
    );
  });

  it('uses the last process transport stage when active launch grace expires', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-process-bootstrap-transport-timeout';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const acceptedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const bootstrapRunId = 'run-process-transport-timeout';
    const runtimePid = 1235;
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            backendType: 'process',
            tmuxPaneId: `process:${runtimePid}`,
            runtimePid,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapRunId,
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeLaunchState(
      teamName,
      leadSessionId,
      {
        jack: {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          runtimePid,
          runtimeRunId: bootstrapRunId,
          tmuxPaneId: `process:${runtimePid}`,
          backendType: 'process',
          bootstrapConfirmed: false,
          hardFailure: false,
          hardFailureReason: undefined,
          firstSpawnAcceptedAt: acceptedAt,
        },
      },
      { launchPhase: 'active' }
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      `${JSON.stringify({
        version: 1,
        type: 'bootstrap_prompt_observed',
        timestamp: new Date(Date.now() - 14 * 60_000).toISOString(),
        pid: runtimePid,
        teamName,
        agentName: 'jack',
        agentId: `jack@${teamName}`,
        bootstrapRunId,
        detail: 'prompt seen',
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack).toMatchObject({
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      hardFailure: true,
      runtimeDiagnosticSeverity: 'error',
    });
    expect(result.statuses.jack?.hardFailureReason).toContain(
      'Last transport stage: bootstrap prompt observed: prompt seen'
    );
  });

  it('uses non-retryable process transport rejection as terminal launch failure', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-process-bootstrap-transport-terminal';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const acceptedAt = new Date(Date.now() - 15_000).toISOString();
    const bootstrapRunId = 'run-process-transport-terminal';
    const runtimePid = 1236;
    const runtimeEventsPath = path.join(tempTeamsBase, teamName, 'runtime', 'jack.runtime.jsonl');

    writeLaunchConfig(teamName, projectPath, leadSessionId, ['jack']);
    const configPath = path.join(tempTeamsBase, teamName, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    config.members = config.members.map((member) =>
      member.name === 'jack'
        ? {
            ...member,
            agentId: `jack@${teamName}`,
            backendType: 'process',
            tmuxPaneId: `process:${runtimePid}`,
            runtimePid,
            bootstrapExpectedAfter: acceptedAt,
            bootstrapRunId,
            bootstrapRuntimeEventsPath: runtimeEventsPath,
          }
        : member
    );
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    writeLaunchState(
      teamName,
      leadSessionId,
      {
        jack: {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          runtimePid,
          runtimeRunId: bootstrapRunId,
          tmuxPaneId: `process:${runtimePid}`,
          backendType: 'process',
          bootstrapConfirmed: false,
          hardFailure: false,
          hardFailureReason: undefined,
          firstSpawnAcceptedAt: acceptedAt,
        },
      },
      { launchPhase: 'active' }
    );
    fs.mkdirSync(path.dirname(runtimeEventsPath), { recursive: true });
    fs.writeFileSync(
      runtimeEventsPath,
      `${JSON.stringify({
        version: 1,
        type: 'bootstrap_submit_rejected',
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        pid: runtimePid,
        teamName,
        agentName: 'jack',
        agentId: `jack@${teamName}`,
        bootstrapRunId,
        retryable: false,
        detail: 'fatal submit rejection',
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack).toMatchObject({
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      hardFailure: true,
      runtimeDiagnosticSeverity: 'error',
    });
    expect(result.statuses.jack?.hardFailureReason).toBe(
      'bootstrap submit rejected: fatal submit rejection'
    );
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

  it('extracts a human-readable bootstrap failure from message_send tool result JSON', async () => {
    allowConsoleLogs();
    const teamName = 'zz-unit-bootstrap-message-send-json-failure';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'alice-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const failureAt = new Date(Date.now() - 4_000).toISOString();

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
          timestamp: failureAt,
          teamName,
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-message-send',
                content: JSON.stringify({
                  success: true,
                  message: "Message sent to team-lead's inbox",
                  routing: {
                    sender: 'alice',
                    target: '@team-lead',
                    summary: 'Bootstrap failed - no member_briefing tool',
                    content: 'Не могу выполнить member_briefing: tool not found.',
                  },
                }),
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const reason = await (svc as any).findBootstrapTranscriptFailureReason(
      teamName,
      'alice',
      Date.parse(acceptedAt) - 1
    );

    expect(reason).toBe(
      'Bootstrap failed - no member_briefing tool: Не могу выполнить member_briefing: tool not found.'
    );
    expect(reason).not.toContain('{"success":true');
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

  it('clears a live grace-window failure when member transcript later shows successful member_briefing', async () => {
    allowConsoleLogs();
    const teamName = 'zz-live-bootstrap-late-transcript-success';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 170_000).toISOString();
    const successAt = new Date(Date.now() - 5_000).toISOString();

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
          timestamp: successAt,
          teamName,
          agentName: 'jack',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'item_1',
                content: `Member briefing for jack on team "${teamName}" (${teamName}).\nTask briefing for jack:\nNo actionable tasks.`,
                is_error: false,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const run = {
      runId: 'run-live-late-success-1',
      teamName,
      startedAt: new Date(Date.now() - 220_000).toISOString(),
      request: {
        members: [],
      },
      expectedMembers: ['jack'],
      memberSpawnStatuses: new Map([
        [
          'jack',
          {
            status: 'error',
            launchState: 'failed_to_start',
            error: 'Teammate did not join within the launch grace window.',
            updatedAt: new Date(Date.now() - 10_000).toISOString(),
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Teammate did not join within the launch grace window.',
            agentToolAccepted: true,
            firstSpawnAcceptedAt: acceptedAt,
            lastHeartbeatAt: undefined,
          },
        ],
      ]),
      lastMemberSpawnAuditAt: Date.now(),
      provisioningOutputParts: [],
      activeToolCalls: new Map(),
      isLaunch: false,
    } as any;

    await (svc as any).maybeAuditMemberSpawnStatuses(run);

    expect(run.memberSpawnStatuses.get('jack')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('jack')?.hardFailureReason).toBeUndefined();
    expect(run.provisioningOutputParts.join('\n')).toContain('bootstrap confirmed via transcript');
  });

  it('does not treat OpenCode member_briefing transcript success as runtime bootstrap evidence', async () => {
    allowConsoleLogs();
    const teamName = 'zz-opencode-bootstrap-transcript-not-evidence';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'jack-opencode-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 30_000).toISOString();
    const successAt = new Date(Date.now() - 5_000).toISOString();

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
          timestamp: successAt,
          teamName,
          agentName: 'jack',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'item_1',
                content: `Member briefing for jack on team "${teamName}" (${teamName}).\nTask briefing for jack:\nNo actionable tasks.`,
                is_error: false,
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const run = {
      runId: 'run-opencode-transcript-not-evidence',
      teamName,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      request: {
        members: [],
      },
      expectedMembers: ['jack'],
      mixedSecondaryLanes: [
        {
          laneId: 'secondary:opencode:jack',
          providerId: 'opencode',
          member: { name: 'jack', providerId: 'opencode', model: 'openrouter/qwen/qwen3-coder' },
          runId: 'opencode-run-jack',
          state: 'launching',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ],
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

    await (svc as any).reconcileBootstrapTranscriptSuccesses(run);

    expect(run.memberSpawnStatuses.get('jack')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      bootstrapConfirmed: false,
    });
    expect(run.provisioningOutputParts.join('\n')).not.toContain(
      'bootstrap confirmed via transcript'
    );
  });

  it('marks OpenCode secondary partial member_briefing bootstrap as stalled instead of confirmed', async () => {
    allowConsoleLogs();
    const teamName = 'zz-opencode-partial-bootstrap-stalled';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'alice-opencode-session';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const acceptedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const successAt = new Date(Date.now() - 5 * 60_000).toISOString();

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
    const run = createMemberSpawnRun({
      teamName,
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
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
            livenessKind: 'registered_only',
          }),
        ],
      ]),
    });
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:alice',
        providerId: 'opencode',
        member: {
          name: 'alice',
          providerId: 'opencode',
          model: 'openrouter/qwen/qwen3-coder',
        },
        runId: 'opencode-run-alice',
        state: 'finished',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ];

    await (svc as any).maybeAuditMemberSpawnStatuses(run, { force: true });

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      bootstrapStalled: true,
      runtimeDiagnostic:
        'OpenCode member_briefing completed, but runtime_bootstrap_checkin did not complete after 5 min.',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(run.provisioningOutputParts.join('\n')).not.toContain(
      'bootstrap confirmed via transcript'
    );
  });

  it('preserves OpenCode secondary bootstrapStalled through mixed launch snapshot rebuilds', () => {
    const teamName = 'zz-opencode-bootstrap-stalled-snapshot-rebuild';
    const svc = new TeamProvisioningService();
    const acceptedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const run = createMemberSpawnRun({
      teamName,
      expectedMembers: [],
      memberSpawnStatuses: new Map([
        [
          'alice',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
            livenessKind: 'registered_only',
            bootstrapStalled: true,
            runtimeDiagnostic:
              'OpenCode member_briefing completed, but runtime_bootstrap_checkin did not complete after 5 min.',
            runtimeDiagnosticSeverity: 'warning',
          }),
        ],
      ]),
    });
    run.isLaunch = true;
    run.effectiveMembers = [];
    run.request = {
      ...run.request,
      teamName,
      cwd: '/tmp/opencode-bootstrap-stalled-snapshot-rebuild',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      skipPermissions: true,
    };
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:alice',
        providerId: 'opencode',
        member: {
          name: 'alice',
          providerId: 'opencode',
          model: 'openrouter/qwen/qwen3-coder',
        },
        runId: 'opencode-run-alice',
        state: 'finished',
        result: {
          runId: 'opencode-run-alice',
          teamName,
          launchPhase: 'active',
          teamLaunchState: 'partial_pending',
          members: {
            alice: {
              memberName: 'alice',
              providerId: 'opencode',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              sessionId: 'ses_alice_partial_bootstrap',
              livenessKind: 'registered_only',
              diagnostics: ['OpenCode runtime session materialized.'],
            },
          },
          warnings: [],
          diagnostics: [],
        },
        warnings: [],
        diagnostics: [],
      },
    ];

    const snapshot = (svc as any).buildMixedPersistedLaunchSnapshotForRun(run, 'active');

    expect(snapshot?.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      runtimeSessionId: 'ses_alice_partial_bootstrap',
      livenessKind: 'registered_only',
      bootstrapStalled: true,
    });
  });

  it('does not copy bootstrap-state success into OpenCode secondary runtime evidence', async () => {
    const teamName = 'zz-opencode-bootstrap-state-not-evidence';
    const leadSessionId = 'lead-session';
    const acceptedAt = Date.now() - 30_000;
    const observedAt = Date.now() - 5_000;

    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'jack',
        providerId: 'opencode',
        model: 'openrouter/qwen/qwen3-coder',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', leadSessionId, ['jack']);
    writeBootstrapState(
      teamName,
      [
        {
          name: 'jack',
          status: 'bootstrap_confirmed',
          lastAttemptAt: acceptedAt,
          lastObservedAt: observedAt,
        },
      ],
      new Date(observedAt - 10_000).toISOString()
    );
    writeLaunchState(teamName, leadSessionId, {
      jack: {
        providerId: 'opencode',
        laneId: 'secondary:opencode:jack',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        firstSpawnAcceptedAt: new Date(acceptedAt).toISOString(),
        lastRuntimeAliveAt: new Date(observedAt).toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
      },
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.jack).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
    });
  });

  it('promotes OpenCode secondary pending launch state from committed bootstrap session evidence', async () => {
    const teamName = 'zz-opencode-committed-overlay-promotes';
    const leadSessionId = 'lead-session';
    const laneId = 'secondary:opencode:tom';
    const runId = 'opencode-run-tom';

    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'tom',
        providerId: 'opencode',
        model: 'openrouter/minimax/minimax-m2.5',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', leadSessionId, ['tom']);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId,
      state: 'active',
      diagnostics: [
        'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.',
      ],
    });
    await writeCommittedOpenCodeSessionStore({
      teamName,
      laneId,
      runId,
      sessions: [
        {
          id: 'ses-tom',
          teamName,
          memberName: 'tom',
          laneId,
          runId,
          providerId: 'opencode',
          observedAt: '2026-04-22T12:00:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
      ],
    });
    writeLaunchState(teamName, leadSessionId, {
      tom: {
        providerId: 'opencode',
        laneId,
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        livenessKind: 'registered_only',
        diagnostics: [
          'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.',
        ],
        lastEvaluatedAt: '2026-04-22T12:00:01.000Z',
      },
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.tom).toMatchObject({
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      bootstrapConfirmed: true,
      runtimeAlive: true,
      livenessKind: 'confirmed_bootstrap',
    });
    const persisted = JSON.parse(
      await fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    );
    expect(persisted.members.tom).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      runtimeSessionId: 'ses-tom',
      livenessKind: 'confirmed_bootstrap',
    });
  });

  it('prevents stale OpenCode secondary pending or missing writes from downgrading committed bootstrap evidence', async () => {
    const teamName = 'zz-opencode-committed-overlay-write-boundary';
    const leadSessionId = 'lead-session';
    const laneId = 'secondary:opencode:tom';
    const runId = 'opencode-run-tom';

    writeMembersMeta(teamName, [{ name: 'tom', providerId: 'opencode' }]);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId,
      state: 'active',
    });
    await writeCommittedOpenCodeSessionStore({
      teamName,
      laneId,
      runId,
      sessions: [
        {
          id: 'ses-tom',
          teamName,
          memberName: 'tom',
          laneId,
          runId,
          observedAt: '2026-04-22T12:00:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
      ],
    });
    writeLaunchState(teamName, leadSessionId, {
      tom: {
        providerId: 'opencode',
        laneId,
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: false,
        runtimeSessionId: 'ses-tom',
      },
    });
    const staleSnapshot = createPersistedLaunchSnapshot({
      teamName,
      leadSessionId,
      launchPhase: 'active',
      expectedMembers: ['tom'],
      members: {
        tom: {
          name: 'tom',
          providerId: 'opencode',
          laneId,
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:00:02.000Z',
          diagnostics: [
            'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.',
          ],
        },
      },
      updatedAt: '2026-04-22T12:00:02.000Z',
    });

    const svc = new TeamProvisioningService();
    await (svc as any).writeLaunchStateSnapshot(teamName, staleSnapshot);

    const persisted = JSON.parse(
      await fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    );
    expect(persisted.members.tom).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      runtimeSessionId: 'ses-tom',
    });
    expect(persisted.teamLaunchState).toBe('clean_success');

    const missingMemberSnapshot = createPersistedLaunchSnapshot({
      teamName,
      leadSessionId,
      launchPhase: 'active',
      expectedMembers: [],
      members: {},
      updatedAt: '2026-04-22T12:00:03.000Z',
    });
    await (svc as any).writeLaunchStateSnapshot(teamName, missingMemberSnapshot);

    const persistedAfterMissingWrite = JSON.parse(
      await fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    );
    expect(persistedAfterMissingWrite.members.tom).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      runtimeSessionId: 'ses-tom',
    });
    expect(persistedAfterMissingWrite.teamLaunchState).toBe('clean_success');
  });

  it('normalizes stale confirmed OpenCode secondary liveness from committed bootstrap evidence', async () => {
    const teamName = 'zz-opencode-committed-overlay-normalizes-liveness';
    const leadSessionId = 'lead-session';
    const laneId = 'secondary:opencode:tom';
    const runId = 'opencode-run-tom';

    writeMembersMeta(teamName, [{ name: 'tom', providerId: 'opencode' }]);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId,
      state: 'active',
    });
    await writeCommittedOpenCodeSessionStore({
      teamName,
      laneId,
      runId,
      sessions: [
        {
          id: 'ses-tom',
          teamName,
          memberName: 'tom',
          laneId,
          runId,
          observedAt: '2026-04-22T12:00:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
      ],
    });
    writeLaunchState(teamName, leadSessionId, {
      tom: {
        providerId: 'opencode',
        laneId,
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        runtimeSessionId: 'ses-tom',
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'OpenCode bootstrap evidence committed.',
        diagnostics: ['opencode_bootstrap_evidence_committed'],
      },
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      livenessKind: 'confirmed_bootstrap',
    });
    const persisted = JSON.parse(
      await fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    );
    expect(persisted.members.tom).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      livenessKind: 'confirmed_bootstrap',
    });
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

  it('reports workspace trust failures with a specific deterministic bootstrap title', () => {
    const reason =
      'Teammate "Gayani" cannot start in headless process runtime because workspace trust is not accepted for "C:\\Users\\vilok\\OneDrive\\Desktop\\Safar 0.1". Open that workspace once interactively and accept trust, then launch the team again.';
    const progressUpdates: any[] = [];
    const run = createMemberSpawnRun({
      runId: 'run-workspace-trust-bootstrap',
      teamName: 'workspace-trust-bootstrap-team',
      expectedMembers: ['Gayani'],
    });
    Object.assign(run, {
      cancelRequested: false,
      isLaunch: false,
      lastDeterministicBootstrapSeq: 0,
      progress: {
        runId: run.runId,
        teamName: run.teamName,
        state: 'assembling',
        message: 'Spawning teammate runtimes',
        startedAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      onProgress: (progress: any) => {
        progressUpdates.push(progress);
      },
    });
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockResolvedValue(null);
    vi.spyOn(svc as any, 'cleanupRun').mockImplementation(() => {});

    const handled = (svc as any).handleDeterministicBootstrapEvent(run, {
      type: 'system',
      subtype: 'team_bootstrap',
      event: 'failed',
      reason,
      run_id: run.runId,
      team_name: run.teamName,
      seq: 1,
    });

    expect(handled).toBe(true);
    expect(progressUpdates.at(-1)).toMatchObject({
      state: 'failed',
      message: 'Workspace trust required',
      error: reason,
    });
    expect(run.memberSpawnStatuses.get('Gayani')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: reason,
    });
  });

  it('includes legacy member provider fields when planning workspace trust providers', () => {
    const svc = new TeamProvisioningService();

    expect(
      (svc as any).collectWorkspaceTrustProviders({
        leadProviderId: 'anthropic',
        members: [{ name: 'alice', provider: 'codex' }],
      })
    ).toEqual(['claude', 'codex']);
  });

  it('dedupes workspace trust providers across lead, member providerId, and legacy provider fields', () => {
    const svc = new TeamProvisioningService();

    expect(
      (svc as any).collectWorkspaceTrustProviders({
        leadProviderId: 'codex',
        members: [
          { name: 'alice', providerId: 'anthropic' },
          { name: 'bob', providerId: 'codex' },
          { name: 'cara', provider: 'gemini' },
          { name: 'drew', providerId: 'opencode' },
        ],
      })
    ).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });

  it('degrades workspace trust planning failures without blocking launch preparation', async () => {
    const svc = new TeamProvisioningService();
    const workspaces = buildWorkspaceTrustPathCandidates({
      cwd: '/tmp/workspace-trust-planning-fallback',
      platform: 'posix',
    });
    svc.setWorkspaceTrustCoordinator({
      planArgsOnly: vi.fn(async () => {
        throw new Error('args planning crashed');
      }),
      planFull: vi.fn(async () => {
        throw new Error('full planning crashed');
      }),
      execute: vi.fn(),
    } as any);

    await expect(
      (svc as any).planWorkspaceTrustArgsOnlySafely({
        providers: ['claude', 'codex'],
        workspaces,
        featureFlags: {
          enabled: true,
          claudePty: true,
          codexArgs: true,
          retry: false,
          fileLock: false,
        },
      })
    ).resolves.toEqual({ launchArgPatches: [] });

    await expect(
      (svc as any).planWorkspaceTrustFullSafely({
        providers: ['claude', 'codex'],
        workspaces,
        featureFlags: {
          enabled: true,
          claudePty: true,
          codexArgs: true,
          retry: false,
          fileLock: false,
        },
      })
    ).resolves.toEqual({ workspaces, launchArgPatches: [] });
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining(
        'Workspace trust args-only planning failed; continuing without trust arg patches'
      ),
      expect.stringContaining(
        'Workspace trust full planning failed; continuing without trust arg patches'
      ),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('keeps launch moving with info diagnostics when workspace trust preflight succeeds', async () => {
    const progressUpdates: any[] = [];
    const run = createMemberSpawnRun({
      runId: 'run-workspace-trust-preflight-ok',
      teamName: 'workspace-trust-preflight-ok-team',
      expectedMembers: ['alice'],
    });
    Object.assign(run, {
      cancelRequested: false,
      processKilled: false,
      progress: {
        runId: run.runId,
        teamName: run.teamName,
        state: 'validating',
        message: 'Validating launch',
        warnings: [],
        startedAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      onProgress: (progress: any) => {
        progressUpdates.push(progress);
      },
    });
    const execute = vi.fn(async () => ({
      id: 'claude-pty-workspace-trust',
      provider: 'claude',
      status: 'ok',
      workspaceIds: ['workspace-trust-1'],
      evidence: ['trusted project key'],
    }));
    const svc = new TeamProvisioningService();
    svc.setWorkspaceTrustCoordinator({
      planArgsOnly: vi.fn(),
      planFull: vi.fn(),
      execute,
    } as any);
    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await (svc as any).prepareWorkspaceTrustForDeterministicRun({
      mode: 'create',
      run,
      claudePath: '/usr/local/bin/claude',
      shellEnv: {},
      stopAllGenerationAtStart: (svc as any).stopAllTeamsGeneration,
      workspaceTrustPlan: {
        launchArgPatches: [],
        workspaces: buildWorkspaceTrustPathCandidates({
          cwd: '/tmp/workspace-trust-preflight-ok-team',
          platform: 'posix',
        }),
      },
      featureFlags: {
        enabled: true,
        claudePty: true,
        codexArgs: true,
        retry: false,
        fileLock: false,
      },
      provisioningEnv: {
        anthropicApiKeyHelper: null,
      },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.workspaceTrustExecution).toMatchObject({ status: 'ok' });
    expect(run.progress.warnings).toEqual([]);
    expect(progressUpdates.at(-1).launchDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'info',
        code: 'workspace_trust_preflight',
        label: 'Workspace trust preflight completed',
        detail: 'trusted project key',
      }),
    ]);
  });

  it('keeps launch alive with diagnostics when workspace trust preflight throws', async () => {
    const progressUpdates: any[] = [];
    const run = createMemberSpawnRun({
      runId: 'run-workspace-trust-preflight-throw',
      teamName: 'workspace-trust-preflight-team',
      expectedMembers: ['alice'],
    });
    Object.assign(run, {
      cancelRequested: false,
      processKilled: false,
      progress: {
        runId: run.runId,
        teamName: run.teamName,
        state: 'validating',
        message: 'Validating launch',
        warnings: [],
        startedAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      onProgress: (progress: any) => {
        progressUpdates.push(progress);
      },
    });
    const svc = new TeamProvisioningService();
    svc.setWorkspaceTrustCoordinator({
      planArgsOnly: vi.fn(),
      planFull: vi.fn(),
      execute: vi.fn(async () => {
        throw new Error('preflight adapter crashed');
      }),
    } as any);
    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await (svc as any).prepareWorkspaceTrustForDeterministicRun({
      mode: 'create',
      run,
      claudePath: '/usr/local/bin/claude',
      shellEnv: {
        CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP: '1',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH: '/tmp/helper.json',
      },
      stopAllGenerationAtStart: (svc as any).stopAllTeamsGeneration,
      workspaceTrustPlan: {
        launchArgPatches: [],
        workspaces: buildWorkspaceTrustPathCandidates({
          cwd: '/tmp/workspace-trust-preflight-team',
          platform: 'posix',
        }),
      },
      featureFlags: {
        enabled: true,
        claudePty: true,
        codexArgs: true,
        retry: false,
        fileLock: false,
      },
      provisioningEnv: {
        anthropicApiKeyHelper: null,
      },
    });

    expect(run.workspaceTrustExecution).toMatchObject({
      status: 'soft_failed',
      errorCode: 'workspace_trust_preflight_error',
      errorMessage: 'preflight adapter crashed',
    });
    expect(run.workspaceTrustDiagnostics).toMatchObject({
      attempt: 1,
      strategyResults: [
        expect.objectContaining({
          status: 'soft_failed',
          errorMessage: 'preflight adapter crashed',
        }),
      ],
    });
    expect(run.progress.warnings).toContain('preflight adapter crashed');
    expect(progressUpdates.at(0)).toMatchObject({
      state: 'spawning',
      message: 'Preparing workspace trust',
    });
    expect(progressUpdates.at(-1).warnings).toContain('preflight adapter crashed');
    expect(progressUpdates.at(-1).launchDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'workspace_trust_preflight',
        label: 'Workspace trust preflight could not verify trust',
        detail: 'preflight adapter crashed',
      }),
    ]);
  });

  it('blocks launch with structured workspace trust diagnostics when preflight is blocked', async () => {
    const progressUpdates: any[] = [];
    const run = createMemberSpawnRun({
      runId: 'run-workspace-trust-preflight-blocked',
      teamName: 'workspace-trust-preflight-blocked-team',
      expectedMembers: ['alice'],
    });
    Object.assign(run, {
      cancelRequested: false,
      processKilled: false,
      progress: {
        runId: run.runId,
        teamName: run.teamName,
        state: 'validating',
        message: 'Validating launch',
        warnings: [],
        startedAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      onProgress: (progress: any) => {
        progressUpdates.push(progress);
      },
    });
    const svc = new TeamProvisioningService();
    svc.setWorkspaceTrustCoordinator({
      planArgsOnly: vi.fn(),
      planFull: vi.fn(),
      execute: vi.fn(async () => ({
        id: 'claude-pty-workspace-trust',
        provider: 'claude',
        status: 'blocked',
        workspaceIds: ['workspace-trust-1'],
        errorCode: 'workspace_trust_preflight_not_confirmed',
        errorMessage: 'Claude workspace trust was not confirmed for /tmp/project',
        evidence: ['claude workspace trust prompt'],
      })),
    } as any);
    vi.spyOn(svc as any, 'cleanupRun').mockImplementation(() => {});
    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await expect(
      (svc as any).prepareWorkspaceTrustForDeterministicRun({
        mode: 'create',
        run,
        claudePath: '/usr/local/bin/claude',
        shellEnv: {},
        stopAllGenerationAtStart: (svc as any).stopAllTeamsGeneration,
        workspaceTrustPlan: {
          launchArgPatches: [],
          workspaces: buildWorkspaceTrustPathCandidates({
            cwd: '/tmp/project',
            platform: 'posix',
          }),
        },
        featureFlags: {
          enabled: true,
          claudePty: true,
          codexArgs: true,
          retry: false,
          fileLock: false,
        },
        provisioningEnv: {
          anthropicApiKeyHelper: null,
        },
      })
    ).rejects.toThrow('Claude workspace trust was not confirmed for /tmp/project');

    expect(progressUpdates.at(-1)).toMatchObject({
      state: 'failed',
      message: 'Workspace trust required',
      error: 'Claude workspace trust was not confirmed for /tmp/project',
    });
    expect(progressUpdates.at(-1).launchDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'workspace_trust_preflight',
        label: 'Workspace trust preflight blocked launch',
        detail: 'Claude workspace trust was not confirmed for /tmp/project',
      }),
    ]);
  });

  it('cancels launch before spawn when workspace trust preflight is cancelled', async () => {
    const progressUpdates: any[] = [];
    const run = createMemberSpawnRun({
      runId: 'run-workspace-trust-preflight-cancelled',
      teamName: 'workspace-trust-preflight-cancelled-team',
      expectedMembers: ['alice'],
    });
    Object.assign(run, {
      cancelRequested: false,
      processKilled: false,
      progress: {
        runId: run.runId,
        teamName: run.teamName,
        state: 'validating',
        message: 'Validating launch',
        warnings: [],
        startedAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      onProgress: (progress: any) => {
        progressUpdates.push(progress);
      },
    });
    const svc = new TeamProvisioningService();
    svc.setWorkspaceTrustCoordinator({
      planArgsOnly: vi.fn(),
      planFull: vi.fn(),
      execute: vi.fn(async () => ({
        id: 'claude-pty-workspace-trust',
        provider: 'claude',
        status: 'cancelled',
        workspaceIds: ['workspace-trust-1'],
        errorCode: 'workspace_trust_lock_cancelled',
      })),
    } as any);
    vi.spyOn(svc as any, 'cleanupRun').mockImplementation(() => {});
    (svc as any).runs.set(run.runId, run);
    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await expect(
      (svc as any).prepareWorkspaceTrustForDeterministicRun({
        mode: 'create',
        run,
        claudePath: '/usr/local/bin/claude',
        shellEnv: {},
        stopAllGenerationAtStart: (svc as any).stopAllTeamsGeneration,
        workspaceTrustPlan: {
          launchArgPatches: [],
          workspaces: buildWorkspaceTrustPathCandidates({
            cwd: '/tmp/workspace-trust-preflight-cancelled-team',
            platform: 'posix',
          }),
        },
        featureFlags: {
          enabled: true,
          claudePty: true,
          codexArgs: true,
          retry: false,
          fileLock: false,
        },
        provisioningEnv: {
          anthropicApiKeyHelper: null,
        },
      })
    ).rejects.toThrow('Team launch cancelled');

    expect(run.cancelRequested).toBe(true);
    expect(progressUpdates.at(-1)).toMatchObject({
      state: 'cancelled',
      message: 'Team launch cancelled',
    });
    expect(progressUpdates.at(-1).launchDiagnostics).toBeUndefined();
  });

  it('does not execute workspace trust preflight when the feature is disabled', async () => {
    const progressUpdates: any[] = [];
    const run = createMemberSpawnRun({
      runId: 'run-workspace-trust-disabled',
      teamName: 'workspace-trust-disabled-team',
      expectedMembers: ['alice'],
    });
    Object.assign(run, {
      cancelRequested: false,
      processKilled: false,
      progress: {
        runId: run.runId,
        teamName: run.teamName,
        state: 'validating',
        message: 'Validating launch',
        warnings: [],
        startedAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      onProgress: (progress: any) => {
        progressUpdates.push(progress);
      },
    });
    const execute = vi.fn();
    const svc = new TeamProvisioningService();
    svc.setWorkspaceTrustCoordinator({
      planArgsOnly: vi.fn(),
      planFull: vi.fn(),
      execute,
    } as any);

    await (svc as any).prepareWorkspaceTrustForDeterministicRun({
      mode: 'create',
      run,
      claudePath: '/usr/local/bin/claude',
      shellEnv: {},
      stopAllGenerationAtStart: (svc as any).stopAllTeamsGeneration,
      workspaceTrustPlan: {
        launchArgPatches: [],
        workspaces: buildWorkspaceTrustPathCandidates({
          cwd: '/tmp/workspace-trust-disabled-team',
          platform: 'posix',
        }),
      },
      featureFlags: {
        enabled: false,
        claudePty: false,
        codexArgs: false,
        retry: false,
        fileLock: false,
      },
      provisioningEnv: {
        anthropicApiKeyHelper: null,
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(progressUpdates).toEqual([]);
    expect(run.workspaceTrustExecution).toBeUndefined();
    expect(run.workspaceTrustDiagnostics).toBeUndefined();
    expect(run.progress).toMatchObject({
      state: 'validating',
      message: 'Validating launch',
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

  it('clears registered-only stale failure when a verified runtime process appears later', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'tom',
            {
              alive: true,
              model: 'gpt-5.4',
              livenessKind: 'runtime_process',
              runtimeDiagnostic: 'verified runtime process detected',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses('forge-labs-10', {
      tom: createMemberSpawnStatusEntry({
        status: 'error',
        launchState: 'failed_to_start',
        error: 'registered runtime metadata without live process',
        hardFailure: true,
        hardFailureReason: 'registered runtime metadata without live process',
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'registered runtime metadata without live process',
      }),
    });

    expect(result.tom).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      runtimeModel: 'gpt-5.4',
      livenessKind: 'runtime_process',
      runtimeDiagnostic: 'verified runtime process detected',
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

  it('keeps OpenCode secondary pending-bootstrap status waiting when live runtime process is attached', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'tom',
            {
              alive: true,
              model: 'openrouter/minimax/minimax-m2.5',
              livenessKind: 'runtime_process',
              providerId: 'opencode',
              runtimeDiagnostic: 'OpenCode runtime process detected',
              runtimeDiagnosticSeverity: 'info',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses(
      'beacon-desk-4',
      {
        tom: createMemberSpawnStatusEntry({
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
      { openCodeSecondaryBootstrapPendingMembers: new Set(['tom']) }
    );

    expect(result.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      bootstrapConfirmed: false,
      livenessSource: undefined,
      livenessKind: 'runtime_process',
      runtimeModel: 'openrouter/minimax/minimax-m2.5',
      runtimeDiagnostic: 'OpenCode runtime process detected',
      runtimeDiagnosticSeverity: 'info',
    });
  });

  it('marks stale OpenCode secondary pending-bootstrap status stalled when live runtime is attached after restart', async () => {
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(
      async () =>
        new Map([
          [
            'tom',
            {
              alive: true,
              model: 'openrouter/minimax/minimax-m2.5',
              livenessKind: 'runtime_process',
              providerId: 'opencode',
              runtimeDiagnostic: 'OpenCode runtime process detected',
              runtimeDiagnosticSeverity: 'info',
            },
          ],
        ])
    );

    const result = await (svc as any).attachLiveRuntimeMetadataToStatuses(
      'beacon-desk-4',
      {
        tom: createMemberSpawnStatusEntry({
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      },
      { openCodeSecondaryBootstrapPendingMembers: new Set(['tom']) }
    );

    expect(result.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      bootstrapConfirmed: false,
      livenessSource: undefined,
      livenessKind: 'runtime_process',
      bootstrapStalled: true,
      runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('self-heals stale persisted OpenCode secondary bootstrap without live metadata', async () => {
    const teamName = 'zz-opencode-persisted-bootstrap-stall-no-live';
    const leadSessionId = 'lead-session';
    const acceptedAt = new Date(Date.now() - 6 * 60_000).toISOString();

    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'tom',
        providerId: 'opencode',
        model: 'openrouter/minimax/minimax-m2.5',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', leadSessionId, ['tom']);
    writeLaunchState(teamName, leadSessionId, {
      tom: {
        providerId: 'opencode',
        model: 'openrouter/minimax/minimax-m2.5',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        runtimeSessionId: 'ses_tom_partial',
        runtimePid: 55947,
        livenessKind: 'registered_only',
        firstSpawnAcceptedAt: acceptedAt,
        diagnostics: [
          'OpenCode bootstrap MCP tool failed before required attach completed: runtime_bootstrap_checkin',
          'member_briefing at 2026-05-04T18:25:43.091Z',
        ],
        lastEvaluatedAt: acceptedAt,
      },
    });

    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getLiveTeamAgentRuntimeMetadata').mockResolvedValue(new Map());

    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.tom).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
      bootstrapStalled: true,
      runtimeDiagnostic:
        'OpenCode bootstrap MCP tool failed before required attach completed: runtime_bootstrap_checkin',
      runtimeDiagnosticSeverity: 'warning',
    });
    const persisted = JSON.parse(
      await fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    );
    expect(persisted.members.tom).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
      bootstrapStalled: true,
    });
  });

  it('sends one targeted OpenCode bootstrap check-in retry when a partial bootstrap stalls', async () => {
    const teamName = 'zz-opencode-bootstrap-checkin-retry';
    const acceptedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const sendMessageToMember = vi.fn(async (input: Record<string, unknown>) => ({
      ok: true,
      providerId: 'opencode',
      memberName: String(input.memberName),
      diagnostics: [],
    }));
    const svc = new TeamProvisioningService();
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
    vi.spyOn(svc as any, 'refreshMemberSpawnStatusesFromLeadInbox').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'maybeAuditMemberSpawnStatuses').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'getLiveTeamAgentRuntimeMetadata').mockResolvedValue(
      new Map([
        [
          'tom',
          {
            alive: true,
            providerId: 'opencode',
            livenessKind: 'runtime_process',
            runtimeSessionId: 'ses_tom_partial',
            runtimeDiagnostic: 'OpenCode runtime process detected',
            runtimeDiagnosticSeverity: 'info',
          },
        ],
      ])
    );

    const run = createMemberSpawnRun({
      teamName,
      runId: 'run-bootstrap-checkin-retry',
      expectedMembers: ['tom'],
      memberSpawnStatuses: new Map([
        [
          'tom',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
            livenessKind: 'runtime_process',
          }),
        ],
      ]),
    });
    run.onProgress = vi.fn();
    run.isLaunch = false;
    run.request = {
      teamName,
      cwd: '/Users/test/proj',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      members: [],
    };
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:tom',
        providerId: 'opencode',
        member: {
          name: 'tom',
          providerId: 'opencode',
          model: 'openrouter/minimax/minimax-m2.5',
          cwd: '/Users/test/proj',
        },
        runId: 'opencode-run-tom',
        state: 'finished',
        result: {
          runId: 'opencode-run-tom',
          teamName,
          launchPhase: 'active',
          teamLaunchState: 'partial_pending',
          members: {
            tom: {
              memberName: 'tom',
              providerId: 'opencode',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              sessionId: 'ses_tom_partial',
              diagnostics: [
                'runtime_bootstrap_checkin failed: Not connected',
                'member_briefing at 2026-05-04T18:25:43.091Z',
              ],
            },
          },
          warnings: [],
          diagnostics: [],
        },
        warnings: [],
        diagnostics: [],
      },
    ];
    (svc as any).runs.set(run.runId, run);
    (svc as any).aliveRunByTeam.set(teamName, run.runId);

    await (svc as any).reevaluateMemberLaunchStatus(run, 'tom');
    await (svc as any).reevaluateMemberLaunchStatus(run, 'tom');

    expect(sendMessageToMember).toHaveBeenCalledTimes(1);
    expect(sendMessageToMember).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'opencode-run-tom',
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: '/Users/test/proj',
        bootstrapCheckinRetry: {
          runtimeSessionId: 'ses_tom_partial',
          reason: 'runtime_bootstrap_checkin failed: Not connected',
        },
      })
    );
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

  it('clears stale launch-state and launch-summary when bootstrap truth supersedes a persisted failure', async () => {
    const teamName = 'bootstrap-supersedes-stale-launch-summary-team';
    const leadSessionId = 'lead-session';
    const staleUpdatedAt = '2026-04-16T09:55:00.000Z';
    const freshObservedAt = '2026-04-16T10:00:00.000Z';
    writeLaunchConfig(teamName, '/Users/test/proj', leadSessionId, ['bob']);
    writeLaunchState(
      teamName,
      leadSessionId,
      {
        bob: {
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Teammate was never spawned during launch.',
        },
      },
      { updatedAt: staleUpdatedAt }
    );
    fs.writeFileSync(
      getTeamLaunchSummaryPath(teamName),
      `${JSON.stringify(
        {
          version: 1,
          teamName,
          updatedAt: staleUpdatedAt,
          launchPhase: 'finished',
          partialLaunchFailure: true,
          expectedMemberCount: 1,
          confirmedMemberCount: 0,
          missingMembers: ['bob'],
          teamLaunchState: 'partial_failure',
          launchUpdatedAt: staleUpdatedAt,
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          skippedCount: 0,
          runtimeAlivePendingCount: 0,
          shellOnlyPendingCount: 0,
          runtimeProcessPendingCount: 0,
          runtimeCandidatePendingCount: 0,
          noRuntimePendingCount: 0,
          permissionPendingCount: 0,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    writeBootstrapState(
      teamName,
      [
        {
          name: 'bob',
          status: 'bootstrap_confirmed',
          lastAttemptAt: Date.parse(freshObservedAt),
          lastObservedAt: Date.parse(freshObservedAt),
        },
      ],
      freshObservedAt
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    await expect(
      fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fsPromises.readFile(getTeamLaunchSummaryPath(teamName), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
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

  it('confirms a teammate from bootstrap transcript stored under its worktree cwd', async () => {
    const teamName = 'worktree-bootstrap-transcript-team';
    const leadSessionId = 'lead-session';
    const projectPath = '/Users/test/proj';
    const worktreePath = `${projectPath}/.claude/worktrees/team-${teamName}-tom-12345678`;
    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    const observedAt = new Date(Date.now() - 30_000).toISOString();
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead', cwd: projectPath },
          { name: 'tom', providerId: 'codex', model: 'gpt-5.4', cwd: worktreePath },
          { name: 'bob', providerId: 'codex', model: 'gpt-5.4-mini', cwd: projectPath },
        ],
      }),
      'utf8'
    );
    writeLaunchState(teamName, leadSessionId, {
      tom: {
        providerId: 'codex',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'codex',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'registered runtime metadata without live process',
        firstSpawnAcceptedAt: acceptedAt,
        lastEvaluatedAt: acceptedAt,
      },
    });
    const worktreeProjectDir = path.join(tempProjectsBase, encodePath(worktreePath));
    fs.mkdirSync(worktreeProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeProjectDir, 'tom-session.jsonl'),
      `${JSON.stringify({
        type: 'user',
        teamName,
        agentName: 'tom',
        timestamp: observedAt,
        cwd: worktreePath,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'item_0',
              content: `Member briefing for tom on team "${teamName}" (${teamName}).\nRole: developer.`,
            },
          ],
        },
      })}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      lastHeartbeatAt: observedAt,
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

  it('degrades mixed secondary lanes when lanes.json is active but the lane manifest has no runtime evidence', async () => {
    const teamName = 'atlas-hq-empty-lane';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'bob',
        providerId: 'opencode',
        model: 'openrouter/moonshotai/kimi-k2.6',
      },
      {
        name: 'jack',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['jack']);
    writeBootstrapState(teamName, [{ name: 'jack', status: 'registered' }]);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:bob',
      runId: 'run-empty-bob',
      clock: () => new Date('2026-04-20T10:00:00.000Z'),
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: expect.stringContaining('no committed runtime evidence after launch grace'),
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:bob': {
          state: 'degraded',
        },
      },
    });
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

  it('does not keep an empty active OpenCode lane pending when runtime reconcile has no runtime handle', async () => {
    const teamName = 'atlas-hq-empty-lane-nonrecoverable';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      {
        name: 'bob',
        providerId: 'opencode',
        model: 'openrouter/moonshotai/kimi-k2.6',
      },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', []);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: 'secondary:opencode:bob',
      runId: 'run-empty-bob',
      clock: () => new Date('2026-04-20T10:00:00.000Z'),
    });

    const adapterReconcile = vi.fn(async () => ({
      runId: 'reconcile-run',
      teamName,
      launchPhase: 'reconciled' as const,
      teamLaunchState: 'partial_pending' as const,
      members: {
        bob: {
          memberName: 'bob',
          providerId: 'opencode' as const,
          launchState: 'runtime_pending_bootstrap' as const,
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'registered_only' as const,
          diagnostics: ['bridge has no runtime session'],
        },
      },
      snapshot: null,
      warnings: [],
      diagnostics: [],
    }));
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

    expect(adapterReconcile).toHaveBeenCalledTimes(1);
    expect(result.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: expect.stringContaining('no committed runtime evidence after launch grace'),
    });
  });

  it('recovers missing mixed secondary lane index from materialized OpenCode runtime evidence', async () => {
    const teamName = 'relay-works-missing-lane-recovery';
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
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob']);
    writeBootstrapState(teamName, [{ name: 'bob', status: 'registered' }]);
    fs.writeFileSync(
      getTeamLaunchStatePath(teamName),
      `${JSON.stringify(
        {
          version: 2,
          teamName,
          updatedAt: '2026-04-23T10:00:00.000Z',
          expectedMembers: ['atlas', 'bob'],
          bootstrapExpectedMembers: ['bob'],
          leadSessionId: 'lead-session',
          launchPhase: 'reconciled',
          members: {
            atlas: {
              name: 'atlas',
              providerId: 'opencode',
              model: 'opencode/nemotron-3-super-free',
              laneId: 'secondary:opencode:atlas',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'OpenCode bridge reported member launch failure',
              runtimePid: 44123,
              runtimeSessionId: 'ses_atlas_materialized',
              livenessKind: 'runtime_process_candidate',
              pidSource: 'opencode_bridge',
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
            bob: {
              name: 'bob',
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
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 1,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_failure',
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const adapterReconcile = vi.fn(async (input: Record<string, unknown>) => {
      const member = (input.expectedMembers as Array<{ name: string }>)[0]?.name;
      return {
        runId: String(input.runId),
        teamName,
        launchPhase: 'reconciled',
        teamLaunchState: 'partial_pending',
        members: member
          ? {
              [member]: {
                memberName: member,
                providerId: 'opencode',
                launchState: 'runtime_pending_bootstrap',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: false,
                runtimePid: 44123,
                sessionId: 'ses_atlas_materialized',
                livenessKind: 'runtime_process_candidate',
                diagnostics: ['runtime process candidate recovered'],
              },
            }
          : {},
        snapshot: null,
        warnings: [],
        diagnostics: ['fake reconcile recovered materialized runtime'],
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

    expect(adapterReconcile).toHaveBeenCalledTimes(1);
    expect(adapterReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        laneId: 'secondary:opencode:atlas',
        reason: 'startup_recovery',
      })
    );
    expect(result.expectedMembers).toEqual(expect.arrayContaining(['atlas', 'bob']));
    expect(result.statuses.atlas).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempTeamsBase, teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:atlas': {
          state: 'active',
        },
      },
    });
  });

  it('recovers degraded OpenCode file-lock failures when bootstrap evidence committed later', async () => {
    const teamName = 'atlas-hq-file-lock-late-evidence';
    const tomLaneId = 'secondary:opencode:tom';
    const tomRunId = 'tom-runtime-run';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.5',
    });
    writeMembersMeta(teamName, [
      { name: 'bob', providerId: 'codex', model: 'gpt-5.5' },
      { name: 'jack', providerId: 'codex', model: 'gpt-5.4' },
      { name: 'tom', providerId: 'opencode', model: 'openrouter/minimax/minimax-m2.5' },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob', 'jack']);
    writeBootstrapState(teamName, [
      { name: 'bob', status: 'bootstrap_confirmed', lastObservedAt: Date.now() - 60_000 },
      { name: 'jack', status: 'bootstrap_confirmed', lastObservedAt: Date.now() - 60_000 },
    ]);
    fs.writeFileSync(
      getTeamLaunchStatePath(teamName),
      `${JSON.stringify(
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'finished',
          expectedMembers: ['bob', 'jack', 'tom'],
          bootstrapExpectedMembers: ['bob', 'jack'],
          members: {
            bob: {
              name: 'bob',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate was never spawned during launch.',
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
            jack: {
              name: 'jack',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate was never spawned during launch.',
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
            tom: {
              name: 'tom',
              providerId: 'opencode',
              model: 'openrouter/minimax/minimax-m2.5',
              laneId: tomLaneId,
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: `File lock timeout: ${path.join(
                tempTeamsBase,
                teamName,
                '.opencode-runtime',
                'lanes',
                encodeURIComponent(tomLaneId),
                'opencode-runtime-receipts.json'
              )}`,
              diagnostics: ['File lock timeout: opencode-runtime-receipts.json'],
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
          },
          updatedAt: '2026-04-23T10:00:00.000Z',
        }),
        null,
        2
      )}\n`,
      'utf8'
    );
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: tomLaneId,
      state: 'degraded',
      diagnostics: ['File lock timeout: opencode-runtime-receipts.json'],
    });
    await writeCommittedOpenCodeSessionStore({
      teamName,
      laneId: tomLaneId,
      runId: tomRunId,
      sessions: [
        {
          id: 'ses_tom_late',
          teamName,
          memberName: 'tom',
          runId: tomRunId,
          laneId: tomLaneId,
          providerId: 'opencode',
          observedAt: '2026-04-23T10:01:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
      ],
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
      bootstrapConfirmed: true,
    });
    expect(result.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(result.statuses.jack).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('does not recover degraded OpenCode file-lock failures from stale run evidence', async () => {
    const teamName = 'atlas-hq-file-lock-stale-run-evidence';
    const tomLaneId = 'secondary:opencode:tom';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.5',
    });
    writeMembersMeta(teamName, [
      { name: 'tom', providerId: 'opencode', model: 'openrouter/minimax/minimax-m2.5' },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', []);
    fs.writeFileSync(
      getTeamLaunchStatePath(teamName),
      `${JSON.stringify(
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'finished',
          expectedMembers: ['tom'],
          bootstrapExpectedMembers: [],
          members: {
            tom: {
              name: 'tom',
              providerId: 'opencode',
              model: 'openrouter/minimax/minimax-m2.5',
              laneId: tomLaneId,
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'File lock timeout: opencode-runtime-receipts.json',
              diagnostics: ['File lock timeout: opencode-runtime-receipts.json'],
              lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            },
          },
          updatedAt: '2026-04-23T10:00:00.000Z',
        }),
        null,
        2
      )}\n`,
      'utf8'
    );
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempTeamsBase,
      teamName,
      laneId: tomLaneId,
      state: 'degraded',
      diagnostics: ['File lock timeout: opencode-runtime-receipts.json'],
    });
    await writeCommittedOpenCodeSessionStore({
      teamName,
      laneId: tomLaneId,
      runId: 'current-runtime-run',
      sessions: [
        {
          id: 'ses_tom_old',
          teamName,
          memberName: 'tom',
          runId: 'old-runtime-run',
          laneId: tomLaneId,
          providerId: 'opencode',
          observedAt: '2026-04-23T09:00:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
      ],
    });

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      bootstrapConfirmed: false,
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

  it('keeps primary bootstrap-confirmed members alive when OpenCode secondary lanes fail', async () => {
    const teamName = 'atlas-hq-source-aware-live';
    const startedAt = '2026-04-23T10:00:00.000Z';
    const exactOpenCodeReason =
      'Latest assistant message msg_alice failed with APIError - Insufficient credits.';
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob', 'jack']);
    writeBootstrapState(
      teamName,
      [
        {
          name: 'bob',
          status: 'bootstrap_confirmed',
          lastObservedAt: Date.parse('2026-04-23T10:01:00.000Z'),
        },
        {
          name: 'jack',
          status: 'bootstrap_confirmed',
          lastObservedAt: Date.parse('2026-04-23T10:01:00.000Z'),
        },
      ],
      '2026-04-23T10:01:00.000Z'
    );
    const run = createMemberSpawnRun({
      teamName,
      runId: 'run-atlas-hq-source-aware-live',
      startedAt,
      expectedMembers: ['bob', 'jack'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'error',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            error: 'Teammate was never spawned during launch.',
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
        ],
        [
          'jack',
          createMemberSpawnStatusEntry({
            status: 'error',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
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
    run.request = {
      teamName,
      cwd: '/Users/test/proj',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      members: [],
    };
    run.effectiveMembers = [
      { name: 'bob', providerId: 'codex', model: 'gpt-5.3-codex' },
      { name: 'jack', providerId: 'codex', model: 'gpt-5.4' },
    ];
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:alice',
        providerId: 'opencode',
        member: {
          name: 'alice',
          providerId: 'opencode',
          model: 'openrouter/z-ai/glm-5.1',
        },
        runId: 'lane-run-alice',
        state: 'finished',
        result: {
          runId: 'lane-run-alice',
          teamName,
          launchPhase: 'finished',
          teamLaunchState: 'partial_failure',
          members: {
            alice: {
              memberName: 'alice',
              providerId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: exactOpenCodeReason,
              diagnostics: [exactOpenCodeReason],
            },
          },
          warnings: [],
          diagnostics: [exactOpenCodeReason],
        },
        warnings: [],
        diagnostics: [exactOpenCodeReason],
      },
      {
        laneId: 'secondary:opencode:tom',
        providerId: 'opencode',
        member: {
          name: 'tom',
          providerId: 'opencode',
          model: 'openrouter/minimax/minimax-m2.5',
        },
        runId: 'lane-run-tom',
        state: 'finished',
        result: {
          runId: 'lane-run-tom',
          teamName,
          launchPhase: 'finished',
          teamLaunchState: 'partial_failure',
          members: {
            tom: {
              memberName: 'tom',
              providerId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Tom provider launch failed.',
              diagnostics: ['Tom provider launch failed.'],
            },
          },
          warnings: [],
          diagnostics: ['Tom provider launch failed.'],
        },
        warnings: [],
        diagnostics: ['Tom provider launch failed.'],
      },
    ];
    run.detectedSessionId = 'lead-session';

    const svc = new TeamProvisioningService();
    const snapshot = await (svc as any).persistLaunchStateSnapshot(run, 'finished');

    expect(snapshot.members.bob).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(snapshot.members.jack).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(snapshot.members.alice).toMatchObject({
      launchState: 'failed_to_start',
      hardFailureReason: exactOpenCodeReason,
    });
    expect(snapshot.members.tom).toMatchObject({
      launchState: 'failed_to_start',
      hardFailureReason: 'Tom provider launch failed.',
    });
    expect(snapshot.summary.confirmedCount).toBe(2);
    expect(snapshot.summary.failedCount).toBe(2);
  });

  it('reconciles persisted mixed launch-state when primary bootstrap members were marked missing', async () => {
    const teamName = 'atlas-hq-source-aware-persisted';
    const exactOpenCodeReason =
      'Latest assistant message msg_alice failed with APIError - Insufficient credits.';
    const transientBobMcpFailure =
      'resources/read failed: resources/read failed for `agent-teams` (member_briefing?teamName=atlas-hq-source-aware-persisted&memberName=bob): Mcp error: -32601: Method not found';
    writeTeamMeta(teamName, {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
    });
    writeMembersMeta(teamName, [
      { name: 'bob', providerId: 'codex', model: 'gpt-5.3-codex' },
      { name: 'jack', providerId: 'codex', model: 'gpt-5.4' },
      { name: 'alice', providerId: 'opencode', model: 'openrouter/z-ai/glm-5.1' },
      { name: 'tom', providerId: 'opencode', model: 'openrouter/minimax/minimax-m2.5' },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob', 'jack']);
    writeBootstrapState(
      teamName,
      [
        {
          name: 'bob',
          status: 'bootstrap_confirmed',
          lastObservedAt: Date.parse('2026-04-23T10:01:00.000Z'),
        },
        {
          name: 'jack',
          status: 'bootstrap_confirmed',
          lastObservedAt: Date.parse('2026-04-23T10:01:00.000Z'),
        },
      ],
      '2026-04-23T10:01:00.000Z'
    );
    fs.writeFileSync(
      getTeamLaunchStatePath(teamName),
      `${JSON.stringify(
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'finished',
          expectedMembers: ['bob', 'jack', 'alice', 'tom'],
          bootstrapExpectedMembers: ['bob', 'jack'],
          members: {
            bob: {
              name: 'bob',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: transientBobMcpFailure,
              lastEvaluatedAt: '2026-04-23T10:02:00.000Z',
            },
            jack: {
              name: 'jack',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate was never spawned during launch.',
              lastEvaluatedAt: '2026-04-23T10:02:00.000Z',
            },
            alice: {
              name: 'alice',
              providerId: 'opencode',
              model: 'openrouter/z-ai/glm-5.1',
              laneId: 'secondary:opencode:alice',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'OpenCode bridge reported member launch failure',
              diagnostics: [exactOpenCodeReason],
              lastEvaluatedAt: '2026-04-23T10:02:00.000Z',
            },
            tom: {
              name: 'tom',
              providerId: 'opencode',
              model: 'openrouter/minimax/minimax-m2.5',
              laneId: 'secondary:opencode:tom',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'OpenCode bridge reported member launch failure',
              diagnostics: ['Tom provider launch failed.'],
              lastEvaluatedAt: '2026-04-23T10:02:00.000Z',
            },
          },
          updatedAt: '2026-04-23T10:02:00.000Z',
        }),
        null,
        2
      )}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(result.statuses.jack).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(result.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: exactOpenCodeReason,
    });
    expect(result.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: 'Tom provider launch failed.',
    });
    const summary = JSON.parse(
      await fsPromises.readFile(getTeamLaunchSummaryPath(teamName), 'utf8')
    );
    expect(summary).toMatchObject({
      teamLaunchState: 'partial_failure',
      confirmedCount: 2,
      failedCount: 2,
      missingMembers: ['alice', 'tom'],
    });
  });

  it('does not collapse persisted mixed secondary failures when primary bootstrap snapshot is clean and richer', async () => {
    const teamName = 'mixed-clean-bootstrap-does-not-collapse-secondary-failure';
    writeMembersMeta(teamName, [
      { name: 'bob', providerId: 'codex', model: 'gpt-5.4' },
      { name: 'alice', providerId: 'opencode', model: 'openrouter/z-ai/glm-5.1' },
    ]);
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob']);
    writeBootstrapState(
      teamName,
      [
        { name: 'bob', status: 'bootstrap_confirmed' },
        { name: 'jack', status: 'bootstrap_confirmed' },
        { name: 'nova', status: 'bootstrap_confirmed' },
        { name: 'sam', status: 'bootstrap_confirmed' },
        { name: 'kim', status: 'bootstrap_confirmed' },
      ],
      '2026-04-23T10:03:00.000Z'
    );
    const exactOpenCodeReason =
      'Latest assistant message msg_alice failed with APIError - Insufficient credits.';
    fs.writeFileSync(
      getTeamLaunchStatePath(teamName),
      `${JSON.stringify(
        createPersistedLaunchSnapshot({
          teamName,
          leadSessionId: 'lead-session',
          launchPhase: 'finished',
          expectedMembers: ['bob', 'alice'],
          bootstrapExpectedMembers: ['bob'],
          members: {
            bob: {
              name: 'bob',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Teammate was never spawned during launch.',
              lastEvaluatedAt: '2026-04-23T10:02:00.000Z',
            },
            alice: {
              name: 'alice',
              providerId: 'opencode',
              laneId: 'secondary:opencode:alice',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'OpenCode bridge reported member launch failure',
              diagnostics: [exactOpenCodeReason],
              lastEvaluatedAt: '2026-04-23T10:02:00.000Z',
            },
          },
          updatedAt: '2026-04-23T10:02:00.000Z',
        }),
        null,
        2
      )}\n`,
      'utf8'
    );

    const svc = new TeamProvisioningService();
    const result = await svc.getMemberSpawnStatuses(teamName);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(result.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: exactOpenCodeReason,
    });
    const persisted = JSON.parse(
      await fsPromises.readFile(getTeamLaunchStatePath(teamName), 'utf8')
    );
    expect(persisted.members.alice).toMatchObject({
      laneId: 'secondary:opencode:alice',
      launchState: 'failed_to_start',
      hardFailureReason: exactOpenCodeReason,
    });
  });

  it('does not revive primary members from stale bootstrap-state during mixed projection', async () => {
    const teamName = 'atlas-hq-stale-bootstrap-live';
    writeLaunchConfig(teamName, '/Users/test/proj', 'lead-session', ['bob']);
    writeBootstrapState(
      teamName,
      [
        {
          name: 'bob',
          status: 'bootstrap_confirmed',
          lastObservedAt: Date.parse('2026-04-23T09:59:00.000Z'),
        },
      ],
      '2026-04-23T09:59:00.000Z'
    );
    const run = createMemberSpawnRun({
      teamName,
      runId: 'run-atlas-hq-stale-bootstrap-live',
      startedAt: '2026-04-23T10:00:00.000Z',
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'error',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
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
    run.request = {
      teamName,
      cwd: '/Users/test/proj',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      members: [],
    };
    run.effectiveMembers = [{ name: 'bob', providerId: 'codex', model: 'gpt-5.3-codex' }];
    run.mixedSecondaryLanes = [
      {
        laneId: 'secondary:opencode:alice',
        providerId: 'opencode',
        member: { name: 'alice', providerId: 'opencode', model: 'openrouter/model' },
        runId: 'lane-run-alice',
        state: 'finished',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ];

    const svc = new TeamProvisioningService();
    const snapshot = await (svc as any).persistLaunchStateSnapshot(run, 'finished');

    expect(snapshot.members.bob).toMatchObject({
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      hardFailure: true,
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

  it('bulk retries failed OpenCode secondary lanes sequentially and classifies outcomes', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      teamName: 'mixed-retry-team',
      runId: 'run-mixed-retry',
      expectedMembers: ['alice', 'tom', 'nova'],
    });
    run.isLaunch = true;
    run.provisioningComplete = true;

    (svc as any).runs.set(run.runId, run);
    (svc as any).aliveRunByTeam.set(run.teamName, run.runId);

    vi.spyOn(svc as any, 'collectFailedOpenCodeSecondaryRetryCandidates').mockResolvedValue([
      { memberName: 'alice', laneId: 'secondary:opencode:alice' },
      { memberName: 'tom', laneId: 'secondary:opencode:tom' },
      { memberName: 'nova', laneId: 'secondary:opencode:nova' },
    ]);
    const reattach = vi
      .spyOn(svc as any, 'reattachOpenCodeOwnedMemberLaneUnlocked')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('OpenCode bridge crashed'));
    vi.spyOn(svc as any, 'readOpenCodeSecondaryRetryOutcome')
      .mockResolvedValueOnce({ launchState: 'confirmed_alive' })
      .mockResolvedValueOnce({
        launchState: 'failed_to_start',
        reason: 'Latest assistant message reported OpenRouter credits exhausted',
      });
    const notify = vi
      .spyOn(svc as any, 'notifyLeadAboutConfirmedOpenCodeRetries')
      .mockResolvedValue(undefined);

    const result = await svc.retryFailedOpenCodeSecondaryLanes(run.teamName);

    expect(reattach).toHaveBeenNthCalledWith(1, run.teamName, 'alice', {
      reason: 'manual_restart',
    });
    expect(reattach).toHaveBeenNthCalledWith(2, run.teamName, 'tom', {
      reason: 'manual_restart',
    });
    expect(reattach).toHaveBeenNthCalledWith(3, run.teamName, 'nova', {
      reason: 'manual_restart',
    });
    expect(result).toEqual({
      attempted: ['alice', 'tom'],
      confirmed: ['alice'],
      pending: [],
      failed: [
        {
          memberName: 'tom',
          error: 'Latest assistant message reported OpenRouter credits exhausted',
        },
        { memberName: 'nova', error: 'OpenCode bridge crashed' },
      ],
      skipped: [],
    });
    expect(notify).toHaveBeenCalledWith(run, result);
  });

  it('rejects a concurrent manual restart for the same teammate', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      teamName: 'codex-lifecycle-team',
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
          }),
        ],
      ]),
    });
    run.child = { pid: 111 };
    run.processKilled = false;
    run.cancelRequested = false;

    const configReady = createDeferred<{
      name: string;
      members: Array<{ name: string; agentType?: string }>;
    }>();
    (svc as any).configReader = {
      getConfig: vi.fn(() => configReady.promise),
    };
    (svc as any).membersMetaStore = {
      getMembers: vi.fn(async () => [
        {
          name: 'bob',
          role: 'Developer',
          providerId: 'codex',
          model: 'gpt-5.4',
          agentType: 'general-purpose',
        },
      ]),
    };
    (svc as any).sendMessageToRun = vi.fn(async () => undefined);
    (svc as any).readPersistedRuntimeMembers = vi.fn(() => []);
    (svc as any).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
    (svc as any).aliveRunByTeam.set(run.teamName, run.runId);
    (svc as any).runs.set(run.runId, run);

    const firstRestart = svc.restartMember(run.teamName, 'bob');
    await Promise.resolve();

    await expect(svc.restartMember(run.teamName, 'bob')).rejects.toThrow(
      'Lifecycle operation for teammate "bob" is already in progress'
    );

    configReady.resolve({
      name: 'Codex Lifecycle Team',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    });
    await firstRestart;
  });

  it('does not let one teammate lifecycle operation block another teammate or team', async () => {
    const svc = new TeamProvisioningService();
    const aliceDone = createDeferred<void>();
    const firstOperation = (svc as any).runMemberLifecycleOperation(
      'same-team',
      'alice',
      'manual_restart',
      () => aliceDone.promise
    );

    await expect(
      (svc as any).runMemberLifecycleOperation(
        'same-team',
        'bob',
        'manual_restart',
        async () => 'bob-ok'
      )
    ).resolves.toBe('bob-ok');

    await expect(
      (svc as any).runMemberLifecycleOperation(
        'other-team',
        'alice',
        'manual_restart',
        async () => 'other-ok'
      )
    ).resolves.toBe('other-ok');

    aliceDone.resolve();
    await firstOperation;
  });

  it('skips busy OpenCode retry candidates while continuing other candidates', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      teamName: 'mixed-retry-busy-team',
      runId: 'run-mixed-retry-busy',
      expectedMembers: ['alice', 'tom'],
    });
    run.isLaunch = true;
    run.provisioningComplete = true;
    (svc as any).runs.set(run.runId, run);
    (svc as any).aliveRunByTeam.set(run.teamName, run.runId);

    const busyDone = createDeferred<void>();
    const busyOperation = (svc as any).runMemberLifecycleOperation(
      run.teamName,
      'alice',
      'manual_restart',
      () => busyDone.promise
    );

    vi.spyOn(svc as any, 'collectFailedOpenCodeSecondaryRetryCandidates').mockResolvedValue([
      { memberName: 'alice', laneId: 'secondary:opencode:alice' },
      { memberName: 'tom', laneId: 'secondary:opencode:tom' },
    ]);
    const reattach = vi
      .spyOn(svc as any, 'reattachOpenCodeOwnedMemberLaneUnlocked')
      .mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'readOpenCodeSecondaryRetryOutcome').mockResolvedValue({
      launchState: 'confirmed_alive',
    });
    vi.spyOn(svc as any, 'notifyLeadAboutConfirmedOpenCodeRetries').mockResolvedValue(undefined);

    const result = await svc.retryFailedOpenCodeSecondaryLanes(run.teamName);

    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach).toHaveBeenCalledWith(run.teamName, 'tom', { reason: 'manual_restart' });
    expect(result).toMatchObject({
      attempted: ['tom'],
      confirmed: ['tom'],
      skipped: [
        {
          memberName: 'alice',
          reason: 'Lifecycle operation already in progress',
        },
      ],
    });

    busyDone.resolve();
    await busyOperation;
  });

  it('blocks manual restart while an OpenCode member update reattach is active', async () => {
    const svc = new TeamProvisioningService();
    const reattachDone = createDeferred<void>();
    const reattachOperation = (svc as any).runMemberLifecycleOperation(
      'mixed-update-team',
      'bob',
      'opencode_member_updated',
      () => reattachDone.promise
    );

    await expect(svc.restartMember('mixed-update-team', 'bob')).rejects.toThrow(
      'Lifecycle operation for teammate "bob" is already in progress'
    );

    reattachDone.resolve();
    await reattachOperation;
  });

  it('blocks manual restart while an OpenCode member removal detach is active', async () => {
    const svc = new TeamProvisioningService();
    const detachDone = createDeferred<void>();
    const detachOperation = (svc as any).runMemberLifecycleOperation(
      'mixed-remove-team',
      'bob',
      'opencode_member_removed',
      () => detachDone.promise
    );

    await expect(svc.restartMember('mixed-remove-team', 'bob')).rejects.toThrow(
      'Lifecycle operation for teammate "bob" is already in progress'
    );

    detachDone.resolve();
    await detachOperation;
  });

  it('does not let launch cleanup overwrite a teammate with an active lifecycle operation', async () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      teamName: 'cleanup-guard-team',
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            bootstrapConfirmed: false,
          }),
        ],
      ]),
    });
    const lifecycleDone = createDeferred<void>();
    const lifecycleOperation = (svc as any).runMemberLifecycleOperation(
      run.teamName,
      'bob',
      'manual_restart',
      () => lifecycleDone.promise
    );

    (svc as any).markUnconfirmedBootstrapMembersFailed(run, 'launch cleanup failure', {
      cleanupRequested: true,
    });

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      hardFailure: false,
    });

    lifecycleDone.resolve();
    await lifecycleOperation;
  });

  it('still marks unconfirmed teammates failed during cleanup when no lifecycle operation is active', () => {
    const svc = new TeamProvisioningService();
    const run = createMemberSpawnRun({
      teamName: 'cleanup-no-guard-team',
      expectedMembers: ['bob'],
      memberSpawnStatuses: new Map([
        [
          'bob',
          createMemberSpawnStatusEntry({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
            bootstrapConfirmed: false,
            livenessSource: 'process',
          }),
        ],
      ]),
    });

    (svc as any).markUnconfirmedBootstrapMembersFailed(run, 'launch cleanup failure', {
      cleanupRequested: true,
    });

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      runtimeAlive: false,
      livenessSource: undefined,
    });
  });
});
