import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

export class McpStdIoClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private spawnError: Error | null = null;
  private childClosed = false;
  private readonly serverPath: string;

  constructor(serverPath: string, cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
    this.serverPath = serverPath;
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
    // A dead child makes stdin writes fail asynchronously; the request loop
    // reports the real reason, so swallow the EPIPE here.
    this.child.stdin.on('error', () => undefined);
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
    const deadline = Date.now() + 15000;

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

    throw new Error(`Timed out waiting for MCP response ${expectedId}`);
  }

  private childIsGone(): boolean {
    return this.spawnError !== null || this.childClosed;
  }

  /** A server that never started must fail the test at once, with the reason. */
  private describeDeadChild(expectedId: number): string {
    const how = this.spawnError
      ? `could not be started: ${this.spawnError.message}`
      : `exited before answering (code ${this.child.exitCode}, signal ${this.child.signalCode})`;
    const hint = existsSync(this.serverPath)
      ? ''
      : `\nThe entry file does not exist: ${this.serverPath}. Build it first with: pnpm --filter agent-teams-mcp build`;
    const stderr = this.stderrBuffer.trim();
    return (
      `MCP server ${how} while waiting for response ${expectedId}.${hint}` +
      (stderr ? `\nstderr:\n${stderr}` : '')
    );
  }
}

