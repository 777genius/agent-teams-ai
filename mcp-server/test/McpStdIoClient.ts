import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export class McpStdIoClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';

  constructor(serverPath: string, cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [serverPath, ...args], {
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
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

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`Timed out waiting for MCP response ${expectedId}`);
  }
}

