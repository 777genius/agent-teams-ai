import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const configuredDefault = 'gateway/qwen-default';
export const diagnosticModel = 'gateway/legacy-fast';
export const firstCatalogModel = 'gateway/first-catalog-model';
export const probePrompt = 'Output only the single word PONG.';
export interface GatewayRequest {
  id: number;
  at: string;
  method?: string;
  path: string;
  authorized: boolean;
  model?: string;
  kind?: 'generic-fast-diagnostic' | 'saved-model-inference';
  completed?: boolean;
  allowed: boolean;
}

/** Local-only Messages endpoint. Legacy fast diagnostic and selected Qwen stay distinct. */
export async function startDefaultModelGateway() {
  const token = `default-model-fixture-${randomBytes(18).toString('hex')}`;
  const requests: GatewayRequest[] = [];
  let inFlight = 0;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const authorized =
      req.headers.authorization === `Bearer ${token}` || req.headers['x-api-key'] === token;
    const entry: GatewayRequest = {
      id: requests.length + 1,
      at: new Date().toISOString(),
      method: req.method,
      path: pathname,
      authorized,
      allowed: false,
    };
    requests.push(entry);
    req.on('error', () => {
      entry.allowed = false;
      res.destroy();
    });
    inFlight++;
    res.once('close', () => {
      inFlight--;
    });
    res.once('finish', () => {
      entry.completed = true;
    });
    if (req.method === 'HEAD' && pathname === '/') {
      entry.allowed = true;
      res.end();
      return;
    }
    if (authorized && req.method === 'GET' && pathname === '/v1/models') {
      entry.allowed = true;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [firstCatalogModel, configuredDefault, diagnosticModel].map((id) => ({
            id,
            object: 'model',
            display_name: id,
          })),
        })
      );
      return;
    }
    if (!authorized || req.method !== 'POST' || pathname !== '/v1/messages') {
      res.writeHead(authorized ? 404 : 401).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
      if (raw.length > 262_144) req.destroy(new Error('Fixture request exceeded bound'));
    });
    req.on('end', () => {
      let body: { model?: string; messages?: unknown; stream?: boolean };
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      entry.model = body.model;
      entry.kind =
        body.model === diagnosticModel ? 'generic-fast-diagnostic' : 'saved-model-inference';
      entry.allowed =
        [configuredDefault, diagnosticModel].includes(body.model ?? '') &&
        JSON.stringify(body.messages).includes(probePrompt);
      if (!entry.allowed) {
        res.writeHead(400).end('Only bounded fixture PONG inference is permitted');
        return;
      }
      const message = {
        id: `msg_default_${entry.id}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      if (!body.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ...message,
            content: [{ type: 'text', text: 'PONG' }],
            stop_reason: 'end_turn',
          })
        );
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      for (const event of [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    token,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    inFlight: () => inFlight,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
