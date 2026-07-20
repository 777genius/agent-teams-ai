// @vitest-environment node
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceTrustCoordinator } from '../../../../src/features/workspace-trust/main';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { killProcessByPid } from '../../../../src/main/utils/processKill';

import {
  createOpenCodeLiveHarness,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitUntil,
} from './openCodeLiveTestHarness';

import type {
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamMember,
  TeamProviderId,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';

vi.mock('../../../../src/main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: vi.fn(async () => undefined),
    }),
  },
}));

const liveDescribe =
  process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1' && hasAnthropicAuthConfigured()
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_ANTHROPIC_MODEL = 'haiku';
const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const DEFAULT_CODEX_EFFORT = 'low' as const;
const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';
const DEFAULT_ORDER: ProviderLaunchStressScenario[] = ['anthropic', 'codex', 'opencode', 'mixed'];
const MEMBER_NAMES = [
  'alice',
  'bob',
  'jack',
  'tom',
  'atlas',
  'nova',
  'cody',
  'oscar',
  'maya',
  'liam',
  'ivy',
  'noah',
  'zoe',
  'ryan',
  'emma',
  'owen',
  'luna',
  'finn',
  'aria',
  'milo',
];
const RESTART_CONFIRM_TIMEOUT_MS = 300_000;
const POST_LAUNCH_WORK_TIMEOUT_MS = 300_000;
let currentStressTempDir = '';
let currentStressProjectPath = '';

type ProviderLaunchStressScenario = 'anthropic' | 'codex' | 'opencode' | 'mixed';

interface ActiveScenario {
  scenario: ProviderLaunchStressScenario;
  teamName: string;
  svc: TeamProvisioningService;
  harness?: Awaited<ReturnType<typeof createOpenCodeLiveHarness>>;
  codexCleanup?: () => Promise<void>;
  failed: boolean;
}

liveDescribe('provider launch stress live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let tempHome: string;
  let projectPath: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousCodexHome: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousNodeEnv: string | undefined;
  let previousAnthropicApiKey: string | undefined;
  let previousAnthropicAuthToken: string | undefined;
  let previousRuntimeReadyTimeout: string | undefined;
  let previousInboxPollerReadyTimeout: string | undefined;
  let previousClaudeJsonConfig: string | null | undefined;
  const activeScenarios: ActiveScenario[] = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-launch-stress-live-'));
    tempClaudeRoot = usingAnthropicSubscriptionAuth()
      ? os.userInfo().homedir
      : path.join(tempDir, '.claude');
    tempHome = path.join(tempDir, 'home');
    projectPath = path.join(tempDir, 'project');
    currentStressTempDir = tempDir;
    currentStressProjectPath = projectPath;
    await fs.mkdir(tempHome, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Provider launch stress live e2e\n\nKeep this project intentionally tiny.\n',
      'utf8'
    );

    if (usingAnthropicSubscriptionAuth()) {
      setClaudeBasePathOverride(null);
      previousClaudeJsonConfig = await upsertTrustedClaudeProjectConfig(
        tempClaudeRoot,
        projectPath
      );
    } else {
      await fs.mkdir(tempClaudeRoot, { recursive: true });
      await writeTrustedClaudeConfig(tempClaudeRoot, projectPath);
      setClaudeBasePathOverride(tempClaudeRoot);
      previousClaudeJsonConfig = undefined;
    }

    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousCodexHome = process.env.CODEX_HOME;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousNodeEnv = process.env.NODE_ENV;
    previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    previousRuntimeReadyTimeout = process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS;
    previousInboxPollerReadyTimeout = process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS;

    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS?.trim() || '90000';
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS?.trim() || '30000';
    process.env.CODEX_HOME = resolveConnectedCodexHome(previousCodexHome);
    process.env.HOME = usingAnthropicSubscriptionAuth() ? os.userInfo().homedir : tempHome;
    process.env.USERPROFILE = usingAnthropicSubscriptionAuth() ? os.userInfo().homedir : tempHome;
    process.env.NODE_ENV = 'production';
    if (usingAnthropicSubscriptionAuth()) {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  afterEach(async () => {
    for (const active of [...activeScenarios].reverse()) {
      await cleanupActiveScenario(active, { preserveFiles: active.failed }).catch(() => undefined);
    }
    activeScenarios.length = 0;
    discardKnownProviderLaunchStressWarnings();

    if (usingAnthropicSubscriptionAuth() && previousClaudeJsonConfig !== undefined) {
      await restoreClaudeJsonConfig(tempClaudeRoot, previousClaudeJsonConfig);
    }
    setClaudeBasePathOverride(null);

    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
    restoreEnv('NODE_ENV', previousNodeEnv);
    restoreEnv('ANTHROPIC_API_KEY', previousAnthropicApiKey);
    restoreEnv('ANTHROPIC_AUTH_TOKEN', previousAnthropicAuthToken);
    restoreEnv('CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS', previousRuntimeReadyTimeout);
    restoreEnv(
      'CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS',
      previousInboxPollerReadyTimeout
    );

    if (process.env.PROVIDER_LAUNCH_STRESS_KEEP_TEMP === '1') {
      process.stderr.write(`[ProviderLaunchStress.live] preserved temp dir: ${tempDir}\n`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    currentStressTempDir = '';
    currentStressProjectPath = '';
  }, 240_000);

  it(
    'launches, restarts, and exercises post-launch work for provider teams with the requested teammate count',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertExecutable(orchestratorCli!);
      await assertCodexSubscriptionAuthAvailable(process.env.CODEX_HOME!);

      for (const scenario of getStressOrder()) {
        await runProviderStressScenario(scenario, activeScenarios);
      }
    },
    30 * 60_000
  );
});

async function runProviderStressScenario(
  scenario: ProviderLaunchStressScenario,
  activeScenarios: ActiveScenario[]
): Promise<void> {
  const selected = resolveScenarioSelection(scenario);
  const memberCount = getStressMemberCount();
  const teamName = `provider-stress-${scenario}-${Date.now()}`;
  const progressEvents: TeamProvisioningProgress[] = [];
  process.stderr.write(
    `[ProviderLaunchStress.live] starting ${scenario} with ${memberCount} teammates\n`
  );
  let codexCleanup: (() => Promise<void>) | undefined;
  let harness: Awaited<ReturnType<typeof createOpenCodeLiveHarness>> | undefined;
  try {
    codexCleanup =
      scenario === 'codex' || scenario === 'mixed' ? await installCodexAccountFeature() : undefined;
    harness =
      scenario === 'opencode' || scenario === 'mixed'
        ? await createOpenCodeLiveHarness({
            tempDir: currentStressTempDir,
            selectedModel: selected.openCodeModel,
            projectPath: projectPathForStress(),
          })
        : undefined;
  } catch (error) {
    await harness?.dispose().catch(() => undefined);
    await codexCleanup?.().catch(() => undefined);
    throw error;
  }
  const svc = harness?.svc ?? new TeamProvisioningService();
  configureWorkspaceTrustCoordinator(svc);
  const active: ActiveScenario = { scenario, teamName, svc, harness, codexCleanup, failed: false };
  activeScenarios.push(active);

  try {
    await svc.createTeam(
      buildStressCreateRequest({
        scenario,
        teamName,
        memberCount,
        selection: selected,
      }),
      (progress) => progressEvents.push(progress)
    );

    await waitUntil(async () => {
      const last = progressEvents.at(-1);
      if (last?.state === 'failed') {
        active.failed = true;
        throw new Error(await formatStressDiagnostics(svc, teamName, progressEvents));
      }
      return last?.state === 'ready';
    }, 420_000);

    const expectedMembers = buildExpectedMemberNames(memberCount);
    await waitUntil(async () => {
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      if (statuses.teamLaunchState === 'partial_failure') {
        active.failed = true;
        throw new Error(await formatStressDiagnostics(svc, teamName, progressEvents));
      }
      return expectedMembers.every((memberName) => {
        const entry = statuses.statuses[memberName];
        return (
          entry?.status === 'online' &&
          entry.launchState === 'confirmed_alive' &&
          entry.bootstrapConfirmed === true
        );
      });
    }, 240_000);

    await waitUntil(async () => {
      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      return expectedMembers.every((memberName) => snapshot.members[memberName]?.alive === true);
    }, 180_000);
    process.stderr.write(`[ProviderLaunchStress.live] ${scenario} confirmed all teammates\n`);

    await runRestartStressChecks(active, expectedMembers, progressEvents);
    await runPostLaunchWorkProofCheck(active, expectedMembers, progressEvents);
  } catch (error) {
    active.failed = true;
    throw error;
  } finally {
    if (!active.failed) {
      await cleanupActiveScenario(active, { preserveFiles: false });
      const index = activeScenarios.indexOf(active);
      if (index >= 0) activeScenarios.splice(index, 1);
    }
  }
}

function configureWorkspaceTrustCoordinator(svc: TeamProvisioningService): void {
  svc.setWorkspaceTrustCoordinator(
    createWorkspaceTrustCoordinator({
      claudeConfigDir: () => getClaudeBasePath(),
      globalConfigFilePath: () => {
        const claudeBasePath = getClaudeBasePath();
        return claudeBasePath !== getAutoDetectedClaudeBasePath()
          ? path.join(claudeBasePath, '.claude.json')
          : path.join(getHomeDir(), '.claude.json');
      },
    })
  );
}

async function runRestartStressChecks(
  active: ActiveScenario,
  expectedMembers: string[],
  progressEvents: TeamProvisioningProgress[]
): Promise<void> {
  const targets = resolveRestartStressTargets(active.scenario, expectedMembers);
  for (const memberName of targets) {
    process.stderr.write(
      `[ProviderLaunchStress.live] restarting ${active.scenario}/${memberName}\n`
    );
    try {
      await active.svc.restartMember(active.teamName, memberName);
      await waitForStressCondition(
        `restart ${active.teamName}/${memberName}`,
        async () => {
          const statuses = await active.svc.getMemberSpawnStatuses(active.teamName);
          const entry = statuses.statuses[memberName];
          if (entry?.status === 'error' || entry?.launchState === 'failed_to_start') {
            throw new Error(
              `restart ${memberName} failed: ${entry.hardFailureReason ?? entry.error ?? 'unknown'}`
            );
          }
          return (
            entry?.status === 'online' &&
            entry.launchState === 'confirmed_alive' &&
            entry.bootstrapConfirmed === true
          );
        },
        RESTART_CONFIRM_TIMEOUT_MS,
        2_000,
        () => formatStressDiagnostics(active.svc, active.teamName, progressEvents)
      );
      await waitForStressCondition(
        `runtime alive after restart ${active.teamName}/${memberName}`,
        async () => {
          const snapshot = await active.svc.getTeamAgentRuntimeSnapshot(active.teamName);
          return snapshot.members[memberName]?.alive === true;
        },
        120_000,
        2_000,
        () => formatStressDiagnostics(active.svc, active.teamName, progressEvents)
      );
    } catch (error) {
      throw new Error(
        `Restart stress failed for ${active.scenario}/${memberName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await waitForStressCondition(
    `all teammates still confirmed after restarts ${active.teamName}`,
    async () => {
      const statuses = await active.svc.getMemberSpawnStatuses(active.teamName);
      return expectedMembers.every((memberName) => {
        const entry = statuses.statuses[memberName];
        return (
          entry?.status === 'online' &&
          entry.launchState === 'confirmed_alive' &&
          entry.bootstrapConfirmed === true
        );
      });
    },
    120_000,
    2_000,
    () => formatStressDiagnostics(active.svc, active.teamName, progressEvents)
  );
  process.stderr.write(`[ProviderLaunchStress.live] ${active.scenario} restart checks passed\n`);
}

async function runPostLaunchWorkProofCheck(
  active: ActiveScenario,
  expectedMembers: string[],
  progressEvents: TeamProvisioningProgress[]
): Promise<void> {
  const memberNames = resolvePostLaunchWorkTargets(active.scenario, expectedMembers);
  const markerPrefix = `provider-stress-${active.scenario}-${Date.now()}`;
  const teamDataService = new TeamDataService();
  const taskReader = new TeamTaskReader();

  process.stderr.write(
    `[ProviderLaunchStress.live] sending post-launch work probes to ${active.scenario}/${memberNames.join(',')}\n`
  );
  const probes = await Promise.all(
    memberNames.map(async (memberName, index) => {
      const marker = `${markerPrefix}-${index + 1}`;
      const peerRecipient =
        memberNames.length > 1 ? memberNames[(index + 1) % memberNames.length] : null;
      const peerToken = peerRecipient ? `${marker}:to:${peerRecipient}` : null;
      const task = await teamDataService.createTask(active.teamName, {
        subject: `Provider launch stress proof ${marker}`,
        owner: memberName,
        startImmediately: true,
        prompt: [
          `This is a live provider launch stress validation. Marker: ${marker}.`,
          'Do not edit files.',
          'Add one task comment containing exactly:',
          `${marker}:done`,
          ...(peerRecipient && peerToken
            ? [
                `Send ${peerRecipient} one team message whose full text is exactly: ${peerToken}`,
                'Use agent-teams_message_send for the team message.',
              ]
            : []),
          'Then mark this task complete.',
          'After that stop. Do not send a separate user-visible chat reply.',
        ].join('\n'),
      });
      const relay = await active.svc.relayInboxFileToLiveRecipient(active.teamName, memberName);
      if (!isAcceptedStressRelayResult(relay)) {
        throw new Error(
          `Post-launch work probe was not relayed to ${memberName}; relay result: ${JSON.stringify(relay)}`
        );
      }
      return { marker, memberName, peerRecipient, peerToken, taskId: task.id };
    })
  );

  await waitForStressCondition(
    `post-launch work proofs ${active.teamName}/${memberNames.join(',')}`,
    async () => {
      const tasks = await taskReader.getTasks(active.teamName);
      return probes.every((probe) => {
        const current = tasks.find((candidate) => candidate.id === probe.taskId);
        const hasMarkerComment = current?.comments?.some((comment) =>
          comment.text.includes(`${probe.marker}:done`)
        );
        return Boolean(hasMarkerComment && current?.status === 'completed');
      });
    },
    POST_LAUNCH_WORK_TIMEOUT_MS,
    2_000,
    () => formatStressDiagnostics(active.svc, active.teamName, progressEvents)
  );

  const peerProbes = probes.filter(
    (
      probe
    ): probe is (typeof probes)[number] & {
      peerRecipient: string;
      peerToken: string;
    } => Boolean(probe.peerRecipient && probe.peerToken)
  );
  await Promise.all(
    peerProbes.map((probe) =>
      waitForMemberInboxMessage(
        active.teamName,
        probe.peerRecipient,
        probe.memberName,
        probe.peerToken,
        POST_LAUNCH_WORK_TIMEOUT_MS
      )
    )
  );
  await Promise.all(
    Array.from(new Set(peerProbes.map((probe) => probe.peerRecipient))).map(
      async (recipientName) => {
        const relay = await active.svc.relayInboxFileToLiveRecipient(
          active.teamName,
          recipientName
        );
        if (!isAcceptedStressRelayResult(relay)) {
          throw new Error(
            `Peer message was not relayed to ${recipientName}; relay result: ${JSON.stringify(relay)}`
          );
        }
      }
    )
  );
  process.stderr.write(`[ProviderLaunchStress.live] ${active.scenario} post-launch work passed\n`);
}

function isAcceptedStressRelayResult(
  relay: Awaited<ReturnType<TeamProvisioningService['relayInboxFileToLiveRecipient']>>
): boolean {
  if (relay.kind === 'native_member_noop') return true;
  if (relay.relayed > 0) return true;
  const lastDelivery = relay.lastDelivery;
  return Boolean(
    lastDelivery &&
    (lastDelivery.accepted === true ||
      lastDelivery.delivered === true ||
      lastDelivery.responsePending === true)
  );
}

function resolveRestartStressTargets(
  scenario: ProviderLaunchStressScenario,
  expectedMembers: string[]
): string[] {
  if (expectedMembers.length === 0) return [];
  if (scenario !== 'mixed') {
    return [expectedMembers[1] ?? expectedMembers[0]];
  }

  const targets: string[] = [];
  const wantedProviders: TeamProviderId[] = ['anthropic', 'codex', 'opencode'];
  for (const providerId of wantedProviders) {
    const index = expectedMembers.findIndex(
      (_memberName, memberIndex) => resolveStressMemberProvider('mixed', memberIndex) === providerId
    );
    if (index >= 0) targets.push(expectedMembers[index]!);
  }
  return targets;
}

function resolvePostLaunchWorkTarget(
  scenario: ProviderLaunchStressScenario,
  expectedMembers: string[]
): string {
  if (scenario === 'mixed') {
    const openCodeIndex = expectedMembers.findIndex(
      (_memberName, memberIndex) => resolveStressMemberProvider('mixed', memberIndex) === 'opencode'
    );
    if (openCodeIndex >= 0) return expectedMembers[openCodeIndex]!;
  }
  return expectedMembers[1] ?? expectedMembers[0] ?? 'alice';
}

function resolvePostLaunchWorkTargets(
  scenario: ProviderLaunchStressScenario,
  expectedMembers: string[]
): string[] {
  if (process.env.PROVIDER_LAUNCH_STRESS_WORK_TARGETS?.trim().toLowerCase() === 'all') {
    return expectedMembers;
  }
  return [resolvePostLaunchWorkTarget(scenario, expectedMembers)];
}

async function waitForStressCondition(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs: number,
  diagnostics: () => Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const suffix = lastError
    ? `\nLast error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : '';
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${suffix}\n${await diagnostics()}`
  );
}

function discardKnownProviderLaunchStressWarnings(): void {
  const warn = vi.mocked(console.warn);
  if (!warn.mock) return;
  const calls = warn.mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const text = calls[index]?.map((value) => String(value)).join(' ') ?? '';
    if (text.includes('Failed to resolve login shell env: shell env resolve timeout')) {
      calls.splice(index, 1);
    }
  }
}

function buildStressCreateRequest(input: {
  scenario: ProviderLaunchStressScenario;
  teamName: string;
  memberCount: number;
  selection: ReturnType<typeof resolveScenarioSelection>;
}): TeamCreateRequest {
  const members = buildStressMembers(input.scenario, input.memberCount, input.selection);
  const providerId: TeamProviderId = input.scenario === 'mixed' ? 'anthropic' : input.scenario;
  return {
    teamName: input.teamName,
    cwd: projectPathForStress(),
    providerId,
    providerBackendId: providerId === 'codex' ? 'codex-native' : undefined,
    model:
      providerId === 'codex'
        ? input.selection.codexModel
        : providerId === 'opencode'
          ? input.selection.openCodeModel
          : input.selection.anthropicModel,
    effort: providerId === 'codex' ? input.selection.codexEffort : undefined,
    fastMode: providerId === 'codex' ? 'off' : undefined,
    skipPermissions: true,
    extraCliArgs: process.env.PROVIDER_LAUNCH_STRESS_EXTRA_CLI_ARGS?.trim() || undefined,
    prompt: 'Keep the team idle after bootstrap. Do not start extra work.',
    members,
  };
}

function buildStressMembers(
  scenario: ProviderLaunchStressScenario,
  memberCount: number,
  selection: ReturnType<typeof resolveScenarioSelection>
): TeamMember[] {
  const names = buildExpectedMemberNames(memberCount);
  return names.map((name, index) => {
    const providerId = resolveStressMemberProvider(scenario, index);
    return {
      name,
      role: index % 2 === 0 ? 'Developer' : 'Reviewer',
      providerId,
      providerBackendId: providerId === 'codex' ? 'codex-native' : undefined,
      model:
        providerId === 'codex'
          ? selection.codexModel
          : providerId === 'opencode'
            ? selection.openCodeModels[index % selection.openCodeModels.length] ??
              selection.openCodeModel
            : selection.anthropicModel,
      effort: providerId === 'codex' ? selection.codexEffort : undefined,
      fastMode: providerId === 'codex' ? 'off' : undefined,
    };
  });
}

function resolveStressMemberProvider(
  scenario: ProviderLaunchStressScenario,
  index: number
): TeamProviderId {
  if (scenario !== 'mixed') return scenario;
  const providers: TeamProviderId[] = ['anthropic', 'codex', 'opencode', 'anthropic', 'codex'];
  return providers[index % providers.length] ?? 'anthropic';
}

function resolveScenarioSelection(_scenario: ProviderLaunchStressScenario): {
  anthropicModel: string;
  codexModel: string;
  codexEffort: 'low' | 'medium' | 'high' | 'xhigh';
  openCodeModel: string;
  openCodeModels: string[];
} {
  const openCodeModel =
    process.env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL;
  const openCodeModels = process.env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODELS?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return {
    anthropicModel:
      process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    codexModel: process.env.PROVIDER_LAUNCH_STRESS_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL,
    codexEffort: (process.env.PROVIDER_LAUNCH_STRESS_CODEX_EFFORT?.trim() ||
      DEFAULT_CODEX_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh',
    openCodeModel,
    openCodeModels: openCodeModels?.length ? openCodeModels : [openCodeModel],
  };
}

function getStressMemberCount(): number {
  const parsed = Number.parseInt(process.env.PROVIDER_LAUNCH_STRESS_MEMBER_COUNT ?? '5', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MEMBER_NAMES.length) : 5;
}

function buildExpectedMemberNames(memberCount: number): string[] {
  return MEMBER_NAMES.slice(0, memberCount);
}

function getStressOrder(): ProviderLaunchStressScenario[] {
  const raw = process.env.PROVIDER_LAUNCH_STRESS_ORDER?.trim();
  if (!raw) return DEFAULT_ORDER;
  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is ProviderLaunchStressScenario =>
      ['anthropic', 'codex', 'opencode', 'mixed'].includes(item)
    );
  return parsed.length > 0 ? parsed : DEFAULT_ORDER;
}

function projectPathForStress(): string {
  const explicit = process.env.PROVIDER_LAUNCH_STRESS_PROJECT_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  if (!currentStressProjectPath) {
    throw new Error('Provider launch stress project path requested before test setup');
  }
  return currentStressProjectPath;
}

async function cleanupActiveScenario(
  active: ActiveScenario,
  options: { preserveFiles: boolean }
): Promise<void> {
  const beforeStopSnapshot = await active.svc
    .getTeamAgentRuntimeSnapshot(active.teamName)
    .catch(() => null);
  await active.svc.stopTeam(active.teamName).catch(() => undefined);
  if (active.harness) {
    await waitForOpenCodeLanesStopped(active.teamName, 90_000).catch(() => undefined);
  }
  await terminateProcessBackends(beforeStopSnapshot);
  const afterStopSnapshot = await active.svc
    .getTeamAgentRuntimeSnapshot(active.teamName)
    .catch(() => null);
  await terminateProcessBackends(afterStopSnapshot);
  await active.harness?.dispose().catch(() => undefined);
  await active.codexCleanup?.().catch(() => undefined);
  if (!options.preserveFiles) {
    await fs.rm(path.join(getTeamsBasePath(), active.teamName), { recursive: true, force: true });
    await fs.rm(path.join(getTasksBasePath(), active.teamName), { recursive: true, force: true });
  }
}

async function terminateProcessBackends(snapshot: TeamAgentRuntimeSnapshot | null): Promise<void> {
  const pids = new Set<number>();
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.backendType !== 'process' || member.providerId === 'opencode') continue;
    const pid = member.runtimePid ?? member.pid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      killProcessByPid(pid);
    } catch {
      // Best-effort cleanup; the runtime may already be gone.
    }
  }
}

async function installCodexAccountFeature(): Promise<() => Promise<void>> {
  const [{ createCodexAccountFeature }, { ProviderConnectionService }] = await Promise.all([
    import('../../../../src/features/codex-account/main/composition/createCodexAccountFeature'),
    import('../../../../src/main/services/runtime/ProviderConnectionService'),
  ]);
  const feature = createCodexAccountFeature({
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
  const providerConnectionService = ProviderConnectionService.getInstance();
  providerConnectionService.setCodexAccountFeature(feature);
  return async () => {
    providerConnectionService.setCodexAccountFeature(null);
    await feature.dispose().catch(() => undefined);
  };
}

async function formatStressDiagnostics(
  svc: TeamProvisioningService,
  teamName: string,
  progressEvents: TeamProvisioningProgress[]
): Promise<string> {
  const [spawnStatuses, runtimeSnapshot, artifact] = await Promise.all([
    svc.getMemberSpawnStatuses(teamName).catch((error) => ({ error: String(error) })),
    svc.getTeamAgentRuntimeSnapshot(teamName).catch((error) => ({ error: String(error) })),
    readLatestArtifactManifest(teamName),
  ]);
  return redactSecrets(
    JSON.stringify(
      {
        progress: progressEvents.map((progress) => ({
          state: progress.state,
          message: progress.message,
          messageSeverity: progress.messageSeverity,
          error: progress.error,
          launchDiagnostics: progress.launchDiagnostics,
        })),
        spawnStatuses,
        runtimeSnapshot,
        artifact,
      },
      null,
      2
    )
  );
}

async function readLatestArtifactManifest(teamName: string): Promise<unknown> {
  try {
    const latest = JSON.parse(
      await fs.readFile(
        path.join(getTeamsBasePath(), teamName, 'launch-failure-artifacts', 'latest.json'),
        'utf8'
      )
    ) as { manifestPath?: unknown };
    if (typeof latest.manifestPath !== 'string') return latest;
    return JSON.parse(await fs.readFile(latest.manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasAnthropicAuthConfigured(): boolean {
  return usingAnthropicSubscriptionAuth() || Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function usingAnthropicSubscriptionAuth(): boolean {
  const mode = process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH?.trim().toLowerCase();
  return mode === 'subscription' || mode === 'oauth';
}

async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.X_OK);
}

async function assertCodexSubscriptionAuthAvailable(codexHome: string): Promise<void> {
  const legacyAuthPath = path.join(codexHome, 'auth.json');
  if (await pathReadable(legacyAuthPath)) {
    const legacyAuth = await readJsonObject(legacyAuthPath);
    if (isCodexChatGptSubscriptionAuth(legacyAuth)) return;
  }

  const accountsDir = path.join(codexHome, 'accounts');
  const registry = await readJsonObject(path.join(accountsDir, 'registry.json')).catch(() => null);
  const activeAccountId =
    readStringProperty(registry, 'active_account_id') ??
    readStringProperty(registry, 'activeAccountId') ??
    readStringProperty(registry, 'current_account_id') ??
    readStringProperty(registry, 'currentAccountId');

  const candidates = new Set<string>();
  if (activeAccountId) {
    candidates.add(path.join(accountsDir, `${activeAccountId}.auth.json`));
    candidates.add(path.join(accountsDir, activeAccountId));
  }
  const entries = await fs.readdir(accountsDir).catch(() => []);
  for (const entry of entries) {
    if (entry.endsWith('.auth.json')) candidates.add(path.join(accountsDir, entry));
  }
  for (const candidate of candidates) {
    const auth = await readJsonObject(candidate).catch(() => null);
    if (isCodexChatGptSubscriptionAuth(auth)) return;
  }
  throw new Error(`Codex subscription auth not found in ${codexHome}`);
}

async function pathReadable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function readStringProperty(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isCodexChatGptSubscriptionAuth(source: Record<string, unknown> | null): boolean {
  if (!source) return false;
  const direct = readStringProperty(source, 'refresh_token');
  const tokens = source.tokens;
  const nested =
    tokens && typeof tokens === 'object' && !Array.isArray(tokens)
      ? readStringProperty(tokens as Record<string, unknown>, 'refresh_token')
      : null;
  return Boolean(direct || nested);
}

function resolveConnectedCodexHome(previousCodexHome: string | undefined): string {
  const explicit = process.env.PROVIDER_LAUNCH_STRESS_CODEX_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const previous = previousCodexHome?.trim();
  if (previous) return path.resolve(previous);
  return path.join(os.userInfo().homedir, '.codex');
}

async function writeTrustedClaudeConfig(configDir: string, projectPath: string): Promise<void> {
  const normalizedProjectPath = path.normalize(await fs.realpath(projectPath)).replace(/\\/g, '/');
  const approvedApiKeySuffix = process.env.ANTHROPIC_API_KEY?.trim().slice(-20);
  const config: {
    projects: Record<string, { hasTrustDialogAccepted: true }>;
    customApiKeyResponses?: { approved: string[]; rejected: string[] };
  } = {
    projects: {
      [normalizedProjectPath]: {
        hasTrustDialogAccepted: true,
      },
    },
  };
  if (approvedApiKeySuffix) {
    config.customApiKeyResponses = { approved: [approvedApiKeySuffix], rejected: [] };
  }
  await fs.writeFile(
    path.join(configDir, '.claude.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
}

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
  const normalizedProjectPath = path.normalize(await fs.realpath(projectPath)).replace(/\\/g, '/');
  const projects =
    existing.projects && typeof existing.projects === 'object' && !Array.isArray(existing.projects)
      ? { ...(existing.projects as Record<string, unknown>) }
      : {};
  const current =
    projects[normalizedProjectPath] &&
    typeof projects[normalizedProjectPath] === 'object' &&
    !Array.isArray(projects[normalizedProjectPath])
      ? (projects[normalizedProjectPath] as Record<string, unknown>)
      : {};
  projects[normalizedProjectPath] = { ...current, hasTrustDialogAccepted: true };
  await fs.writeFile(configPath, `${JSON.stringify({ ...existing, projects }, null, 2)}\n`, 'utf8');
  return previous;
}

async function restoreClaudeJsonConfig(configDir: string, previous: string | null): Promise<void> {
  const configPath = path.join(configDir, '.claude.json');
  if (previous === null) {
    await fs.rm(configPath, { force: true });
  } else {
    await fs.writeFile(configPath, previous, 'utf8');
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-api03-[A-Za-z0-9_-]+/g, '<redacted-anthropic-key>')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{20,}\b/g, '<redacted-api-key>');
}
