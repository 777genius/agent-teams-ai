import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';

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
    getAutoDetectedClaudeBasePath: () => tempClaudeRoot,
    getClaudeBasePath: () => tempClaudeRoot,
    getTeamsBasePath: () => tempTeamsBase,
    getTasksBasePath: () => tempTasksBase,
  };
});

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
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
    tempClaudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-prompts-'));
    tempTeamsBase = path.join(tempClaudeRoot, 'teams');
    tempTasksBase = path.join(tempClaudeRoot, 'tasks');
    fs.mkdirSync(tempTeamsBase, { recursive: true });
    fs.mkdirSync(tempTasksBase, { recursive: true });
  });

  afterEach(() => {
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
    expect(prompt).toContain('task_start');
    expect(prompt).toContain('task_complete');
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
});
