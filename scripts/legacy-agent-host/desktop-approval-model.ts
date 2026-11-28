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
export const APPROVAL_TURNS = [
  'M06_DENY_COMMAND',
  'M06_ALLOW_WRITE',
  'M06_ALLOW_ALL',
  'M06_AUTO_WRITE',
  'M06_DENY_QUESTION',
  'M06_ANSWER_QUESTION',
] as const;
export const APPROVAL_BEFORE = 'TEST_ORIGINAL_PRIVATE_BYTES\n';
export const APPROVAL_AFTER = 'TEST_APPROVED_NATIVE_WRITE\n';
export const APPROVAL_ANSWER = 'TEST_BLUE';

function emit(response: ServerResponse, sequence: number, model: string, block: Row): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, value: Row) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  const tool = block.type === 'tool_use';
  event('message_start', {
    message: {
      id: `msg_m06_${sequence}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 24, output_tokens: 0 },
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
    usage: { output_tokens: 16 },
  });
  event('message_stop', {});
  response.end();
}
function text(message: Row): string {
  return typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .map(record)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
      : '';
}
export function approvalActions(workspace: string, turn: (typeof APPROVAL_TURNS)[number]) {
  const question = {
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Choose the TEST answer',
          header: 'TEST choice',
          multiSelect: false,
          options: [
            { label: APPROVAL_ANSWER, description: 'Use blue in this TEST' },
            { label: 'TEST_GREEN', description: 'Use green in this TEST' },
          ],
        },
      ],
    },
  };
  if (turn === 'M06_DENY_COMMAND')
    return [
      {
        name: 'Bash',
        input: {
          command: `printf TEST_DENIED_EFFECT > '${join(workspace, 'approval-denied.txt')}'`,
          description: 'TEST denied command must never execute',
        },
      },
    ];
  if (turn === 'M06_DENY_QUESTION' || turn === 'M06_ANSWER_QUESTION') return [question];
  const file =
    turn === 'M06_ALLOW_WRITE'
      ? 'approval-preview.txt'
      : turn === 'M06_ALLOW_ALL'
        ? 'approval-auto.txt'
        : 'approval-auto-next.txt';
  const content = turn === 'M06_ALLOW_WRITE' ? APPROVAL_AFTER : `${turn}_NATIVE_WRITE\n`;
  return [
    { name: 'Read', input: { file_path: join(workspace, file) } },
    { name: 'Write', input: { file_path: join(workspace, file), content } },
  ];
}

/** Response script only. Actual SDK permissions, tools and Runtime interactions remain production-owned. */
export async function startDesktopApprovalModel(options: {
  workspace(): string;
}): Promise<Model & { approvalReceipts: Row[] }> {
  const observations: Model['observations'] = [],
    probes: Model['probes'] = [],
    failures: string[] = [];
  const unexpectedNoToolsRequests: Model['unexpectedNoToolsRequests'] = [],
    approvalReceipts: Row[] = [];
  const counts = new Map<string, number>();
  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.includes('count_tokens')) {
        response.end('{"input_tokens":24}');
        return;
      }
      assert.equal(failures.length, 0, 'TEST permission model sealed after failure');
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
      assert.ok(Array.isArray(body.messages) && Array.isArray(body.tools));
      const messages = body.messages.map(record),
        tools = body.tools.map(record).map((tool) => tool.name);
      const source = [...messages]
        .reverse()
        .filter((message) => message.role === 'user')
        .map(text)
        .find((value) => APPROVAL_TURNS.some((turn) => value.includes(turn)));
      const turn = APPROVAL_TURNS.find((value) => source?.includes(value));
      if (!turn || tools.length === 0) {
        unexpectedNoToolsRequests.push({
          ...(typeof body.model === 'string' ? { model: body.model } : {}),
          roles: messages.map((message) => message.role),
          userContent: [],
        });
        throw new Error('Unqualified TEST approval model request');
      }
      const contextEffective = JSON.stringify(body.system).includes(CONTEXT_MARKER);
      assert.equal(contextEffective, true, 'actual captured role instructions');
      const step = counts.get(turn) ?? 0,
        nativeActions = approvalActions(options.workspace(), turn);
      const actions = [
        ...nativeActions,
        {
          name: 'mcp__team__message_send',
          input: {
            commandId: `m06-reply-${turn}`,
            to: 'user',
            text: `DONE_${turn}`,
          },
        },
      ];
      assert.ok(step <= actions.length, 'one finite request sequence per original Composer input');
      let toolResultError = false;
      if (step > 0) {
        const last = messages.at(-1)!;
        assert.equal(last.role, 'user');
        assert.ok(Array.isArray(last.content));
        const rows = last.content.map(record).filter((block) => block.type === 'tool_result');
        assert.equal(rows.length, 1);
        const toolUseId = `m06_${turn.toLowerCase()}_${step - 1}`;
        assert.equal(rows[0]!.tool_use_id, toolUseId);
        toolResultError = rows[0]!.is_error === true;
        assert.equal(
          toolResultError,
          step === 1 && (turn === 'M06_DENY_COMMAND' || turn === 'M06_DENY_QUESTION')
        );
        if (step === actions.length)
          assert.equal(
            nativeToolReceipt(rows[0]!.content).phase,
            'completed',
            'actual canonical reply completed'
          );
        if (turn === 'M06_ANSWER_QUESTION' && step === 1)
          assert.ok(
            JSON.stringify(rows[0]!.content).includes(APPROVAL_ANSWER),
            'actual question answer reached native tool result'
          );
        approvalReceipts.push({
          turn,
          step,
          toolUseId,
          toolResultError,
          ...(turn === 'M06_ANSWER_QUESTION' && step === 1 ? { answer: APPROVAL_ANSWER } : {}),
        });
      }
      const incomingMessageId = /"messageId":"([^"\n]+)"/.exec(source!)?.[1];
      assert.match(
        incomingMessageId ?? '',
        /^[a-f0-9-]{36}$/,
        'original Composer input identity reaches model'
      );
      const visibleReplyContract =
        source!.includes('message_send tool to="user", including commandId and text') &&
        source!.includes('Do not reuse the incoming messageId as a reply commandId');
      assert.ok(
        visibleReplyContract,
        'original human reply contract reached actual native request'
      );
      observations.push({
        turn,
        step,
        contextEffective,
        incomingMessageId,
        priorTurn: messages.length > 1,
        tools: tools.map(String),
        toolResultError,
        visibleReplyContract,
        ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
        ...(typeof record(body.output_config).effort === 'string'
          ? { requestedEffort: String(record(body.output_config).effort) }
          : {}),
      });
      counts.set(turn, step + 1);
      assert.ok(typeof body.model === 'string');
      if (step === actions.length) {
        emit(response, ++sequence, body.model, {
          type: 'text',
          text: `DONE_${turn}`,
        });
        return;
      }
      const action = actions[step]!;
      assert.ok(tools.includes(action.name), `actual native ${action.name} tool advertised`);
      emit(response, ++sequence, body.model, {
        type: 'tool_use',
        id: `m06_${turn.toLowerCase()}_${step}`,
        name: action.name,
        input: action.input,
      });
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'TEST model failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST approval oracle refused request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    crossTeamRequests: [],
    compactionRequests: [],
    compactionTokenRequests: 0,
    url: `http://127.0.0.1:${address.port}`,
    observations,
    probes,
    unexpectedNoToolsRequests,
    failures,
    ordinaryRequests: [],
    approvalReceipts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
