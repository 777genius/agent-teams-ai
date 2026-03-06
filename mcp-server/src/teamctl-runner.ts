import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamctlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ITeamctlRunner {
  execute(args: string[]): Promise<TeamctlResult>;
}

export interface TeamctlRunnerOptions {
  /** Explicit path to teamctl.js. Falls back to TEAMCTL_PATH env, then default. */
  teamctlPath?: string;
  /** Max concurrent subprocess calls (default: 5) */
  maxConcurrent?: number;
  /** Subprocess timeout in ms (default: 10 000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent subprocess spawns
// ---------------------------------------------------------------------------

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// TeamctlRunner
// ---------------------------------------------------------------------------

export class TeamctlRunner implements ITeamctlRunner {
  readonly teamctlPath: string;
  private readonly timeoutMs: number;
  private readonly semaphore: Semaphore;

  constructor(options?: TeamctlRunnerOptions) {
    this.teamctlPath = resolveTeamctlPath(options?.teamctlPath);
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.semaphore = new Semaphore(options?.maxConcurrent ?? 5);

    // Fail fast if teamctl.js doesn't exist
    if (!existsSync(this.teamctlPath)) {
      throw new Error(
        `teamctl.js not found at ${this.teamctlPath}. ` +
          'Make sure Claude Agent Teams UI has been run at least once, ' +
          'or set the TEAMCTL_PATH environment variable.',
      );
    }
  }

  async execute(args: string[]): Promise<TeamctlResult> {
    await this.semaphore.acquire();
    try {
      return await this.spawn(args);
    } finally {
      this.semaphore.release();
    }
  }

  private spawn(args: string[]): Promise<TeamctlResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [this.teamctlPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
        env: { ...process.env },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      let settled = false;

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to spawn teamctl: ${err.message}`));
        }
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (signal === 'SIGTERM') {
          const partial = stdout.slice(0, 500) || stderr.slice(0, 500);
          reject(
            new Error(
              `teamctl timed out after ${this.timeoutMs}ms` +
                (partial ? `. Partial output: ${partial}` : ''),
            ),
          );
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveTeamctlPath(explicit?: string): string {
  if (explicit) return explicit;

  const fromEnv = process.env['TEAMCTL_PATH'];
  if (fromEnv) return fromEnv;

  // Default: ~/.claude/tools/teamctl.js
  return join(homedir(), '.claude', 'tools', 'teamctl.js');
}
