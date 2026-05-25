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

import {
  assertExecutable,
  FatalWaitError,
  formatMemberWorkSyncDiagnostics,
  formatProgressDump,
  type MemberWorkSyncLiveControlServer,
  readRuntimeTurnSettledProcessedMetas,
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
  process.env.MEMBER_WORK_SYNC_CODEX_LIVE === '1' &&
  (hasCodexApiKey || allowConnectedChatGptAccount)
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_EFFORT = 'low' as const;

liveDescribe('Member work sync Codex live e2e', () => {
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
        | ((input: { provider: 'claude' | 'codex' | 'opencode' }) => Promise<Record<string, string> | null>)
        | null
    ): void;
    relayInboxFileToLiveRecipient(teamName: string, inboxName: string): Promise<{ relayed: number }>;
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

  const createLiveNudgeDeliveryWake = (activeService: NonNullable<typeof svc>) => ({
    schedule: async (input: { teamName: string; memberName: string; delayMs?: number }) => {
      const timer = setTimeout(() => {
        void activeService
          .relayInboxFileToLiveRecipient(input.teamName, input.memberName)
          .catch(() => undefined);
      }, Math.max(0, input.delayMs ?? 0));
      timer.unref?.();
    },
  });

  const relayInboxIfNotAlreadyConsumed = async (
    activeService: NonNullable<typeof svc>,
    memberName: string
  ): Promise<void> => {
    const activeTeamName = teamName;
    if (!activeTeamName) {
      return;
    }
    const relay = await activeService.relayInboxFileToLiveRecipient(activeTeamName, memberName);
    if (relay.relayed === 0) {
      console.info(
        `[MemberWorkSyncCodex.live] manual inbox relay returned 0 for ${activeTeamName}/${memberName}; waiting for watcher or wake delivery proof`
      );
    }
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-codex-live-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);

    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    previousCodexHome = process.env.CODEX_HOME;
    previousCodexIgnoreUserConfig = process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG;

    const shouldUseConnectedAccountHome = allowConnectedChatGptAccount && !hasLiveCodexApiKey();
    if (shouldUseConnectedAccountHome) {
      codexHomeDir = resolveConnectedCodexHome(previousCodexHome);
      ownsCodexHomeDir = false;
      await fs.access(codexHomeDir);
    } else {
      const codexHomeRoot = path.resolve('temp', 'member-work-sync-codex-live');
      await fs.mkdir(codexHomeRoot, { recursive: true });
      codexHomeDir = await fs.mkdtemp(path.join(codexHomeRoot, 'codex-home-'));
      ownsCodexHomeDir = true;
    }

    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    process.env.CODEX_HOME = codexHomeDir;
    process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG = 'true';

    codexAccountFeature = null;
    providerConnectionService = null;
    svc = null;
    feature = null;
    controlServer = null;
    teamName = null;
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
    if (process.env.MEMBER_WORK_SYNC_CODEX_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncCodex.live] preserved temp dir: ${tempDir}`);
      console.info(`[MemberWorkSyncCodex.live] preserved CODEX_HOME: ${codexHomeDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (ownsCodexHomeDir) {
        await fs.rm(codexHomeDir, { recursive: true, force: true });
      }
    }
  });

  it(
    'lets a real Codex teammate report still-working for the current actionable agenda with active nudge guards',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertExecutable(orchestratorCli!);

      const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
      const effort = (process.env.MEMBER_WORK_SYNC_CODEX_EFFORT?.trim() ||
        DEFAULT_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh';
      const marker = `member-work-sync-codex-live-${Date.now()}`;
      teamName = `member-work-sync-codex-${Date.now()}`;
      const projectPath = path.join(tempDir, 'project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync Codex live e2e\n\nKeep this project intentionally tiny.\n',
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
                preferredAuthMode: hasLiveCodexApiKey() ? 'auto' : ('chatgpt' as const),
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
      feature = createMemberWorkSyncFeature({
        teamsBasePath: getTeamsBasePath(),
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
        nudgeDeliveryWake: createLiveNudgeDeliveryWake(activeService),
      });
      activeService.setTeamChangeEmitter((event: TeamChangeEvent) =>
        feature!.noteTeamChange(event)
      );
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
          effort,
          fastMode: 'off',
          skipPermissions: true,
          prompt: [
            'Keep launch work minimal.',
            'If you receive a task, follow task instructions exactly.',
            'Do not call member_work_sync_status until a task instruction or member_work_sync_nudge provides exact teamName, memberName, and controlUrl.',
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
        config?.members?.find((member) => member.role?.toLowerCase().includes('lead'))?.name?.trim() ||
        config?.members?.[0]?.name?.trim() ||
        'team-lead';
      const task = await teamDataService.createTask(teamName, {
        subject: `Member work sync live lease ${marker}`,
        owner: memberName,
        startImmediately: true,
        prompt: [
          `This is a live member-work-sync validation task. Marker: ${marker}.`,
          'Do not edit files and do not complete this task.',
          'Call task_start for this task.',
          `Then call member_work_sync_status with teamName "${teamName}", memberName "${memberName}", and controlUrl "${controlServer.baseUrl}".`,
          `Then call member_work_sync_report with teamName "${teamName}", memberName "${memberName}", controlUrl "${controlServer.baseUrl}", state "still_working", the exact agendaFingerprint and reportToken returned by member_work_sync_status, and the current task id if available.`,
          `Only after member_work_sync_report is accepted, add one task comment containing exactly: ${marker}:still-working.`,
          'After that stop. Do not send a user-visible message.',
        ].join('\n'),
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

      const preRelayStatus = await feature.refreshStatus({ teamName, memberName });
      expect(preRelayStatus.memberName).toBe(memberName);
      expect(preRelayStatus.providerId).toBe('codex');
      expect(preRelayStatus.agenda.items.some((item) => item.taskId === task.id)).toBe(true);
      expect(preRelayStatus.shadow?.wouldNudge).toBe(true);

      await relayInboxIfNotAlreadyConsumed(activeService, memberName);

      await waitUntil(async () => {
        const fatalRuntimeMessage = await readFatalRuntimeMessage(teamName!);
        if (fatalRuntimeMessage) {
          throw new FatalWaitError(fatalRuntimeMessage);
        }
        await feature!.replayPendingReports([teamName!]);
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        if (status.report?.accepted && status.report.state === 'still_working') {
          return true;
        }
        const tasks = await new TeamTaskReader().getTasks(teamName!);
        const currentTask = tasks.find((candidate) => candidate.id === task.id);
        const hasMarkerComment = currentTask?.comments?.some((comment) =>
          comment.text.includes(`${marker}:still-working`)
        );
        return Boolean(hasMarkerComment && status.report?.accepted);
      }, 240_000, 2_000, async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
      );

      const [finalStatus, metrics] = await Promise.all([
        feature.getStatus({ teamName, memberName }),
        feature.getMetrics({ teamName }),
      ]);
      expect(finalStatus.state).toBe('still_working');
      expect(finalStatus.report).toMatchObject({
        accepted: true,
        state: 'still_working',
      });
      expect(metrics.recentEvents.some((event) => event.kind === 'report_accepted')).toBe(true);
      await waitUntil(async () => {
        await feature!.drainRuntimeTurnSettledEvents();
        const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
        return metas.some(
          ({ meta }) =>
            (meta.event as { provider?: unknown; teamName?: unknown } | undefined)?.provider ===
              'codex' &&
            (meta.event as { provider?: unknown; teamName?: unknown } | undefined)?.teamName ===
              teamName
        );
      }, 60_000);
      const postReportDispatch = await feature.dispatchDueNudges([teamName]);
      expect(postReportDispatch.delivered).toBe(0);
      expect(postReportDispatch.retryable).toBe(0);
      expect(postReportDispatch.terminal).toBe(0);
      expect(postReportDispatch.claimed).toBe(postReportDispatch.superseded);
      expect(postReportDispatch.claimed).toBeLessThanOrEqual(1);
    },
    360_000
  );

  it(
    'delivers a real work-sync nudge to a Codex teammate and accepts the follow-up report',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertExecutable(orchestratorCli!);

      const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
      const effort = (process.env.MEMBER_WORK_SYNC_CODEX_EFFORT?.trim() ||
        DEFAULT_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh';
      const marker = `member-work-sync-codex-nudge-${Date.now()}`;
      teamName = `member-work-sync-codex-nudge-${Date.now()}`;
      const projectPath = path.join(tempDir, 'project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync Codex nudge live e2e\n\nKeep this project intentionally tiny.\n',
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
                preferredAuthMode: 'chatgpt' as const,
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
      feature = createMemberWorkSyncFeature({
        teamsBasePath: getTeamsBasePath(),
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        queueQuietWindowMs: 1,
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
        nudgeDeliveryWake: createLiveNudgeDeliveryWake(activeService),
      });
      activeService.setTeamChangeEmitter((event: TeamChangeEvent) =>
        feature!.noteTeamChange(event)
      );
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
          effort,
          fastMode: 'off',
          skipPermissions: true,
          prompt: [
            'Keep launch work minimal.',
            'If you receive a member_work_sync_nudge, do not complete the task.',
            'For a member_work_sync_nudge, call member_work_sync_status first, then call member_work_sync_report with state "still_working", the returned agendaFingerprint/reportToken, and taskIds for the current agenda.',
            'After reporting, stop without a user-visible message.',
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
        config?.members?.find((member) => member.role?.toLowerCase().includes('lead'))?.name?.trim() ||
        config?.members?.[0]?.name?.trim() ||
        'team-lead';
      await seedShadowReadyMetrics({ teamName, memberName });

      const task = await teamDataService.createTask(teamName, {
        subject: `Member work sync live nudge ${marker}`,
        owner: memberName,
        startImmediately: false,
        prompt: [
          `This is a live member-work-sync nudge validation task. Marker: ${marker}.`,
          'Do not edit files and do not complete this task.',
          'Only report still_working if member-work-sync asks you to synchronize.',
        ].join('\n'),
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

      await waitUntil(async () => {
        const status = await feature!.refreshStatus({ teamName: teamName!, memberName });
        if (!status.agenda.items.some((item) => item.taskId === task.id)) {
          return false;
        }
        await feature!.dispatchDueNudges([teamName!]);
        return true;
      }, 60_000, 500, async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
      );

      await relayInboxIfNotAlreadyConsumed(activeService, memberName);

      await waitUntil(async () => {
        const fatalRuntimeMessage = await readFatalRuntimeMessage(teamName!);
        if (fatalRuntimeMessage) {
          throw new FatalWaitError(fatalRuntimeMessage);
        }
        await feature!.replayPendingReports([teamName!]);
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        return status.report?.accepted === true && status.report.state === 'still_working';
      }, 240_000, 2_000, async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
      );

      const finalStatus = await feature.getStatus({ teamName, memberName });
      expect(finalStatus.state).toBe('still_working');
      expect(finalStatus.report).toMatchObject({
        accepted: true,
        state: 'still_working',
      });
      await waitUntil(async () => {
        await feature!.drainRuntimeTurnSettledEvents();
        const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
        return metas.some(
          ({ meta }) =>
            (meta.event as { provider?: unknown; teamName?: unknown } | undefined)?.provider ===
              'codex' &&
            (meta.event as { provider?: unknown; teamName?: unknown } | undefined)?.teamName ===
              teamName
        );
      }, 60_000);
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 0,
        delivered: 0,
      });
    },
    420_000
  );

  it(
    'lets a real Codex teammate complete the task and report caught-up after the board clears',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertExecutable(orchestratorCli!);

      const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
      const effort = (process.env.MEMBER_WORK_SYNC_CODEX_EFFORT?.trim() ||
        DEFAULT_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh';
      const marker = `member-work-sync-codex-complete-${Date.now()}`;
      teamName = `member-work-sync-codex-complete-${Date.now()}`;
      const projectPath = path.join(tempDir, 'project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync Codex complete live e2e\n\nKeep this project intentionally tiny.\n',
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
                preferredAuthMode: hasLiveCodexApiKey() ? 'auto' : ('chatgpt' as const),
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
      const taskReader = new TeamTaskReader();
      feature = createMemberWorkSyncFeature({
        teamsBasePath: getTeamsBasePath(),
        configReader: new TeamConfigReader(),
        taskReader,
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        queueQuietWindowMs: 1,
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
        nudgeDeliveryWake: createLiveNudgeDeliveryWake(activeService),
      });
      activeService.setTeamChangeEmitter((event: TeamChangeEvent) =>
        feature!.noteTeamChange(event)
      );
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
          effort,
          fastMode: 'off',
          skipPermissions: true,
          prompt: [
            'Keep launch work minimal.',
            'If you receive a task, follow task instructions exactly.',
            'Use member_work_sync_status and member_work_sync_report whenever the task asks you to synchronize work state.',
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
        config?.members?.find((member) => member.role?.toLowerCase().includes('lead'))?.name?.trim() ||
        config?.members?.[0]?.name?.trim() ||
        'team-lead';
      await seedShadowReadyMetrics({ teamName, memberName });

      const task = await teamDataService.createTask(teamName, {
        subject: `Member work sync live completion ${marker}`,
        owner: memberName,
        startImmediately: true,
        prompt: [
          `This is a live member-work-sync completion validation task. Marker: ${marker}.`,
          'Do not edit files.',
          'Call task_start for this task.',
          `Then call member_work_sync_status with teamName "${teamName}", memberName "${memberName}", and controlUrl "${controlServer.baseUrl}".`,
          `Then call member_work_sync_report with teamName "${teamName}", memberName "${memberName}", controlUrl "${controlServer.baseUrl}", state "still_working", the exact agendaFingerprint and reportToken returned by member_work_sync_status, and the current task id if available.`,
          'After that, call task_complete for this task.',
          `Then call member_work_sync_status again with teamName "${teamName}", memberName "${memberName}", and controlUrl "${controlServer.baseUrl}".`,
          'If the returned agenda has no items, call member_work_sync_report with state "caught_up", no taskIds, and the exact agendaFingerprint/reportToken returned by that second status call.',
          `Only after the caught_up report is accepted, add one task comment containing exactly: ${marker}:completed-and-caught-up.`,
          'After that stop. Do not send a user-visible message.',
        ].join('\n'),
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
      await relayInboxIfNotAlreadyConsumed(activeService, memberName);

      await waitUntil(async () => {
        const fatalRuntimeMessage = await readFatalRuntimeMessage(teamName!);
        if (fatalRuntimeMessage) {
          throw new FatalWaitError(fatalRuntimeMessage);
        }
        await feature!.replayPendingReports([teamName!]);
        await feature!.drainRuntimeTurnSettledEvents();
        const [tasks, status] = await Promise.all([
          taskReader.getTasks(teamName!),
          feature!.refreshStatus({ teamName: teamName!, memberName }),
        ]);
        const currentTask = tasks.find((candidate) => candidate.id === task.id);
        const hasCompletionMarker = currentTask?.comments?.some((comment) =>
          comment.text.includes(`${marker}:completed-and-caught-up`)
        );
        return Boolean(
          currentTask?.status === 'completed' &&
            hasCompletionMarker &&
            status.state === 'caught_up' &&
            status.agenda.items.length === 0 &&
            status.report?.accepted === true &&
            status.report.state === 'caught_up'
        );
      }, 300_000, 2_000, async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
      );

      const [tasks, finalStatus, metrics] = await Promise.all([
        taskReader.getTasks(teamName),
        feature.getStatus({ teamName, memberName }),
        feature.getMetrics({ teamName }),
      ]);
      const completedTask = tasks.find((candidate) => candidate.id === task.id);
      expect(completedTask?.status).toBe('completed');
      expect(finalStatus.state).toBe('caught_up');
      expect(finalStatus.agenda.items).toEqual([]);
      expect(finalStatus.report).toMatchObject({
        accepted: true,
        state: 'caught_up',
      });
      expect(metrics.recentEvents.some((event) => event.kind === 'report_accepted')).toBe(true);
      await expect(feature.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 0,
        delivered: 0,
      });
    },
    480_000
  );
});

async function readFatalRuntimeMessage(teamName: string): Promise<string | null> {
  const sentMessagesPath = path.join(getTeamsBasePath(), teamName, 'sentMessages.json');
  let raw: string;
  try {
    raw = await fs.readFile(sentMessagesPath, 'utf8');
  } catch {
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

function hasLiveCodexApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim());
}

function resolveConnectedCodexHome(previousCodexHome: string | undefined): string {
  const explicit = process.env.MEMBER_WORK_SYNC_CODEX_CONNECTED_HOME?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const previous = previousCodexHome?.trim();
  if (previous) {
    return path.resolve(previous);
  }
  return path.join(os.userInfo().homedir, '.codex');
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

async function readInboxMessages(teamName: string, memberName: string): Promise<
  Array<{
    messageId?: string;
    messageKind?: string;
    text: string;
    read?: boolean;
  }>
> {
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
  const raw = await fs.readFile(inboxPath, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === 'object'
    )
    .flatMap((message) => {
      const text = typeof message.text === 'string' ? message.text : '';
      if (!text) {
        return [];
      }
      return [
        {
          ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
          ...(typeof message.messageKind === 'string'
            ? { messageKind: message.messageKind }
            : {}),
          text,
          ...(typeof message.read === 'boolean' ? { read: message.read } : {}),
        },
      ];
    });
}
