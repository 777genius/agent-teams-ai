import { nativeGroupChatScript } from './group-chat.ts';
import { assertNativeChatAttachments } from './chat-attachments.ts';
import { contextCompactionScript } from '../native-claude-compaction/model.ts';
import type { CompactionScenario } from '../native-claude-compaction/model.ts';
import { ordinarySubagentScript } from '../native-claude-subagent/model.ts';
// Finite Anthropic SSE oracle adapted from the archived P1 packed-host walk.
// It scripts model responses only: native Claude executes every MCP/Bash tool.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nativePeerTurn, nativePeerActions } from '../native-peers.ts';
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
          // Native text carries the receipt directly; structuredContent wraps it.
          // A canonical receipt also has its own business result, which is not an envelope.
          return record(typeof value.phase === 'string' ? value : (value.result ?? value));
        }
      }
    }
  }
  throw new Error('Native MCP receipt JSON missing or incomplete');
}

interface Observation {
  requestedModel?: string;
  requestedEffort?: string;
  turn: string;
  step: number;
  contextEffective: boolean;
  priorTurn: boolean;
  priorNativeToolIds?: string[];
  tools: string[];
  toolResultError: boolean;
  visibleReplyContract: boolean;
  incomingMessageId?: string;
}

function emitResponse(
  response: ServerResponse,
  sequence: number,
  block: RecordValue,
  model = 'claude-sonnet-4-6'
): void {
  const tool = block.type === 'tool_use';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, payload: RecordValue) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  emit('message_start', {
    message: {
      id: `msg_native_team_${sequence}`,
      type: 'message',
      role: 'assistant',
      model,
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

export async function startNativeTeamModel(
  options: {
    chatAttachments?: boolean;
    groupChats?: boolean;
    ordinarySubagents?: { workspace: string; parentStopRequested?: () => boolean };
    contextCompaction?: CompactionScenario;
    requireVisibleReply?: boolean;
    /** TEST Quit proof: hold one real first-turn inference until its client is closed. */
    holdInitialTurnResponse?: boolean;
    peerMessaging?: boolean;
    uiGeneratedMessageIds?: boolean;
    /** TEST-only original native tool-use IDs observed in actual model request history. */
    captureHistoryMarkers?: boolean;
    allowModelProbes?: boolean;
    principalId?: () => string;
    memberName?: 'alice' | 'team-lead';
  } = {}
) {
  const groupChats = options.groupChats ? nativeGroupChatScript(nativeToolReceipt) : undefined;
  const compaction = options.contextCompaction
    ? contextCompactionScript(options.contextCompaction)
    : undefined;
  const ordinary = options.ordinarySubagents
    ? ordinarySubagentScript(
        options.ordinarySubagents.workspace,
        options.ordinarySubagents.parentStopRequested
      )
    : undefined;
  const observations: Observation[] = [];
  const probes: { requestedModel?: string; requestedEffort?: string }[] = [];
  const unexpectedNoToolsRequests: {
    model?: string;
    roles: unknown[];
    userContent: { blockTypes: string[]; text: string[] }[];
  }[] = [];
  const failures: string[] = [];
  const heldInitialRequests: { turn: string; step: number; disconnected: boolean }[] = [];
  const counters = new Map<string, number>();
  let taskId: string | undefined;
  let sequence = 0;
  let compactionTokenRequests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.includes('count_tokens')) {
        if (compaction)
          assert.ok(++compactionTokenRequests <= 8, 'bounded native compact token-count requests');
        response.end('{"input_tokens":20}');
        return;
      }
      assert.equal(failures.length, 0, 'oracle is sealed after its first protocol failure');
      assert.equal(request.method, 'POST');
      assert.ok(request.url?.startsWith('/v1/messages'));
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
      const tools = (Array.isArray(body.tools) ? body.tools.map(record) : []).map((tool) =>
        String(tool.name)
      );
      if (groupChats) {
        emitResponse(
          response,
          ++sequence,
          groupChats.respond(body, tools),
          typeof body.model === 'string' ? body.model : undefined
        );
        return;
      }
      if (compaction) {
        emitResponse(
          response,
          ++sequence,
          compaction.respond(body, tools),
          typeof body.model === 'string' ? body.model : undefined
        );
        return;
      }
      if (ordinary) {
        emitResponse(
          response,
          ++sequence,
          ordinary.respond(body, tools),
          typeof body.model === 'string' ? body.model : undefined
        );
        return;
      }
      const probeMessages = messages.filter((message) => message.role === 'user');
      const probeContent = probeMessages[0]?.content;
      const probeTexts =
        typeof probeContent === 'string'
          ? [probeContent]
          : Array.isArray(probeContent) &&
              probeContent.every(
                (block) => record(block).type === 'text' && typeof record(block).text === 'string'
              )
            ? probeContent.map((block) => String(record(block).text))
            : [];
      const textOnlySystem = (message: Record<string, unknown>) => {
        if (message.role !== 'system') return false;
        if (typeof message.content === 'string') return message.content.length <= 64 * 1024;
        return (
          Array.isArray(message.content) &&
          message.content.length > 0 &&
          message.content.length <= 8 &&
          message.content.every((raw) => {
            const block = record(raw);
            return (
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.length <= 64 * 1024
            );
          })
        );
      };
      // One exact SDK user input may have native reminders and text-only system transport wrappers.
      // Additional user, assistant, tool, or nontext system messages never qualify as a model probe.
      const probeText =
        messages.length <= 8 &&
        probeMessages.length === 1 &&
        messages.every((message) => message.role === 'user' || textOnlySystem(message))
          ? probeTexts
              .map((text) =>
                text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
              )
              .filter(Boolean)
              .join('\n')
          : undefined;
      if (
        options.allowModelProbes &&
        probeText === 'Reply only OK. Do not use tools, access files or run commands.' &&
        tools.length === 0
      ) {
        assert.ok(probes.length < 8, 'finite native model probe request budget');
        probes.push({
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof record(body.output_config).effort === 'string'
            ? { requestedEffort: String(record(body.output_config).effort) }
            : {}),
        });
        emitResponse(
          response,
          ++sequence,
          { type: 'text', text: 'OK' },
          typeof body.model === 'string' ? body.model : undefined
        );
        return;
      }
      if (options.allowModelProbes && tools.length === 0 && unexpectedNoToolsRequests.length < 2) {
        unexpectedNoToolsRequests.push({
          ...(typeof body.model === 'string' ? { model: body.model.slice(0, 256) } : {}),
          roles: messages.slice(0, 8).map((message) => message.role),
          userContent: probeMessages.slice(0, 8).map((message) => {
            const blocks =
              typeof message.content === 'string'
                ? [{ type: 'text', text: message.content }]
                : Array.isArray(message.content)
                  ? message.content.map(record)
                  : [];
            return {
              blockTypes: blocks.slice(0, 8).map((block) => String(block.type).slice(0, 64)),
              text: blocks
                .filter((block) => block.type === 'text' && typeof block.text === 'string')
                .slice(0, 8)
                .map((block) =>
                  String(block.text)
                    .replace(
                      /<system-reminder>[\s\S]*?<\/system-reminder>/g,
                      '<system-reminder>[omitted]</system-reminder>'
                    )
                    .slice(0, 1024)
                ),
            };
          }),
        });
      }
      assert.ok(
        observations.length < (options.peerMessaging ? 48 : 16),
        'finite native model request budget'
      );
      let turn = '';
      let turnText = '';
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
        const peer = options.peerMessaging ? nativePeerTurn(text, 'alice') : undefined;
        if (peer || match) {
          turn = peer ?? match![0];
          turnText = text;
          break;
        }
      }
      assert.ok(turn, 'request is tied to a deliberate TEST input');
      const step = counters.get(turn) ?? 0;
      if (options.chatAttachments && turn === 'NATIVE_TEAM_TWO' && step === 0)
        assertNativeChatAttachments(messages);
      const peerActions = options.peerMessaging ? nativePeerActions(turn, 'alice') : undefined;
      const incomingMessageId = /"messageId":"([^"\n]+)"/.exec(turnText)?.[1];
      const expectedMessageId = options.uiGeneratedMessageIds
        ? typeof incomingMessageId === 'string' &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(incomingMessageId)
        : incomingMessageId === `human-native-${turn === 'NATIVE_TEAM_ONE' ? 'one' : 'two'}`;
      const visibleReplyContract =
        turnText.includes('message_send tool to="user", including commandId and text') &&
        turnText.includes('Do not reuse the incoming messageId as a reply commandId') &&
        expectedMessageId;
      if (options.requireVisibleReply)
        assert.ok(
          visibleReplyContract,
          'prepared human message reply contract reached the actual native model request'
        );
      const contextEffective = JSON.stringify(body.system).includes(CONTEXT_MARKER);
      assert.ok(contextEffective, 'fixed role/context reached the actual native request');
      const results = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map(record).filter((block) => block.type === 'tool_result')
          : []
      );
      const last = results.at(-1);
      if (
        (turn === 'NATIVE_TEAM_ONE' && [1, 2, 3, 5, 6, 7].includes(step)) ||
        (turn === 'NATIVE_TEAM_TWO' && step === 2) ||
        (peerActions && step > 0 && step <= peerActions.length)
      ) {
        const completed = nativeToolReceipt(last?.content);
        assert.equal(
          completed.phase,
          'completed',
          'native MCP action must succeed before scripted continuation'
        );
        assert.equal(completed.principalId, options.principalId?.() ?? 'alice-session');
      }
      if (turn === 'NATIVE_TEAM_ONE' && step === 1) {
        const receipt = nativeToolReceipt(last?.content);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, options.principalId?.() ?? 'alice-session');
        taskId = String(record(receipt.effects).taskId);
        assert.ok(taskId && taskId !== 'undefined');
      }
      observations.push({
        ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
        ...(typeof record(body.output_config).effort === 'string'
          ? { requestedEffort: String(record(body.output_config).effort) }
          : {}),
        turn,
        step,
        contextEffective,
        priorTurn: JSON.stringify(messages).includes('NATIVE_TEAM_ONE'),
        ...(options.captureHistoryMarkers
          ? {
              priorNativeToolIds: messages.flatMap((message) =>
                Array.isArray(message.content)
                  ? message.content
                      .map(record)
                      .filter(
                        (block) =>
                          block.type === 'tool_use' &&
                          typeof block.id === 'string' &&
                          /^native_NATIVE_TEAM_ONE_[0-6]$/.test(block.id)
                      )
                      .map((block) => String(block.id))
                  : []
              ),
            }
          : {}),
        tools,
        toolResultError: last?.is_error === true,
        visibleReplyContract,
        ...(options.uiGeneratedMessageIds && incomingMessageId !== undefined
          ? { incomingMessageId }
          : {}),
      });
      if (options.holdInitialTurnResponse) {
        assert.equal(turn, 'NATIVE_TEAM_ONE', 'queued input must never reach native inference');
        assert.equal(step, 0);
        assert.equal(
          heldInitialRequests.length,
          0,
          'one original native request, no inference retry'
        );
        for (const tool of REQUIRED_TOOLS) assert.ok(tools.includes(`mcp__team__${tool}`));
        assert.ok(tools.includes('Bash'));
        const held = { turn, step, disconnected: false };
        heldInitialRequests.push(held);
        await new Promise<void>((resolve) => {
          response.once('close', () => {
            held.disconnected = true;
            resolve();
          });
          if (response.destroyed) {
            held.disconnected = true;
            resolve();
          }
        });
        return;
      }
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
          input: { commandId: 'native-task-assign', taskId, owner: options.memberName ?? 'alice' },
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
      const action = (peerActions ?? (turn === 'NATIVE_TEAM_ONE' ? one : two))[step];
      if (!action) {
        counters.set(turn, step + 1);
        emitResponse(
          response,
          ++sequence,
          { type: 'text', text: `DONE_${turn}` },
          typeof body.model === 'string' ? body.model : undefined
        );
        return;
      }
      const name = action.name === 'Bash' ? 'Bash' : mcp(action.name);
      assert.ok(tools.includes(name));
      counters.set(turn, step + 1);
      emitResponse(
        response,
        ++sequence,
        {
          type: 'tool_use',
          id: `native_${turn}_${step}`,
          name,
          input: action.input,
        },
        typeof body.model === 'string' ? body.model : undefined
      );
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
    ordinaryRequests: ordinary?.requests ?? [],
    compactionRequests: compaction?.requests ?? [],
    get compactionTokenRequests() {
      return compactionTokenRequests;
    },
    observations,
    ...(groupChats ? { groupRequests: groupChats.requests } : {}),
    ...(options.holdInitialTurnResponse ? { heldInitialRequests } : {}),
    probes,
    unexpectedNoToolsRequests,
    failures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
