import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const MODELS = ['claude-sonnet-4-5', 'gpt-5-codex', 'gpt-5.1'];
const BOOTSTRAP_MARKER = '<agent_teams_native_app_managed_bootstrap_check>';

export interface MockUpstreamCall {
  readonly at: string;
  readonly path: string;
  readonly model: string;
  readonly authFingerprint: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly bootstrapProof: boolean;
}

export interface MockUpstream {
  server: Server;
  baseUrl: string;
  dockerBaseUrl: string;
  readonly calls: readonly MockUpstreamCall[];
  close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;
interface Usage {
  input: number;
  output: number;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  const part = record(value);
  return typeof part.text === 'string' ? part.text : contentText(part.content);
}

function currentUserPrompt(body: JsonRecord): string {
  if (typeof body.input === 'string') return body.input;
  const messages = Array.isArray(body.messages) ? body.messages : body.input;
  if (!Array.isArray(messages)) return '';
  const user = [...messages]
    .reverse()
    .map(record)
    .find((item) => item.role === 'user');
  return contentText(user?.content);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error('Mock request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function beginStream(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function event(response: ServerResponse, type: string, payload: JsonRecord): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function anthropicMessage(model: string, text: string, usage: Usage): JsonRecord {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function messages(
  response: ServerResponse,
  model: string,
  text: string,
  usage: Usage,
  stream: boolean
): void {
  const message = anthropicMessage(model, text, usage);
  if (!stream) return json(response, 200, message);
  beginStream(response);
  event(response, 'message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: usage.input,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  event(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  event(response, 'content_block_stop', { index: 0 });
  event(response, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  event(response, 'message_stop', {});
  response.end();
}

function responses(
  response: ServerResponse,
  model: string,
  text: string,
  usage: Usage,
  stream: boolean
): void {
  const responseId = `resp_${randomUUID()}`;
  const itemId = `msg_${randomUUID()}`;
  const part = { type: 'output_text', text, annotations: [], logprobs: [] };
  const item = {
    id: itemId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [part],
  };
  const shell = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'in_progress',
    output: [] as unknown[],
    error: null,
    incomplete_details: null,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  };
  const completed = {
    ...shell,
    status: 'completed',
    output: [item],
    output_text: text,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input + usage.output,
    },
  };
  if (!stream) return json(response, 200, completed);
  beginStream(response);
  let sequence = 0;
  const emit = (type: string, payload: JsonRecord): void =>
    event(response, type, { sequence_number: sequence++, ...payload });
  const indices = { item_id: itemId, output_index: 0, content_index: 0 };
  emit('response.created', { response: { ...shell, usage: null } });
  emit('response.in_progress', { response: { ...shell, usage: null } });
  emit('response.output_item.added', {
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  emit('response.content_part.added', { ...indices, part: { ...part, text: '' } });
  emit('response.output_text.delta', { ...indices, delta: text, logprobs: [] });
  emit('response.output_text.done', { ...indices, text, logprobs: [] });
  emit('response.content_part.done', { ...indices, part });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: completed });
  response.end();
}

function chat(
  response: ServerResponse,
  model: string,
  text: string,
  usage: Usage,
  stream: boolean
): void {
  const base = { id: `chatcmpl_${randomUUID()}`, created: Math.floor(Date.now() / 1000), model };
  const tokens = {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  if (!stream)
    return json(response, 200, {
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: tokens,
    });
  beginStream(response);
  const emit = (choices: unknown[], extra: JsonRecord = {}): void => {
    response.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...extra })}\n\n`
    );
  };
  emit([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
  emit([{ index: 0, delta: { content: text }, finish_reason: null }]);
  emit([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  emit([], { usage: tokens });
  response.end('data: [DONE]\n\n');
}

/** In-memory protocol upstream for sandbox E2E; it never forwards any requests. */
export async function startMockUpstream(): Promise<MockUpstream> {
  const calls: MockUpstreamCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://mock.invalid').pathname;
      if (request.method === 'GET' && path === '/v1/models') {
        return json(response, 200, {
          object: 'list',
          data: MODELS.map((id) => ({ id, object: 'model' })),
        });
      }
      if (request.method === 'GET' && path === '/healthz') return json(response, 200, { ok: true });
      if (
        request.method !== 'POST' ||
        ![
          '/v1/messages',
          '/v1/messages/count_tokens',
          '/v1/responses',
          '/v1/chat/completions',
        ].includes(path)
      ) {
        return json(response, 404, { error: { type: 'not_found', message: 'Unknown mock route' } });
      }
      const bytes = await readBody(request);
      let body: JsonRecord;
      try {
        body = record(JSON.parse(bytes.toString('utf8')));
      } catch {
        return json(response, 400, {
          error: { type: 'invalid_request_error', message: 'Invalid JSON' },
        });
      }
      const model = typeof body.model === 'string' ? body.model : MODELS[0];
      const proof = currentUserPrompt(body).includes(BOOTSTRAP_MARKER);
      const usage = {
        input: 20 + (bytes.length % 80),
        output: path.endsWith('/count_tokens') ? 0 : 7 + (bytes.length % 23),
      };
      const auth =
        request.headers.authorization ??
        request.headers['x-api-key'] ??
        request.headers['api-key'] ??
        '';
      calls.push(
        Object.freeze({
          at: new Date().toISOString(),
          path,
          model,
          authFingerprint: createHash('sha256')
            .update(Array.isArray(auth) ? auth.join(',') : auth)
            .digest('hex')
            .slice(0, 12),
          inputTokens: usage.input,
          outputTokens: usage.output,
          bootstrapProof: proof,
        })
      );
      const text = proof ? 'Startup context loaded.' : 'GATEWAY_E2E_OK';
      if (path === '/v1/messages/count_tokens')
        return json(response, 200, { input_tokens: usage.input });
      if (path === '/v1/messages')
        return messages(response, model, text, usage, body.stream === true);
      if (path === '/v1/responses')
        return responses(response, model, text, usage, body.stream === true);
      return chat(response, model, text, usage, body.stream === true);
    })().catch(() => {
      if (!response.headersSent)
        json(response, 500, { error: { type: 'mock_error', message: 'Mock request failed' } });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock upstream has no TCP port');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dockerBaseUrl: `http://host.docker.internal:${address.port}`,
    get calls() {
      return Object.freeze([...calls]);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
