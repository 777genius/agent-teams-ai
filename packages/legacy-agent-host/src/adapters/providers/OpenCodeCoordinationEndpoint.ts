import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const coordinationServer = 'coordination';
export const coordinationNames = ['task_briefing', 'message_send'] as const;
export const coordinationDestination = 'native-local-coordination-v1';
export const coordinationPrompt =
  'Native local coordination check. Call coordination_task_briefing with {} once. ' +
  'Read its nonce and destination from the actual result. Then call coordination_message_send ' +
  'with exactly that nonce and destination once. After its accepted result reply OK. ' +
  'Do not use any other tool, file, command or agent.';

type Fact = { name: string; input: Readonly<Record<string, string>>; output: string; served: boolean };
const unavailable = (): never => { throw new Error('Native coordination unavailable'); };
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
};

/** Private inert challenge, not a Team MCP port. Construction allocates no listener or process. */
export class OpenCodeCoordinationEndpoint {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly nonce = randomBytes(32).toString('hex');
  private readonly facts: Fact[] = [];
  private readonly active = new Set<Server>();
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly server = createServer((request, response) => {
    const work = this.request(request, response);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
  });
  private address?: string;
  private originalSession?: string;
  private deadline = 0;
  private current: () => boolean = () => false;
  private signal?: AbortSignal;
  private started = false;
  private sealed = false;
  private invalid = false;
  private cleanupUnknown = false;
  private catalogServed = false;
  private requests = 0;
  private concurrent = 0;
  private listening?: Promise<void>;
  private closing?: Promise<boolean>;

  get url(): string { return this.address ?? unavailable(); }
  get bearerToken(): string { return this.token; }

  async start(deadline: number, signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
    if (this.started || this.sealed || !Number.isSafeInteger(deadline) ||
        deadline <= Date.now() || deadline - Date.now() > 90000) return unavailable();
    this.started = true; this.deadline = deadline; this.current = isCurrent; this.signal = signal;
    this.check();
    signal.addEventListener('abort', () => this.seal(), { once: true });
    this.listening = new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error('Native coordination listener unavailable'));
      this.server.once('error', fail);
      this.abort.signal.addEventListener('abort', fail, { once: true });
      this.server.listen({ port: 0, host: '127.0.0.1', signal: this.abort.signal }, () => {
        this.server.off('error', fail); this.abort.signal.removeEventListener('abort', fail); resolve();
      });
    });
    await this.listening;
    const address = this.server.address();
    if (!address || typeof address === 'string') return unavailable();
    this.address = 'http://127.0.0.1:' + address.port + '/coordination';
    this.check();
  }

  bindSession(id: string): void {
    this.check();
    if (this.originalSession || typeof id !== 'string' || !id || id.length > 256 || this.facts.length)
      return unavailable();
    this.originalSession = id;
  }

  catalogCurrent(): boolean {
    try { this.check(); return this.catalogServed; } catch { return false; }
  }

  /** Native IDs are checked at Session SPI; the MCP request ID is not treated as a native tool ID. */
  matches(session: string, index: number, name: string, input: unknown, content: unknown): boolean {
    try {
      this.check();
      const fact = this.facts[index];
      if (session !== this.originalSession || !fact?.served ||
          name !== coordinationServer + '_' + fact.name) return false;
      const supplied = row(input);
      if (Object.keys(supplied).sort().join(',') !== Object.keys(fact.input).sort().join(',') ||
          Object.entries(fact.input).some(([key, value]) => supplied[key] !== value)) return false;
      if (typeof content === 'string') return content === fact.output;
      if (!Array.isArray(content) || content.length !== 1) return false;
      const text = row(content[0]);
      return text.type === 'text' && text.text === fact.output;
    } catch { return false; }
  }

  completed(session: string): boolean {
    try {
      this.check();
      return this.originalSession === session && this.catalogServed &&
        this.facts.length === 2 && this.facts.every(fact => fact.served);
    } catch { return false; }
  }

  seal(): void { this.sealed = true; this.abort.abort(); }

  close(): Promise<boolean> {
    this.seal();
    return this.closing ??= (async () => {
      let clean = true;
      const work = (async () => {
        await this.listening?.catch(() => {});
        this.server.closeAllConnections();
        const outcomes = await Promise.allSettled([...this.active].map(server => server.close()));
        if (outcomes.some(value => value.status === 'rejected')) clean = false;
        if (this.server.listening) await new Promise<void>(resolve => {
          this.server.close(error => { if (error) clean = false; resolve(); });
          this.server.closeAllConnections();
        });
        await Promise.allSettled([...this.pending]);
        return clean && !this.cleanupUnknown && !this.server.listening && this.concurrent === 0 && this.active.size === 0;
      })();
      if (!this.started) return work;
      return closeCoordinationByDeadline(work, this.deadline);
    })();
  }

  private check(): void {
    this.signal?.throwIfAborted();
    if (this.sealed || this.invalid || Date.now() >= this.deadline || !this.current()) unavailable();
  }

  private body(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let bytes = 0, done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        clearTimeout(timer); this.abort.signal.removeEventListener('abort', fail);
        request.off('data', data); request.off('end', end);
        request.off('error', fail); request.off('aborted', fail);
        if (error) { request.resume(); reject(error); }
      };
      const fail = () => finish(new Error('Native coordination request unavailable'));
      const data = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { fail(); return; }
        chunks.push(chunk);
      };
      const end = () => {
        finish();
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new Error('Native coordination request invalid')); }
      };
      const timer = setTimeout(fail, Math.max(1, Math.min(10000, this.deadline - Date.now())));
      timer.unref(); this.abort.signal.addEventListener('abort', fail, { once: true });
      request.on('data', data); request.once('end', end);
      request.once('error', fail); request.once('aborted', fail);
      if (this.abort.signal.aborted) fail();
    });
  }

  private async request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let server: Server | undefined, catalog = false, accepted: Fact | undefined;
    let counted = false;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('connection', 'close');
    const refuse = () => {
      this.invalid = true;
      if (!response.headersSent && !response.writableEnded) {
        response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end('{"error":"coordination-unavailable"}');
      }
      request.resume();
    };
    response.once('finish', () => {
      if (response.statusCode !== 200) return;
      try {
        this.check();
        if (catalog) this.catalogServed = true;
        if (accepted) accepted.served = true;
      } catch { this.invalid = true; }
    });
    try {
      this.check();
      const expected = Buffer.from('Bearer ' + this.token), supplied = Buffer.from(request.headers.authorization ?? '');
      if (++this.requests > 16 || this.concurrent >= 2 ||
          request.url !== '/coordination' || supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected) || request.headers.origin !== undefined ||
          request.headers.host !== new URL(this.url).host)
        return refuse();
      // The same stateless SDK negotiation as the Team endpoint: no SSE stream is exposed.
      if (request.method === 'GET') {
        response.writeHead(405); response.end(); request.resume(); return;
      }
      if (request.method !== 'POST') return refuse();
      this.concurrent++; counted = true;
      const body = await this.body(request); this.check();
      server = new Server({ name: 'native-local-coordination', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.onerror = () => { this.invalid = true; };
      server.setRequestHandler(ListToolsRequestSchema, () => {
        this.check(); catalog = true;
        return { tools: [
          { name: coordinationNames[0], description: 'Return this inert coordination challenge.',
            inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } },
          { name: coordinationNames[1], description: 'Accept the exact inert challenge result.',
            inputSchema: { type: 'object' as const, properties: {
              nonce: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              destination: { type: 'string', const: coordinationDestination },
            }, required: ['nonce', 'destination'], additionalProperties: false } },
        ] };
      });
      server.setRequestHandler(CallToolRequestSchema, request => {
        try {
          this.check();
          if (!this.originalSession || !this.catalogServed || this.facts.length >= 2) return unavailable();
          const input = row(request.params.arguments ?? {}), index = this.facts.length;
          if (request.params.name !== coordinationNames[index]) return unavailable();
          if (index === 0 ? Object.keys(input).length !== 0 :
              !this.facts[0]?.served || Object.keys(input).sort().join(',') !== 'destination,nonce' ||
              input.nonce !== this.nonce || input.destination !== coordinationDestination) return unavailable();
          accepted = { name: request.params.name,
            input: index === 0 ? {} : { nonce: this.nonce, destination: coordinationDestination },
            output: JSON.stringify(index === 0 ? { nonce: this.nonce, destination: coordinationDestination } :
              { accepted: true, nonce: this.nonce }), served: false };
          this.facts.push(accepted);
          return { content: [{ type: 'text' as const, text: accepted.output }] };
        } catch {
          this.invalid = true;
          return { isError: true, content: [{ type: 'text' as const, text: 'Coordination refused' }] };
        }
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      this.active.add(server);
      // Same documented SDK stateless transport as the original Team endpoint.
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, body);
    } catch { refuse(); }
    finally {
      if (server) {
        await server.close().catch(() => { this.invalid = true; this.cleanupUnknown = true; });
        this.active.delete(server);
      }
      if (counted) this.concurrent--;
    }
  }
}

/** Cleanup consumes only the time remaining in this original admitted operation. */
export async function closeCoordinationByDeadline(work: Promise<boolean>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || remaining <= 0) {
    void work.catch(() => {});
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const clean = await Promise.race([work.catch(() => false), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), remaining);
      timer.unref();
    })]);
    return clean && Date.now() < deadline;
  } finally { clearTimeout(timer); }
}
