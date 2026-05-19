import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  encodePath,
  encodePathPortable,
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { killProcessByPid } from '../../../../src/main/utils/processKill';

import type {
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamMember,
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
  process.env.ANTHROPIC_LAUNCH_SELECTION_LIVE === '1' &&
  (Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || usingAnthropicSubscriptionAuth())
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_LEAD_MODEL = 'claude-opus-4-6[1m]';
const DEFAULT_MEMBER_MODEL = 'haiku';
const DEFAULT_LEAD_EFFORT = 'medium' as const;

liveDescribe('Anthropic launch selection live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let tempHome: string;
  let projectPath: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousNodeEnv: string | undefined;
  let previousAnthropicApiKey: string | undefined;
  let previousAnthropicAuthToken: string | undefined;
  let previousDisableAppBootstrap: string | undefined;
  let previousDisableRuntimeBootstrap: string | undefined;
  let previousRuntimeReadyTimeout: string | undefined;
  let previousClaudeJsonConfig: string | null | undefined;
  let svc: TeamProvisioningService | null;
  let teamName: string | null;
  let subscriptionAuth = false;

  beforeEach(async () => {
    subscriptionAuth = usingAnthropicSubscriptionAuth();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anthropic-launch-selection-live-'));
    tempClaudeRoot = subscriptionAuth ? os.userInfo().homedir : path.join(tempDir, '.claude');
    tempHome = path.join(tempDir, 'home');
    projectPath = path.join(tempDir, 'project');
    if (!subscriptionAuth) {
      await fs.mkdir(tempClaudeRoot, { recursive: true });
    }
    await fs.mkdir(tempHome, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Anthropic launch selection live e2e\n\nKeep this project intentionally tiny.\n',
      'utf8'
    );

    if (subscriptionAuth) {
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
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousNodeEnv = process.env.NODE_ENV;
    previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    previousDisableAppBootstrap = process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    previousDisableRuntimeBootstrap = process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    previousRuntimeReadyTimeout = process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS;

    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS?.trim() || '90000';
    process.env.HOME = subscriptionAuth ? os.userInfo().homedir : tempHome;
    process.env.USERPROFILE = subscriptionAuth ? os.userInfo().homedir : tempHome;
    process.env.NODE_ENV = 'production';
    delete process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    if (subscriptionAuth) {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }

    svc = null;
    teamName = null;
  });

  afterEach(async () => {
    const preserveArtifacts = process.env.ANTHROPIC_LAUNCH_SELECTION_KEEP_TEMP === '1';
    const beforeStopSnapshot = svc && teamName ? await safeRuntimeSnapshot(svc, teamName) : null;
    if (svc && teamName) {
      await svc.stopTeam(teamName).catch(() => undefined);
    }
    await terminateSmokeOwnedProcessBackends(beforeStopSnapshot);
    const afterStopSnapshot = svc && teamName ? await safeRuntimeSnapshot(svc, teamName) : null;
    await terminateSmokeOwnedProcessBackends(afterStopSnapshot);

    if (!preserveArtifacts && subscriptionAuth && projectPath) {
      await removeClaudeProjectArtifacts(tempClaudeRoot, projectPath);
    }
    if (!preserveArtifacts && subscriptionAuth && teamName) {
      await removeTeamArtifacts(teamName);
    }
    if (subscriptionAuth && previousClaudeJsonConfig !== undefined) {
      await restoreClaudeJsonConfig(tempClaudeRoot, previousClaudeJsonConfig);
    }
    setClaudeBasePathOverride(null);

    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
    restoreEnv('NODE_ENV', previousNodeEnv);
    restoreEnv('ANTHROPIC_API_KEY', previousAnthropicApiKey);
    restoreEnv('ANTHROPIC_AUTH_TOKEN', previousAnthropicAuthToken);
    restoreEnv('CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableAppBootstrap);
    restoreEnv('CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableRuntimeBootstrap);
    restoreEnv('CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS', previousRuntimeReadyTimeout);

    if (preserveArtifacts) {
      process.stderr.write(`[AnthropicLaunchSelection.live] preserved temp dir: ${tempDir}\n`);
    } else {
      await removeTempDirWithRetries(tempDir);
    }
    if (!preserveArtifacts && subscriptionAuth && projectPath) {
      await removeClaudeProjectArtifacts(tempClaudeRoot, projectPath);
    }
    if (!preserveArtifacts && subscriptionAuth && teamName) {
      await removeTeamArtifacts(teamName);
    }
    if (!preserveArtifacts && subscriptionAuth && (projectPath || teamName)) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    if (!preserveArtifacts && subscriptionAuth && projectPath) {
      await removeClaudeProjectArtifacts(tempClaudeRoot, projectPath);
    }
    if (!preserveArtifacts && subscriptionAuth && teamName) {
      await removeTeamArtifacts(teamName);
    }
    discardKnownAnthropicLaunchSelectionWarnings();
  }, 180_000);

  it('launches Opus 4.6 1M medium lead with explicit Haiku teammate without inherited effort', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const leadModel =
      process.env.ANTHROPIC_LAUNCH_SELECTION_LEAD_MODEL?.trim() || DEFAULT_LEAD_MODEL;
    const memberModel =
      process.env.ANTHROPIC_LAUNCH_SELECTION_MEMBER_MODEL?.trim() || DEFAULT_MEMBER_MODEL;
    const leadEffort = (process.env.ANTHROPIC_LAUNCH_SELECTION_LEAD_EFFORT?.trim() ||
      DEFAULT_LEAD_EFFORT) as TeamCreateRequest['effort'];

    svc = new TeamProvisioningService();
    teamName = `anthropic-launch-selection-live-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];

    const response = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'anthropic',
        model: leadModel,
        effort: leadEffort,
        skipPermissions: true,
        extraCliArgs: "--settings '{\"disableAllHooks\":true}'",
        prompt: 'Keep the team idle after bootstrap. Do not start extra work.',
        members: [
          {
            name: 'jack',
            role: 'Reviewer',
            providerId: 'anthropic',
            model: memberModel,
          },
          {
            name: 'alice',
            role: 'Developer',
          },
        ],
      },
      (progress) => {
        progressEvents.push(progress);
      }
    );

    const run = (
      svc as unknown as { runs: Map<string, { allEffectiveMembers?: TeamMember[] }> }
    ).runs.get(response.runId);
    expect(run?.allEffectiveMembers).toEqual([
      expect.objectContaining({
        name: 'jack',
        providerId: 'anthropic',
        model: memberModel,
        effort: undefined,
      }),
      expect.objectContaining({
        name: 'alice',
        providerId: 'anthropic',
        model: leadModel,
        effort: leadEffort,
      }),
    ]);

    await waitUntil(async () => {
      const last = progressEvents.at(-1);
      if (last?.state === 'failed') {
        throw new Error(formatProgressDump(progressEvents));
      }
      return last?.state === 'ready';
    }, 360_000);

    await waitUntil(
      async () => {
        const statuses = await svc!.getMemberSpawnStatuses(teamName!);
        if (statuses.teamLaunchState === 'partial_failure') {
          throw new Error(await formatLaunchDiagnostics(svc!, teamName!, progressEvents));
        }
        return ['jack', 'alice'].every((memberName) => {
          const member = statuses.statuses[memberName];
          return (
            member?.status === 'online' &&
            member.launchState === 'confirmed_alive' &&
            member.bootstrapConfirmed === true
          );
        });
      },
      240_000,
      2_000,
      () => formatLaunchDiagnostics(svc!, teamName!, progressEvents)
    );

    await waitUntil(
      async () => {
        const snapshot = await svc!.getTeamAgentRuntimeSnapshot(teamName!);
        return (
          snapshot.members.jack?.providerId === 'anthropic' &&
          snapshot.members.jack.alive === true &&
          snapshot.members.alice?.providerId === 'anthropic' &&
          snapshot.members.alice.alive === true
        );
      },
      180_000,
      2_000,
      () => formatLaunchDiagnostics(svc!, teamName!, progressEvents)
    );
  }, 480_000);
});

function usingAnthropicSubscriptionAuth(): boolean {
  const mode = process.env.ANTHROPIC_LAUNCH_SELECTION_AUTH?.trim().toLowerCase();
  return mode === 'subscription' || mode === 'oauth';
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function discardKnownAnthropicLaunchSelectionWarnings(): void {
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

async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.X_OK);
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

async function removeTempDirWithRetries(dirPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 20 : 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function removeTeamArtifacts(teamName: string): Promise<void> {
  const targets = [path.join(getTeamsBasePath(), teamName), path.join(getTasksBasePath(), teamName)];
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await Promise.all(targets.map((target) => fs.rm(target, { recursive: true, force: true })));
    const stillExists = await Promise.all(targets.map(pathExists));
    if (!stillExists.some(Boolean)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await Promise.all(targets.map((target) => fs.rm(target, { recursive: true, force: true })));
}

async function removeClaudeProjectArtifacts(configDir: string, projectPath: string): Promise<void> {
  const projectPaths = new Set([projectPath]);
  if (projectPath.startsWith('/var/')) {
    projectPaths.add(`/private${projectPath}`);
  } else if (projectPath.startsWith('/private/var/')) {
    projectPaths.add(projectPath.slice('/private'.length));
  }
  const canonicalProjectPath = await fs.realpath(projectPath).catch(() => null);
  if (canonicalProjectPath) {
    projectPaths.add(canonicalProjectPath);
  }
  await Promise.all(
    Array.from(projectPaths)
      .flatMap((candidatePath) => [encodePath(candidatePath), encodePathPortable(candidatePath)])
      .filter(Boolean)
      .flatMap((encodedProjectPath) =>
        [
          path.join(configDir, 'projects', encodedProjectPath),
          path.join(configDir, '.claude', 'projects', encodedProjectPath),
        ].map((projectDir) =>
          fs.rm(projectDir, {
            recursive: true,
            force: true,
          })
        )
      )
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeRuntimeSnapshot(
  svc: TeamProvisioningService,
  teamName: string
): Promise<TeamAgentRuntimeSnapshot | null> {
  return svc.getTeamAgentRuntimeSnapshot(teamName).catch(() => null);
}

async function terminateSmokeOwnedProcessBackends(
  snapshot: TeamAgentRuntimeSnapshot | null
): Promise<void> {
  const pids = new Set<number>();
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.backendType !== 'process' || member.providerId !== 'anthropic') {
      continue;
    }
    const pid = member.runtimePid ?? member.pid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      killProcessByPid(pid);
    } catch {
      // Already gone.
    }
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 1_000,
  describeState?: () => string | Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const suffix =
    lastError instanceof Error && lastError.message ? ` Last error: ${lastError.message}` : '';
  const state = describeState ? ` Last state: ${await describeState()}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.${suffix}${state}`);
}

async function formatLaunchDiagnostics(
  svc: TeamProvisioningService,
  teamName: string,
  progressEvents: TeamProvisioningProgress[]
): Promise<string> {
  const [spawnStatuses, runtimeSnapshot] = await Promise.all([
    svc.getMemberSpawnStatuses(teamName).catch((error) => ({ error: String(error) })),
    svc.getTeamAgentRuntimeSnapshot(teamName).catch((error) => ({ error: String(error) })),
  ]);
  return redactSecrets(
    JSON.stringify(
      {
        progress: formatProgressDump(progressEvents),
        spawnStatuses,
        runtimeSnapshot,
      },
      null,
      2
    )
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
