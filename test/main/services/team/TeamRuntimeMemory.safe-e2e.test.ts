import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

describe('Team runtime memory safe e2e', () => {
  let tempDir: string;
  let child: ChildProcess | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-runtime-memory-e2e-'));
    await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));
    child = null;
  });

  afterEach(async () => {
    if (child?.pid) {
      child.kill('SIGTERM');
      await waitForExit(child, 2_000).catch(() => {
        if (child?.pid) child.kill('SIGKILL');
      });
    }
    setClaudeBasePathOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reports RSS for a bootstrap-confirmed Anthropic teammate discovered from the real process table', async () => {
    const teamName = `anthropic-rss-${process.pid}`;
    const memberName = 'alice';
    const agentId = `${memberName}@${teamName}`;
    const projectPath = path.join(tempDir, 'project');
    const runtimeScriptPath = path.join(tempDir, 'anthropic-runtime-fixture.mjs');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      runtimeScriptPath,
      [
        'const keepAlive = setInterval(() => {}, 1000);',
        "process.on('SIGTERM', () => { clearInterval(keepAlive); process.exit(0); });",
      ].join('\n'),
      'utf8'
    );
    await writeTeamFixture({
      tempDir,
      teamName,
      projectPath,
      memberName,
      agentId,
    });

    child = spawn(
      process.execPath,
      [
        runtimeScriptPath,
        '--agent-id',
        agentId,
        '--agent-name',
        memberName,
        '--team-name',
        teamName,
        '--model',
        'claude-sonnet-4-6',
      ],
      {
        cwd: projectPath,
        stdio: 'ignore',
      }
    );
    expect(child.pid).toEqual(expect.any(Number));
    await waitForProcessCommand(child.pid!, agentId, teamName);

    const snapshot = await new TeamProvisioningService().getTeamAgentRuntimeSnapshot(teamName);

    expect(snapshot.members[memberName]).toMatchObject({
      alive: true,
      providerId: 'anthropic',
      pid: child.pid,
      pidSource: 'agent_process_table',
      livenessKind: 'runtime_process',
      runtimeModel: 'claude-sonnet-4-6',
      historicalBootstrapConfirmed: true,
    });
    expect(snapshot.members[memberName]?.rssBytes).toEqual(expect.any(Number));
    expect(snapshot.members[memberName]?.rssBytes).toBeGreaterThan(0);
  });

  const cliSmokeIt =
    process.env.ANTHROPIC_RUNTIME_MEMORY_CLI_SMOKE === '1' &&
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() &&
    existsSync(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.trim())
      ? it
      : it.skip;

  cliSmokeIt('reports RSS for a real Anthropic teammate CLI process', async () => {
    const teamName = `anthropic-cli-rss-${process.pid}`;
    const memberName = 'alice';
    const agentId = `${memberName}@${teamName}`;
    const projectPath = path.join(tempDir, 'project');
    const cliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!.trim();
    await fs.mkdir(projectPath, { recursive: true });
    await writeTeamFixture({
      tempDir,
      teamName,
      projectPath,
      memberName,
      agentId,
    });

    let stderrTail = '';
    child = spawn(
      cliPath,
      [
        '--agent-id',
        agentId,
        '--agent-name',
        memberName,
        '--team-name',
        teamName,
        '--model',
        'claude-sonnet-4-6',
      ],
      {
        cwd: projectPath,
        env: {
          ...process.env,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          NO_UPDATE_NOTIFIER: '1',
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      }
    );
    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-4_000);
    });
    expect(child.pid).toEqual(expect.any(Number));
    await waitForProcessCommand(child.pid!, agentId, teamName, () => stderrTail);

    const snapshot = await new TeamProvisioningService().getTeamAgentRuntimeSnapshot(teamName);

    expect(snapshot.members[memberName]).toMatchObject({
      alive: true,
      providerId: 'anthropic',
      pid: child.pid,
      pidSource: 'agent_process_table',
      livenessKind: 'runtime_process',
      runtimeModel: 'claude-sonnet-4-6',
      historicalBootstrapConfirmed: true,
    });
    expect(snapshot.members[memberName]?.rssBytes).toEqual(expect.any(Number));
    expect(snapshot.members[memberName]?.rssBytes).toBeGreaterThan(0);
  });
});

async function writeTeamFixture(params: {
  tempDir: string;
  teamName: string;
  projectPath: string;
  memberName: string;
  agentId: string;
}): Promise<void> {
  const teamDir = path.join(params.tempDir, '.claude', 'teams', params.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: params.teamName,
        projectPath: params.projectPath,
        leadSessionId: 'lead-session',
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            role: 'Lead',
            providerId: 'anthropic',
          },
          {
            name: params.memberName,
            role: 'Developer',
            providerId: 'anthropic',
            model: 'claude-sonnet-4-6',
            agentId: params.agentId,
            backendType: 'tmux',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(
      {
        version: 2,
        teamName: params.teamName,
        updatedAt: '2026-04-24T12:00:00.000Z',
        leadSessionId: 'lead-session',
        launchPhase: 'active',
        expectedMembers: [params.memberName],
        members: {
          [params.memberName]: {
            name: params.memberName,
            providerId: 'anthropic',
            model: 'claude-sonnet-4-6',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            lastHeartbeatAt: '2026-04-24T12:00:00.000Z',
            lastEvaluatedAt: '2026-04-24T12:00:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'clean_success',
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function waitForProcessCommand(
  pid: number,
  agentId: string,
  teamName: string,
  getDebugTail: () => string = () => ''
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const output = await readProcessCommand(pid).catch(() => '');
    if (output.includes(agentId) && output.includes(teamName)) {
      return;
    }
    await sleep(100);
  }
  const debugTail = getDebugTail().trim();
  throw new Error(
    `Process ${pid} did not appear in ps with expected team identity${
      debugTail ? `\nCLI stderr tail:\n${debugTail}` : ''
    }`
  );
}

function readProcessCommand(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('ps', ['-p', String(pid), '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    ps.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    ps.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `ps exited with ${code}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for process exit'));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
