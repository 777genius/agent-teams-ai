// @vitest-environment node
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { userInfo } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamRosterMutationFeature,
  registerTeamRosterMutationIpc,
  removeTeamRosterMutationIpc,
} from '../../../../src/features/team-roster-mutations/main';
import { createWorkspaceTrustCoordinator } from '../../../../src/features/workspace-trust/main';
import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../../src/main/ipc/teams';
import {
  bindTeamMemberLifecycleApi,
  bindTeamMessagingApi,
  bindTeamRuntimeApi,
} from '../../../../src/main/services/team/contracts/TeamProvisioningApis';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  getClaudeBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { killProcessByPid } from '../../../../src/main/utils/processKill';
import { TEAM_REMOVE_MEMBER } from '../../../../src/preload/constants/ipcChannels';
import { createLogger } from '../../../../src/shared/utils/logger';

import type { CodexAccountSnapshotDto } from '../../../../src/features/codex-account/contracts';
import type {
  IpcResult,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

vi.mock('../../../../src/main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({ addTeamNotification: vi.fn(async () => undefined) }),
  },
}));

const liveDescribe = process.env.AGENT_DELETION_258_LIVE === '1' ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const MODEL = process.env.AGENT_DELETION_258_CODEX_MODEL?.trim() || 'gpt-5.6-sol';
const TEAMMATES = ['alice', 'bob'] as const;
const REMOVED = TEAMMATES[0];
const SURVIVOR = TEAMMATES[1];

interface RegisteredHandler {
  (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> | unknown;
}

liveDescribe('issue #258 member deletion live e2e', () => {
  let ownedRoot = '';
  let projectPath = '';
  let claudeRoot = '';
  let teamName = '';
  let activeService: TeamProvisioningService | null = null;
  let lastSnapshot: TeamAgentRuntimeSnapshot | null = null;
  let ipcMain: IpcMain | null = null;
  let disposeCodexLaunchFixture: (() => Promise<void>) | null = null;
  const previousEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    if (activeService && teamName) {
      lastSnapshot = await activeService.getTeamAgentRuntimeSnapshot(teamName).catch(() => null);
      await activeService.stopTeam(teamName).catch(() => undefined);
    }
    terminateOwnedProcesses(lastSnapshot);
    if (ipcMain) {
      removeTeamRosterMutationIpc(ipcMain);
      removeTeamHandlers(ipcMain);
    }
    await disposeCodexLaunchFixture?.().catch(() => undefined);
    setClaudeBasePathOverride(null);
    for (const [name, value] of previousEnv) restoreEnv(name, value);
    if (ownedRoot) await fs.rm(ownedRoot, { recursive: true, force: true });
  }, 180_000);

  it(
    'keeps removals tombstoned and relaunches lead-only after every teammate is removed',
    async () => {
      const allowedRoot = requireExplicitE2eRoot();
      ownedRoot = path.join(allowedRoot, `issue-258-${process.pid}-${Date.now()}`);
      assertStrictDescendant(allowedRoot, ownedRoot);
      projectPath = path.join(ownedRoot, 'project');
      claudeRoot = path.join(ownedRoot, '.claude');
      teamName = `agent-deletion-258-${process.pid}-${Date.now()}`;
      await fs.mkdir(projectPath, { recursive: true });
      await fs.mkdir(claudeRoot, { recursive: true });
      await fs.writeFile(path.join(projectPath, 'README.md'), '# Issue 258 live fixture\n');
      await execFileAsync('git', ['init', '--quiet'], { cwd: projectPath });
      await execFileAsync('git', ['add', 'README.md'], { cwd: projectPath });
      await execFileAsync(
        'git',
        [
          '-c',
          'user.name=Issue 258 Test',
          '-c',
          'user.email=issue258@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ],
        { cwd: projectPath }
      );

      configureLiveEnvironment(claudeRoot, previousEnv);
      setClaudeBasePathOverride(claudeRoot);
      disposeCodexLaunchFixture = await installCodexLaunchFixture();

      activeService = createProvisioningService();
      const progress: TeamProvisioningProgress[] = [];
      let sawRevokedToken = false;
      await activeService.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: MODEL,
          effort: 'low',
          fastMode: 'off',
          skipPermissions: false,
          prompt: 'Remain idle after bootstrap until assigned a task.',
          members: TEAMMATES.map((name) => ({
            name,
            role: name === SURVIVOR ? 'Survivor' : 'Removal target',
            providerId: 'codex' as const,
            providerBackendId: 'codex-native' as const,
            model: MODEL,
            effort: 'low' as const,
            fastMode: 'off' as const,
          })),
        },
        (event) => progress.push(event)
      );
      await waitForReady(activeService, teamName, [...TEAMMATES], progress);
      sawRevokedToken = (await waitForLaunchOutcome(progress, TEAMMATES)) || sawRevokedToken;
      const beforeRemoval = await activeService.getTeamAgentRuntimeSnapshot(teamName);
      const removedRuntimePid =
        beforeRemoval.members[REMOVED]?.runtimePid ?? beforeRemoval.members[REMOVED]?.pid;
      expect(removedRuntimePid).toEqual(expect.any(Number));
      expect(removedRuntimePid).toBeGreaterThan(0);
      expect(isProcessGone(removedRuntimePid!)).toBe(false);

      const handlers = new Map<string, RegisteredHandler>();
      ipcMain = createIpcMainHarness(handlers);
      registerTeamHandlers(ipcMain);
      const bindCurrentTeamHandlers = (): void => {
        if (!activeService || !ipcMain) throw new Error('E2E team handlers are unavailable');
        const teamDataService = new TeamDataService();
        const teamRuntimeApi = bindTeamRuntimeApi(activeService);
        initializeTeamHandlers(teamDataService, teamRuntimeApi);
        removeTeamRosterMutationIpc(ipcMain);
        registerTeamRosterMutationIpc(
          ipcMain,
          createTeamRosterMutationFeature({
            repository: teamDataService,
            runtime: teamRuntimeApi,
            lifecycle: bindTeamMemberLifecycleApi(activeService),
            messaging: bindTeamMessagingApi(activeService),
            logger: createLogger('E2E:AgentDeletion258'),
          })
        );
      };
      bindCurrentTeamHandlers();
      const remove = (...args: unknown[]): Promise<unknown> | unknown => {
        const handler = handlers.get(TEAM_REMOVE_MEMBER);
        if (!handler) throw new Error('TEAM_REMOVE_MEMBER IPC handler was not registered');
        return handler({} as IpcMainInvokeEvent, ...args);
      };
      const removal = (await remove(teamName, REMOVED)) as IpcResult<void>;
      expect(removal).toEqual({ success: true, data: undefined });
      await waitUntil(
        async () => {
          const snapshot = await activeService!.getTeamAgentRuntimeSnapshot(teamName);
          return isProcessGone(removedRuntimePid!) && snapshot.members[SURVIVOR]?.alive === true;
        },
        120_000,
        'removed OS process exit while survivor stays alive'
      );
      expect(await remove(teamName, REMOVED)).toMatchObject({
        success: true,
      });
      await proveSurvivorOperational(activeService, teamName);

      for (let restart = 1; restart <= 2; restart += 1) {
        lastSnapshot = await activeService.getTeamAgentRuntimeSnapshot(teamName);
        await activeService.stopTeam(teamName);
        terminateOwnedProcesses(lastSnapshot);
        activeService = createProvisioningService();
        bindCurrentTeamHandlers();
        const relaunchProgress: TeamProvisioningProgress[] = [];
        await activeService.launchTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: MODEL,
            effort: 'low',
            fastMode: 'off',
            skipPermissions: false,
            clearContext: true,
          },
          (event) => relaunchProgress.push(event)
        );
        await waitForReady(activeService, teamName, [SURVIVOR], relaunchProgress);
        sawRevokedToken =
          (await waitForLaunchOutcome(relaunchProgress, [SURVIVOR])) || sawRevokedToken;
        const statuses = await activeService.getMemberSpawnStatuses(teamName);
        const snapshot = await activeService.getTeamAgentRuntimeSnapshot(teamName);
        expect(statuses.statuses[REMOVED]).toBeUndefined();
        expect(snapshot.members[REMOVED]?.alive).not.toBe(true);
        expect(snapshot.members[SURVIVOR]?.alive).toBe(true);
        await assertTombstone(teamName);
        if (restart === 2) await proveSurvivorOperational(activeService, teamName);
      }

      const beforeSurvivorRemoval = await activeService.getTeamAgentRuntimeSnapshot(teamName);
      const survivorRuntimePid =
        beforeSurvivorRemoval.members[SURVIVOR]?.runtimePid ??
        beforeSurvivorRemoval.members[SURVIVOR]?.pid;
      expect(survivorRuntimePid).toEqual(expect.any(Number));
      expect(survivorRuntimePid).toBeGreaterThan(0);
      expect(isProcessGone(survivorRuntimePid!)).toBe(false);

      const survivorRemoval = (await remove(teamName, SURVIVOR)) as IpcResult<void>;
      expect(survivorRemoval).toEqual({ success: true, data: undefined });
      await waitUntil(
        async () => {
          const snapshot = await activeService!.getTeamAgentRuntimeSnapshot(teamName);
          return isProcessGone(survivorRuntimePid!) && snapshot.members[SURVIVOR]?.alive !== true;
        },
        120_000,
        'remaining teammate OS process exit'
      );
      await assertAllRemovedMembersPersisted(claudeRoot, teamName);

      lastSnapshot = await activeService.getTeamAgentRuntimeSnapshot(teamName);
      await activeService.stopTeam(teamName);
      terminateOwnedProcesses(lastSnapshot);
      activeService = createProvisioningService();
      initializeTeamHandlers(new TeamDataService(), bindTeamRuntimeApi(activeService));
      const soloProgress: TeamProvisioningProgress[] = [];
      await activeService.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: MODEL,
          effort: 'low',
          fastMode: 'off',
          skipPermissions: false,
          clearContext: true,
        },
        (event) => soloProgress.push(event)
      );
      sawRevokedToken = (await waitForLaunchOutcome(soloProgress, [])) || sawRevokedToken;

      const finalStatuses = await activeService.getMemberSpawnStatuses(teamName);
      const finalSnapshot = await activeService.getTeamAgentRuntimeSnapshot(teamName);
      for (const memberName of TEAMMATES) {
        expect(finalStatuses.statuses[memberName]).toBeUndefined();
        expect(finalSnapshot.members[memberName]?.alive).not.toBe(true);
      }
      await assertAllRemovedMembersPersisted(claudeRoot, teamName);
      if (sawRevokedToken) assertAndClearRevokedTokenWarnings();
    },
    30 * 60_000
  );
});

function requireExplicitE2eRoot(): string {
  const raw = process.env.AGENT_DELETION_258_E2E_ROOT?.trim();
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error('AGENT_DELETION_258_E2E_ROOT must be an explicit absolute test-only path');
  }
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(process.cwd())) {
    throw new Error('AGENT_DELETION_258_E2E_ROOT must not be a filesystem or workspace root');
  }
  return resolved;
}

function assertStrictDescendant(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing non-descendant E2E path: ${candidate}`);
  }
}

function createProvisioningService(): TeamProvisioningService {
  const service = new TeamProvisioningService();
  service.setWorkspaceTrustCoordinator(
    createWorkspaceTrustCoordinator({
      claudeConfigDir: () => getClaudeBasePath(),
      globalConfigFilePath: () => path.join(getClaudeBasePath(), '.claude.json'),
    })
  );
  return service;
}

async function waitForReady(
  service: TeamProvisioningService,
  teamName: string,
  expected: string[],
  progress: TeamProvisioningProgress[]
): Promise<void> {
  await waitUntil(
    async () => {
      const failure = progress.findLast((event) => event.state === 'failed');
      if (failure) throw new Error(`Launch failed: ${JSON.stringify(failure)}`);
      const statuses = await service.getMemberSpawnStatuses(teamName);
      return expected.every((name) => {
        const member = statuses.statuses[name];
        return (
          member?.status === 'online' &&
          member.launchState === 'confirmed_alive' &&
          member.bootstrapConfirmed === true
        );
      });
    },
    360_000,
    `bootstrap confirmation for ${expected.join(', ')}`
  );
}

async function proveSurvivorOperational(
  service: TeamProvisioningService,
  teamName: string
): Promise<void> {
  const marker = `issue-258-survivor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await new TeamInboxWriter().sendMessage(teamName, {
    member: SURVIVOR,
    from: 'team-lead',
    to: SURVIVOR,
    text: marker,
  });
  await service.relayInboxFileToLiveRecipient(teamName, SURVIVOR);
  await waitUntil(
    async () => {
      const delivered = (await new TeamInboxReader().getMessagesFor(teamName, SURVIVOR)).find(
        (message) => message.text === marker && message.read === true
      );
      const snapshot = await service.getTeamAgentRuntimeSnapshot(teamName);
      return delivered !== undefined && snapshot.members[SURVIVOR]?.alive === true;
    },
    180_000,
    'survivor inbox consumption while its runtime stays alive'
  );
}

async function assertTombstone(teamName: string): Promise<void> {
  const meta = await new TeamMembersMetaStore().getMeta(teamName);
  expect(meta?.members.find((member) => member.name === REMOVED)?.removedAt).toEqual(
    expect.any(Number)
  );
  expect(meta?.members.find((member) => member.name === SURVIVOR)?.removedAt).toBeUndefined();
}

async function assertAllRemovedMembersPersisted(
  claudeRoot: string,
  teamName: string
): Promise<void> {
  const meta = await new TeamMembersMetaStore().getMeta(teamName);
  for (const memberName of TEAMMATES) {
    expect(meta?.members.find((member) => member.name === memberName)?.removedAt).toEqual(
      expect.any(Number)
    );
    const inbox = await fs.stat(
      path.join(claudeRoot, 'teams', teamName, 'inboxes', `${memberName}.json`)
    );
    expect(inbox.isFile()).toBe(true);
  }
}

async function waitForLaunchOutcome(
  progress: TeamProvisioningProgress[],
  expectedMembers: readonly string[]
): Promise<boolean> {
  await waitUntil(
    async () => progress.some((event) => event.state === 'ready' || event.state === 'failed'),
    360_000,
    'launch terminal progress'
  );
  const terminal = progress.findLast(
    (event) => event.state === 'ready' || event.state === 'failed'
  );
  if (terminal?.state === 'ready') return false;

  const failureText = `${terminal?.cliLogsTail ?? ''}\n${terminal?.assistantOutput ?? ''}`;
  if (!failureText.includes('refresh token was revoked')) {
    throw new Error(
      `Launch failed: ${terminal?.message ?? 'unknown'} (${terminal?.error ?? 'unknown'})`
    );
  }

  const completion = findCompletedBootstrapEvent(terminal?.cliLogsTail ?? '');
  expect(completion).not.toBeNull();
  expect(new Set(asStringArray(completion?.expected_members))).toEqual(new Set(expectedMembers));
  expect(new Set(asStringArray(completion?.registered_members))).toEqual(new Set(expectedMembers));
  expect(asStringArray(completion?.failed_members)).toEqual([]);
  return true;
}

function findCompletedBootstrapEvent(logs: string): Record<string, unknown> | null {
  for (const line of logs.split('\n')) {
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      const event = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
      if (
        event.type === 'system' &&
        event.subtype === 'team_bootstrap' &&
        event.event === 'completed' &&
        event.status === 'completed'
      ) {
        return event;
      }
    } catch {
      // Non-JSON CLI output is expected alongside structured bootstrap events.
    }
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function assertAndClearRevokedTokenWarnings(): void {
  const warningMock = vi.mocked(console.warn);
  const warnings = warningMock.mock.calls.map((args) => args.map(String).join(' '));
  const allowed = [
    'stream-json result: error',
    'Launch cleanup finalizing unconfirmed bootstrap members',
  ];
  expect(warnings.length).toBeGreaterThan(0);
  expect(
    warnings.filter((warning) => !allowed.some((fragment) => warning.includes(fragment)))
  ).toEqual([]);
  warningMock.mockClear();
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createIpcMainHarness(handlers: Map<string, RegisteredHandler>): IpcMain {
  return {
    handle: (channel: string, listener: RegisteredHandler) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;
}

function terminateOwnedProcesses(snapshot: TeamAgentRuntimeSnapshot | null): void {
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.backendType !== 'process') continue;
    const pid = member.runtimePid ?? member.pid;
    if (typeof pid !== 'number' || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      killProcessByPid(pid);
    } catch {
      /* already stopped */
    }
  }
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function configureLiveEnvironment(
  claudeRoot: string,
  previous: Map<string, string | undefined>
): void {
  const connectedCodexHome =
    process.env.AGENT_DELETION_258_CODEX_HOME?.trim() || path.join(userInfo().homedir, '.codex');
  const updates: Record<string, string> = {
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH:
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ||
      '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source',
    CLAUDE_TEAM_CLI_FLAVOR: 'agent_teams_orchestrator',
    CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '90000',
    CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '30000',
    NODE_ENV: 'production',
    CODEX_HOME: connectedCodexHome,
    HOME: path.dirname(claudeRoot),
    USERPROFILE: path.dirname(claudeRoot),
  };
  for (const [name, value] of Object.entries(updates)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
}

async function installCodexLaunchFixture(): Promise<() => Promise<void>> {
  const { ProviderConnectionService } =
    await import('../../../../src/main/services/runtime/ProviderConnectionService');
  const binaryPath =
    process.env.CODEX_CLI_PATH?.trim() || (await execFileAsync('which', ['codex'])).stdout.trim();
  if (!binaryPath) throw new Error('Codex CLI was not found for the live E2E');
  const loginStatus = await execFileAsync(
    binaryPath,
    ['-c', 'forced_login_method="chatgpt"', '-c', 'service_tier="fast"', 'login', 'status'],
    { env: process.env, timeout: 30_000 }
  );
  if (!`${loginStatus.stdout}\n${loginStatus.stderr}`.includes('Logged in using ChatGPT')) {
    throw new Error('Codex CLI is not logged in with ChatGPT for the live E2E');
  }
  const snapshot: CodexAccountSnapshotDto = {
    preferredAuthMode: 'chatgpt',
    effectiveAuthMode: 'chatgpt',
    launchAllowed: true,
    launchIssueMessage: null,
    launchReadinessState: 'ready_chatgpt',
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount: { type: 'chatgpt', email: null, planType: null },
    apiKey: { available: false, source: null, sourceLabel: null },
    requiresOpenaiAuth: false,
    localAccountArtifactsPresent: true,
    localActiveChatgptAccountPresent: true,
    runtimeContext: {
      binaryPath,
      codexHome: process.env.CODEX_HOME?.trim() || null,
    },
    login: { status: 'idle', error: null, startedAt: null },
    rateLimits: null,
    updatedAt: new Date().toISOString(),
  };
  const feature = {
    getSnapshot: async () => snapshot,
    refreshSnapshot: async () => snapshot,
  };
  const connections = ProviderConnectionService.getInstance();
  connections.setCodexAccountFeature(feature);
  return async () => {
    connections.setCodexAccountFeature(null);
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
