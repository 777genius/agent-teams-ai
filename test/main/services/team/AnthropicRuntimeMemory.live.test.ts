import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type {
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';

const liveDescribe =
  process.env.ANTHROPIC_RUNTIME_MEMORY_LIVE === '1' && process.env.ANTHROPIC_API_KEY?.trim()
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const DEFAULT_MODEL = 'haiku';

liveDescribe('Anthropic runtime memory live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousDisableAppBootstrap: string | undefined;
  let previousDisableRuntimeBootstrap: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let svc: TeamProvisioningService | null;
  let teamName: string | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anthropic-runtime-memory-live-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    const tempHome = path.join(tempDir, 'home');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    await fs.mkdir(tempHome, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousDisableAppBootstrap = process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    previousDisableRuntimeBootstrap = process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    delete process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
    svc = null;
    teamName = null;
  });

  afterEach(async () => {
    if (svc && teamName) {
      await svc.stopTeam(teamName).catch(() => undefined);
    }
    setClaudeBasePathOverride(null);
    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableAppBootstrap);
    restoreEnv('CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP', previousDisableRuntimeBootstrap);
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a real Anthropic team and reports teammate RSS in the runtime snapshot', async () => {
    const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    expect(orchestratorCli).toBeTruthy();
    await assertExecutable(orchestratorCli!);

    const selectedModel = process.env.ANTHROPIC_RUNTIME_MEMORY_LIVE_MODEL?.trim() || DEFAULT_MODEL;
    teamName = `anthropic-memory-live-${Date.now()}`;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Anthropic runtime memory live e2e\n',
      'utf8'
    );

    svc = new TeamProvisioningService();
    const progressEvents: TeamProvisioningProgress[] = [];

    await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'anthropic',
        model: selectedModel,
        skipPermissions: true,
        prompt: 'Keep the team idle after bootstrap. Do not start extra work.',
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'anthropic',
            model: selectedModel,
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
      if (last?.state === 'ready') {
        return true;
      }
      return false;
    }, 240_000);

    let snapshot: TeamAgentRuntimeSnapshot | null = null;
    await waitUntil(async () => {
      snapshot = await svc!.getTeamAgentRuntimeSnapshot(teamName!);
      const alice = snapshot.members.alice;
      return (
        alice?.providerId === 'anthropic' &&
        alice.pidSource === 'agent_process_table' &&
        alice.livenessKind === 'runtime_process' &&
        typeof alice.pid === 'number' &&
        typeof alice.rssBytes === 'number' &&
        alice.rssBytes > 0
      );
    }, 60_000);

    expect(snapshot!.members.alice).toMatchObject({
      alive: true,
      providerId: 'anthropic',
      pidSource: 'agent_process_table',
      livenessKind: 'runtime_process',
      runtimeModel: selectedModel,
    });
    expect(snapshot!.members.alice.rssBytes).toBeGreaterThan(0);
  }, 300_000);
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.X_OK);
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const suffix =
    lastError instanceof Error && lastError.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.${suffix}`);
}

function formatProgressDump(progressEvents: TeamProvisioningProgress[]): string {
  return progressEvents
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
    .join('\n');
}
