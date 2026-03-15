import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';

let tempClaudeRoot = '';
let tempTeamsBase = '';
let tempTasksBase = '';
let originalMemberBriefingBootstrapEnv: string | undefined;

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
    getAutoDetectedClaudeBasePath: () => tempClaudeRoot,
    getClaudeBasePath: () => tempClaudeRoot,
    getTeamsBasePath: () => tempTeamsBase,
    getTasksBasePath: () => tempTasksBase,
  };
});

import {
  MEMBER_BRIEFING_BOOTSTRAP_ENV,
  TeamProvisioningService,
} from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { spawnCli } from '@main/utils/childProcess';

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

function extractPromptFromWrite(writeSpy: ReturnType<typeof vi.fn>): string {
  const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
  const parsed = JSON.parse(payload) as {
    type: string;
    message?: { role: string; content: { type: string; text?: string }[] };
  };
  const text = parsed.message?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Failed to extract prompt text from stdin write payload');
  }
  return text;
}

describe('TeamProvisioningService prompt content (solo mode discipline)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalMemberBriefingBootstrapEnv = process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV];
    process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV] = '1';
    tempClaudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-prompts-'));
    tempTeamsBase = path.join(tempClaudeRoot, 'teams');
    tempTasksBase = path.join(tempClaudeRoot, 'tasks');
    fs.mkdirSync(tempTeamsBase, { recursive: true });
    fs.mkdirSync(tempTasksBase, { recursive: true });
  });

  afterEach(() => {
    if (originalMemberBriefingBootstrapEnv === undefined) {
      delete process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV];
    } else {
      process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV] = originalMemberBriefingBootstrapEnv;
    }
    // Best-effort cleanup of temp dir (per-test)
    try {
      fs.rmSync(tempClaudeRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('createTeam prompt (solo) mandates sequential status + frequent user updates', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
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

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const prompt = extractPromptFromWrite(writeSpy);
    expect(prompt).toContain('SOLO MODE: This team CURRENTLY has ZERO teammates.');
    expect(prompt).toContain('PROGRESS REPORTING (MANDATORY)');
    expect(prompt).toContain('Never bulk-move many tasks at the end');
    expect(prompt).toContain('Default to working ONE task at a time');
    expect(prompt).toContain(
      'review_request already notifies the reviewer, so do NOT send a second manual SendMessage for the same review request'
    );
    expect(prompt).toContain('task_start');
    expect(prompt).toContain('task_complete');
    expect(prompt).toContain('TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):');
    expect(prompt).toContain('ASK: Strict read-only conversation mode.');
    expect(prompt).toContain('DELEGATE: Strict orchestration mode for leads.');
    expect(prompt).toContain(`AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}`);
    expect(prompt).toContain(`AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}`);
    expect(prompt).not.toContain('teamctl.js');
    expect(prompt).not.toContain('.claude/tools');

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain('--mcp-config');
    expect(launchArgs).not.toContain('--strict-mcp-config');

    await svc.cancelProvisioning(runId);
  });

  it('launchTeam prompt (solo) requires sequential execution and incremental updates', async () => {
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
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [],
      source: 'config-fallback',
      warning: undefined,
    }));
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

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const prompt = extractPromptFromWrite(writeSpy);
    expect(prompt).toContain('SOLO MODE: This team CURRENTLY has ZERO teammates.');
    expect(prompt).toContain('Execute tasks sequentially and keep the board + user updated');
    expect(prompt).toContain('Do NOT start the next task until the current task is completed');
    expect(prompt).toContain('Do NOT delay this reconnect turn by reading internal config files');
    expect(prompt).toContain('Treat it as a diagnostic cross-check, not as the first reconnect action.');
    expect(prompt).toContain(
      'review_request already notifies the reviewer, so do NOT send a second manual SendMessage for the same review request'
    );
    expect(prompt).toContain('task_start');
    expect(prompt).toContain(`AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}`);
    expect(prompt).toContain(`AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}`);
    expect(prompt).not.toContain('teamctl.js');
    expect(prompt).not.toContain('.claude/tools');

    const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain('--mcp-config');
    expect(launchArgs).not.toContain('--strict-mcp-config');

    await svc.cancelProvisioning(runId);
  });

  it('createTeam prompt for teammates includes explicit hidden-instruction block rules', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
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

    const prompt = extractPromptFromWrite(writeSpy);
    expect(prompt).toContain('Hidden internal instructions rule (IMPORTANT):');
    expect(prompt).toContain(`  ${AGENT_BLOCK_OPEN}`);
    expect(prompt).toContain(`  ${AGENT_BLOCK_CLOSE}`);
    expect(prompt).toContain('NEVER use agent-only blocks in messages to "user".');
    expect(prompt).toContain('TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):');
    expect(prompt).toContain('DO: Full execution mode.');
    expect(prompt).toContain('DELEGATE: Strict orchestration mode for leads.');
    expect(prompt).toContain('Your FIRST action: call MCP tool member_briefing');
    expect(prompt).toContain('Do NOT start work, claim tasks, or improvise workflow/task/process rules');
    expect(prompt).toContain('If member_briefing fails, send a short message to your team lead');
    expect(prompt).toContain('Introduce yourself briefly (name and role) and confirm you are ready');
    expect(prompt).toContain('use task_briefing as your compact queue view');
    expect(prompt).toContain('Use task_get when you need the full task context before starting a pending/needsFix task');
    expect(prompt).toContain(
      'If that teammate already has another in_progress task, create/keep the new task in pending/TODO. Do NOT mark it in_progress for them yet.'
    );
    expect(prompt).toContain(
      'leave a short task comment on that waiting task right away with the reason and your best ETA, keep it in pending/TODO'
    );
    expect(prompt).toContain(
      'Direct messages to your team lead are only for urgent attention, no-task situations, or when the lead explicitly asked for a direct reply.'
    );
    expect(prompt).toContain(
      'do NOT send a duplicate SendMessage to the lead with the same content unless you need urgent non-task attention.'
    );
    expect(prompt).not.toContain('Include the following agent-only instructions verbatim in the prompt:');
    expect(prompt).not.toContain('runtime forwards task comments to the lead automatically');

    await svc.cancelProvisioning(runId);
  });

  it('includes task-comment forwarding wording by default', async () => {
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    const { runId } = await svc.createTeam(
      {
        teamName: 'forward-live-team',
        cwd: process.cwd(),
        members: [{ name: 'alice', role: 'developer' }],
        description: 'Task comment forwarding live prompt test',
      },
      () => {}
    );

    const prompt = extractPromptFromWrite(writeSpy);
    expect(prompt).toContain(
      'do NOT send a duplicate SendMessage to the lead with the same content unless you need urgent non-task attention.'
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
    (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
      members: [{ name: 'alice', role: 'developer' }],
      source: 'config-fallback',
      warning: undefined,
    }));
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

    const prompt = extractPromptFromWrite(writeSpy);
    expect(prompt).toContain('The team has been reconnected after a restart.');
    expect(prompt).toContain('Restore/start the existing teammates first.');
    expect(prompt).toContain('Treat it as a diagnostic cross-check, not as the first reconnect action.');
    expect(prompt).toContain('Hidden internal instructions rule (IMPORTANT):');
    expect(prompt).toContain(`  ${AGENT_BLOCK_OPEN}`);
    expect(prompt).toContain(`  ${AGENT_BLOCK_CLOSE}`);
    expect(prompt).toContain('NEVER use agent-only blocks in messages to "user".');
    expect(prompt).toContain('Your FIRST action: call MCP tool member_briefing');
    expect(prompt).toContain('Do NOT start work, claim tasks, or improvise workflow/task/process rules');
    expect(prompt).toContain('If member_briefing fails, send a short message to your team lead');
    expect(prompt).toContain('After member_briefing succeeds:');
    expect(prompt).toContain('Use task_briefing as your compact queue view.');
    expect(prompt).toContain('resume/finish those first');
    expect(prompt).toContain('Call task_get only if you need more context than task_briefing already gave you');
    expect(prompt).toContain('Before you start any needsFix or pending task, call task_get');
    expect(prompt).toContain(
      'If you assign a task to a member who already has another in_progress task, keep the newly assigned task pending/TODO. Do NOT move it to in_progress until that member actually starts it.'
    );
    expect(prompt).toContain(
      'leave a short task comment on that waiting task with the reason and your best ETA, keep it in pending/TODO'
    );

    await svc.cancelProvisioning(runId);
  });

  it('createTeam prompt falls back to legacy inline protocol when bootstrap flag is disabled', async () => {
    process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV] = '0';
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    const { child, writeSpy } = createFakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as any);

    const svc = new TeamProvisioningService();
    (svc as any).buildProvisioningEnv = vi.fn(async () => ({
      env: { ANTHROPIC_API_KEY: 'test' },
      authSource: 'anthropic_api_key',
    }));
    (svc as any).startFilesystemMonitor = vi.fn();
    (svc as any).pathExists = vi.fn(async () => false);

    const { runId } = await svc.createTeam(
      {
        teamName: 'legacy-team',
        cwd: process.cwd(),
        members: [{ name: 'alice', role: 'developer' }],
        description: 'Legacy prompt fallback test',
      },
      () => {}
    );

    const prompt = extractPromptFromWrite(writeSpy);
    expect(prompt).toContain('Include the following agent-only instructions verbatim in the prompt:');
    expect(prompt).toContain('Use task_briefing as a compact queue view of your assigned tasks.');
    expect(prompt).toContain(
      'If a newly assigned task must wait because you are still busy on another task, immediately add a short task comment on that waiting task with the reason and your best ETA.'
    );
    expect(prompt).not.toContain('Your FIRST action: call MCP tool member_briefing');

    await svc.cancelProvisioning(runId);
  });
});
