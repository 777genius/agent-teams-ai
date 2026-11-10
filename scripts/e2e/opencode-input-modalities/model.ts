import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// Official native v2.0.21 tag, verified at this immutable source commit.
export const nativeTitleSource = {
  commit: '8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72',
  promptPath: 'packages/core/src/plugin/agent.ts',
  promptSha256: 'd2f45520a3d99f523c139cde9409420ed6662514b506ca4aba76df659bfe5997',
};
const textDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
const messageText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((part: unknown) =>
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('\n');
};
export interface ModelObservation {
  purpose: 'native-title' | 'model-turn';
  nativeSessionId?: string;
  requestSha256: string;
  messages: Array<{ role: string; textSha256: string; textLength: number }>;
  model: string;
  messageIds: string[];
  files: Array<{ mime: string; sha256: string; size: number }>;
}
interface ModelRequest {
  model: string;
  stream?: boolean;
  messages: unknown[];
}
/** Scripted transport fixture: these responses make no semantic media-understanding claim. */
export async function startModel() {
  const observations: ModelObservation[] = [];
  let failure: unknown;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, '127.0.0.1');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      assert(request.method === 'POST' && request.url === '/v1/chat/completions');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        assert(size < 32 * 1024 * 1024, 'Bounded loopback request');
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw) as ModelRequest;
      assert(Array.isArray(body.messages));
      const files: ModelObservation['files'] = [];
      const walk = (value: unknown): void => {
        if (typeof value === 'string') {
          const media = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
          if (media) {
            const bytes = Buffer.from(media[2], 'base64');
            files.push({
              mime: media[1],
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            });
          }
        } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(body.messages);
      const messageIds = [
        ...new Set([...raw.matchAll(/Original User MessageId: ([a-f0-9-]+)/g)].map((m) => m[1])),
      ];
      assert(observations.length < 1000);
      const messages = body.messages.map((message: unknown) => {
        assert(
          message &&
            typeof message === 'object' &&
            'role' in message &&
            typeof message.role === 'string'
        );
        const text = messageText('content' in message ? message.content : undefined);
        return { role: message.role, textSha256: textDigest(text), textLength: text.length };
      });
      // title.ts constructs a text-only user request with this exact built-in system prompt.
      // No other model/request-purpose heuristic can exempt a correlated request.
      const purpose =
        messages.length === 2 &&
        messages[0].role === 'system' &&
        messages[0].textSha256 === nativeTitleSource.promptSha256 &&
        messages[1].role === 'user'
          ? 'native-title'
          : 'model-turn';
      const sessionHeader = request.headers['x-opencode-session-id'];
      observations.push({
        model: body.model,
        messageIds,
        files,
        purpose,
        messages,
        requestSha256: textDigest(raw),
        ...(typeof sessionHeader === 'string' ? { nativeSessionId: sessionHeader } : {}),
      });
      const challenge = raw.match(/Output only this exact token: (STRICT_LAUNCH_[a-f0-9-]+)/)?.[1];
      const content = challenge ?? (/PONG/.test(raw) ? 'PONG' : 'READY');
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'TEST-transport',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [
          [{ role: 'assistant', content }, null],
          [{}, 'stop'],
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: 'TEST-transport',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`
          );
        }
        response.end('data: [DONE]\n\n');
      }
    } catch (error) {
      failure = error;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"TEST transport contract failed"}}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    observations,
    check: () => {
      if (failure) throw failure;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
