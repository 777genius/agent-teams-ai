import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import type { ServerResponse } from 'node:http';

type Mode = 'success' | 'wrong-model' | 'hold';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}
function textResponse(response: ServerResponse, model: string, sequence: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, payload: Record<string, unknown>) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  emit('message_start', {
    message: {
      id: `msg_TEST_probe_${sequence}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  emit('message_stop', {});
  response.end();
}

/** Local scripted inference only. Actual CLI executes the request and its lifecycle. */
export async function startNativeClaudeModelProbeFixture(
  options: { expectedEffort?: string } = {}
) {
  let next: Mode = 'success';
  let held = deferred();
  let disconnected = deferred();
  const observations: {
    model: string;
    mode: Mode;
    tools: number;
    promptSeen: boolean;
    effort?: string;
  }[] = [];
  const failures: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.includes('count_tokens')) {
        response.end('{"input_tokens":20}');
        return;
      }
      assert.equal(request.method, 'POST');
      assert.ok(request.url?.startsWith('/v1/messages'));
      assert.ok(observations.length < 8, 'finite model-test request budget');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes < 256 * 1024);
        chunks.push(chunk);
      }
      const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(value.model, 'claude-opus-4-6');
      const tools = Array.isArray(value.tools) ? value.tools : [];
      assert.equal(tools.length, 0, 'model probe must not advertise tools');
      assert.ok(Array.isArray(value.messages));
      const promptSeen = value.messages.some((message) =>
        JSON.stringify(record(message).content).includes('Reply only OK.')
      );
      assert.equal(promptSeen, true);
      const effort = record(value.output_config).effort;
      if (options.expectedEffort !== undefined) assert.equal(effort, options.expectedEffort);
      const mode = next;
      next = 'success';
      observations.push({
        model: String(value.model),
        mode,
        tools: tools.length,
        promptSeen,
        ...(typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
          ? { effort }
          : {}),
      });
      if (mode === 'hold') {
        response.once('close', () => disconnected.resolve());
        held.resolve();
        return;
      }
      textResponse(
        response,
        mode === 'wrong-model' ? 'TEST-wrong-wire-model' : 'claude-opus-4-6',
        observations.length
      );
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : 'TEST oracle failure');
      response.writeHead(500);
      response.end('TEST oracle rejected request');
      held.resolve();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    observations,
    failures,
    setNext(mode: Mode) {
      next = mode;
      if (mode === 'hold') {
        held = deferred();
        disconnected = deferred();
      }
    },
    waitForHeld: () => held.promise,
    waitForDisconnect: () => disconnected.promise,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
