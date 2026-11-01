import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface CopyHandoffReply {
  result?: unknown;
  error?: unknown;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Copy handoff process deadline exceeded')),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The general stdio helper cannot observe secret output or join close after startup failure. */
export class CopyHandoffStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<number | null>;
  private readonly pending = new Map<
    number,
    {
      resolve(reply: CopyHandoffReply): void;
      reject(error: Error): void;
    }
  >();
  private buffer = '';
  private stderrTail = '';
  private sequence = 0;
  private didClose = false;
  private leaked = false;
  private protocolFailed = false;
  private observedStdoutBytes = 0;

  constructor(
    entry: string,
    selector: string,
    cwd: string,
    private readonly secrets: readonly string[],
    inheritedControlUrl: string
  ) {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of [
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
      'TMPDIR',
    ]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    this.child = spawn(process.execPath, [entry, '--handoff', selector], {
      cwd,
      env: {
        ...environment,
        OPENAI_API_KEY: 'synthetic-provider-hint',
        AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN: 'synthetic-auth-hint',
        CLAUDE_TEAM_CONTROL_URL: inheritedControlUrl,
        AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
        AGENT_TEAMS_MCP_HTTP_PORT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code) => {
        this.didClose = true;
        for (const waiter of this.pending.values())
          waiter.reject(new Error('Copy handoff process closed'));
        this.pending.clear();
        resolve(code);
      });
    });
    // Observe immediately; the original promise still rejects when awaited.
    void this.closed.catch(() => undefined);
    this.child.stdin.on('error', () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error('Copy handoff input closed'));
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      const incoming = this.stderrTail + chunk.toString('utf8');
      this.scan(incoming);
      this.stderrTail = incoming.slice(-2048);
    });
  }

  get secretObserved(): boolean {
    return this.leaked;
  }
  get joined(): boolean {
    return this.didClose;
  }
  get stdoutBytes(): number {
    return this.observedStdoutBytes;
  }
  get protocolError(): boolean {
    return this.protocolFailed;
  }

  private scan(text: string): void {
    if (
      [...this.secrets, 'synthetic-provider-hint', 'synthetic-auth-hint'].some((secret) =>
        text.includes(secret)
      )
    )
      this.leaked = true;
  }

  private consume(chunk: Buffer): void {
    this.observedStdoutBytes += chunk.length;
    this.buffer += chunk.toString('utf8');
    this.scan(this.buffer);
    if (this.buffer.length > 1024 * 1024) {
      this.protocolFailed = true;
      this.child.kill('SIGTERM');
      return;
    }
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const reply = JSON.parse(line) as CopyHandoffReply & { id?: number };
        if (typeof reply.id === 'number') {
          this.pending.get(reply.id)?.resolve(reply);
          this.pending.delete(reply.id);
        }
      } catch {
        this.protocolFailed = true;
        this.child.kill('SIGTERM');
      }
    }
  }

  async request(method: string, params: Record<string, unknown>): Promise<CopyHandoffReply> {
    const id = ++this.sequence;
    const response = new Promise<CopyHandoffReply>((resolve, reject) =>
      this.pending.set(id, { resolve, reject })
    );
    void response.catch(() => undefined);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    try {
      return await within(response, 10_000);
    } finally {
      this.pending.delete(id);
    }
  }

  async initialize(): Promise<void> {
    const reply = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'copy-handoff-e2e', version: '1' },
    });
    if (reply.error || !reply.result) throw new Error('Copy handoff initialization failed');
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
  }

  tool(name: string, args: Record<string, unknown> = {}): Promise<CopyHandoffReply> {
    return this.request('tools/call', { name, arguments: args });
  }

  waitForClose(): Promise<number | null> {
    return within(this.closed, 10_000);
  }

  async endInput(): Promise<number | null> {
    this.child.stdin.end();
    return this.waitForClose();
  }

  async close(): Promise<void> {
    if (this.didClose) return;
    this.child.kill('SIGTERM');
    try {
      await within(this.closed, 3_000);
    } catch {
      if (!this.didClose) this.child.kill('SIGKILL');
      await within(this.closed, 3_000);
    }
  }
}

export function copyToolFailed(reply: CopyHandoffReply): boolean {
  return Boolean(reply.error || (reply.result as { isError?: boolean } | undefined)?.isError);
}

export function copyToolJson(reply: CopyHandoffReply): Record<string, unknown> {
  if (copyToolFailed(reply)) throw new Error('Copy handoff tool failed');
  try {
    const result = reply.result as { content?: { text?: string }[] };
    return JSON.parse(result.content?.[0]?.text ?? 'null') as Record<string, unknown>;
  } catch {
    // Never echo protocol data or credentials through assertion diagnostics.
    throw new Error('Copy handoff tool returned invalid JSON');
  }
}
