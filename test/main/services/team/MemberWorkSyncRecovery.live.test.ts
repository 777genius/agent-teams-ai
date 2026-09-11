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
});

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
