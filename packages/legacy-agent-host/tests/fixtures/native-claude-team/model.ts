// Finite Anthropic SSE oracle adapted from the archived P1 packed-host walk.
// It scripts model responses only: native Claude executes every MCP/Bash tool.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
export const CONTEXT_MARKER = 'TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1';
export const REQUIRED_TOOLS = [
  'task_create',
  'task_set_owner',
  'task_start',
  'task_add_comment',
  'task_complete',
  'message_send',
];

/** Native SDK may append reminders after structured MCP JSON in one text block. */
export function nativeToolReceipt(content: unknown): RecordValue {
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content
            .map(record)
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
        : [];
  for (const candidate of texts) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trimStart();
    if (!text.startsWith('{') || Buffer.byteLength(text) > 256 * 1024) continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) {
          const value = record(JSON.parse(text.slice(0, index + 1)) as unknown);
          return record(value.result ?? value);
        }
      }
    }
  }
  throw new Error('Native MCP receipt JSON missing or incomplete');
}

interface Observation {
  turn: string;
  step: number;
  contextEffective: boolean;
  priorTurn: boolean;
  tools: string[];
  toolResultError: boolean;
}

function emitResponse(response: ServerResponse, sequence: number, block: RecordValue): void {
  const tool = block.type === 'tool_use';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, payload: RecordValue) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  emit('message_start', {
    message: {
      id: `msg_native_team_${sequence}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  emit('content_block_start', {
    index: 0,
    content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' },
  });
  emit('content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text },
  });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 15 },
  });
  emit('message_stop', {});
  response.end();
}

export async function startNativeTeamModel() {
  const observations: Observation[] = [];
  const failures: string[] = [];
  const counters = new Map<string, number>();
  let taskId: string | undefined;
  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.includes('count_tokens')) {
        response.end('{"input_tokens":20}');
        return;
      }
      assert.equal(failures.length, 0, 'oracle is sealed after its first protocol failure');
      assert.equal(request.method, 'POST');
      assert.ok(request.url?.startsWith('/v1/messages'));
      assert.ok(observations.length < 16, 'finite native model request budget');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes < 2_000_000);
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      const messages = Array.isArray(body.messages) ? body.messages.map(record) : [];
      let turn = '';
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
        const text =
          typeof message.content === 'string'
            ? message.content
            : blocks
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
        const match = /NATIVE_TEAM_(ONE|TWO)/.exec(text);
        if (match) {
          turn = match[0];
          break;
        }
      }
      assert.ok(turn, 'request is tied to a deliberate TEST input');
      const step = counters.get(turn) ?? 0;
      const tools = (Array.isArray(body.tools) ? body.tools.map(record) : []).map((tool) =>
        String(tool.name)
      );
      const contextEffective = JSON.stringify(body.system).includes(CONTEXT_MARKER);
      assert.ok(contextEffective, 'fixed role/context reached the actual native request');
      const results = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map(record).filter((block) => block.type === 'tool_result')
          : []
      );
      const last = results.at(-1);
      if (turn === 'NATIVE_TEAM_ONE' && step === 1) {
        const receipt = nativeToolReceipt(last?.content);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, 'alice-session');
        taskId = String(record(receipt.effects).taskId);
        assert.ok(taskId && taskId !== 'undefined');
      }
      observations.push({
        turn,
        step,
        contextEffective,
        priorTurn: JSON.stringify(messages).includes('NATIVE_TEAM_ONE'),
        tools,
        toolResultError: last?.is_error === true,
      });
      const mcp = (name: string) => {
        const exact = tools.find((tool) => tool === `mcp__team__${name}`);
        assert.ok(exact, `actual native MCP catalog contains ${name}`);
        return exact;
      };
      const one: { name: string; input: RecordValue }[] = [
        {
          name: 'task_create',
          input: { commandId: 'native-task-create', subject: 'Native TEST task' },
        },
        {
          name: 'task_set_owner',
          input: { commandId: 'native-task-assign', taskId, owner: 'alice' },
        },
        { name: 'task_start', input: { commandId: 'native-task-start', taskId } },
        {
          name: 'Bash',
          input: {
            command: "printf 'ONE\\n' >> native-effect.txt; exit 7",
            description: 'Write one TEST-owned task effect and report a failed command',
          },
        },
        {
          name: 'task_add_comment',
          input: {
            commandId: 'native-task-comment',
            taskId,
            text: 'Native Bash produced the TEST file; command exit was seven.',
          },
        },
        { name: 'task_complete', input: { commandId: 'native-task-complete', taskId } },
        {
          name: 'message_send',
          input: { commandId: 'native-reply-one', to: 'user', text: 'REPLY_NATIVE_ONE' },
        },
      ];
      const two: { name: string; input: RecordValue }[] = [
        {
          name: 'Bash',
          input: {
            command: "printf 'TWO\\n' >> native-effect.txt",
            description: 'Append the second deliberate TEST turn',
          },
        },
        {
          name: 'message_send',
          input: { commandId: 'native-reply-two', to: 'user', text: 'REPLY_NATIVE_TWO' },
        },
      ];
      const action = (turn === 'NATIVE_TEAM_ONE' ? one : two)[step];
      if (!action) {
        counters.set(turn, step + 1);
        emitResponse(response, ++sequence, { type: 'text', text: `DONE_${turn}` });
        return;
      }
      const name = action.name === 'Bash' ? 'Bash' : mcp(action.name);
      assert.ok(tools.includes(name));
      counters.set(turn, step + 1);
      emitResponse(response, ++sequence, {
        type: 'tool_use',
        id: `native_${turn}_${step}`,
        name,
        input: action.input,
      });
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'fixture-failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST model fixture rejected request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    observations,
    failures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
