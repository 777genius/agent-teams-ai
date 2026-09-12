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
  FatalWaitError,
  formatMemberWorkSyncDiagnostics,
  formatProgressDump,
  type MemberWorkSyncLiveControlServer,
  readMemberWorkSyncOutboxItems,
  readRuntimeTurnSettledProcessedMetas,
  restoreEnv,
  startMemberWorkSyncControlServer,
  throwIfClaudeTranscriptApiError,
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
  let previousHome: string | undefined;
  let previousHistFile: string | undefined;
  let previousUserProfile: string | undefined;
  let previousDisableAppBootstrap: string | undefined;
  let previousDisableRuntimeBootstrap: string | undefined;
  let previousClaudeJsonConfig: string | null | undefined;
  let previousTeamControlApiJson: string | null | undefined;
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
    relayInboxFileToLiveRecipient(
      teamName: string,
      inboxName: string
    ): Promise<{ relayed: number }>;
    relayLeadInboxMessages(teamName: string): Promise<number>;
    sendMessageToTeam(teamName: string, text: string): Promise<unknown>;
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
    previousHome = process.env.HOME;
    previousHistFile = process.env.HISTFILE;
    previousUserProfile = process.env.USERPROFILE;
    previousDisableAppBootstrap = process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    previousDisableRuntimeBootstrap = process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    usingConnectedClaudeAccount =
      allowConnectedClaudeAccount && !process.env.ANTHROPIC_API_KEY?.trim();
    const connectedHome = os.userInfo().homedir;
    const tempHome = usingConnectedClaudeAccount ? connectedHome : path.join(tempDir, 'home');
    tempClaudeRoot = usingConnectedClaudeAccount
      ? path.join(tempHome, '.claude')
      : path.join(tempDir, '.claude');
    claudeJsonConfigRoot = usingConnectedClaudeAccount ? tempHome : tempClaudeRoot;
    await fs.mkdir(tempHome, { recursive: true });
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    if (usingConnectedClaudeAccount) {
      setClaudeBasePathOverride(null);
    } else {
      setClaudeBasePathOverride(tempClaudeRoot);
    }
    process.env.HOME = tempHome;
    process.env.HISTFILE = '/dev/null';
    process.env.USERPROFILE = tempHome;
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    delete process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    svc = null;
    feature = null;
    controlServer = null;
    teamName = null;
    previousClaudeJsonConfig = undefined;
    previousTeamControlApiJson = undefined;
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
    if (
      usingConnectedClaudeAccount &&
      teamName &&
      process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP !== '1'
    ) {
      await fs.rm(path.join(getTeamsBasePath(), teamName), { recursive: true, force: true });
      await fs.rm(path.join(getTasksBasePath(), teamName), { recursive: true, force: true });
    }
    if (usingConnectedClaudeAccount && previousClaudeJsonConfig !== undefined) {
      await restoreClaudeJsonConfig(claudeJsonConfigRoot, previousClaudeJsonConfig);
    }
    if (previousTeamControlApiJson !== undefined) {
      await restoreNamedConfigFile(
        tempClaudeRoot,
        'team-control-api.json',
        previousTeamControlApiJson
      );
    }
    const warn = vi.mocked(console.warn);
    if (warn.mock) {
      for (let index = warn.mock.calls.length - 1; index >= 0; index -= 1) {
        const rendered = warn.mock.calls[index]?.map((arg) => String(arg)).join(' ') ?? '';
        if (
          rendered.includes('stream-json result: error') ||
          rendered.includes('Failed to resolve login shell env') ||
          rendered.includes('Failed to resolve interactive shell env') ||
          rendered.includes('Failed to parse runtime model list for launch validation') ||
          rendered.includes('Failed to cleanup stale Anthropic team API-key helper material')
        ) {
          warn.mock.calls.splice(index, 1);
        }
      }
    }
    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CLAUDE_TEAM_CONTROL_URL', previousControlUrl);
    restoreEnv('CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableAppBootstrap);
    restoreEnv('CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableRuntimeBootstrap);
    restoreEnv('HOME', previousHome);
    restoreEnv('HISTFILE', previousHistFile);
    restoreEnv('USERPROFILE', previousUserProfile);
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
        throw new FatalWaitError(formatProgressDump(progressEvents));
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

  it('continues remaining Claude work after a settled status-only turn (A/B/C)', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const model = process.env.MEMBER_WORK_SYNC_CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
    const marker = `recovery-live-claude-a-${Date.now()}`;
    const startedAt = Date.now();
    const memberName = 'alice';
    teamName = `member-work-sync-recovery-claude-progress-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    const canaryPath = path.join(projectPath, 'CANARY.txt');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery Claude live progress canary\n\nDisposable sandbox only.\n',
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
    const configReader = new TeamConfigReader();
    const createFeature = (incarnation: string, busy = false) =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: createTestWorkSyncIdentity(incarnation),
        teamsBasePath: getTeamsBasePath(),
        recoveryAllocation: { enabled: true },
        recoveryProtocol: { version: 1 },
        configReader,
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
        queueQuietWindowMs: 500,
        runtimeTurnSettledTargetResolver: {
          resolve: async (event) => {
            if (event.provider !== 'claude') {
              return { ok: false, reason: 'unsupported_provider' };
            }
            if (!teamName) {
              return { ok: false, reason: 'missing_team' };
            }
            const config = await configReader.getConfig(teamName);
            const leadSessionId = config?.leadSessionId?.trim();
            if (!leadSessionId || event.sessionId !== leadSessionId) {
              return { ok: false, reason: 'no_matching_member_session' };
            }
            return { ok: true, teamName, memberName };
          },
        },
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
        ...(busy
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
    activeService.setRuntimeTurnSettledHookSettingsProvider((input) =>
      feature!.buildRuntimeTurnSettledHookSettings(input)
    );
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
    const teamControlApiPath = path.join(tempClaudeRoot, 'team-control-api.json');
    previousTeamControlApiJson = await fs.readFile(teamControlApiPath, 'utf8').catch(() => null);
    await fs.writeFile(
      teamControlApiPath,
      JSON.stringify({ baseUrl: controlServer.baseUrl }, null, 2),
      'utf8'
    );

    const progressEvents: TeamProvisioningProgress[] = [];
    await activeService.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'anthropic',
        model,
        skipPermissions: true,
        prompt: [
          'Keep launch work minimal and wait for the explicit live-test instruction.',
          'Do not inspect tasks or send messages until the next user turn.',
          'Do not write CANARY.txt during launch.',
        ].join(' '),
        members: [
          {
            name: memberName,
            role: 'Developer',
            providerId: 'anthropic',
            model,
          },
        ],
      },
      (progress) => {
        progressEvents.push(progress);
      }
    );

    await waitUntil(async () => {
      const last = progressEvents.at(-1);
      if (last?.state === 'failed') {
        throw new FatalWaitError(formatProgressDump(progressEvents));
      }
      return last?.state === 'ready';
    }, 240_000);
    expect(activeService.isTeamAlive(teamName)).toBe(true);
    await waitUntil(async () => {
      await feature!.drainRuntimeTurnSettledEvents();
      const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
      return metas.some(({ meta }) => meta.teamName === teamName && meta.memberName === memberName);
    }, 30_000).catch(() => undefined);

    const config = await new TeamConfigReader().getConfig(teamName);
    expect(config?.members?.some((member) => member.name === memberName)).toBe(true);
    await seedClaudeShadowReadyMetrics({ teamName, memberName });

    const task = await teamDataService.createTask(teamName, {
      subject: `Write CANARY.txt ${marker}`,
      owner: memberName,
      startImmediately: true,
      prompt: [
        `This is a live recovery canary. Marker: ${marker}.`,
        'Call task_start for this task first.',
        `Then call member_work_sync_status with teamName "${teamName}", memberName "${memberName}", and controlUrl "${controlServer.baseUrl}".`,
        `Then call member_work_sync_report with teamName "${teamName}", memberName "${memberName}", controlUrl "${controlServer.baseUrl}", state "still_working", the exact agendaFingerprint and reportToken, and this task id.`,
        'Do not write CANARY.txt in this first turn.',
        'Do not complete this task.',
        'After the report is accepted, stop.',
      ].join('\n'),
    });
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
    await feature.refreshStatus({ teamName, memberName });
    const inboxRelay = await activeService.relayInboxFileToLiveRecipient(teamName, memberName);
    const leadRelay = await activeService.relayLeadInboxMessages(teamName).catch(() => 0);
    const inboxAfterStart = await readClaudeInboxMessages(teamName, memberName);
    expect(
      inboxAfterStart.length,
      `task-start inbox empty after relay inbox=${inboxRelay.relayed} lead=${leadRelay}`
    ).toBeGreaterThan(0);
    const processedMetasBeforeValidation =
      await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
    const processedMetaPathsBeforeValidation = new Set(
      processedMetasBeforeValidation.map(({ filePath }) => filePath)
    );
    const validationSentAt = Date.now();
    await activeService.sendMessageToTeam(
      teamName,
      [
        `Live recovery canary instruction. Marker: ${marker}.`,
        `Use the board MCP tools as member "${memberName}" for this validation.`,
        `Call task_get for taskId "${task.id}", then task_start.`,
        `Then call member_work_sync_status with teamName "${teamName}", memberName "${memberName}", and controlUrl "${controlServer.baseUrl}".`,
        `Then call member_work_sync_report with teamName "${teamName}", memberName "${memberName}", controlUrl "${controlServer.baseUrl}", state "still_working", the exact agendaFingerprint and reportToken, and taskIds ["${task.id}"].`,
        'Do not write CANARY.txt in this first turn.',
        'Do not complete this task.',
        'After the report is accepted, stop.',
      ].join('\n')
    );

    const busyFeature = createFeature('inc-a', true);
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
        await throwIfClaudeTranscriptApiError({
          claudeRoot: tempClaudeRoot,
          context: 'Claude recovery first turn',
          projectPath,
          sinceMs: startedAt,
        });
        await feature!.replayPendingReports([teamName!]);
        await feature!.drainRuntimeTurnSettledEvents();
        await activeService
          .relayInboxFileToLiveRecipient(teamName!, memberName)
          .catch(() => undefined);
        await activeService.relayLeadInboxMessages(teamName!).catch(() => 0);
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        return status.report?.accepted === true && status.report.state === 'still_working';
      },
      240_000,
      2_000,
      async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
    );
    await waitUntil(
      async () => {
        await throwIfClaudeTranscriptApiError({
          claudeRoot: tempClaudeRoot,
          context: 'Claude recovery first turn settled',
          projectPath,
          sinceMs: startedAt,
        });
        await feature!.drainRuntimeTurnSettledEvents();
        const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
        return metas.some(({ filePath, meta }) => {
          const event = meta.event as Record<string, unknown> | undefined;
          const recordedAt =
            typeof event?.recordedAt === 'string' ? Date.parse(event.recordedAt) : Number.NaN;
          return (
            !processedMetaPathsBeforeValidation.has(filePath) &&
            meta.outcome === 'enqueued' &&
            meta.teamName === teamName &&
            meta.memberName === memberName &&
            event?.provider === 'claude' &&
            Number.isFinite(recordedAt) &&
            recordedAt >= validationSentAt
          );
        });
      },
      180_000,
      2_000,
      async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
    );
    expect((await fs.readFile(canaryPath, 'utf8').catch(() => '')).trim()).not.toMatch(/^done$/i);

    await expireClaudeAcceptedReportLease({ teamName, memberName });
    await feature.refreshStatus({ teamName, memberName });
    const recoveryIdsBeforeAttention = Object.values(
      await readMemberWorkSyncOutboxItems(teamName, memberName)
    )
      .map((item) => item.payload?.workSyncIntentKey)
      .filter((value): value is string => Boolean(value))
      .sort();
    await backdateClaudeRecoveryEpisode({ teamName, memberName });
    const attention = await feature.refreshStatus({ teamName, memberName });
    expect(attention.recoveryHealth?.episodes[0]?.phase).toBe('attention');
    expect(attention.recoveryHealth?.attentionAt).toBeTruthy();
    expect(
      Object.values(await readMemberWorkSyncOutboxItems(teamName, memberName))
        .map((item) => item.payload?.workSyncIntentKey)
        .filter((value): value is string => Boolean(value))
        .sort()
    ).toEqual(recoveryIdsBeforeAttention);

    await waitUntil(
      async () => {
        await feature!.drainRuntimeTurnSettledEvents();
        try {
          await feature!.continueManually({
            teamName: teamName!,
            memberName,
            idempotencyKey: 'live-progress',
          });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/member_busy|status_not_nudgeable/.test(message)) {
            await expireClaudeAcceptedReportLease({ teamName: teamName!, memberName });
            await feature!.refreshStatus({ teamName: teamName!, memberName });
            return false;
          }
          throw error;
        }
      },
      180_000,
      2_000,
      async () => {
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        return [
          await formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName,
            taskId: task.id,
          }),
          `recoveryHealth=${JSON.stringify(status.recoveryHealth ?? null)}`,
          `wouldNudge=${String(status.shadow?.wouldNudge)}`,
          `state=${status.state}`,
        ].join('\n');
      }
    );
    await feature.dispatchDueNudges([teamName]);
    await activeService.relayInboxFileToLiveRecipient(teamName, memberName);
    await activeService.relayLeadInboxMessages(teamName).catch(() => 0);
    await activeService.sendMessageToTeam(
      teamName,
      [
        `Continue remaining recovery work. Marker: ${marker}.`,
        `Use the board MCP tools as member "${memberName}".`,
        'A member_work_sync_nudge for remaining work was already delivered.',
        'Write CANARY.txt in the project root with exactly: done',
        'Do not complete the task unless the file is written.',
        'Then stop.',
      ].join('\n')
    );

    await waitUntil(
      async () => {
        await feature!.dispatchDueNudges([teamName!]);
        await feature!.drainRuntimeTurnSettledEvents();
        await activeService
          .relayInboxFileToLiveRecipient(teamName!, memberName)
          .catch(() => undefined);
        await activeService.relayLeadInboxMessages(teamName!).catch(() => 0);
        const canary = await fs.readFile(canaryPath, 'utf8').catch(() => '');
        return /^\s*done\s*$/i.test(canary);
      },
      240_000,
      2_000,
      async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
    );

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 1_200_000);
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
  await fs.writeFile(configPath, `${JSON.stringify({ ...existing, projects }, null, 2)}\n`, 'utf8');
  return previous;
}

async function restoreClaudeJsonConfig(configDir: string, previous: string | null): Promise<void> {
  await restoreNamedConfigFile(configDir, '.claude.json', previous);
}

async function restoreNamedConfigFile(
  configDir: string,
  fileName: string,
  previous: string | null
): Promise<void> {
  const configPath = path.join(configDir, fileName);
  if (previous === null) {
    await fs.rm(configPath, { force: true });
    return;
  }
  await fs.writeFile(configPath, previous, 'utf8');
}

async function readClaudeInboxMessages(
  teamName: string,
  memberName: string
): Promise<Array<{ messageId?: string; messageKind?: string }>> {
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
  const raw = await fs.readFile(inboxPath, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function claudeMemberStatusPath(teamName: string, memberName: string): string {
  return path.join(
    getTeamsBasePath(),
    teamName,
    'members',
    memberName,
    '.member-work-sync',
    'status.json'
  );
}

async function readClaudeStoredMemberStatus(
  teamName: string,
  memberName: string
): Promise<{
  status?: {
    report?: { expiresAt?: string };
    lastAcceptedReport?: { expiresAt?: string };
    recoveryHealth?: {
      episodes?: Array<{ firstObservedAt?: string; dueAt?: string }>;
      attentionAt?: string;
    };
  };
}> {
  const raw = await fs.readFile(claudeMemberStatusPath(teamName, memberName), 'utf8');
  return JSON.parse(raw) as Awaited<ReturnType<typeof readClaudeStoredMemberStatus>>;
}

async function seedClaudeShadowReadyMetrics(input: {
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
            providerId: 'anthropic',
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
          providerId: 'anthropic',
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function backdateClaudeRecoveryEpisode(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const stored = await readClaudeStoredMemberStatus(input.teamName, input.memberName);
  const health = stored.status?.recoveryHealth;
  const observed = health?.episodes?.[0]?.firstObservedAt;
  if (!observed || !health?.episodes?.[0]) {
    throw new Error('recovery episode missing before attention backdate');
  }
  health.episodes[0].firstObservedAt = new Date(Date.parse(observed) - 21 * 60_000).toISOString();
  health.episodes[0].dueAt = observed;
  await fs.writeFile(
    claudeMemberStatusPath(input.teamName, input.memberName),
    `${JSON.stringify(stored)}\n`,
    'utf8'
  );
}

async function expireClaudeAcceptedReportLease(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const stored = await readClaudeStoredMemberStatus(input.teamName, input.memberName);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  if (stored.status?.report) {
    stored.status.report.expiresAt = expiredAt;
  }
  if (stored.status?.lastAcceptedReport) {
    stored.status.lastAcceptedReport.expiresAt = expiredAt;
  }
  await fs.writeFile(
    claudeMemberStatusPath(input.teamName, input.memberName),
    `${JSON.stringify(stored)}\n`,
    'utf8'
  );
}
