import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberWorkSyncFeature,
  MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
  type MemberWorkSyncFeatureFacade,
} from '../../../../src/features/member-work-sync/main';
import {
  buildCodexTrustedProjectConfigOverrides,
  buildCodexWorkspaceTrustSettingsArgs,
  type WorkspaceTrustArgsOnlyPlanRequest,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustLaunchArgPatch,
  type WorkspaceTrustLaunchArgTargetSurface,
} from '../../../../src/features/workspace-trust/main';
import { CodexBinaryResolver } from '../../../../src/main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { getTeamLaunchStatePath } from '../../../../src/main/services/team/TeamLaunchStateStore';
import { killExternalProcessTree } from '../../../../src/main/utils/externalProcessTreeKill';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import {
  createOwnedWorkSyncIdentity,
  type OwnedWorkSyncIdentity,
} from '../../../features/member-work-sync/helpers/createOwnedWorkSyncIdentity';

import {
  assertExecutable,
  FatalWaitError,
  formatMemberWorkSyncDiagnostics,
  formatProgressDump,
  type MemberWorkSyncLiveControlServer,
  reportWithConflictRetry,
  restoreEnv,
  startMemberWorkSyncControlServer,
  throwIfClaudeTranscriptApiError,
  waitUntil,
} from './memberWorkSyncLiveHarness';

import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';

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
const remainingWorkIt =
  process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' &&
  process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE_REMAINING === '1' &&
  (hasCodexApiKey || allowConnectedChatGptAccount)
    ? it
    : it.skip;

const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/_worktrees/agent_teams_orchestrator-d1/cli-source';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'low' as const;
const TEAMMATE_NAME = 'bob';
const VITEST_HOME_PREFIX = 'agent-teams-vitest-home-';
const LIVE_CODEX_WORKSPACE_TRUST_TARGET_SURFACES: WorkspaceTrustLaunchArgTargetSurface[] = [
  'primary_provider_args',
  'cross_provider_member_args',
  'provider_facts_probe',
  'default_model_probe',
];

async function resolveLiveCodexCliPath(connectedHome: string): Promise<string> {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured) {
    return configured;
  }
  const candidates = [
    path.join(connectedHome, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next well-known Codex binary
    }
  }
  return 'codex';
}

async function createIsolatedConnectedCodexHome(sourceHome: string): Promise<string> {
  const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-codex-home-'));
  await fs.copyFile(path.join(sourceHome, 'auth.json'), path.join(isolatedHome, 'auth.json'));
  const accountsSource = path.join(sourceHome, 'accounts');
  try {
    await fs.access(accountsSource);
  } catch {
    return isolatedHome;
  }
  const accountsDest = path.join(isolatedHome, 'accounts');
  await fs.mkdir(accountsDest, { recursive: true });
  const entries = await fs.readdir(accountsSource, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (
      entry.name === 'registry.json' ||
      entry.name === 'installation_id' ||
      entry.name.endsWith('.auth.json')
    ) {
      await fs.copyFile(path.join(accountsSource, entry.name), path.join(accountsDest, entry.name));
    }
  }
  return isolatedHome;
}

function prependProcessPath(entries: string[]): void {
  const current = process.env.PATH ?? '';
  const merged = [...entries, ...current.split(path.delimiter).filter(Boolean)];
  vi.stubEnv('PATH', [...new Set(merged)].join(path.delimiter));
}

liveDescribe('Member work sync recovery live Codex native teammate', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousControlUrl: string | undefined;
  let previousCodexHome: string | undefined;
  let previousCodexIgnoreUserConfig: string | undefined;
  let previousCodexCliPath: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousPath: string | undefined;
  let previousBootstrapTimeout: string | undefined;
  let previousDebug: string | undefined;
  let previousDevRuntimeRoot: string | undefined;
  let previousHoldConsume: string | undefined;
  let usingConnectedChatGptAccount = false;
  let codexHomeDir = '';
  let ownsCodexHomeDir = false;
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
    setWorkspaceTrustCoordinator(coordinator: WorkspaceTrustCoordinator | null): void;
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
  let owned: OwnedWorkSyncIdentity | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-recovery-codex-teammate-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });

    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    previousCodexHome = process.env.CODEX_HOME;
    previousCodexIgnoreUserConfig = process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG;
    previousCodexCliPath = process.env.CODEX_CLI_PATH;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousPath = process.env.PATH;
    previousBootstrapTimeout = process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS;
    previousDebug = process.env.DEBUG;
    previousDevRuntimeRoot = process.env.CLAUDE_DEV_RUNTIME_ROOT;
    previousHoldConsume = process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH;
    delete process.env.CLAUDE_DEV_RUNTIME_ROOT;
    delete process.env.DEBUG;
    delete process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH;
    usingConnectedChatGptAccount = allowConnectedChatGptAccount && !hasCodexApiKey;

    const connectedHome = os.userInfo().homedir;
    if (usingConnectedChatGptAccount) {
      prependProcessPath([
        path.join(connectedHome, '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]);
      process.env.CODEX_CLI_PATH = await resolveLiveCodexCliPath(connectedHome);
      vi.stubEnv('CODEX_CLI_PATH', process.env.CODEX_CLI_PATH);
      CodexBinaryResolver.clearCache();
      const connectedCodexHome = path.join(connectedHome, '.codex');
      await fs.access(connectedCodexHome);
      codexHomeDir = await createIsolatedConnectedCodexHome(connectedCodexHome);
      ownsCodexHomeDir = true;
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
    process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS?.trim() || '480000';
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS?.trim() || '480000';
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS?.trim() || '480000';
    feature = null;
    controlServer = null;
    svc = null;
    teamName = null;
    codexAccountFeature = null;
    providerConnectionService = null;
    owned = await createOwnedWorkSyncIdentity();
    // TeamBackupService/ConfigManager reset the Claude root; re-apply after identity.
    setClaudeBasePathOverride(tempClaudeRoot);
  }, 120_000);

  afterEach(async () => {
    const warn = vi.mocked(console.warn);
    if (warn.mock) {
      for (let index = warn.mock.calls.length - 1; index >= 0; index -= 1) {
        const rendered = warn.mock.calls[index]?.map((arg) => String(arg)).join(' ') ?? '';
        if (
          rendered.includes('stream-json result: error') ||
          rendered.includes('Failed to cleanup stale Anthropic team API-key helper material') ||
          rendered.includes('Provisioning failed for member-work-sync-recovery-codex-teammate-')
        ) {
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
    await owned?.dispose().catch(() => undefined);
    owned = null;

    if (
      usingConnectedChatGptAccount &&
      teamName &&
      process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP !== '1'
    ) {
      await fs.rm(path.join(getTeamsBasePath(), teamName), { recursive: true, force: true });
      await fs.rm(path.join(getTasksBasePath(), teamName), { recursive: true, force: true });
    }

    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CLAUDE_TEAM_CONTROL_URL', previousControlUrl);
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG', previousCodexIgnoreUserConfig);
    restoreEnv('CODEX_CLI_PATH', previousCodexCliPath);
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
    restoreEnv('PATH', previousPath);
    restoreEnv('CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS', previousBootstrapTimeout);
    restoreEnv('DEBUG', previousDebug);
    restoreEnv('CLAUDE_DEV_RUNTIME_ROOT', previousDevRuntimeRoot);
    restoreEnv('CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH', previousHoldConsume);
    setClaudeBasePathOverride(null);
    if (process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncRecoveryCodexTeammate.live] preserved temp dir: ${tempDir}`);
      console.info(`[MemberWorkSyncRecoveryCodexTeammate.live] preserved CODEX_HOME: ${codexHomeDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (ownsCodexHomeDir) {
        await fs.rm(codexHomeDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  remainingWorkIt(
    'continues remaining Codex native teammate work after a settled status-only turn (A/B/C)',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertExecutable(orchestratorCli!);

      const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
      const marker = `codex-teammate-${Date.now()}`;
      teamName = `member-work-sync-recovery-codex-teammate-${Date.now()}`;
      const projectPath = path.join(tempDir, 'project');
      const canaryPath = path.join(projectPath, 'CANARY.txt');
      const startedAt = Date.now();
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync recovery Codex native teammate remaining-work canary\n',
        'utf8'
      );

      const {
        TeamProvisioningService,
        TeamDataService,
        TeamConfigReader,
        TeamTaskReader,
        TeamKanbanManager,
        TeamMembersMetaStore,
        createCodexAccountFeature,
        ProviderConnectionService,
      } = await loadCodexLiveServices();

      codexAccountFeature = createCodexAccountFeature({
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        configManager: {
          getConfig: () => ({
            providerConnections: {
              codex: { preferredAuthMode: hasCodexApiKey ? 'auto' : ('chatgpt' as const) },
            },
          }),
        },
      });
      providerConnectionService = ProviderConnectionService.getInstance();
      providerConnectionService.setCodexAccountFeature(codexAccountFeature);

      svc = new TeamProvisioningService();
      const activeService = svc;
      setClaudeBasePathOverride(tempClaudeRoot);
      activeService.setWorkspaceTrustCoordinator(createCodexOnlyWorkspaceTrustCoordinator());
      await trustProjectInTempClaudeGlobalConfig({ claudeRoot: tempClaudeRoot, projectPath });
      const teamDataService = new TeamDataService();
      const createFeature = (busy = false) =>
        createMemberWorkSyncFeature({
          lifecycleIdentity: owned!.identity,
          teamsBasePath: getTeamsBasePath(),
          ...MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
          configReader: new TeamConfigReader(),
          taskReader: new TeamTaskReader(),
          kanbanManager: new TeamKanbanManager(),
          membersMetaStore: new TeamMembersMetaStore(),
          isTeamActive: (name) =>
            activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
          listLifecycleActiveTeamNames: async () => [teamName!],
          resolveControlUrl: async () => controlServer?.baseUrl ?? null,
          queueQuietWindowMs: 500,
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
                  { isBusy: async () => ({ busy: true, reason: 'approval_pending' }) },
                ],
              }
            : {}),
        });

      feature = createFeature();
      wireLiveFeature(activeService, feature);
      controlServer = await startMemberWorkSyncControlServer(feature);
      process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
      activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
      await fs.writeFile(
        path.join(tempClaudeRoot, 'team-control-api.json'),
        JSON.stringify({ baseUrl: controlServer.baseUrl }, null, 2),
        'utf8'
      );
      await assertCodexLaunchAllowed(codexAccountFeature);

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
            'Do not write CANARY.txt during launch.',
            'Do not take teammate tasks. Wait for operator instructions.',
          ].join(' '),
          members: [
            {
              name: TEAMMATE_NAME,
              role: 'Developer',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model,
              effort: DEFAULT_EFFORT,
            },
          ],
          extraCliArgs: '--debug',
        },
        (progress) => {
          progressEvents.push(progress);
          console.info(
            `[codex-live] ${progress.state}${progress.message ? ` | ${progress.message}` : ''}${
              progress.error ? ` | ${progress.error}` : ''
            }`
          );
        }
      );

      await waitForCodexTeamReady({
        progressEvents,
        teamName,
        projectPath,
        tempClaudeRoot,
        startedAt,
        context: 'Codex teammate remaining-work launch',
      });
      expect(activeService.isTeamAlive(teamName)).toBe(true);
      await waitUntil(
        async () => (await readMemberRuntimePids(teamName!, TEAMMATE_NAME)).length > 0,
        120_000,
        2_000
      );

      const config = await new TeamConfigReader().getConfig(teamName);
      const leadName =
        config?.members?.find((member) => member.agentType === 'team-lead')?.name?.trim() ||
        'team-lead';
      expect(config?.members?.some((member) => member.name === TEAMMATE_NAME)).toBe(true);
      expect(TEAMMATE_NAME).not.toBe(leadName);
      await seedShadowReadyMetrics({ teamName, memberName: TEAMMATE_NAME });

      const task = await teamDataService.createTask(teamName, {
        subject: `Write CANARY.txt ${marker}`,
        owner: TEAMMATE_NAME,
        startImmediately: false,
        prompt: [
          `This is a live teammate recovery canary. Marker: ${marker}.`,
          'Do not edit files and do not complete this task in the first still_working turn.',
          'Wait for a member_work_sync_nudge, then call the exposed Agent Teams MCP tools directly.',
          'If tool search exposes prefixed names, use mcp__agent-teams__member_work_sync_status and mcp__agent-teams__member_work_sync_report.',
          `Call mcp__agent-teams__member_work_sync_status with teamName "${teamName}", memberName "${TEAMMATE_NAME}", and controlUrl "${controlServer.baseUrl}".`,
          `Then call mcp__agent-teams__member_work_sync_report with teamName "${teamName}", memberName "${TEAMMATE_NAME}", controlUrl "${controlServer.baseUrl}", state "still_working", the exact agendaFingerprint and reportToken, and this task id.`,
          'Do not write CANARY.txt in this first turn.',
          'Only after a later member_work_sync_nudge for remaining work, write CANARY.txt in the project root with exactly: done',
          'After the first report is accepted, stop and wait.',
        ].join('\n'),
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
      await feature.refreshStatus({ teamName, memberName: TEAMMATE_NAME });

      const busyFeature = createFeature(true);
      try {
        await expect(
          busyFeature.continueManually({
            teamName,
            memberName: TEAMMATE_NAME,
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
              memberName: TEAMMATE_NAME,
              idempotencyKey: 'live-first-sync',
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              /member_busy|status_not_nudgeable|payload_conflict|mutation conflict/.test(message)
            ) {
              return false;
            }
            throw error;
          }
          await feature!.dispatchDueNudges([teamName!]);
          await activeService.relayInboxFileToLiveRecipient(teamName!, TEAMMATE_NAME);
          return (await readInboxMessages(teamName!, TEAMMATE_NAME)).some(
            (message) => message.messageKind === 'member_work_sync_nudge'
          );
        },
        60_000,
        2_000
      );

      await waitUntil(
        async () => {
          await pumpCodexTeammate({
            feature: feature!,
            svc: activeService,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            projectPath,
            tempClaudeRoot,
            startedAt,
            context: 'Codex teammate remaining-work first still_working report',
          });
          const teammateStatus = await feature!.getStatus({
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
          });
          return (
            teammateStatus.report?.accepted === true &&
            teammateStatus.report.state === 'still_working'
          );
        },
        240_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            taskId: task.id,
          })
      );

      expect((await fs.readFile(canaryPath, 'utf8').catch(() => '')).trim()).not.toMatch(/^done$/i);

      await waitUntil(
        async () => {
          await pumpCodexTeammate({
            feature: feature!,
            svc: activeService,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            projectPath,
            tempClaudeRoot,
            startedAt,
            context: 'Codex teammate D1 early continuation after settled',
          });
          const inbox = await readInboxMessages(teamName!, TEAMMATE_NAME);
          return inbox.some(
            (message) =>
              message.messageKind === 'member_work_sync_nudge' &&
              typeof message.workSyncIntentKey === 'string' &&
              message.workSyncIntentKey.startsWith('early-continuation:') &&
              Boolean(message.workSyncRuntimeTicketId) &&
              Boolean(message.workSyncRuntimeInstanceId)
          );
        },
        90_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            taskId: task.id,
          })
      );

      await waitUntil(
        async () => {
          await pumpCodexTeammate({
            feature: feature!,
            svc: activeService,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            projectPath,
            tempClaudeRoot,
            startedAt,
            context: 'Codex teammate remaining-work canary',
          });
          const canary = await fs.readFile(canaryPath, 'utf8').catch(() => '');
          return /^\s*done\s*$/i.test(canary);
        },
        420_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            taskId: task.id,
          })
      );

      await feature.prepareTeamDeletion(teamName);
      feature.completeTeamDeletion(teamName);
    },
    1_200_000
  );

  remainingWorkIt(
    'holds Codex consume, survives desktop restart on the same ticket, then Stop before start',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertExecutable(orchestratorCli!);

      const holdPath = path.join(tempDir, 'HOLD_CONSUME');
      process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = holdPath;

      const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
      const marker = `codex-d1-stop-restart-${Date.now()}`;
      teamName = `member-work-sync-recovery-codex-d1-canary-${Date.now()}`;
      const projectPath = path.join(tempDir, 'project');
      const canaryPath = path.join(projectPath, 'CANARY.txt');
      const startedAt = Date.now();
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync D1 Stop-before-consume and desktop-restart canary\n',
        'utf8'
      );

      const {
        TeamProvisioningService,
        TeamDataService,
        TeamConfigReader,
        TeamTaskReader,
        TeamKanbanManager,
        TeamMembersMetaStore,
        createCodexAccountFeature,
        ProviderConnectionService,
      } = await loadCodexLiveServices();

      codexAccountFeature = createCodexAccountFeature({
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        configManager: {
          getConfig: () => ({
            providerConnections: {
              codex: { preferredAuthMode: hasCodexApiKey ? 'auto' : ('chatgpt' as const) },
            },
          }),
        },
      });
      providerConnectionService = ProviderConnectionService.getInstance();
      providerConnectionService.setCodexAccountFeature(codexAccountFeature);

      svc = new TeamProvisioningService();
      const activeService = svc;
      setClaudeBasePathOverride(tempClaudeRoot);
      activeService.setWorkspaceTrustCoordinator(createCodexOnlyWorkspaceTrustCoordinator());
      await trustProjectInTempClaudeGlobalConfig({ claudeRoot: tempClaudeRoot, projectPath });
      const teamDataService = new TeamDataService();
      const createFeature = () =>
        createMemberWorkSyncFeature({
          lifecycleIdentity: owned!.identity,
          teamsBasePath: getTeamsBasePath(),
          ...MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
          configReader: new TeamConfigReader(),
          taskReader: new TeamTaskReader(),
          kanbanManager: new TeamKanbanManager(),
          membersMetaStore: new TeamMembersMetaStore(),
          isTeamActive: (name) =>
            activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
          listLifecycleActiveTeamNames: async () => [teamName!],
          resolveControlUrl: async () => controlServer?.baseUrl ?? null,
          queueQuietWindowMs: 500,
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
        });

      feature = createFeature();
      wireLiveFeature(activeService, feature);
      controlServer = await startMemberWorkSyncControlServer(feature);
      process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
      activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
      await fs.writeFile(
        path.join(tempClaudeRoot, 'team-control-api.json'),
        JSON.stringify({ baseUrl: controlServer.baseUrl }, null, 2),
        'utf8'
      );
      await assertCodexLaunchAllowed(codexAccountFeature);

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
            'Do not write CANARY.txt during launch.',
            'Do not take teammate tasks. Wait for operator instructions.',
          ].join(' '),
          members: [
            {
              name: TEAMMATE_NAME,
              role: 'Developer',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model,
              effort: DEFAULT_EFFORT,
            },
          ],
          extraCliArgs: '--debug',
        },
        (progress) => {
          progressEvents.push(progress);
          console.info(
            `[codex-live] ${progress.state}${progress.message ? ` | ${progress.message}` : ''}${
              progress.error ? ` | ${progress.error}` : ''
            }`
          );
        }
      );

      await waitForCodexTeamReady({
        progressEvents,
        teamName,
        projectPath,
        tempClaudeRoot,
        startedAt,
        context: 'Codex D1 stop/restart launch',
      });
      expect(activeService.isTeamAlive(teamName)).toBe(true);
      await waitUntil(
        async () => (await readMemberRuntimePids(teamName!, TEAMMATE_NAME)).length > 0,
        120_000,
        2_000
      );
      await seedShadowReadyMetrics({ teamName, memberName: TEAMMATE_NAME });
      await fs.writeFile(holdPath, 'hold\n', 'utf8');

      const task = await teamDataService.createTask(teamName, {
        subject: `Keep remaining work open ${marker}`,
        owner: TEAMMATE_NAME,
        startImmediately: false,
        prompt: [
          `This is a live D1 stop/restart canary. Marker: ${marker}.`,
          'Your only actions in this turn are the work-sync tools.',
          `Call mcp__agent-teams__member_work_sync_status with teamName "${teamName}", memberName "${TEAMMATE_NAME}", and controlUrl "${controlServer.baseUrl}".`,
          `Then immediately call mcp__agent-teams__member_work_sync_report with teamName "${teamName}", memberName "${TEAMMATE_NAME}", controlUrl "${controlServer.baseUrl}", state "still_working", the exact agendaFingerprint and reportToken, and this task id.`,
          'Do not write, create, or edit any project files, including CANARY.txt.',
          'Do not complete the task and do not post a done comment.',
          'After the report is accepted, stop and wait.',
        ].join('\n'),
      });
      feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
      await feature.refreshStatus({ teamName, memberName: TEAMMATE_NAME });

      await waitUntil(
        async () => {
          try {
            await feature!.continueManually({
              teamName: teamName!,
              memberName: TEAMMATE_NAME,
              idempotencyKey: 'live-first-sync',
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              /member_busy|status_not_nudgeable|payload_conflict|mutation conflict/.test(message)
            ) {
              return false;
            }
            throw error;
          }
          await feature!.dispatchDueNudges([teamName!]);
          await activeService.relayInboxFileToLiveRecipient(teamName!, TEAMMATE_NAME);
          return (await readInboxMessages(teamName!, TEAMMATE_NAME)).some(
            (message) => message.messageKind === 'member_work_sync_nudge'
          );
        },
        60_000,
        2_000
      );

      await waitUntil(
        async () => {
          await pumpCodexTeammate({
            feature: feature!,
            svc: activeService,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            projectPath,
            tempClaudeRoot,
            startedAt,
            context: 'Codex D1 stop/restart first still_working report',
          });
          const teammateStatus = await feature!.getStatus({
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
          });
          if (
            teammateStatus.report?.accepted === true &&
            teammateStatus.report.state === 'still_working'
          ) {
            return true;
          }
          console.info(
            `[codex-live] waiting first still_working | state=${teammateStatus.state} report=${teammateStatus.report?.state ?? 'none'}`
          );
          return false;
        },
        420_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            taskId: task.id,
          })
      );

      await waitUntil(
        async () => {
          await pumpCodexTeammate({
            feature: feature!,
            svc: activeService,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            projectPath,
            tempClaudeRoot,
            startedAt,
            context: 'Codex D1 ticket before consume',
          });
          const inbox = await readInboxMessages(teamName!, TEAMMATE_NAME);
          const hasTicket = Boolean(findEarlyContinuationTicket(inbox));
          if (!hasTicket) {
            console.info(
              `[codex-live] waiting D1 ticket | hold=${await fs
                .access(holdPath)
                .then(() => 'open')
                .catch(() => 'closed')} rows=${inbox.length}`
            );
          }
          return hasTicket;
        },
        90_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName: TEAMMATE_NAME,
            taskId: task.id,
          })
      );

      const ticketBefore = findEarlyContinuationTicket(
        await readInboxMessages(teamName, TEAMMATE_NAME)
      );
      expect(ticketBefore?.workSyncRuntimeTicketId).toBeTruthy();
      expect(ticketBefore?.read).not.toBe(true);
      expect((await fs.readFile(canaryPath, 'utf8').catch(() => '')).trim()).not.toMatch(/^done$/i);

      await feature.dispose();
      await controlServer.close().catch(() => undefined);
      feature = createFeature();
      controlServer = await startMemberWorkSyncControlServer(feature);
      process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
      activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
      wireLiveFeature(activeService, feature);
      await feature.dispatchDueNudges([teamName]);

      const ticketAfterRestart = findEarlyContinuationTicket(
        await readInboxMessages(teamName, TEAMMATE_NAME)
      );
      expect(ticketAfterRestart?.workSyncRuntimeTicketId).toBe(
        ticketBefore?.workSyncRuntimeTicketId
      );

      const stopped = await feature.stopAutoResume({
        teamName,
        memberName: TEAMMATE_NAME,
        reason: 'user_stop',
      });
      expect(stopped.recoveryHealth?.autoResumeStopLatch).toBeDefined();
      console.info(
        `[codex-live] stop runtimeAdmission=${JSON.stringify(stopped.runtimeAdmission)}`
      );
      await waitUntil(
        async () => {
          const snapshotPath = path.join(
            getTeamsBasePath(),
            teamName!,
            'members',
            TEAMMATE_NAME,
            '.member-work-sync',
            'runtime-admission',
            'snapshot.json'
          );
          const raw = await fs.readFile(snapshotPath, 'utf8').catch(() => '');
          try {
            return (JSON.parse(raw) as { stopped?: boolean }).stopped === true;
          } catch {
            return false;
          }
        },
        30_000,
        500
      );
      await fs.unlink(holdPath).catch(() => undefined);
      delete process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH;

      const stopProbeUntil = Date.now() + 30_000;
      while (Date.now() < stopProbeUntil) {
        await pumpCodexTeammate({
          feature: feature!,
          svc: activeService,
          teamName: teamName!,
          memberName: TEAMMATE_NAME,
          projectPath,
          tempClaudeRoot,
          startedAt,
          context: 'Codex D1 after Stop before consume',
        });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      expect((await fs.readFile(canaryPath, 'utf8').catch(() => '')).trim()).not.toMatch(/^done$/i);
      const afterStop = await feature.getStatus({
        teamName,
        memberName: TEAMMATE_NAME,
      });
      expect(afterStop.recoveryHealth?.autoResumeStopLatch).toBeDefined();

      const evidence = {
        scenario: 'stop-before-consume-and-desktop-restart',
        desktopSha: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
        orchestratorSha: spawnSync('git', ['rev-parse', 'HEAD'], {
          cwd: path.dirname(orchestratorCli!),
          encoding: 'utf8',
        }).stdout.trim(),
        teamName,
        memberName: TEAMMATE_NAME,
        ticketId: ticketBefore?.workSyncRuntimeTicketId,
        runtimeInstanceId: ticketBefore?.workSyncRuntimeInstanceId,
        intentKey: ticketBefore?.workSyncIntentKey,
        settledAt: new Date(startedAt).toISOString(),
        canary: (await fs.readFile(canaryPath, 'utf8').catch(() => '')).trim(),
        runtimeAdmission: afterStop.runtimeAdmission,
        stopLatch: afterStop.recoveryHealth?.autoResumeStopLatch,
      };
      await fs.writeFile(
        path.join(tempDir, 'd1-canary-evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      );
      console.info(`[codex-live] D1 canary evidence: ${JSON.stringify(evidence)}`);

      await feature.prepareTeamDeletion(teamName);
      feature.completeTeamDeletion(teamName);
    },
    1_200_000
  );

  it('keeps the accepted Codex teammate prompt after unknown delivery, feature restart, and PID kill (D02/R06)', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
    teamName = `member-work-sync-recovery-codex-teammate-d02-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery Codex native teammate D02 canary\n',
      'utf8'
    );

    const {
      TeamProvisioningService,
      TeamDataService,
      TeamConfigReader,
      TeamTaskReader,
      TeamKanbanManager,
      TeamMembersMetaStore,
      createCodexAccountFeature,
      ProviderConnectionService,
    } = await loadCodexLiveServices();

    codexAccountFeature = createCodexAccountFeature({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      configManager: {
        getConfig: () => ({
          providerConnections: {
            codex: { preferredAuthMode: hasCodexApiKey ? 'auto' : ('chatgpt' as const) },
          },
        }),
      },
    });
    providerConnectionService = ProviderConnectionService.getInstance();
    providerConnectionService.setCodexAccountFeature(codexAccountFeature);

    svc = new TeamProvisioningService();
    const activeService = svc;
    setClaudeBasePathOverride(tempClaudeRoot);
    activeService.setWorkspaceTrustCoordinator(createCodexOnlyWorkspaceTrustCoordinator());
    await trustProjectInTempClaudeGlobalConfig({ claudeRoot: tempClaudeRoot, projectPath });
    const teamDataService = new TeamDataService();
    const createFeature = () =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: owned!.identity,
        teamsBasePath: getTeamsBasePath(),
        ...MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) =>
          activeService.isTeamAlive(name) || activeService.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => [teamName!],
        resolveControlUrl: async () => controlServer?.baseUrl ?? null,
        queueQuietWindowMs: 500,
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
      });

    feature = createFeature();
    wireLiveFeature(activeService, feature);
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
    await fs.writeFile(
      path.join(tempClaudeRoot, 'team-control-api.json'),
      JSON.stringify({ baseUrl: controlServer.baseUrl }, null, 2),
      'utf8'
    );
    await assertCodexLaunchAllowed(codexAccountFeature);

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
          'Do not take teammate tasks. Wait for operator instructions.',
        ].join(' '),
        members: [
          {
            name: TEAMMATE_NAME,
            role: 'Developer',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model,
            effort: DEFAULT_EFFORT,
          },
        ],
      },
      (progress) => {
        progressEvents.push(progress);
        console.info(
          `[codex-live] ${progress.state}${progress.message ? ` | ${progress.message}` : ''}${
            progress.error ? ` | ${progress.error}` : ''
          }`
        );
      }
    );
    await waitForCodexTeamReady({
      progressEvents,
      teamName,
      projectPath,
      tempClaudeRoot,
      startedAt: Date.now(),
      context: 'Codex teammate D02 launch',
    });
    expect(activeService.isTeamAlive(teamName)).toBe(true);
    await waitUntil(
      async () => (await readMemberRuntimePids(teamName!, TEAMMATE_NAME)).length > 0,
      120_000,
      2_000
    );

    await seedShadowReadyMetrics({ teamName, memberName: TEAMMATE_NAME });
    const task = await teamDataService.createTask(teamName, {
      subject: `Recovery Codex teammate unknown-delivery canary ${Date.now()}`,
      owner: TEAMMATE_NAME,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for operator instructions.',
    });
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    await waitUntil(
      async () => {
        const inbox = await readInboxMessages(teamName!, TEAMMATE_NAME);
        return inbox.some(
          (message) =>
            message.messageKind === 'member_work_sync_nudge' &&
            typeof message.messageId === 'string'
        );
      },
      60_000,
      500
    );
    const firstNudge = [...(await readInboxMessages(teamName, TEAMMATE_NAME))]
      .reverse()
      .find(
        (message) =>
          message.messageKind === 'member_work_sync_nudge' && typeof message.messageId === 'string'
      );
    expect(firstNudge?.messageId).toBeTruthy();
    await activeService.relayInboxFileToLiveRecipient(teamName, TEAMMATE_NAME);

    const messageIdsBefore = await listNudgeMessageIds(teamName, TEAMMATE_NAME);
    const recoveryIdsBefore = await readRecoveryIntentKeys(teamName, TEAMMATE_NAME);
    const proof = await feature.scheduleProofMissingRecovery({
      teamName,
      memberName: TEAMMATE_NAME,
      originalMessageId: firstNudge!.messageId!,
      taskRefs: [{ taskId: task.id, teamName }],
      reason: 'protocol_proof_missing',
    });
    expect(proof.reason === 'scheduled' || proof.reason === 'coalesced_recent').toBe(true);
    await feature.dispatchDueNudges([teamName]);
    expect(await listNudgeMessageIds(teamName, TEAMMATE_NAME)).toEqual(
      expect.arrayContaining(messageIdsBefore)
    );

    await feature.dispose();
    await controlServer.close().catch(() => undefined);
    feature = createFeature();
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
    wireLiveFeature(activeService, feature);
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
    await feature.dispatchDueNudges([teamName]);
    expect(await listNudgeMessageIds(teamName, TEAMMATE_NAME)).toEqual(
      expect.arrayContaining(messageIdsBefore)
    );

    const runtimePids = await readMemberRuntimePids(teamName, TEAMMATE_NAME);
    expect(runtimePids.length).toBeGreaterThan(0);
    for (const pid of runtimePids) {
      killSmokeOwnedRuntimePid(pid, teamName, tempDir);
    }
    await waitUntil(async () => runtimePids.every((pid) => !isPidAlive(pid)), 15_000, 250);
    await feature.dispatchDueNudges([teamName]);
    expect(await listNudgeMessageIds(teamName, TEAMMATE_NAME)).toEqual(
      expect.arrayContaining(messageIdsBefore)
    );
    expect(
      (await readRecoveryIntentKeys(teamName, TEAMMATE_NAME)).filter(
        (key) => !key.startsWith('proof-missing:')
      )
    ).toEqual(recoveryIdsBefore.filter((key) => !key.startsWith('proof-missing:')));

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 420_000);

  it('rejects token T1 after delete/recreate of the same live Codex teammate team name (C21/S12)', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const model = process.env.MEMBER_WORK_SYNC_CODEX_MODEL?.trim() || DEFAULT_MODEL;
    teamName = `member-work-sync-recovery-codex-teammate-recreate-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery Codex native teammate recreate canary\n',
      'utf8'
    );

    const {
      TeamProvisioningService,
      TeamConfigReader,
      TeamTaskReader,
      TeamKanbanManager,
      TeamMembersMetaStore,
      createCodexAccountFeature,
      ProviderConnectionService,
    } = await loadCodexLiveServices();

    codexAccountFeature = createCodexAccountFeature({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      configManager: {
        getConfig: () => ({
          providerConnections: {
            codex: { preferredAuthMode: hasCodexApiKey ? 'auto' : ('chatgpt' as const) },
          },
        }),
      },
    });
    providerConnectionService = ProviderConnectionService.getInstance();
    providerConnectionService.setCodexAccountFeature(codexAccountFeature);

    svc = new TeamProvisioningService();
    const activeService = svc;
    setClaudeBasePathOverride(tempClaudeRoot);
    activeService.setWorkspaceTrustCoordinator(createCodexOnlyWorkspaceTrustCoordinator());
    await trustProjectInTempClaudeGlobalConfig({ claudeRoot: tempClaudeRoot, projectPath });
    const lifecycleIdentity = owned!.identity;
    const createFeature = () =>
      createMemberWorkSyncFeature({
        lifecycleIdentity,
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
        queueQuietWindowMs: 1,
      });

    feature = createFeature();
    wireLiveFeature(activeService, feature);
    controlServer = await startMemberWorkSyncControlServer(feature);
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    activeService.setControlApiBaseUrlResolver(async () => controlServer?.baseUrl ?? null);
    await fs.writeFile(
      path.join(tempClaudeRoot, 'team-control-api.json'),
      JSON.stringify({ baseUrl: controlServer.baseUrl }, null, 2),
      'utf8'
    );
    await assertCodexLaunchAllowed(codexAccountFeature);

    const launchTeam = async (context: string) => {
      const progressEvents: TeamProvisioningProgress[] = [];
      await activeService.createTeam(
        {
          teamName: teamName!,
          cwd: projectPath,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model,
          effort: DEFAULT_EFFORT,
          fastMode: 'off',
          skipPermissions: true,
          prompt: [
            'Keep launch work minimal.',
            'Do not take teammate tasks. Wait for operator instructions.',
          ].join(' '),
          members: [
            {
              name: TEAMMATE_NAME,
              role: 'Developer',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model,
              effort: DEFAULT_EFFORT,
            },
          ],
        },
        (progress) => {
          progressEvents.push(progress);
          console.info(
            `[codex-live] ${progress.state}${progress.message ? ` | ${progress.message}` : ''}${
              progress.error ? ` | ${progress.error}` : ''
            }`
          );
        }
      );
      await waitForCodexTeamReady({
        progressEvents,
        teamName: teamName!,
        projectPath,
        tempClaudeRoot,
        startedAt: Date.now(),
        context,
      });
      await waitUntil(
        async () => (await readMemberRuntimePids(teamName!, TEAMMATE_NAME)).length > 0,
        120_000,
        2_000
      );
    };

    await launchTeam('Codex teammate C21 first launch');
    expect(activeService.isTeamAlive(teamName)).toBe(true);

    const firstStatus = await refreshStatusWithToken({
      feature,
      teamName,
      memberName: TEAMMATE_NAME,
    });
    const firstIdentity = await lifecycleIdentity.readCurrent(teamName);
    expect(firstIdentity.status).toBe('identified');
    if (firstIdentity.status !== 'identified') {
      throw new Error('expected identified lifecycle marker before recreate');
    }
    const firstToken = firstStatus.reportToken;
    const firstFingerprint = firstStatus.agenda.fingerprint;
    await waitUntil(
      async () => {
        await feature!.stopAutoResume({
          teamName: teamName!,
          memberName: TEAMMATE_NAME,
          reason: 'user_stop',
        });
        return true;
      },
      15_000,
      250
    );

    await activeService.stopTeam(teamName).catch(() => undefined);
    await feature.prepareTeamDeletion(teamName, firstIdentity.identityId);
    feature.completeTeamDeletion(teamName);
    await fs.rm(path.join(getTeamsBasePath(), teamName), { recursive: true, force: true });
    feature.resumeTeam(teamName);

    await launchTeam('Codex teammate C21 recreate launch');
    feature.noteTeamChange({ type: 'config', teamName, detail: 'config.json' });
    const recreated = await refreshStatusWithToken({
      feature,
      teamName,
      memberName: TEAMMATE_NAME,
    });
    const secondIdentity = await lifecycleIdentity.readCurrent(teamName);
    expect(secondIdentity.status).toBe('identified');
    if (secondIdentity.status !== 'identified') {
      throw new Error('expected identified lifecycle marker after recreate');
    }
    expect(secondIdentity.identityId).not.toBe(firstIdentity.identityId);
    expect(recreated.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
    expect(recreated.recoveryHealth?.unresolvedIntentId).toBeUndefined();
    expect(recreated.agenda.fingerprint).toBe(firstFingerprint);
    const secondToken = recreated.reportToken;
    if (!secondToken) {
      throw new Error('expected report token after recreate');
    }
    expect(secondToken).not.toBe(firstToken);
    await expect(
      reportWithConflictRetry(feature, {
        teamName,
        memberName: TEAMMATE_NAME,
        state: 'caught_up',
        agendaFingerprint: firstFingerprint,
        reportToken: firstToken,
        source: 'test',
      })
    ).resolves.toMatchObject({
      accepted: false,
      code: 'invalid_report_token',
    });
    const t2Status = await refreshStatusWithToken({
      feature,
      teamName,
      memberName: TEAMMATE_NAME,
    });
    const t2Token = t2Status.reportToken;
    if (!t2Token) {
      throw new Error('expected report token after T1 reject');
    }
    const t2HasWork = t2Status.agenda.items.length > 0;
    await expect(
      reportWithConflictRetry(feature, {
        teamName,
        memberName: TEAMMATE_NAME,
        state: t2HasWork ? 'still_working' : 'caught_up',
        agendaFingerprint: t2Status.agenda.fingerprint,
        reportToken: t2Token,
        source: 'test',
        ...(t2HasWork
          ? { taskIds: t2Status.agenda.items.map((item) => item.taskId) }
          : {}),
      })
    ).resolves.toMatchObject({
      accepted: true,
    });

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 720_000);
});

async function refreshStatusWithToken(input: {
  feature: MemberWorkSyncFeatureFacade;
  teamName: string;
  memberName: string;
}): Promise<Awaited<ReturnType<MemberWorkSyncFeatureFacade['refreshStatus']>>> {
  const latest: { status?: Awaited<ReturnType<MemberWorkSyncFeatureFacade['refreshStatus']>> } = {};
  await waitUntil(
    async () => {
      latest.status = await input.feature.refreshStatus({
        teamName: input.teamName,
        memberName: input.memberName,
      });
      return Boolean(latest.status.reportToken);
    },
    30_000,
    250
  );
  if (!latest.status?.reportToken) {
    throw new Error('expected report token after refresh');
  }
  return latest.status;
}

async function loadCodexLiveServices() {
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
  return {
    TeamProvisioningService,
    TeamDataService,
    TeamConfigReader,
    TeamTaskReader,
    TeamKanbanManager,
    TeamMembersMetaStore,
    createCodexAccountFeature,
    ProviderConnectionService,
  };
}

function wireLiveFeature(
  svc: {
    setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void;
    setRuntimeTurnSettledEnvironmentProvider(
      provider:
        | ((input: {
            provider: 'claude' | 'codex' | 'opencode';
          }) => Promise<Record<string, string> | null>)
        | null
    ): void;
  },
  nextFeature: MemberWorkSyncFeatureFacade
): void {
  svc.setTeamChangeEmitter((event: TeamChangeEvent) => nextFeature.noteTeamChange(event));
  svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
    nextFeature.buildRuntimeTurnSettledEnvironment(input)
  );
}

async function assertCodexLaunchAllowed(feature: {
  getSnapshot(): Promise<unknown>;
}): Promise<void> {
  const accountSnapshot = (await feature.getSnapshot()) as {
    launchAllowed?: boolean;
    launchIssueMessage?: string | null;
  };
  if (!accountSnapshot.launchAllowed) {
    throw new Error(
      accountSnapshot.launchIssueMessage ?? 'Codex account snapshot is not launchable.'
    );
  }
}

async function waitForCodexTeamReady(input: {
  progressEvents: TeamProvisioningProgress[];
  teamName: string;
  projectPath: string;
  tempClaudeRoot: string;
  startedAt: number;
  context: string;
}): Promise<void> {
  const timeoutMs = Number(process.env.MEMBER_WORK_SYNC_CODEX_READY_TIMEOUT_MS?.trim()) || 480_000;
  await waitUntil(
    async () => {
      const last = input.progressEvents.at(-1);
      if (last?.state === 'failed') {
        throw new FatalWaitError(formatProgressDump(input.progressEvents));
      }
      const dump = formatProgressDump(input.progressEvents);
      if (/usage limit/i.test(dump)) {
        throw new FatalWaitError(dump);
      }
      await throwIfTranscriptApiError(input);
      const fatalRuntimeMessage = await readFatalRuntimeMessage(input.teamName);
      if (fatalRuntimeMessage) {
        throw new FatalWaitError(fatalRuntimeMessage);
      }
      return last?.state === 'ready';
    },
    timeoutMs,
    2_000,
    () => formatCodexLaunchDiagnostics(input)
  );
}

async function formatCodexLaunchDiagnostics(input: {
  progressEvents: TeamProvisioningProgress[];
  teamName: string;
}): Promise<string> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const launchStatePath = getTeamLaunchStatePath(input.teamName);
  const bootstrapPath = path.join(teamDir, 'bootstrap-state.json');
  const debugDir = path.join(getTeamsBasePath(), '..', 'debug');
  const [entries, launchState, bootstrapState, nestedFiles, debugFiles] = await Promise.all([
    fs.readdir(teamDir).catch(() => [] as string[]),
    fs.readFile(launchStatePath, 'utf8').catch(() => ''),
    fs.readFile(bootstrapPath, 'utf8').catch(() => ''),
    fs
      .readdir(teamDir, { recursive: true })
      .then((names) => names.slice(0, 80).join(','))
      .catch(() => ''),
    fs
      .readdir(debugDir)
      .then(async (names) => {
        const files = names.filter((name) => name.endsWith('.txt')).slice(-2);
        const bodies = await Promise.all(
          files.map(async (name) => {
            const raw = await fs.readFile(path.join(debugDir, name), 'utf8').catch(() => '');
            return `--- ${name} ---\n${raw.slice(-4000)}`;
          })
        );
        return bodies.join('\n');
      })
      .catch(() => ''),
  ]);
  return [
    `teamDir=${teamDir}`,
    `entries=${entries.join(',')}`,
    `nested=${nestedFiles || '(none)'}`,
    `codexHome=${process.env.CODEX_HOME ?? '(unset)'}`,
    `cliPath=${process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH ?? '(unset)'}`,
    'progress:',
    formatProgressDump(input.progressEvents) || '(none)',
    'launch-state:',
    launchState.slice(0, 4000) || '(missing)',
    'bootstrap-state:',
    bootstrapState.slice(0, 4000) || '(missing)',
    'cli-debug:',
    debugFiles || '(none)',
  ].join('\n');
}

async function throwIfTranscriptApiError(input: {
  tempClaudeRoot: string;
  projectPath: string;
  startedAt: number;
  context: string;
}): Promise<void> {
  const claudeRoots = [input.tempClaudeRoot];
  const homeClaudeRoot = process.env.HOME?.trim()
    ? path.join(process.env.HOME.trim(), '.claude')
    : null;
  if (homeClaudeRoot && path.resolve(homeClaudeRoot) !== path.resolve(input.tempClaudeRoot)) {
    claudeRoots.push(homeClaudeRoot);
  }
  for (const claudeRoot of claudeRoots) {
    await throwIfClaudeTranscriptApiError({
      claudeRoot,
      context: input.context,
      projectPath: input.projectPath,
      sinceMs: input.startedAt,
    });
  }
}

async function pumpCodexTeammate(input: {
  feature: MemberWorkSyncFeatureFacade;
  svc: {
    relayInboxFileToLiveRecipient(
      teamName: string,
      inboxName: string
    ): Promise<{ relayed: number }>;
  };
  teamName: string;
  memberName: string;
  projectPath: string;
  tempClaudeRoot: string;
  startedAt: number;
  context: string;
}): Promise<void> {
  const fatalRuntimeMessage = await readFatalRuntimeMessage(input.teamName);
  if (fatalRuntimeMessage) {
    throw new FatalWaitError(fatalRuntimeMessage);
  }
  await throwIfTranscriptApiError(input);
  await input.feature.dispatchDueNudges([input.teamName]);
  await input.feature.replayPendingReports([input.teamName]);
  await input.feature.drainRuntimeTurnSettledEvents();
  await input.svc
    .relayInboxFileToLiveRecipient(input.teamName, input.memberName)
    .catch(() => undefined);
}

async function readInboxMessages(
  teamName: string,
  memberName: string
): Promise<
  Array<{
    messageId?: string;
    messageKind?: string;
    workSyncIntentKey?: string;
    workSyncRuntimeTicketId?: string;
    workSyncRuntimeInstanceId?: string;
    read?: boolean;
  }>
> {
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
  const raw = await fs.readFile(inboxPath, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function findEarlyContinuationTicket(
  inbox: Array<{
    messageKind?: string;
    workSyncIntentKey?: string;
    workSyncRuntimeTicketId?: string;
    workSyncRuntimeInstanceId?: string;
    read?: boolean;
  }>
) {
  return [...inbox].reverse().find(
    (message) =>
      typeof message.workSyncIntentKey === 'string' &&
      message.workSyncIntentKey.startsWith('early-continuation:') &&
      Boolean(message.workSyncRuntimeTicketId)
  );
}

async function listNudgeMessageIds(teamName: string, memberName: string): Promise<string[]> {
  return (await readInboxMessages(teamName, memberName))
    .filter((message) => message.messageKind === 'member_work_sync_nudge')
    .map((message) => message.messageId)
    .filter((value): value is string => Boolean(value))
    .sort();
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
  status?: {
    report?: { expiresAt?: string };
    lastAcceptedReport?: { expiresAt?: string };
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

async function expireAcceptedReportLease(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const stored = await readStoredMemberStatus(input.teamName, input.memberName);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  if (stored.status?.report) {
    stored.status.report.expiresAt = expiredAt;
  }
  if (stored.status?.lastAcceptedReport) {
    stored.status.lastAcceptedReport.expiresAt = expiredAt;
  }
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
      text.includes('Codex native turn failed:') ||
      text.includes('requires an active `codex login`')
    ) {
      return text;
    }
  }
  return null;
}

async function readMemberRuntimePids(teamName: string, memberName: string): Promise<number[]> {
  const pids = new Set<number>();
  const addPid = (pid: unknown) => {
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
      pids.add(pid);
    }
  };
  const bootstrapPath = path.join(getTeamsBasePath(), teamName, 'bootstrap-state.json');
  const bootstrapRaw = await fs.readFile(bootstrapPath, 'utf8').catch(() => '');
  if (bootstrapRaw) {
    const bootstrap = JSON.parse(bootstrapRaw) as {
      members?: Array<{ name?: string; runtimePid?: number }>;
    };
    for (const member of bootstrap.members ?? []) {
      if (member.name === memberName) {
        addPid(member.runtimePid);
      }
    }
  }
  const launchRaw = await fs.readFile(getTeamLaunchStatePath(teamName), 'utf8').catch(() => '');
  if (launchRaw) {
    const snapshot = JSON.parse(launchRaw) as PersistedTeamLaunchSnapshot;
    const member = snapshot.members?.[memberName];
    addPid(member?.runtimePid);
  }
  return [...pids];
}

function killSmokeOwnedRuntimePid(pid: number, teamName: string, tempDir: string): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Refusing pid ${pid}`);
  }
  if (!isPidAlive(pid)) {
    return;
  }
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  }).stdout.trim();
  const allowed = [teamName, tempDir, 'codex', 'node'];
  if (command && !allowed.some((token) => command.includes(token))) {
    throw new Error(`Refusing to kill pid ${pid}: ${command}`);
  }
  const result = killExternalProcessTree(pid, { signal: 'SIGKILL' });
  if (result.killed.length === 0 && isPidAlive(pid)) {
    throw new Error(`Failed to kill pid ${pid}: ${result.diagnostics.join('; ')}`);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function trustProjectInTempClaudeGlobalConfig(input: {
  claudeRoot: string;
  projectPath: string;
}): Promise<void> {
  const projectRealPath = await fs.realpath(input.projectPath).catch(() => input.projectPath);
  const projects = Object.fromEntries(
    [...new Set([input.projectPath, projectRealPath])].map((projectPath) => [
      projectPath,
      {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        projectOnboardingSeenCount: 0,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
        hasTrustDialogAccepted: true,
      },
    ])
  );
  const configPaths = [path.join(input.claudeRoot, '.claude.json')];
  const homeDir = process.env.HOME?.trim();
  if (homeDir && path.basename(homeDir).startsWith(VITEST_HOME_PREFIX)) {
    configPaths.push(path.join(homeDir, '.claude.json'));
  }
  for (const configPath of configPaths) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf8');
  }
}

function createCodexOnlyWorkspaceTrustCoordinator(): WorkspaceTrustCoordinator {
  return {
    async planArgsOnly(request) {
      return { launchArgPatches: buildLiveCodexWorkspaceTrustPatches(request) };
    },
    async planFull(request) {
      return {
        providers: request.providers,
        workspaces: request.workspaces,
        launchArgPatches: buildLiveCodexWorkspaceTrustPatches(request),
      };
    },
    async execute(plan) {
      return {
        id: 'member-work-sync-recovery-codex-live-workspace-trust',
        provider: 'claude',
        status: 'skipped',
        workspaceIds: plan.workspaces.map((workspace) => workspace.id),
        evidence: ['live test injects Codex native trusted-project settings'],
      };
    },
  };
}

function buildLiveCodexWorkspaceTrustPatches(
  request: WorkspaceTrustArgsOnlyPlanRequest
): WorkspaceTrustLaunchArgPatch[] {
  if (
    !request.featureFlags.enabled ||
    !request.featureFlags.codexArgs ||
    !request.providers.includes('codex')
  ) {
    return [];
  }
  const configKeys = request.workspaces.flatMap((workspace) => [
    workspace.configKeyCwd,
    workspace.realCwd,
    ...(workspace.gitRootConfigKey ? [workspace.gitRootConfigKey] : []),
  ]);
  const overrides = buildCodexTrustedProjectConfigOverrides(configKeys);
  const args = buildCodexWorkspaceTrustSettingsArgs(overrides);
  if (args.length === 0) {
    return [];
  }
  const workspaceIds = request.workspaces.map((workspace) => workspace.id);
  return (request.targetSurfaces ?? LIVE_CODEX_WORKSPACE_TRUST_TARGET_SURFACES).map((surface) => ({
    id: `member-work-sync-recovery-codex-live-workspace-trust:${surface}`,
    owner: 'workspace-trust',
    targetProvider: 'codex',
    targetSurface: surface,
    dialect: 'claude-codex-runtime-settings',
    args,
    dedupeKey: `member-work-sync-recovery-codex-live-workspace-trust:${surface}:${overrides.join('|')}`,
    sourceWorkspaceIds: workspaceIds,
    reason: 'Trust the live e2e project for Codex native headless teammate startup.',
  }));
}
