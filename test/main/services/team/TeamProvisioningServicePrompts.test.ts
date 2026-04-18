import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';

const hoisted = vi.hoisted(() => ({
  paths: {
    claudeRoot: '',
    teamsBase: '',
    tasksBase: '',
  },
}));

let tempClaudeRoot = '';
let tempTeamsBase = '';
let tempTasksBase = '';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getAutoDetectedClaudeBasePath: () => hoisted.paths.claudeRoot,
    getClaudeBasePath: () => hoisted.paths.claudeRoot,
    getTeamsBasePath: () => hoisted.paths.teamsBase,
    getTasksBasePath: () => hoisted.paths.tasksBase,
  };
});

import {
  buildAddMemberSpawnMessage,
  TeamProvisioningService,
} from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { spawnCli } from '@main/utils/childProcess';
import { setAppDataBasePath } from '@main/utils/pathDecoder';

function createFakeChild() {
  const writeSpy = vi.fn((_data: unknown, cb?: (err?: Error | null) => void) => {
    if (typeof cb === 'function') cb(null);
    return true;
  });
  const endSpy = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: { writable: true, write: writeSpy, end: endSpy },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return { child, writeSpy };
}

function extractPromptFromBootstrapFile(callIndex = 0): string {
  const args = vi.mocked(spawnCli).mock.calls[callIndex]?.[1] as string[] | undefined;
  const promptFlagIndex = args?.indexOf('--team-bootstrap-user-prompt-file') ?? -1;
  const promptPath = promptFlagIndex >= 0 ? args?.[promptFlagIndex + 1] : null;
  if (!promptPath) {
    throw new Error('Failed to extract bootstrap prompt file path from spawn args');
  }
  return fs.readFileSync(promptPath, 'utf8');
}

function extractBootstrapSpec(callIndex = 0): {
  mode?: string;
  team?: { name?: string; cwd?: string };
  lead?: { permissionSeedTools?: string[] };
  members?: Array<Record<string, unknown>>;
} {
  const args = vi.mocked(spawnCli).mock.calls[callIndex]?.[1] as string[] | undefined;
  const specFlagIndex = args?.indexOf('--team-bootstrap-spec') ?? -1;
  const specPath = specFlagIndex >= 0 ? args?.[specFlagIndex + 1] : null;
  if (!specPath) {
    throw new Error('Failed to extract bootstrap spec path from spawn args');
  }
  return JSON.parse(fs.readFileSync(specPath, 'utf8')) as {
    mode?: string;
    team?: { name?: string; cwd?: string };
    lead?: { permissionSeedTools?: string[] };
    members?: Array<Record<string, unknown>>;
  };
}

describe('TeamProvisioningService prompt content (solo mode discipline)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempClaudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-prompts-'));
    tempTeamsBase = path.join(tempClaudeRoot, 'teams');
    tempTasksBase = path.join(tempClaudeRoot, 'tasks');
    hoisted.paths.claudeRoot = tempClaudeRoot;
    hoisted.paths.teamsBase = tempTeamsBase;
    hoisted.paths.tasksBase = tempTasksBase;
    setAppDataBasePath(tempClaudeRoot);
    fs.mkdirSync(tempTeamsBase, { recursive: true });
    fs.mkdirSync(tempTasksBase, { recursive: true });
  });

  afterEach(() => {
    setAppDataBasePath(null);
    // Best-effort cleanup of temp dir (per-test)
    try {
      fs.rmSync(tempClaudeRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('createTeam uses deterministic bootstrap spec and safe flags in solo mode', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    const { runId } = await svc.createTeam(
      {
        teamName: 'solo-team',
        cwd: process.cwd(),
        members: [],
        description: 'Solo team for prompt test',
      },
      () => {}
    );

    expect(writeSpy).not.toHaveBeenCalled();
    const bootstrapSpec = extractBootstrapSpec();
    expect(bootstrapSpec.mode).toBe('create');
    expect(bootstrapSpec.team).toMatchObject({
      name: 'solo-team',
      cwd: process.cwd(),
    });
    expect(bootstrapSpec.members).toEqual([]);

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain('--mcp-config');
    expect(launchArgs).toContain('--team-bootstrap-spec');
    expect(launchArgs).not.toContain('--team-bootstrap-user-prompt-file');
    expect(launchArgs).not.toContain('--strict-mcp-config');
    expect(launchArgs).toContain('--disallowedTools');
    const disallowed = launchArgs[launchArgs.indexOf('--disallowedTools') + 1] ?? '';
    expect(disallowed).not.toContain('Agent');
    expect(disallowed).toContain('mcp__agent-teams__team_launch');

    await svc.cancelProvisioning(runId);
  });

  it('launchTeam prompt (solo) uses deterministic refresh-only reconnect instructions', async () => {
    // Seed config.json so launchTeam can validate team existence.
    const teamName = 'solo-team-launch';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        description: 'Solo team for prompt test',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
    (svc as any).persistLaunchStateSnapshot = vi.fn(async () => {});
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [],
      source: 'config-fallback',
      warning: undefined,
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);
    (svc as any).startFilesystemMonitor = vi.fn();

    const { runId } = await svc.launchTeam(
      {
        teamName,
        cwd: process.cwd(),
        clearContext: true,
      } as any,
      () => {}
    );

    expect(writeSpy).not.toHaveBeenCalled();
    const prompt = extractPromptFromBootstrapFile();
    expect(prompt).toContain('SOLO MODE: This team CURRENTLY has ZERO teammates.');
    expect(prompt).toContain('This reconnect/bootstrap step has already been completed deterministically by the runtime.');
    expect(prompt).toContain('Do NOT start implementation in this turn.');
    expect(prompt).toContain('Use this turn only to refresh context, review the current board snapshot, and confirm you are ready.');
    expect(prompt).toContain(
      'Do NOT create, assign, or delegate any new task in this turn. If the board is empty, stay silent and wait for a fresh user instruction.'
    );
    expect(prompt).toContain(
      'review_request already notifies the reviewer, so do NOT send a second manual SendMessage for the same review request'
    );
    expect(prompt).toContain(
      'Review is a state transition on the EXISTING work task.'
    );
    expect(prompt).toContain(
      'The REVIEW column is for the same task #X moving through review. It is NOT a signal to create another task for review.'
    );
    expect(prompt).toContain('task_create_from_message');
    expect(prompt).toContain(`AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}`);
    expect(prompt).toContain(`AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}`);
    expect(prompt).not.toContain('teamctl.js');
    expect(prompt).not.toContain('.claude/tools');

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain('--mcp-config');
    expect(launchArgs).not.toContain('--strict-mcp-config');

    await svc.cancelProvisioning(runId);
  });

  it('createTeam bootstrap spec carries teammate descriptors for deterministic startup', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    const { runId } = await svc.createTeam(
      {
        teamName: 'multi-team',
        cwd: process.cwd(),
        members: [{ name: 'alice', role: 'developer' }],
        description: 'Multi team prompt test',
      },
      () => {}
    );

    expect(writeSpy).not.toHaveBeenCalled();
    const bootstrapSpec = extractBootstrapSpec();
    expect(bootstrapSpec.mode).toBe('create');
    expect(bootstrapSpec.members).toEqual([
      expect.objectContaining({
        name: 'alice',
        role: 'developer',
        description: 'developer',
        cwd: process.cwd(),
      }),
    ]);

    await svc.cancelProvisioning(runId);
  });

  it('createTeam materializes an explicit Codex default model for teammates before bootstrap spawn', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { PATH: '/usr/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    }));
    (svc as any).resolveProviderDefaultModel = vi.fn(async () => 'gpt-5.4');
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    const { runId } = await svc.createTeam(
      {
        teamName: 'codex-default-team',
        cwd: process.cwd(),
        providerId: 'codex',
        members: [{ name: 'alice', role: 'developer', providerId: 'codex' }],
      },
      () => {}
    );

    const bootstrapSpec = extractBootstrapSpec();
    expect(bootstrapSpec.members).toEqual([
      expect.objectContaining({
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4',
      }),
    ]);

    await svc.cancelProvisioning(runId);
  });

  it('createTeam fails fast when a Codex teammate default model cannot be resolved', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    vi.mocked(spawnCli).mockReset();

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { PATH: '/usr/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    }));
    (svc as any).resolveProviderDefaultModel = vi.fn(async () => null);
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    await expect(
      svc.createTeam(
        {
          teamName: 'codex-default-missing',
          cwd: process.cwd(),
          providerId: 'codex',
          members: [{ name: 'alice', providerId: 'codex' }],
        },
        () => {}
      )
    ).rejects.toThrow(
      'Could not resolve the runtime default model for Codex teammates. Select an explicit model and retry.'
    );

    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('add-member spawn prompt tells teammates to keep review on the same task', () => {
    const prompt = buildAddMemberSpawnMessage('my-team', 'My Team', 'team-lead', {
      name: 'alice',
      role: 'developer',
    });

    expect(prompt).toContain('Review flow rule: review is a state transition on the SAME work task');
    expect(prompt).toContain('Do NOT create a separate "review task"');
    expect(prompt).toContain(
      'If no reviewer exists, leave #X completed.'
    );
    expect(prompt).toContain(
      'If you are the reviewer for task #X, call review_start on #X first, then review_approve or review_request_changes on #X itself.'
    );
  });

  it('launchTeam hydration prompt includes task-comment handling guidance by default', async () => {
    const teamName = 'forward-live-team';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        description: 'Task comment forwarding live prompt test',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'teammate', role: 'developer' },
        ],
      }),
      'utf8'
    );

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
    (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
    (svc as any).persistLaunchStateSnapshot = vi.fn(async () => {});
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice', role: 'developer' }],
      source: 'config-fallback',
      warning: undefined,
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    const { runId } = await svc.launchTeam(
      {
        teamName,
        cwd: process.cwd(),
        clearContext: true,
      },
      () => {}
    );

    expect(writeSpy).not.toHaveBeenCalled();
    const prompt = extractPromptFromBootstrapFile();
    expect(prompt).toContain(
      'Teammate task comments are auto-forwarded to you.'
    );

    await svc.cancelProvisioning(runId);
  });

  it('launchTeam reconnect prompt for teammates includes explicit hidden-instruction block rules', async () => {
    const teamName = 'multi-team-launch';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        description: 'Multi team prompt test',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'teammate', role: 'developer' },
        ],
      }),
      'utf8'
    );

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
    (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
    (svc as any).persistLaunchStateSnapshot = vi.fn(async () => {});
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice', role: 'developer' }],
      source: 'config-fallback',
      warning: undefined,
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);
    (svc as any).startFilesystemMonitor = vi.fn();

    const { runId } = await svc.launchTeam(
      {
        teamName,
        cwd: process.cwd(),
        clearContext: true,
      } as any,
      () => {}
    );

    expect(writeSpy).not.toHaveBeenCalled();
    const prompt = extractPromptFromBootstrapFile();
    expect(prompt).toContain('This reconnect/bootstrap step has already been completed deterministically by the runtime.');
    expect(prompt).toContain('Do NOT use Agent to spawn or restore teammates.');
    expect(prompt).toContain('Use this turn only to refresh context and review the current board snapshot.');
    expect(prompt).toContain(
      'Do NOT create, assign, or delegate any new task in this turn. If the board is empty, stay silent and wait for a fresh user instruction.'
    );
    expect(prompt).toContain('DELEGATION-FIRST (behavior rule for ALL future turns):');
    expect(prompt).toContain(`AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}`);
    expect(prompt).toContain(`AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}`);
    expect(prompt).toContain('Messages to "user" (the human) must NEVER contain agent-only blocks.');
    expect(prompt).toContain('task_create_from_message');
    expect(prompt).toContain('task_set_owner');
    expect(prompt).toContain('cross_team_send');
    expect(prompt).toContain(
      'review_request already notifies the reviewer'
    );
    expect(prompt).toContain(
      'By default, NEVER create a separate "review task".'
    );
    expect(prompt).toContain(
      'Only move #X into REVIEW when a real reviewer exists for #X.'
    );
    expect(prompt).not.toContain(
      'Only create a separate review reminder/assignment task'
    );
    expect(prompt).toContain(
      'Correct flow: finish implementation on #X -> task_complete #X -> review_request #X -> reviewer runs review_start #X -> reviewer runs review_approve or review_request_changes on #X.'
    );

    await svc.cancelProvisioning(runId);
  });

  it('launchTeam materializes an explicit Codex default model for launch teammates before bootstrap spawn', async () => {
    const teamName = 'codex-default-launch';
    const teamDir = path.join(tempTeamsBase, teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        members: [
          { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
          { name: 'alice', agentType: 'teammate', role: 'developer', providerId: 'codex' },
        ],
      }),
      'utf8'
    );

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { PATH: '/usr/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    }));
    (svc as any).resolveProviderDefaultModel = vi.fn(async () => 'gpt-5.4');
    (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
    (svc as any).updateConfigProjectPath = vi.fn(async () => {});
    (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
    (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
    (svc as any).persistLaunchStateSnapshot = vi.fn(async () => {});
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice', role: 'developer', providerId: 'codex' }],
      source: 'config-fallback',
      warning: undefined,
    }));
    (svc as any).validateAgentTeamsMcpRuntime = vi.fn(async () => {});
    (svc as any).pathExists = vi.fn(async () => false);
    (svc as any).startFilesystemMonitor = vi.fn();

    const { runId } = await svc.launchTeam(
      {
        teamName,
        cwd: process.cwd(),
        providerId: 'codex',
        clearContext: true,
      } as any,
      () => {}
    );

    const bootstrapSpec = extractBootstrapSpec();
    expect(bootstrapSpec.members).toEqual([
      expect.objectContaining({
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4',
      }),
    ]);

    await svc.cancelProvisioning(runId);
  });
});
