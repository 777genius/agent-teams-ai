// @vitest-environment node
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { describe, expect, it } from 'vitest';

import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli, killProcessTree, spawnCli } from '@main/utils/childProcess';

const execFileAsync = promisify(execFile);
const liveDescribe = process.env.AGENT_CLI_LAUNCH_LIVE_E2E === '1' ? describe : describe.skip;
const CLI_LAUNCH_TIMEOUT_MS = 15_000;

type AgentCliProvider = 'opencode' | 'codex' | 'claude';

type AgentCliSpec = {
  providerId: AgentCliProvider;
  command: string;
  overrideEnv: string;
  versionPattern: RegExp;
  resolver?: () => Promise<string | null>;
};

const AGENT_CLI_SPECS: AgentCliSpec[] = [
  {
    providerId: 'opencode',
    command: 'opencode',
    overrideEnv: 'OPENCODE_CLI_PATH',
    versionPattern: /\b\d+\.\d+\.\d+\b/,
  },
  {
    providerId: 'codex',
    command: 'codex',
    overrideEnv: 'CODEX_CLI_PATH',
    versionPattern: /\b(?:codex-cli\s+)?\d+\.\d+\.\d+\b/i,
    resolver: () => CodexBinaryResolver.resolve(),
  },
  {
    providerId: 'claude',
    command: 'claude',
    overrideEnv: 'CLAUDE_CLI_PATH',
    versionPattern: /\b\d+\.\d+\.\d+\b.*Claude Code/i,
    resolver: () => ClaudeBinaryResolver.resolve(),
  },
];

liveDescribe('agent CLI launch live e2e', () => {
  it.each(AGENT_CLI_SPECS)(
    'resolves and executes $providerId through execCli without tmux',
    async (spec) => {
      const binaryPath = await resolveCliBinary(spec);
      expect(binaryPath, `${spec.providerId} binary must be installed`).toBeTruthy();

      const result = await execCli(binaryPath, ['--version'], {
        timeout: CLI_LAUNCH_TIMEOUT_MS,
        windowsHide: true,
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();

      expect(output).toMatch(spec.versionPattern);
      expect(output).not.toMatch(/tmux/i);
      expect(output).not.toMatch(/running scripts is disabled/i);
      expect(output).not.toMatch(/not digitally signed/i);
    },
    CLI_LAUNCH_TIMEOUT_MS + 5_000
  );

  it.each(AGENT_CLI_SPECS)(
    'spawns $providerId through spawnCli and exits cleanly without tmux',
    async (spec) => {
      const binaryPath = await resolveCliBinary(spec);
      expect(binaryPath, `${spec.providerId} binary must be installed`).toBeTruthy();

      const result = await spawnAndCollect(binaryPath, ['--version']);
      const output = `${result.stdout}\n${result.stderr}`.trim();

      expect(result.exitCode).toBe(0);
      expect(output).toMatch(spec.versionPattern);
      expect(output).not.toMatch(/tmux/i);
      expect(output).not.toMatch(/running scripts is disabled/i);
      expect(output).not.toMatch(/not digitally signed/i);
    },
    CLI_LAUNCH_TIMEOUT_MS + 5_000
  );
});

async function resolveCliBinary(spec: AgentCliSpec): Promise<string> {
  const override = process.env[spec.overrideEnv]?.trim();
  if (override) {
    return override;
  }

  if (spec.resolver) {
    const resolved = await spec.resolver();
    if (resolved) {
      return preferWindowsCmdShim(resolved);
    }
  }

  return preferWindowsCmdShim(await resolveCommandFromPath(spec.command));
}

async function resolveCommandFromPath(command: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('where.exe', [command], {
      timeout: CLI_LAUNCH_TIMEOUT_MS,
      windowsHide: true,
    });
    const candidates = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const cmdCandidate = candidates.find((candidate) => /\.cmd$/i.test(candidate));
    return cmdCandidate ?? candidates[0] ?? command;
  }

  const { stdout } = await execFileAsync('which', [command], {
    timeout: CLI_LAUNCH_TIMEOUT_MS,
  });
  return stdout.trim().split(/\r?\n/)[0] ?? command;
}

function preferWindowsCmdShim(binaryPath: string): string {
  if (process.platform !== 'win32') {
    return binaryPath;
  }

  const extension = path.extname(binaryPath).toLowerCase();
  if (extension === '.cmd') {
    return binaryPath;
  }

  const cmdPeer = extension ? `${binaryPath.slice(0, -extension.length)}.cmd` : `${binaryPath}.cmd`;
  return fs.existsSync(cmdPeer) ? cmdPeer : binaryPath;
}

function spawnAndCollect(
  binaryPath: string,
  args: string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProcessTree(child, 'SIGKILL');
        reject(new Error(`Timed out launching ${binaryPath}`));
      }
    }, CLI_LAUNCH_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once('close', (exitCode) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      }
    });
  });
}
