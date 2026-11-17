import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { flattenTools } from './model.ts';

export interface CodexSuggestionSource {
  readonly marker: string;
  readonly owner: string;
  readonly suggestion: string;
  readonly hold?: 'turn' | 'suggestion';
  readonly sampleToolAttempt?: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface NativeToolAttempt {
  marker: string;
  commandId: string;
  text: string;
  name: string;
  namespace?: string;
  toolsSha256: string;
  responseCompletedSent: boolean;
  responseClosedByNative: boolean;
  parentTurnToCloseMs?: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(record(value))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

/** Scripts only localhost model output; original Codex owns turns and sampling. */
export async function startCodexSuggestionModel(options: {
  sources: readonly CodexSuggestionSource[];
}) {
  assert.ok(options.sources.length > 0 && options.sources.length <= 16);
  assert.equal(
    new Set(options.sources.map((source) => source.marker)).size,
    options.sources.length
  );
  assert.ok(
    options.sources.every(
      (source) =>
        /^TEST_[A-Z0-9_]+$/u.test(source.marker) &&
        source.owner.length > 0 &&
        source.suggestion.length > 0
    )
  );
  const requests: {
    marker: string;
    kind: 'turn' | 'suggestion';
    tools: number;
    toolsSha256: string;
    receivedAtMs: number;
  }[] = [];
  const toolAttempts: NativeToolAttempt[] = [];
  const failures: string[] = [];
  let closing = false;
  const held = new Map<string, { response: ServerResponse; send(): void }>();
  const server = createServer((request, response) => {
    void (async () => {
      assert.deepEqual(failures, [], 'local model seals after its first unexpected request');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        assert.ok((bytes += chunk.length) <= 2_000_000, 'finite TEST request');
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const context = JSON.stringify(body.input);
      assert.equal(typeof context, 'string');
      const matches = options.sources
        .map((source) => ({ source, offset: context.lastIndexOf(source.marker) }))
        .filter((row) => row.offset >= 0)
        .sort((a, b) => a.offset - b.offset);
      const source = matches.at(-1)?.source;
      assert.ok(source, 'every native request retains a known original human source');
      assert.ok(
        matches.every((row) => row.source.owner === source.owner),
        'one original native conversation never inherits another member context'
      );
      const kind = /Predict the next message|next message the user will send/u.test(context)
        ? ('suggestion' as const)
        : ('turn' as const);
      assert.equal(
        requests.filter((row) => row.marker === source.marker && row.kind === kind).length,
        0,
        'one original turn and at most one native sample per human source'
      );
      assert.ok(requests.length < options.sources.length * 2);
      assert.ok(Array.isArray(body.tools), 'native request carries its original tool catalog');
      const toolsSha256 = createHash('sha256')
        .update(JSON.stringify(canonical(body.tools)))
        .digest('hex');
      const parent = requests.find((item) => item.marker === source.marker && item.kind === 'turn');
      if (kind === 'suggestion') {
        // Codex rust-v0.169.0 (d32063f9), app-server/src/thread_sample.rs:
        // sampling retains the parent catalog; its interceptor rejects tool-bearing output.
        assert.ok(parent, 'native sample follows its original human model request');
        assert.equal(toolsSha256, parent.toolsSha256, 'native sample retains the exact parent catalog');
      }
      requests.push({
        marker: source.marker,
        kind,
        tools: body.tools.length,
        toolsSha256,
        receivedAtMs: performance.now(),
      });
      let attempt: NativeToolAttempt | undefined;
      if (kind === 'suggestion' && source.sampleToolAttempt) {
        assert.equal(source.hold, 'suggestion', 'snapshot original effects before emitting the attempt');
        const selected = flattenTools(body.tools).filter(
          (tool) =>
            (tool.name === 'message_send' && tool.namespace?.includes('team')) ||
            tool.name.endsWith('__message_send')
        );
        assert.equal(selected.length, 1, 'attempt only the actual advertised Team message_send');
        attempt = {
          marker: source.marker,
          commandId: `TEST-auxiliary-${source.marker}`,
          text: `TEST_AUXILIARY_TOOL_EFFECT_${source.marker}`,
          ...selected[0]!,
          toolsSha256,
          responseCompletedSent: false,
          responseClosedByNative: false,
        };
        toolAttempts.push(attempt);
      }
      const id = `TEST-native-codex-response-${requests.length}`;
      const send = () => {
        if (response.destroyed) return;
        const attemptedCall = attempt
          ? {
              type: 'function_call',
              call_id: id + '-attempt',
              name: attempt.name,
              ...(attempt.namespace ? { namespace: attempt.namespace } : {}),
              arguments: JSON.stringify({
                commandId: attempt.commandId,
                to: 'user',
                text: attempt.text,
              }),
            }
          : undefined;
        const events = [
          { type: 'response.created', response: { id } },
          ...(attemptedCall
            ? [
                { type: 'response.output_item.added', item: attemptedCall },
                { type: 'response.output_item.done', item: attemptedCall },
              ]
            : []),
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: `${id}-message`,
              content: [
                {
                  type: 'output_text',
                  text:
                    kind === 'suggestion'
                      ? source.suggestion
                      : 'Completed the original TEST request.',
                },
              ],
            },
          },
          {
            type: 'response.completed',
            response: {
              id,
              usage: {
                input_tokens: 20,
                input_tokens_details: null,
                output_tokens: 8,
                output_tokens_details: null,
                total_tokens: 28,
              },
            },
          },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('');
        if (attempt) {
          const observed = attempt;
          assert.ok(parent);
          // Keep the completed SSE open. Only the native client may close it before
          // another human Send; HTTP finish alone cannot prove native consumption.
          response.once('close', () => {
            observed.parentTurnToCloseMs = performance.now() - parent.receivedAtMs;
            observed.responseClosedByNative =
              observed.responseCompletedSent &&
              !closing &&
              !response.writableFinished &&
              observed.parentTurnToCloseMs < 10_000;
          });
          response.write(frames);
          observed.responseCompletedSent = true;
        } else response.end(frames);
      };
      if (source.hold === kind) held.set(source.marker, { response, send });
      else send();
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : 'Unexpected native model request');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST localhost model refused');
    });
  });
  server.requestTimeout = 20_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    toolAttempts,
    failures,
    held: (marker: string) => held.has(marker),
    release(marker: string) {
      const retained = held.get(marker);
      assert.ok(retained, 'release only an originally held native response');
      held.delete(marker);
      retained.send();
    },
    async close() {
      closing = true;
      for (const retained of held.values()) retained.response.destroy();
      held.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
