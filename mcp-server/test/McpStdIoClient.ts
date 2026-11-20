import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;

export interface McpStdIoClientOptions {
  /**
   * How long one request may wait for its answer. Keep it clearly below the
   * test timeout so a hung server fails the test with the reason below instead
   * of the runner cutting the test while its body keeps running.
   */
  responseTimeoutMs?: number;
}

export class McpStdIoClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private spawnError: Error | null = null;
  private stdinError: Error | null = null;
  private childClosed = false;
  private readonly serverPath: string;
  private readonly cwd: string;
  private readonly responseTimeoutMs: number;

  constructor(
    serverPath: string,
    cwd: string,
    args: string[] = [],
    env?: NodeJS.ProcessEnv,
    options: McpStdIoClientOptions = {}
  ) {
    this.serverPath = serverPath;
    this.cwd = cwd;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.child = spawn(process.execPath, [serverPath, ...args], {
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
    });
    this.child.on('error', (error) => {
      this.spawnError = error;
    });
    // 'close' fires after the process exited AND its stdio streams drained, so
    // nothing the server printed can still be in flight when it is set.
    this.child.on('close', () => {
      this.childClosed = true;
    });
    // A dead child makes stdin writes fail asynchronously (EPIPE). Keep the error
    // so the failure message can show it, instead of letting it crash the runner.
    this.child.stdin.on('error', (error) => {
      this.stdinError = error;
    });
  }

  async initialize() {
    const response = await this.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-e2e', version: '1.0.0' },
    });

    this.notify('notifications/initialized');
    return response;
  }

  async listTools() {
    return this.request(2, 'tools/list', {});
  }

  async callTool(name: string, args: Record<string, unknown>, id = 3) {
    return this.request(id, 'tools/call', { name, arguments: args });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      setTimeout(() => resolve(), 1000).unref();
    });
  }

  async endInput(): Promise<number | null> {
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP did not exit after stdin EOF')), 2_000);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    this.child.stdin.end();
    return exited;
  }

  private notify(method: string, params?: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  private async request(id: number, method: string, params: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return this.readMessage(id);
  }

  private async readMessage(expectedId: number) {
    const deadline = Date.now() + this.responseTimeoutMs;

    while (Date.now() < deadline) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        const parsed = JSON.parse(line) as { id?: number };
        if (parsed.id === expectedId) {
          return parsed;
        }
      }

      // Only give up on a dead child once everything it printed is consumed.
      if (!this.stdoutBuffer.includes('\n') && this.childIsGone()) {
        throw new Error(this.describeDeadChild(expectedId));
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(this.describeTimeout(expectedId));
  }

  private childIsGone(): boolean {
    return this.spawnError !== null || this.childClosed;
  }

  /** A server that never started must fail the test at once, with the reason. */
  private describeDeadChild(expectedId: number): string {
    const how = this.spawnError
      ? `could not be started: ${this.spawnError.message}`
      : `exited before answering (code ${this.child.exitCode}, signal ${this.child.signalCode})`;
    // The child resolves a relative entry path against its own cwd, so check it there.
    const entry = resolvePath(this.cwd, this.serverPath);
    const hint = existsSync(entry)
      ? ''
      : `\nThe entry file does not exist: ${entry}. Build it first with: pnpm --filter agent-teams-mcp build`;
    return `MCP server ${how} while waiting for response ${expectedId}.${hint}${this.diagnostics()}`;
  }

  /** A server that is alive but silent: say so, with what it printed so far. */
  private describeTimeout(expectedId: number): string {
    return (
      `Timed out after ${this.responseTimeoutMs} ms waiting for MCP response ${expectedId}; ` +
      `the server process is still running (pid ${this.child.pid ?? 'unknown'}).${this.diagnostics()}`
    );
  }

  private diagnostics(): string {
    const stderr = this.stderrBuffer.trim();
    return (
      (this.stdinError ? `\nstdin error: ${this.stdinError.message}` : '') +
      (stderr ? `\nstderr:\n${stderr}` : '')
    );
  }
}
