import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parseJsonToolResult(result: unknown) {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  return JSON.parse(text ?? 'null');
}

class McpStdIoClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';

  constructor(serverPath: string, cwd: string) {
    this.child = spawn('node', [serverPath], {
      cwd,
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
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      setTimeout(() => resolve(), 1000).unref();
    });
  }

  private notify(method: string, params?: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  private async request(id: number, method: string, params: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return this.readMessage(id);
  }

  private async readMessage(expectedId: number) {
    const deadline = Date.now() + 5000;

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

describe('agent-teams-mcp stdio e2e', () => {
  const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

  let claudeDir: string;

  beforeEach(async () => {
    claudeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-e2e-'));
  });

  afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('boots over stdio, lists task tools, and executes task lifecycle calls', async () => {
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      const init = await client.initialize();
      expect(init).toHaveProperty('result');

      const tools = (await client.listTools()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);

      expect(toolNames).toContain('task_create');
      expect(toolNames).toContain('task_start');
      expect(toolNames).toContain('review_approve');

      const createResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'e2e-team',
          subject: 'Smoke task',
          owner: 'alice',
        },
        3
      );
      const createdTask = parseJsonToolResult((createResult as { result: unknown }).result);

      expect(createdTask.subject).toBe('Smoke task');
      expect(createdTask.owner).toBe('alice');
      expect(typeof createdTask.id).toBe('string');

      const startResult = await client.callTool(
        'task_start',
        {
          claudeDir,
          teamName: 'e2e-team',
          taskId: createdTask.id,
          actor: 'alice',
        },
        4
      );
      const startedTask = parseJsonToolResult((startResult as { result: unknown }).result);

      expect(startedTask.status).toBe('in_progress');
      expect(startedTask.id).toBe(createdTask.id);
    } finally {
      await client.close();
    }
  });
});
