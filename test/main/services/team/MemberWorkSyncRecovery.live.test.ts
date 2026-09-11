import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberWorkSyncFeature,
  type MemberWorkSyncFeatureFacade,
} from '../../../../src/features/member-work-sync/main';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { createTestWorkSyncIdentity } from '../../../features/member-work-sync/helpers/createTestWorkSyncIdentity';

import {
  assertExecutable,
  FatalWaitError,
  formatProgressDump,
  type MemberWorkSyncLiveControlServer,
  restoreEnv,
  startMemberWorkSyncControlServer,
  waitUntil,
} from './memberWorkSyncLiveHarness';

import type { TeamChangeEvent, TeamProvisioningProgress } from '../../../../src/shared/types';

vi.mock('../../../../src/main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: vi.fn(async () => undefined),
    }),
  },
}));

const hasCodexApiKey = Boolean(
  process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim()
);
const allowConnectedChatGptAccount =
  process.env.MEMBER_WORK_SYNC_CODEX_ALLOW_CONNECTED_ACCOUNT === '1';
const liveDescribe =
  process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' &&
  (hasCodexApiKey || allowConnectedChatGptAccount)
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'low' as const;

liveDescribe('Member work sync recovery live canary', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousControlUrl: string | undefined;
  let previousCodexHome: string | undefined;
  let previousCodexIgnoreUserConfig: string | undefined;
  let codexHomeDir: string;
  let ownsCodexHomeDir: boolean;
  let codexAccountFeature: {
    getSnapshot(): Promise<unknown>;
    dispose(): Promise<void>;
  } | null;
  let providerConnectionService: {
    setCodexAccountFeature(feature: { getSnapshot(): Promise<unknown> } | null): void;
  } | null;
  let svc: {
    stopTeam(teamName: string): Promise<unknown>;
    isTeamAlive(teamName: string): boolean;
    hasProvisioningRun(teamName: string): boolean;
    setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void;
    setControlApiBaseUrlResolver(resolver: (() => Promise<string | null>) | null): void;
    setRuntimeTurnSettledEnvironmentProvider(
      provider:
        | ((input: {
            provider: 'claude' | 'codex' | 'opencode';
          }) => Promise<Record<string, string> | null>)
        | null
    ): void;
    relayInboxFileToLiveRecipient(
      teamName: string,
      inboxName: string
    ): Promise<{ relayed: number }>;
    relayLeadInboxMessages(teamName: string): Promise<number>;
    createTeam(
      request: Parameters<
        InstanceType<
          typeof import('../../../../src/main/services/team/TeamProvisioningService').TeamProvisioningService
        >['createTeam']
      >[0],
      onProgress: (progress: TeamProvisioningProgress) => void
    ): Promise<unknown>;
  } | null;
  let feature: MemberWorkSyncFeatureFacade | null;
  let controlServer: MemberWorkSyncLiveControlServer | null;
  let teamName: string | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-recovery-live-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);

    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    previousCodexHome = process.env.CODEX_HOME;
    previousCodexIgnoreUserConfig = process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG;

    if (allowConnectedChatGptAccount && !hasCodexApiKey) {
      codexHomeDir = previousCodexHome?.trim() || path.join(os.userInfo().homedir, '.codex');
      ownsCodexHomeDir = false;
      await fs.access(codexHomeDir);
    } else {
      const codexHomeRoot = path.resolve('temp', 'member-work-sync-recovery-live');
      await fs.mkdir(codexHomeRoot, { recursive: true });
      codexHomeDir = await fs.mkdtemp(path.join(codexHomeRoot, 'codex-home-'));
      ownsCodexHomeDir = true;
    }

    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    process.env.CODEX_HOME = codexHomeDir;
    process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG = 'true';

    svc = null;
    feature = null;
    controlServer = null;
    teamName = null;
    codexAccountFeature = null;
    providerConnectionService = null;
  });

  afterEach(async () => {
    const warn = vi.mocked(console.warn);
    if (warn.mock) {
      for (let index = warn.mock.calls.length - 1; index >= 0; index -= 1) {
        const rendered = warn.mock.calls[index]?.map((arg) => String(arg)).join(' ') ?? '';
        if (rendered.includes('stream-json result: error')) {
          warn.mock.calls.splice(index, 1);
        }
      }
    }
    if (svc && teamName) {
      await svc.stopTeam(teamName).catch(() => undefined);
    }
    svc?.setControlApiBaseUrlResolver(null);
    svc?.setRuntimeTurnSettledEnvironmentProvider(null);
    providerConnectionService?.setCodexAccountFeature(null);
    await feature?.dispose().catch(() => undefined);
    await codexAccountFeature?.dispose().catch(() => undefined);
    await controlServer?.close().catch(() => undefined);

    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CLAUDE_TEAM_CONTROL_URL', previousControlUrl);
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG', previousCodexIgnoreUserConfig);
    setClaudeBasePathOverride(null);
    if (process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncRecovery.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (ownsCodexHomeDir) {
        await fs.rm(codexHomeDir, { recursive: true, force: true });
      }
    }
  });

  it('keeps D0 off and a user stop latch across feature restart on a live Codex teammate', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
    teamName = `member-work-sync-recovery-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery live canary\n\nDisposable sandbox only.\n',
      'utf8'
    );

    const [
      { TeamProvisioningService },
      { TeamDataService },
      { TeamConfigReader },
      { TeamTaskReader },
      { TeamKanbanManager },
      { TeamMembersMetaStore },
      { createCodexAccountFeature },
      { ProviderConnectionService },
    ] = await Promise.all([
      import('../../../../src/main/services/team/TeamProvisioningService'),
      import('../../../../src/main/services/team/TeamDataService'),
      import('../../../../src/main/services/team/TeamConfigReader'),
      import('../../../../src/main/services/team/TeamTaskReader'),
      import('../../../../src/main/services/team/TeamKanbanManager'),
      import('../../../../src/main/services/team/TeamMembersMetaStore'),
      import('../../../../src/features/codex-account/main/composition/createCodexAccountFeature'),
      import('../../../../src/main/services/runtime/ProviderConnectionService'),
    ]);

    codexAccountFeature = createCodexAccountFeature({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      configManager: {
        getConfig: () => ({
          providerConnections: {
            codex: {
              preferredAuthMode: hasCodexApiKey ? 'auto' : ('chatgpt' as const),
            },
          },
        }),
      },
    });
    providerConnectionService = ProviderConnectionService.getInstance();
    providerConnectionService.setCodexAccountFeature(codexAccountFeature);

    svc = new TeamProvisioningService();
    const activeService = svc;
    const teamDataService = new TeamDataService();
    const createFeature = (incarnation: string) =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: createTestWorkSyncIdentity(incarnation),
        teamsBasePath: getTeamsBasePath(),
        recoveryAllocation: { enabled: false },
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
      });

    feature = createFeature('inc-a');
    activeService.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
    activeService.setRuntimeTurnSettledEnvironmentProvider((input) =>
      feature!.buildRuntimeTurnSettledEnvironment(input)
    );
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);

    const progressEvents: TeamProvisioningProgress[] = [];
    await activeService.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model,
        effort: DEFAULT_EFFORT,
        fastMode: 'off',
        skipPermissions: true,
        prompt: [
          'Keep launch work minimal.',
          'Do not edit files.',
          'If you receive a task, wait for instructions and do not complete it.',
        ].join(' '),
        members: [],
      },
      (progress) => {
        progressEvents.push(progress);
      }
    );

    await waitUntil(async () => {
      const last = progressEvents.at(-1);
      if (last?.state === 'failed') {
        throw new Error(formatProgressDump(progressEvents));
      }
      return last?.state === 'ready';
    }, 240_000);

    const config = await new TeamConfigReader().getConfig(teamName);
    const memberName =
      config?.members?.find((member) => member.agentType === 'team-lead')?.name?.trim() ||
      config?.members?.[0]?.name?.trim() ||
      'team-lead';
    const task = await teamDataService.createTask(teamName, {
      subject: `Recovery live canary ${Date.now()}`,
      owner: memberName,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for operator instructions.',
    });
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    const status = await feature.refreshStatus({ teamName, memberName });
    expect(status.providerId).toBe('codex');
    expect(status.agenda.items.some((item) => item.taskId === task.id)).toBe(true);

    await feature.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
    await feature.dispose();
    feature = createFeature('inc-a');
    activeService.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    const restarted = await feature.getStatus({ teamName, memberName });
    expect(restarted.recoveryHealth?.autoResumeStopLatch?.reason).toBe('user_stop');
    expect(
      Object.values(await readMemberOutboxItems(teamName, memberName)).filter(
        (item) => item.payload?.workSyncIntentKey
      )
    ).toEqual([]);

    await expect(
      feature.continueManually({ teamName, memberName, idempotencyKey: 'live-canary' })
    ).rejects.toThrow(/member_stopped/);

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
    expect(
      await fs
        .access(
          path.join(
            getTeamsBasePath(),
            teamName,
            'members',
            memberName,
            '.member-work-sync',
            'status.json'
          )
        )
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  }, 420_000);

  it('delivers one live Codex recovery Continue, keeps attention without a burst, and refuses Continue during approval (B/C)', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
    teamName = `member-work-sync-recovery-progress-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery live progress canary\n\nDisposable sandbox only.\n',
      'utf8'
    );

    const [
      { TeamProvisioningService },
      { TeamDataService },
      { TeamConfigReader },
      { TeamTaskReader },
      { TeamKanbanManager },
      { TeamMembersMetaStore },
      { createCodexAccountFeature },
      { ProviderConnectionService },
    ] = await Promise.all([
      import('../../../../src/main/services/team/TeamProvisioningService'),
      import('../../../../src/main/services/team/TeamDataService'),
      import('../../../../src/main/services/team/TeamConfigReader'),
      import('../../../../src/main/services/team/TeamTaskReader'),
      import('../../../../src/main/services/team/TeamKanbanManager'),
      import('../../../../src/main/services/team/TeamMembersMetaStore'),
      import('../../../../src/features/codex-account/main/composition/createCodexAccountFeature'),
      import('../../../../src/main/services/runtime/ProviderConnectionService'),
    ]);

    codexAccountFeature = createCodexAccountFeature({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      configManager: {
        getConfig: () => ({
          providerConnections: {
            codex: {
              preferredAuthMode: hasCodexApiKey ? 'auto' : ('chatgpt' as const),
            },
          },
        }),
      },
    });
    providerConnectionService = ProviderConnectionService.getInstance();
    providerConnectionService.setCodexAccountFeature(codexAccountFeature);

    svc = new TeamProvisioningService();
    const activeService = svc;
    const teamDataService = new TeamDataService();
    const createFeature = (incarnation: string, options: { busy?: boolean } = {}) =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: createTestWorkSyncIdentity(incarnation),
        teamsBasePath: getTeamsBasePath(),
        recoveryAllocation: { enabled: true },
        recoveryProtocol: { version: 1 },
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
        queueQuietWindowMs: 1,
        nudgeDeliveryWake: {
          schedule: async (input) => {
            const timer = setTimeout(
              () => {
                void activeService
                  .relayInboxFileToLiveRecipient(input.teamName, input.memberName)
                  .catch(() => undefined);
              },
              Math.max(0, input.delayMs ?? 0)
            );
            timer.unref?.();
          },
        },
        ...(options.busy
          ? {
              priorityBusySignals: [
                {
                  isBusy: async () => ({ busy: true, reason: 'approval_pending' }),
                },
              ],
            }
          : {}),
      });

    feature = createFeature('inc-a');
    activeService.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
    activeService.setRuntimeTurnSettledEnvironmentProvider((input) =>
      feature!.buildRuntimeTurnSettledEnvironment(input)
    );
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
    await fs.writeFile(
      path.join(tempClaudeRoot, 'team-control-api.json'),
      JSON.stringify({ baseUrl: controlServer.baseUrl }, null, 2),
      'utf8'
    );

    const progressEvents: TeamProvisioningProgress[] = [];
    await activeService.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model,
        effort: DEFAULT_EFFORT,
        fastMode: 'off',
        skipPermissions: true,
        prompt: [
          'Keep launch work minimal.',
          'Do not edit files.',
          'If you receive a task, wait for instructions and do not complete it.',
        ].join(' '),
        members: [],
      },
      (progress) => {
        progressEvents.push(progress);
      }
    );

    await waitUntil(async () => {
      const last = progressEvents.at(-1);
      if (last?.state === 'failed') {
        throw new Error(formatProgressDump(progressEvents));
      }
      const dump = formatProgressDump(progressEvents);
      if (/usage limit/i.test(dump)) {
        throw new FatalWaitError(dump);
      }
      if (teamName) {
        const fatalRuntimeMessage = await readFatalRuntimeMessage(teamName);
        if (fatalRuntimeMessage) {
          throw new FatalWaitError(fatalRuntimeMessage);
        }
      }
      return last?.state === 'ready';
    }, 240_000);
    expect(activeService.isTeamAlive(teamName)).toBe(true);

    const config = await new TeamConfigReader().getConfig(teamName);
    const memberName =
      config?.members?.find((member) => member.agentType === 'team-lead')?.name?.trim() ||
      config?.members?.[0]?.name?.trim() ||
      'team-lead';
    await seedShadowReadyMetrics({ teamName, memberName });

    const task = await teamDataService.createTask(teamName, {
      subject: `Recovery live continuation ${Date.now()}`,
      owner: memberName,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for a later work-sync continuation.',
    });
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
    const status = await feature.refreshStatus({ teamName, memberName });
    expect(status.agenda.items.some((item) => item.taskId === task.id)).toBe(true);

    const busyFeature = createFeature('inc-a', { busy: true });
    try {
      await expect(
        busyFeature.continueManually({
          teamName,
          memberName,
          idempotencyKey: 'live-approval',
        })
      ).rejects.toThrow(/member_busy/);
    } finally {
      await busyFeature.dispose();
    }

    await waitUntil(
      async () => {
        try {
          await feature!.continueManually({
            teamName: teamName!,
            memberName,
            idempotencyKey: 'live-progress',
          });
          return true;
        } catch (error) {
          if (/member_busy/.test(error instanceof Error ? error.message : String(error))) {
            return false;
          }
          throw error;
        }
      },
      60_000,
      2_000
    );
    await feature.dispatchDueNudges([teamName]);
    await activeService.relayInboxFileToLiveRecipient(teamName, memberName);
    await activeService.relayLeadInboxMessages(teamName).catch(() => 0);

    const recoveryIds = await readRecoveryIntentKeys(teamName, memberName);
    expect(recoveryIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(recoveryIds).size).toBeLessThanOrEqual(2);
    expect(
      (await readInboxMessages(teamName, memberName)).filter(
        (message) => message.messageKind === 'member_work_sync_nudge'
      ).length
    ).toBeGreaterThanOrEqual(1);

    await backdateRecoveryEpisode({ teamName, memberName });
    const attention = await feature.refreshStatus({ teamName, memberName });
    expect(attention.recoveryHealth?.episodes[0]?.phase).toBe('attention');
    expect(attention.recoveryHealth?.attentionAt).toBeTruthy();
    expect(await readRecoveryIntentKeys(teamName, memberName)).toEqual(recoveryIds);

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 180_000);
});

async function readInboxMessages(
  teamName: string,
  memberName: string
): Promise<Array<{ messageId?: string; messageKind?: string }>> {
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
  const raw = await fs.readFile(inboxPath, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

async function readMemberOutboxItems(
  teamName: string,
  memberName: string
): Promise<Record<string, { status?: string; payload?: { workSyncIntentKey?: string } }>> {
  const outboxPath = path.join(
    getTeamsBasePath(),
    teamName,
    'members',
    memberName,
    '.member-work-sync',
    'outbox.json'
  );
  const raw = await fs.readFile(outboxPath, 'utf8').catch(() => '{"items":{}}');
  const parsed = JSON.parse(raw) as {
    items?: Record<string, { status?: string; payload?: { workSyncIntentKey?: string } }>;
  };
  return parsed.items ?? {};
}

async function readRecoveryIntentKeys(teamName: string, memberName: string): Promise<string[]> {
  return Object.values(await readMemberOutboxItems(teamName, memberName))
    .map((item) => item.payload?.workSyncIntentKey)
    .filter((value): value is string => Boolean(value))
    .sort();
}

function memberStatusPath(teamName: string, memberName: string): string {
  return path.join(
    getTeamsBasePath(),
    teamName,
    'members',
    memberName,
    '.member-work-sync',
    'status.json'
  );
}

async function readStoredMemberStatus(
  teamName: string,
  memberName: string
): Promise<{
  schemaVersion?: number;
  status?: {
    report?: { expiresAt?: string };
    recoveryHealth?: {
      episodes?: Array<{ firstObservedAt?: string; dueAt?: string; phase?: string }>;
      attentionAt?: string;
    };
  };
}> {
  const raw = await fs.readFile(memberStatusPath(teamName, memberName), 'utf8');
  return JSON.parse(raw) as Awaited<ReturnType<typeof readStoredMemberStatus>>;
}

async function backdateRecoveryEpisode(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const stored = await readStoredMemberStatus(input.teamName, input.memberName);
  const health = stored.status?.recoveryHealth;
  const observed = health?.episodes?.[0]?.firstObservedAt;
  if (!observed || !health?.episodes?.[0]) {
    throw new Error('recovery episode missing before attention backdate');
  }
  const overdueAt = new Date(Date.parse(observed) - 21 * 60_000).toISOString();
  health.episodes[0].firstObservedAt = overdueAt;
  health.episodes[0].dueAt = observed;
  await fs.writeFile(
    memberStatusPath(input.teamName, input.memberName),
    `${JSON.stringify(stored)}\n`,
    'utf8'
  );
}

async function seedShadowReadyMetrics(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const metricsPath = path.join(
    getTeamsBasePath(),
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  const startMs = Date.now() - 2 * 60 * 60_000;
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'caught_up',
            agendaFingerprint: 'agenda:v1:seed',
            actionableCount: 0,
            evaluatedAt: new Date(startMs).toISOString(),
            providerId: 'codex',
          },
        },
        recentEvents: Array.from({ length: 24 }, (_, index) => ({
          id: `seed-status-${index}`,
          teamName: input.teamName,
          memberName: input.memberName,
          kind: 'status_evaluated',
          state: 'caught_up',
          agendaFingerprint: `agenda:v1:seed-${index}`,
          recordedAt: new Date(startMs + index * 6 * 60_000).toISOString(),
          actionableCount: 0,
          providerId: 'codex',
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function readFatalRuntimeMessage(teamName: string): Promise<string | null> {
  const sentMessagesPath = path.join(getTeamsBasePath(), teamName, 'inboxes', 'user.json');
  const raw = await fs.readFile(sentMessagesPath, 'utf8').catch(() => '');
  if (!raw) {
    return null;
  }
  let messages: unknown;
  try {
    messages = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const text = (message as { text?: unknown }).text;
    if (typeof text !== 'string') {
      continue;
    }
    if (
      text.includes('Codex native exec exited') ||
      text.includes('Codex native error:') ||
      text.includes('Codex native turn failed:')
    ) {
      return text;
    }
  }
  return null;
}
