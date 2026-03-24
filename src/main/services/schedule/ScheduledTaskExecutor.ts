/**
 * One-shot executor for scheduled tasks.
 *
 * Spawns `claude -p <prompt>` as a child process with stream-json output,
 * captures stdout/stderr, and returns the result when the process exits.
 *
 * Uses `--output-format stream-json` so the renderer can display rich logs
 * (thinking blocks, tool cards, markdown) via CliLogsRichView.
 */

import { killProcessTree, spawnCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';

import { ClaudeBinaryResolver } from '../team/ClaudeBinaryResolver';

import type { ScheduleLaunchConfig, ScheduleRun } from '@shared/types';
import type { ChildProcess } from 'child_process';

const logger = createLogger('Service:ScheduledTaskExecutor');

const STDOUT_MAX_BYTES = 512 * 1024; // 512KB — stream-json is verbose (JSON wrappers, thinking, tool_use)
const STDERR_MAX_BYTES = 16 * 1024; // 16KB
const SUMMARY_MAX_CHARS = 500;

/**
 * Extracts a human-readable summary from stream-json stdout.
 * Finds the last assistant message's text content blocks.
 * Falls back to raw stdout slice if parsing yields nothing.
 */
function extractSummaryFromStreamJson(stdout: string): string {
  const lines = stdout.split('\n');
  let lastText = '';

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type !== 'assistant') continue;

      const content = (parsed.content ??
        (parsed.message as Record<string, unknown> | undefined)?.content) as
        | { type?: string; text?: string }[]
        | undefined;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lastText = block.text.trim();
        }
      }
      if (lastText) break;
    } catch {
      // skip non-JSON lines
    }
  }

  return (lastText || stdout).slice(0, SUMMARY_MAX_CHARS);
}

export interface ScheduledTaskResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  durationMs: number;
}

export interface ExecutionRequest {
  runId: string;
  config: ScheduleLaunchConfig;
  maxTurns: number;
  maxBudgetUsd?: number;
}

/**
 * Internal extension of ScheduleRun with pinned storage path.
 * Used by SchedulerService to ensure writes go to the correct path
 * even if claudeRootPath changes mid-run.
 */
export interface InternalScheduleRun extends ScheduleRun {
  storageBasePath: string;
}

export class ScheduledTaskExecutor {
  private activeProcesses = new Map<string, ChildProcess>();

  async execute(request: ExecutionRequest): Promise<ScheduledTaskResult> {
    const startTime = Date.now();

    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (!binaryPath) {
      throw new Error('Claude CLI binary not found');
    }

    const shellEnv = await resolveInteractiveShellEnv();

    const args = this.buildArgs(request);

    logger.info(`[${request.runId}] Spawning: ${binaryPath} ${args.join(' ')}`);

    const child = spawnCli(binaryPath, args, {
      cwd: request.config.cwd,
      // shellEnv spread after buildEnrichedEnv ensures freshly-resolved values
      // take precedence over the cached snapshot inside buildEnrichedEnv.
      env: { ...buildEnrichedEnv(binaryPath), ...shellEnv, CLAUDECODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.activeProcesses.set(request.runId, child);

    try {
      const result = await this.waitForExit(child, request.runId);
      const durationMs = Date.now() - startTime;

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        summary: extractSummaryFromStreamJson(result.stdout),
        durationMs,
      };
    } finally {
      this.activeProcesses.delete(request.runId);
    }
  }

  cancel(runId: string): boolean {
    const child = this.activeProcesses.get(runId);
    if (!child) {
      return false;
    }
    logger.info(`[${runId}] Cancelling active run`);
    killProcessTree(child, 'SIGTERM');
    this.activeProcesses.delete(runId);
    return true;
  }

  cancelAll(): void {
    for (const [runId, child] of this.activeProcesses) {
      logger.info(`[${runId}] Cancelling (shutdown)`);
      killProcessTree(child, 'SIGTERM');
    }
    this.activeProcesses.clear();
  }

  get activeCount(): number {
    return this.activeProcesses.size;
  }

  private buildArgs(request: ExecutionRequest): string[] {
    const { config, maxTurns, maxBudgetUsd } = request;
    const args: string[] = [
      '-p',
      config.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(maxTurns),
      '--no-session-persistence',
    ];

    if (maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(maxBudgetUsd));
    }

    if (config.model) {
      args.push('--model', config.model);
    }

    if (config.skipPermissions !== false) {
      args.push('--dangerously-skip-permissions');
    }

    if (config.allowedTools?.length) {
      args.push('--allowed-tools', config.allowedTools.join(','));
    }

    if (config.disallowedTools?.length) {
      args.push('--disallowed-tools', config.disallowedTools.join(','));
    }

    return args;
  }

  private waitForExit(
    child: ChildProcess,
    runId: string
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes < STDOUT_MAX_BYTES) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < STDERR_MAX_BYTES) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });

      child.once('error', (error) => {
        logger.error(`[${runId}] Process error: ${error.message}`);
        reject(error);
      });

      child.once('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').slice(0, STDOUT_MAX_BYTES);
        const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_MAX_BYTES);

        logger.info(`[${runId}] Process exited with code ${code}`);
        resolve({ exitCode: code, stdout, stderr });
      });
    });
  }
}
