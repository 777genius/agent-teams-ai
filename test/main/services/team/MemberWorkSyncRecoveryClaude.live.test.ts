import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberWorkSyncFeature,
  type MemberWorkSyncFeatureFacade,
} from '../../../../src/features/member-work-sync/main';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { createTestWorkSyncIdentity } from '../../../features/member-work-sync/helpers/createTestWorkSyncIdentity';

import {
  assertExecutable,
  formatProgressDump,
  type MemberWorkSyncLiveControlServer,
  readMemberWorkSyncOutboxItems,
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

const allowConnectedClaudeAccount =
  process.env.MEMBER_WORK_SYNC_CLAUDE_ALLOW_CONNECTED_ACCOUNT === '1';
const liveDescribe =
  process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' &&
  (Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || allowConnectedClaudeAccount)
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_MODEL = 'sonnet';

liveDescribe('Member work sync recovery Claude live canary', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousControlUrl: string | undefined;
  let previousClaudeJsonConfig: string | null | undefined;
  let usingConnectedClaudeAccount = false;
  let claudeJsonConfigRoot: string;
  let svc: {
    stopTeam(teamName: string): Promise<unknown>;
    isTeamAlive(teamName: string): boolean;
    hasProvisioningRun(teamName: string): boolean;
    setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void;
    setControlApiBaseUrlResolver(resolver: (() => Promise<string | null>) | null): void;
    setRuntimeTurnSettledHookSettingsProvider(
      provider: ((input: { provider: 'claude' | 'codex' | 'opencode' }) => Promise<unknown>) | null
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-recovery-claude-'));
    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    usingConnectedClaudeAccount =
      allowConnectedClaudeAccount && !process.env.ANTHROPIC_API_KEY?.trim();
    const connectedHome = os.userInfo().homedir;
    tempClaudeRoot = usingConnectedClaudeAccount
      ? path.join(connectedHome, '.claude')
      : path.join(tempDir, '.claude');
    claudeJsonConfigRoot = usingConnectedClaudeAccount ? connectedHome : tempClaudeRoot;
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    if (usingConnectedClaudeAccount) {
      setClaudeBasePathOverride(null);
    } else {
      setClaudeBasePathOverride(tempClaudeRoot);
    }
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    svc = null;
    feature = null;
    controlServer = null;
    teamName = null;
    previousClaudeJsonConfig = undefined;
  });

  afterEach(async () => {
    if (svc && teamName) {
      await svc.stopTeam(teamName).catch(() => undefined);
    }
    svc?.setTeamChangeEmitter(null);
    svc?.setControlApiBaseUrlResolver(null);
    svc?.setRuntimeTurnSettledHookSettingsProvider(null);
    await feature?.dispose().catch(() => undefined);
    await controlServer?.close().catch(() => undefined);
    if (usingConnectedClaudeAccount && teamName) {
      await fs.rm(path.join(getTeamsBasePath(), teamName), { recursive: true, force: true });
      await fs.rm(path.join(getTasksBasePath(), teamName), { recursive: true, force: true });
    }
    if (usingConnectedClaudeAccount && previousClaudeJsonConfig !== undefined) {
      await restoreClaudeJsonConfig(claudeJsonConfigRoot, previousClaudeJsonConfig);
    }
    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CLAUDE_TEAM_CONTROL_URL', previousControlUrl);
    setClaudeBasePathOverride(null);
    if (process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncRecoveryClaude.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps D0 off and a user stop latch across feature restart on a live Claude teammate', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const model = process.env.MEMBER_WORK_SYNC_CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
    teamName = `member-work-sync-recovery-claude-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery Claude live canary\n\nDisposable sandbox only.\n',
      'utf8'
    );
    previousClaudeJsonConfig = await upsertTrustedClaudeProjectConfig(
      claudeJsonConfigRoot,
      projectPath
    );

    const [
      { TeamProvisioningService },
      { TeamDataService },
      { TeamConfigReader },
      { TeamTaskReader },
      { TeamKanbanManager },
      { TeamMembersMetaStore },
    ] = await Promise.all([
      import('../../../../src/main/services/team/TeamProvisioningService'),
      import('../../../../src/main/services/team/TeamDataService'),
      import('../../../../src/main/services/team/TeamConfigReader'),
      import('../../../../src/main/services/team/TeamTaskReader'),
      import('../../../../src/main/services/team/TeamKanbanManager'),
      import('../../../../src/main/services/team/TeamMembersMetaStore'),
    ]);

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
    activeService.setRuntimeTurnSettledHookSettingsProvider((input) =>
      feature!.buildRuntimeTurnSettledHookSettings(input)
    );
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);

    const progressEvents: TeamProvisioningProgress[] = [];
    await activeService.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'anthropic',
        model,
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
      subject: `Recovery Claude live canary ${Date.now()}`,
      owner: memberName,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for operator instructions.',
    });
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    const status = await feature.refreshStatus({ teamName, memberName });
    expect(status.providerId).toBe('anthropic');
    expect(status.agenda.items.some((item) => item.taskId === task.id)).toBe(true);

    await feature.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
    await feature.dispose();
    feature = createFeature('inc-a');
    activeService.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    const restarted = await feature.getStatus({ teamName, memberName });
    expect(restarted.recoveryHealth?.autoResumeStopLatch?.reason).toBe('user_stop');
    expect(
      Object.values(await readMemberWorkSyncOutboxItems(teamName, memberName)).filter(
        (item) => item.payload?.workSyncIntentKey
      )
    ).toEqual([]);
    await expect(
      feature.continueManually({ teamName, memberName, idempotencyKey: 'live-canary' })
    ).rejects.toThrow(/member_stopped/);

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 420_000);
});

async function upsertTrustedClaudeProjectConfig(
  configDir: string,
  projectPath: string
): Promise<string | null> {
  const configPath = path.join(configDir, '.claude.json');
  const previous = await fs.readFile(configPath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const existing = previous ? (JSON.parse(previous) as Record<string, unknown>) : {};
  const canonicalProjectPath = await fs.realpath(projectPath).catch(() => projectPath);
  const normalizedProjectPath = path.normalize(canonicalProjectPath).replace(/\\/g, '/');
  const projects =
    existing.projects && typeof existing.projects === 'object' && !Array.isArray(existing.projects)
      ? { ...(existing.projects as Record<string, unknown>) }
      : {};
  const currentProject =
    projects[normalizedProjectPath] &&
    typeof projects[normalizedProjectPath] === 'object' &&
    !Array.isArray(projects[normalizedProjectPath])
      ? (projects[normalizedProjectPath] as Record<string, unknown>)
      : {};
  projects[normalizedProjectPath] = {
    ...currentProject,
    hasTrustDialogAccepted: true,
  };
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...existing, projects }, null, 2)}\n`,
    'utf8'
  );
  return previous;
}

async function restoreClaudeJsonConfig(configDir: string, previous: string | null): Promise<void> {
  const configPath = path.join(configDir, '.claude.json');
  if (previous === null) {
    await fs.rm(configPath, { force: true });
    return;
  }
  await fs.writeFile(configPath, previous, 'utf8');
}
