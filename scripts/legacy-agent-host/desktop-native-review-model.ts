import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  CONTEXT_MARKER,
  nativeToolReceipt,
  record,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { ServerResponse } from 'node:http';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
type Model = Awaited<ReturnType<typeof startNativeTeamModel>>;
type Row = Record<string, unknown>;
export const REVIEW_BOOTSTRAP = 'NATIVE_REVIEW_BOOTSTRAP';
export const REVIEW_TASK_SUBJECT = 'NATIVE_REVIEW_WORK';
export const REVIEW_REPLY = 'NATIVE_REVIEW_DONE';
export const REVIEW_WORK_TERMINAL_STEP = 7;
const backgroundToolId = 'native_review_work_5';

function emit(response: ServerResponse, sequence: number, block: Row, model: string): void {
  const tool = block.type === 'tool_use';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, value: Row) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', {
    message: {
      id: `msg_native_review_${sequence}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  event('message_stop', {});
  response.end();
}
function userText(message: Row): string {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content
        .map(record)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
    : '';
}
function resultText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map(record)
          .filter((block) => block.type === 'text')
          .map((block) => String(block.text))
          .join('\n')
      : '';
}
function completion(text: string, taskId: string): boolean {
  const blocks = [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)];
  if (!taskId || text.length > 16384 || blocks.length !== 1) return false;
  const block = blocks[0]![1]!;
  const field = (name: string) => {
    const values = [...block.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
    return values.length === 1 ? values[0]![1]!.trim() : '';
  };
  return (
    field('task-id') === taskId &&
    field('tool-use-id') === backgroundToolId &&
    field('status') === 'completed'
  );
}
function probe(messages: Row[], tools: string[]): boolean {
  const user = messages.filter((message) => message.role === 'user');
  return (
    tools.length === 0 &&
    messages.length <= 8 &&
    user.length === 1 &&
    messages.every(
      (message) =>
        message.role === 'user' ||
        (message.role === 'system' &&
          (typeof message.content === 'string' ||
            (Array.isArray(message.content) &&
              message.content.every((block) => record(block).type === 'text'))))
    ) &&
    userText(user[0]!)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim() === 'Reply only OK. Do not use tools, access files or run commands.'
  );
}

/** Local response script only: SDK/MCP/Read/Edit execute in the original captured native process. */
export async function startNativeReviewModel(options: {
  workspace(): string;
  principalId(): string;
}): Promise<Model & { taskId(): string; backgroundTaskId(): string }> {
  const observations: Model['observations'] = [],
    probes: Model['probes'] = [],
    failures: string[] = [];
  const unexpectedNoToolsRequests: Model['unexpectedNoToolsRequests'] = [];
  const counts = new Map<string, number>();
  let taskId = '',
    backgroundTaskId = '',
    backgroundAcknowledged = false,
    sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.includes('count_tokens')) {
        response.end('{"input_tokens":30}');
        return;
      }
      assert.equal(failures.length, 0, 'model sealed after first rejected request');
      assert.equal(request.method, 'POST');
      assert.ok(request.url?.startsWith('/v1/messages'));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        size += chunk.length;
        assert.ok(size < 2_000_000);
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const tools = (Array.isArray(body.tools) ? body.tools : [])
        .map(record)
        .map((tool) => String(tool.name));
      const requestedModel = typeof body.model === 'string' ? body.model : 'claude-sonnet-4-6';
      const requestedEffort =
        typeof record(body.output_config).effort === 'string'
          ? String(record(body.output_config).effort)
          : undefined;
      if (probe(messages, tools)) {
        assert.ok(probes.length < 8, 'finite original-dialog model probe budget');
        probes.push({
          requestedModel,
          ...(requestedEffort ? { requestedEffort } : {}),
        });
        emit(response, ++sequence, { type: 'text', text: 'OK' }, requestedModel);
        return;
      }
      assert.ok(JSON.stringify(body.system).includes(CONTEXT_MARKER));
      const latestUser = messages.findLast((message) => message.role === 'user');
      const latestText = latestUser ? userText(latestUser) : '';
      if (latestText.includes('<task-notification>')) {
        assert.equal(
          counts.get('work'),
          REVIEW_WORK_TERMINAL_STEP + 1,
          'notification ACK only after normal terminal'
        );
        assert.equal(backgroundAcknowledged, false, 'one exact background completion ACK');
        assert.ok(
          latestUser &&
            (typeof latestUser.content === 'string' ||
              (Array.isArray(latestUser.content) &&
                latestUser.content.every((block) => record(block).type === 'text'))),
          'standalone native notification only'
        );
        assert.ok(
          latestText.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') &&
            completion(latestText, backgroundTaskId),
          'exact original background task/tool completion'
        );
        backgroundAcknowledged = true;
        observations.push({
          requestedModel,
          ...(requestedEffort ? { requestedEffort } : {}),
          turn: 'background-notification',
          step: 0,
          contextEffective: true,
          priorTurn: true,
          tools,
          toolResultError: false,
          visibleReplyContract: false,
        });
        emit(
          response,
          ++sequence,
          { type: 'text', text: 'ACK_NATIVE_REVIEW_BACKGROUND' },
          requestedModel
        );
        return;
      }
      assert.ok(
        observations.filter((row) => row.turn !== 'background-notification').length < 10,
        'finite native review conversation budget'
      );
      let turn = '';
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const text = userText(message);
        if (text.includes(REVIEW_TASK_SUBJECT)) {
          turn = 'work';
          break;
        }
        if (text.includes(REVIEW_BOOTSTRAP)) {
          turn = 'bootstrap';
          break;
        }
      }
      assert.ok(turn, 'actual input contains original TEST bootstrap or user Task Start subject');
      assert.ok(JSON.stringify(body.system).includes(CONTEXT_MARKER));
      const step = counts.get(turn) ?? 0;
      const results = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map(record).filter((block) => block.type === 'tool_result')
          : []
      );
      const last = results.at(-1);
      if (turn === 'bootstrap' && step === 1) {
        const receipt = nativeToolReceipt(last?.content);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, options.principalId());
        taskId = String(record(receipt.effects).taskId);
        assert.ok(taskId && taskId !== 'undefined');
      }
      if (turn === 'work') {
        assert.ok(taskId, 'native MCP must create the real Task before original Start');
        if (step === 4) assert.equal(last?.is_error, true, 'actual failed Bash result');
        else if (step > 0)
          assert.notEqual(
            last?.is_error,
            true,
            'native Read/Edit/Write/background/MCP action must succeed'
          );
        if (step === 6) {
          assert.equal(last?.tool_use_id, backgroundToolId, 'original background tool receipt');
          const match = /^Command running in background with ID: ([A-Za-z0-9_-]{1,128})\./.exec(
            resultText(last?.content)
          );
          assert.ok(match, 'native background task registration');
          backgroundTaskId = match[1]!;
        }
        if (step === REVIEW_WORK_TERMINAL_STEP) {
          const receipt = nativeToolReceipt(last?.content);
          assert.equal(receipt.phase, 'completed');
          assert.equal(receipt.principalId, options.principalId());
        }
      }
      observations.push({
        requestedModel,
        ...(requestedEffort ? { requestedEffort } : {}),
        turn,
        step,
        contextEffective: true,
        priorTurn: turn === 'work',
        tools,
        toolResultError: last?.is_error === true,
        visibleReplyContract: false,
      });
      counts.set(turn, step + 1);
      const path = join(options.workspace(), 'native-review.ts');
      const bootstrap = [
        {
          name: 'mcp__team__task_create',
          input: {
            commandId: 'TEST-native-review-create',
            subject: REVIEW_TASK_SUBJECT,
            owner: 'alice',
          },
        },
      ];
      const work = [
        { name: 'Read', input: { file_path: path } },
        {
          name: 'Edit',
          input: {
            file_path: path,
            old_string: 'const first = 1;',
            new_string: 'const first = 2;',
            replace_all: false,
          },
        },
        {
          name: 'Edit',
          input: {
            file_path: path,
            old_string: 'const last = 1;',
            new_string: 'const last = 2;',
            replace_all: false,
          },
        },
        {
          name: 'Bash',
          input: {
            command: "printf 'FAILED\\n' >> native-review-failed.txt; exit 7",
            description: 'TEST failed foreground dirty write',
          },
        },
        {
          name: 'Write',
          input: {
            file_path: join(options.workspace(), 'native-review-write.txt'),
            content: 'WRITE\n',
          },
        },
        {
          name: 'Bash',
          input: {
            command: "sleep 0.4; printf 'BACKGROUND\\n' >> native-review-background.txt",
            run_in_background: true,
            description: 'TEST finite background dirty write',
          },
        },
        {
          name: 'mcp__team__message_send',
          input: {
            commandId: 'TEST-native-review-reply',
            to: 'user',
            text: REVIEW_REPLY,
          },
        },
      ];
      const action = (turn === 'bootstrap' ? bootstrap : work)[step];
      if (!action) {
        assert.equal(
          step,
          turn === 'bootstrap' ? 1 : REVIEW_WORK_TERMINAL_STEP,
          'no repeated native input or terminal inference'
        );
        emit(
          response,
          ++sequence,
          { type: 'text', text: `DONE_NATIVE_REVIEW_${turn}` },
          requestedModel
        );
        return;
      }
      assert.ok(tools.includes(action.name), `actual native catalog contains ${action.name}`);
      emit(
        response,
        ++sequence,
        {
          type: 'tool_use',
          id: `native_review_${turn}_${step}`,
          name: action.name,
          input: action.input,
        },
        requestedModel
      );
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'fixture-rejected');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST native review oracle rejected request');
    });
  });
  server.requestTimeout = 15000;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    crossTeamRequests: [],
    compactionRequests: [],
    compactionTokenRequests: 0,
    url: `http://127.0.0.1:${address.port}`,
    ordinaryRequests: [], // This review oracle never admits ordinary subagent inference.
    observations,
    probes,
    failures,
    unexpectedNoToolsRequests,
    taskId: () => taskId,
    backgroundTaskId: () => backgroundTaskId,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
