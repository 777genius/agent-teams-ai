import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { killProcessByPid } from '../../../../src/main/utils/processKill';

import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  waitForOpenCodeLanesStopped,
  waitUntil,
} from './openCodeLiveTestHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

vi.mock('../../../../src/main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: vi.fn(async () => undefined),
    }),
  },
}));

const liveDescribe =
  process.env.MIXED_PROVIDER_TEAM_LIVE === '1' &&
  process.env.OPENCODE_E2E === '1' &&
  process.env.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS === '1' &&
  (Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || shouldUseAnthropicSubscriptionAuth())
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_ANTHROPIC_MODEL = 'haiku';
const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';

liveDescribe('Mixed provider team launch live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let tempHome: string;
  let projectPath: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousCodexHome: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousAnthropicApiKey: string | undefined;
  let previousAnthropicAuthToken: string | undefined;
  let previousClaudeJsonConfig: string | null | undefined;
  let previousNodeEnv: string | undefined;
  let previousDisableAppBootstrap: string | undefined;
  let previousDisableRuntimeBootstrap: string | undefined;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;
  let codexAccountFeature: { getSnapshot(): Promise<unknown>; dispose(): Promise<void> } | null;
  let providerConnectionService: {
    setCodexAccountFeature(feature: { getSnapshot(): Promise<unknown> } | null): void;
  } | null;
  let usingAnthropicSubscriptionAuth = false;

  beforeEach(async () => {
    usingAnthropicSubscriptionAuth = shouldUseAnthropicSubscriptionAuth();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mixed-provider-team-live-'));
    tempClaudeRoot = usingAnthropicSubscriptionAuth
      ? os.userInfo().homedir
      : path.join(tempDir, '.claude');
    tempHome = path.join(tempDir, 'home');
    projectPath = path.join(tempDir, 'project');
    if (!usingAnthropicSubscriptionAuth) {
      await fs.mkdir(tempClaudeRoot, { recursive: true });
    }
    await fs.mkdir(tempHome, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Mixed provider team live e2e\n\nThis project is intentionally tiny.\n',
      'utf8'
    );
    if (usingAnthropicSubscriptionAuth) {
      // Claude subscription/OAuth is tied to the user's normal Claude config/keychain namespace.
      // Do not point CLAUDE_CONFIG_DIR at an isolated temp dir in this mode or the live smoke
      // will test a different auth namespace than the app/runtime actually uses.
      setClaudeBasePathOverride(null);
      previousClaudeJsonConfig = await upsertTrustedClaudeProjectConfig(
        tempClaudeRoot,
        projectPath
      );
    } else {
      await writeTrustedClaudeConfig(tempClaudeRoot, projectPath);
      setClaudeBasePathOverride(tempClaudeRoot);
      previousClaudeJsonConfig = undefined;
    }

    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousCodexHome = process.env.CODEX_HOME;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    previousNodeEnv = process.env.NODE_ENV;
    previousDisableAppBootstrap = process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    previousDisableRuntimeBootstrap = process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;

    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    process.env.CODEX_HOME = resolveConnectedCodexHome(previousCodexHome);
    process.env.HOME = usingAnthropicSubscriptionAuth ? os.userInfo().homedir : tempHome;
    process.env.USERPROFILE = usingAnthropicSubscriptionAuth ? os.userInfo().homedir : tempHome;
    if (usingAnthropicSubscriptionAuth) {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    process.env.NODE_ENV = 'production';
    delete process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;

    harness = null;
    teamName = null;
    codexAccountFeature = null;
    providerConnectionService = null;
  });

  afterEach(async () => {
    const keepProcesses = process.env.MIXED_PROVIDER_TEAM_LIVE_KEEP_PROCESSES === '1';
    if (!keepProcesses && harness && teamName) {
      await cleanupMixedProviderSmokeTeam(harness, teamName);
    }
    if (!keepProcesses && usingAnthropicSubscriptionAuth && teamName) {
      await fs.rm(path.join(getTeamsBasePath(), teamName), { recursive: true, force: true });
      await fs.rm(path.join(getTasksBasePath(), teamName), { recursive: true, force: true });
    }
    providerConnectionService?.setCodexAccountFeature(null);
    await codexAccountFeature?.dispose().catch(() => undefined);
    if (!keepProcesses) {
      await harness?.dispose().catch(() => undefined);
    }
    if (usingAnthropicSubscriptionAuth && previousClaudeJsonConfig !== undefined) {
      await restoreClaudeJsonConfig(tempClaudeRoot, previousClaudeJsonConfig);
    }
    setClaudeBasePathOverride(null);

    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
    restoreEnv('ANTHROPIC_API_KEY', previousAnthropicApiKey);
    restoreEnv('ANTHROPIC_AUTH_TOKEN', previousAnthropicAuthToken);
    restoreEnv('NODE_ENV', previousNodeEnv);
    restoreEnv('CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableAppBootstrap);
    restoreEnv('CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableRuntimeBootstrap);

    if (process.env.MIXED_PROVIDER_TEAM_LIVE_KEEP_TEMP === '1') {
      process.stderr.write(`[MixedProviderTeamLaunch.live] preserved temp dir: ${tempDir}\n`);
    } else {
      await removeTempDirWithRetries(tempDir);
    }
  }, 180_000);

  it('launches Anthropic, Codex subscription, and OpenCode teammates in one mixed team', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);
    await assertCodexSubscriptionAuthAvailable(process.env.CODEX_HOME!);

    const anthropicModel =
      process.env.MIXED_PROVIDER_TEAM_ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
    const codexModel = process.env.MIXED_PROVIDER_TEAM_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL;
    const codexEffort =
      (process.env.MIXED_PROVIDER_TEAM_CODEX_EFFORT?.trim() as
        | 'low'
        | 'medium'
        | 'high'
        | 'xhigh'
        | undefined) || 'low';
    const openCodeModel =
      process.env.MIXED_PROVIDER_TEAM_OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL;

    const [{ ProviderConnectionService }, { createCodexAccountFeature }] = await Promise.all([
      import('../../../../src/main/services/runtime/ProviderConnectionService'),
      import('../../../../src/features/codex-account/main/composition/createCodexAccountFeature'),
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

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: openCodeModel,
      projectPath,
    });

    teamName = `mixed-provider-live-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];

    await harness.svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'anthropic',
        model: anthropicModel,
        skipPermissions: true,
        prompt: 'Keep the team idle after bootstrap. Do not start extra work.',
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'anthropic',
            model: anthropicModel,
          },
          {
            name: 'cody',
            role: 'Developer',
            providerId: 'codex',
            model: codexModel,
            effort: codexEffort,
          },
          {
            name: 'oscar',
            role: 'Developer',
            providerId: 'opencode',
            model: openCodeModel,
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
        throw new Error(formatProgressDump(progressEvents));
      }
      return last?.state === 'ready';
    }, 360_000);

    await waitUntilWithDiagnostics(
      async () => {
        const status = await harness!.svc.getMemberSpawnStatuses(teamName!);
        if (status.teamLaunchState === 'partial_failure') {
          throw new Error(await formatMixedLaunchDiagnostics(harness!, teamName!, progressEvents));
        }
        for (const memberName of ['alice', 'cody', 'oscar'] as const) {
          const member = status.statuses[memberName];
          if (
            member?.status !== 'online' ||
            member.launchState !== 'confirmed_alive' ||
            member.bootstrapConfirmed !== true
          ) {
            return false;
          }
        }
        return true;
      },
      180_000,
      () => formatMixedLaunchDiagnostics(harness!, teamName!, progressEvents)
    );

    await waitUntilWithDiagnostics(
      async () => {
        const snapshot = await harness!.svc.getTeamAgentRuntimeSnapshot(teamName!);
        return (
          snapshot.members.alice?.providerId === 'anthropic' &&
          snapshot.members.alice.alive === true &&
          snapshot.members.cody?.providerId === 'codex' &&
          snapshot.members.cody.alive === true &&
          snapshot.members.oscar?.providerId === 'opencode' &&
          snapshot.members.oscar.alive === true
        );
      },
      180_000,
      () => formatMixedLaunchDiagnostics(harness!, teamName!, progressEvents)
    );

    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
    expect(
      Object.entries(laneIndex.lanes).some(
        ([laneId, lane]) => lane.state === 'active' && laneId === 'secondary:opencode:oscar'
      )
    ).toBe(true);

    await cleanupMixedProviderSmokeTeam(harness, teamName);

    const relaunchProgressEvents: TeamProvisioningProgress[] = [];
    await harness.svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'anthropic',
        model: anthropicModel,
        skipPermissions: true,
        clearContext: true,
      },
      (progress) => {
        relaunchProgressEvents.push(progress);
      }
    );

    await waitUntil(async () => {
      const last = relaunchProgressEvents.at(-1);
      if (last?.state === 'failed') {
        throw new Error(formatProgressDump(relaunchProgressEvents));
      }
      return last?.state === 'ready';
    }, 360_000);

    await waitUntilWithDiagnostics(
      async () => {
        const status = await harness!.svc.getMemberSpawnStatuses(teamName!);
        if (status.teamLaunchState === 'partial_failure') {
          throw new Error(
            await formatMixedLaunchDiagnostics(harness!, teamName!, relaunchProgressEvents)
          );
        }
        for (const memberName of ['alice', 'cody', 'oscar'] as const) {
          const member = status.statuses[memberName];
          if (
            member?.status !== 'online' ||
            member.launchState !== 'confirmed_alive' ||
            member.bootstrapConfirmed !== true
          ) {
            return false;
          }
        }
        return true;
      },
      180_000,
      () => formatMixedLaunchDiagnostics(harness!, teamName!, relaunchProgressEvents)
    );

    await waitUntilWithDiagnostics(
      async () => {
        const snapshot = await harness!.svc.getTeamAgentRuntimeSnapshot(teamName!);
        return (
          snapshot.members.alice?.providerId === 'anthropic' &&
          snapshot.members.alice.alive === true &&
          snapshot.members.cody?.providerId === 'codex' &&
          snapshot.members.cody.alive === true &&
          snapshot.members.oscar?.providerId === 'opencode' &&
          snapshot.members.oscar.alive === true
        );
      },
      180_000,
      () => formatMixedLaunchDiagnostics(harness!, teamName!, relaunchProgressEvents)
    );

    const relaunchedLaneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
    expect(
      Object.entries(relaunchedLaneIndex.lanes).some(
        ([laneId, lane]) => lane.state === 'active' && laneId === 'secondary:opencode:oscar'
      )
    ).toBe(true);
  }, 480_000);
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function shouldUseAnthropicSubscriptionAuth(): boolean {
  const mode = process.env.MIXED_PROVIDER_TEAM_ANTHROPIC_AUTH?.trim().toLowerCase();
  return mode === 'subscription' || mode === 'oauth';
}

async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.R_OK);
}

async function assertCodexSubscriptionAuthAvailable(codexHome: string): Promise<void> {
  const legacyAuthPath = path.join(codexHome, 'auth.json');
  if (await pathReadable(legacyAuthPath)) {
    const legacyAuth = await readJsonObject(legacyAuthPath);
    if (isCodexChatGptSubscriptionAuth(legacyAuth)) {
      return;
    }
  }

  const accountsDir = path.join(codexHome, 'accounts');
  const registryPath = path.join(accountsDir, 'registry.json');
  const registry = await readJsonObject(registryPath).catch(() => null);
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
    if (entry.endsWith('.auth.json')) {
      candidates.add(path.join(accountsDir, entry));
    }
  }

  for (const candidate of candidates) {
    const auth = await readJsonObject(candidate).catch(() => null);
    if (isCodexChatGptSubscriptionAuth(auth)) {
      return;
    }
  }

  throw new Error(
    `Codex subscription auth not found in ${codexHome}. Expected auth.json or accounts/*.auth.json with a refresh token.`
  );
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

function hasCodexRefreshToken(source: Record<string, unknown> | null): boolean {
  const direct = readStringProperty(source, 'refresh_token');
  const tokens = source?.tokens;
  const nested =
    tokens && typeof tokens === 'object' && !Array.isArray(tokens)
      ? readStringProperty(tokens as Record<string, unknown>, 'refresh_token')
      : null;
  return Boolean(direct || nested);
}

function isCodexChatGptSubscriptionAuth(source: Record<string, unknown> | null): boolean {
  if (!source || !hasCodexRefreshToken(source)) {
    return false;
  }
  const authMode =
    readStringProperty(source, 'auth_mode') ??
    readStringProperty(source, 'authMode') ??
    readStringProperty(source, 'mode');
  if (!authMode) {
    // New account files may omit an explicit mode. A refresh token is the stable OAuth signal.
    return true;
  }
  return authMode.toLowerCase() === 'chatgpt';
}

async function writeTrustedClaudeConfig(configDir: string, projectPath: string): Promise<void> {
  const canonicalProjectPath = await fs.realpath(projectPath).catch(() => projectPath);
  const normalizedProjectPath = path.normalize(canonicalProjectPath).replace(/\\/g, '/');
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
    config.customApiKeyResponses = {
      approved: [approvedApiKeySuffix],
      rejected: [],
    };
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  const existing = parseJsonObject(previous) ?? {};
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
    `${JSON.stringify(
      {
        ...existing,
        projects,
      },
      null,
      2
    )}\n`,
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

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function resolveConnectedCodexHome(previousCodexHome: string | undefined): string {
  const explicit = process.env.MIXED_PROVIDER_TEAM_CODEX_HOME?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const previous = previousCodexHome?.trim();
  if (previous) {
    return path.resolve(previous);
  }
  return path.join(os.userInfo().homedir, '.codex');
}

async function removeTempDirWithRetries(dirPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 20 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function cleanupMixedProviderSmokeTeam(
  harness: OpenCodeLiveHarness,
  teamName: string
): Promise<void> {
  const beforeStopSnapshot = await harness.svc
    .getTeamAgentRuntimeSnapshot(teamName)
    .catch(() => null);
  await harness.svc.stopTeam(teamName).catch(() => undefined);
  await waitForOpenCodeLanesStopped(teamName, 90_000).catch(() => undefined);
  await terminateSmokeOwnedProcessBackends(beforeStopSnapshot);
  const afterStopSnapshot = await harness.svc
    .getTeamAgentRuntimeSnapshot(teamName)
    .catch(() => null);
  await terminateSmokeOwnedProcessBackends(afterStopSnapshot);
}

async function terminateSmokeOwnedProcessBackends(
  snapshot: Awaited<ReturnType<OpenCodeLiveHarness['svc']['getTeamAgentRuntimeSnapshot']>> | null
): Promise<void> {
  const pids = new Set<number>();
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.backendType !== 'process' || member.providerId === 'opencode') {
      continue;
    }
    const pid = member.runtimePid ?? member.pid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  await Promise.all(
    Array.from(pids).map(async (pid) => {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      try {
        killProcessByPid(pid);
      } catch {
        // Best-effort smoke cleanup. The process may have exited between the liveness probe and kill.
      }
    })
  );
}

function formatProgressDump(progressEvents: TeamProvisioningProgress[]): string {
  return redactSecrets(
    progressEvents
      .map((progress) =>
        [
          progress.state,
          progress.message,
          progress.messageSeverity,
          progress.error,
          progress.cliLogsTail,
        ]
          .filter(Boolean)
          .join(' | ')
      )
      .join('\n')
  );
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-api03-[A-Za-z0-9_-]+/g, '<redacted-anthropic-key>')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{20,}\b/g, '<redacted-api-key>');
}

async function waitUntilWithDiagnostics(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  describeState: () => Promise<string>,
  pollMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for condition.\n${await describeState()}`
  );
}

async function formatMixedLaunchDiagnostics(
  harness: OpenCodeLiveHarness,
  teamName: string,
  progressEvents: TeamProvisioningProgress[]
): Promise<string> {
  const [spawnStatuses, runtimeSnapshot, laneIndex] = await Promise.all([
    harness.svc.getMemberSpawnStatuses(teamName).catch((error) => ({
      error: String(error),
    })),
    harness.svc.getTeamAgentRuntimeSnapshot(teamName).catch((error) => ({
      error: String(error),
    })),
    readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch((error) => ({
      error: String(error),
    })),
  ]);
  return redactSecrets(
    JSON.stringify(
      {
        progress: formatProgressDump(progressEvents),
        spawnStatuses,
        runtimeSnapshot,
        laneIndex,
      },
      null,
      2
    )
  );
}
