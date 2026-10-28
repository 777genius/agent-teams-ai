import { mixedNativeText, mixedSemanticText } from '../native-mixed-task-notifications.ts';
import type {
  MixedTaskNoticeReader,
  ObservedMixedTaskNotice,
} from '../native-mixed-task-notifications.ts';
import { assertNativeMessageImage } from '../native-message-image.ts';
import {
  readMixedGroupTurn,
  mixedGroupActions,
  assertMixedGroupReceipt,
  type MixedGroupTurn,
} from '../native-mixed-groups.ts';
// Responses SSE shapes are reused from the archived actual Codex 0.162 proof.
// This fixture scripts only inference; native app-server executes all tools.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nativePeerTurn, nativePeerActions } from '../native-peers.ts';
import { nativeToolReceipt } from '../native-claude-team/model.ts';
import { codeModeCall, codeModeReceipt, codeModeResult, commandExit, linkedOutput,
  originalCallIds, retainUiRequest, uiPalette } from './responses-ui.ts';
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
export const CONTEXT_MARKER = 'TEST_CODEX_CAPTURED_MEMBER_CONTEXT_V1';
export const REQUIRED_TOOLS = [
  'task_create',
  'task_set_owner',
  'task_start',
  'task_add_comment',
  'task_complete',
  'message_send',
];
interface Tool {
  name: string;
  namespace?: string;
}
/** Codex's pinned McpToolOutput adds this native timing header before MCP data. */
export function codexToolReceipt(output: unknown): RecordValue {
  if (typeof output === 'string')
    return nativeToolReceipt(output.replace(/^Wall time: [0-9.]+ seconds\nOutput:\n?/, ''));
  const content = (Array.isArray(output) ? output : [])
    .map(record)
    .filter((block) => block.type === 'input_text' || block.type === 'text')
    .map((block) => ({ type: 'text', text: block.text }));
  return nativeToolReceipt(content);
}
export function flattenTools(value: unknown): Tool[] {
  return (Array.isArray(value) ? value : []).flatMap((raw) => {
    const tool = record(raw);
    if (tool.type === 'namespace' && Array.isArray(tool.tools))
      return tool.tools.map((child) => ({
        name: String(record(child).name),
        namespace: String(tool.name),
      }));
    return [{ name: String(tool.name) }];
  });
}
const MODEL_PROBE_TEXT = 'Reply only OK. Do not use tools, access files or run commands.';
function messageText(message: RecordValue): string | undefined {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) &&
    message.content.every(
      (value) => record(value).type === 'input_text' && typeof record(value).text === 'string'
    )
    ? message.content.map((value) => String(record(value).text)).join('\n')
    : undefined;
}
/** Native Codex may prepend one environment user message; never accept another business input. */
export function isCodexModelProbeInput(input: readonly RecordValue[], workspace?: string): boolean {
  if (!input.every((item) => ['user', 'developer', 'system'].includes(String(item.role))))
    return false;
  const users = input.filter((item) => item.role === 'user');
  if (users.length === 1) return messageText(users[0]!) === MODEL_PROBE_TEXT;
  if (users.length !== 2 || !workspace || messageText(users[1]!) !== MODEL_PROBE_TEXT) return false;
  const context = messageText(users[0]!);
  if (!context) return false;
  const lines = context.split('\n');
  return (
    lines.length === 7 &&
    lines[0] === '<environment_context>' &&
    lines[1] === `  <cwd>${workspace}</cwd>` &&
    /^ {2}<shell>[A-Za-z0-9_/.+-]+<\/shell>$/.test(lines[2]!) &&
    /^ {2}<current_date>\d{4}-\d{2}-\d{2}<\/current_date>$/.test(lines[3]!) &&
    /^ {2}<timezone>[A-Za-z0-9_/+-]+<\/timezone>$/.test(lines[4]!) &&
    lines[5] ===
      `  <filesystem><workspace_roots><root>${workspace}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>` &&
    lines[6] === '</environment_context>'
  );
}
export const CAPTURE_TURN = 'CODEX_CAPTURE_TASK_START_V1';
export const CAPTURE_ASSIGNMENT = CAPTURE_TURN + '_ASSIGNMENT';
export const CAPTURE_BEFORE = 'TEST clean anchor\nTEST dirty preimage\nTEST tail\n';
export const CAPTURE_AFTER = 'TEST clean anchor\nTEST native foreground patched\nTEST tail\n';
export const CAPTURE_FAILED_AFTER = 'TEST clean anchor\nTEST native failed shell\nTEST tail\n';
export const CAPTURE_FAILED_COMMAND =
  "printf 'TEST clean anchor\\nTEST native failed shell\\nTEST tail\\n' > dirty.txt; printf 'TEST_CAPTURE_FAILED_SHELL_EXECUTED\\n'; exit 7";
export const CAPTURE_PATCH =
  '*** Begin Patch\n*** Update File: dirty.txt\n@@\n-TEST dirty preimage\n+TEST native foreground patched\n*** End Patch\n';
export interface CaptureFileUpdateScenario {
  failedShell?: boolean;
  workspace: string;
  taskId(): string;
  phase?(): 'assignment' | 'task-start';
}
export async function startCodexModel(
  options: {
    nativeMessageImage?: boolean;
    mixedGroups?: boolean;
    mixedTaskNotifications?: MixedTaskNoticeReader;
    peerMessaging?: boolean;
    captureFileUpdate?: CaptureFileUpdateScenario;
    allowModelProbes?: boolean;
    modelProbeWorkspace?: () => string;
    principalId?: () => string;
    memberName?: 'alice';
    uiGeneratedMessageIds?: boolean;
    captureHistoryMarkers?: boolean;
    requestEvidenceDirectory?: () => string;
  } = {}
) {
  assert.ok(!(options.peerMessaging && options.captureFileUpdate), 'one bounded fixture scenario');
  if (options.memberName || options.uiGeneratedMessageIds || options.captureHistoryMarkers)
    assert.ok(!options.mixedGroups && !options.mixedTaskNotifications && !options.peerMessaging &&
      !options.captureFileUpdate && !options.nativeMessageImage, 'one original single-member UI scenario');
  if (options.captureFileUpdate)
    assert.match(
      options.captureFileUpdate.workspace,
      /\/TEST-native-codex-capture-[^/]+\/workspace$/
    );

  const probes: {
    requestedModel?: string;
    requestedEffort?: string;
    serviceTier?: string;
    advertisedToolCount: number;
  }[] = [];
  const observations: {
    nativeImage?: ReturnType<typeof assertNativeMessageImage>;
    turn: string;
    step: number;
    contextEffective: boolean;
    priorTurn: boolean;
    tools: Tool[];
    requestedModel?: string;
    requestedEffort?: string;
    priorNativeToolIds?: string[];
    toolResultError?: boolean;
    visibleReplyContract?: boolean;
    incomingMessageId?: string;
  }[] = [];
  const notificationObservations: ((typeof observations)[number] & {
    notice: ObservedMixedTaskNotice;
  })[] = [];
  const failures: string[] = [];
  const counts = new Map<string, number>();
  const issued = new Map<string, RecordValue>();
  const requests: ReturnType<typeof retainUiRequest>[] = [];
  let taskId: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0, 'oracle seals after its first protocol failure');
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes < 2_000_000);
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (options.requestEvidenceDirectory) {
        const lite = request.headers['x-openai-internal-codex-responses-lite'];
        requests.push(retainUiRequest(options.requestEvidenceDirectory(), requests.length + 1,
          raw, request.url ?? '', typeof lite === 'string' ? lite : undefined));
      }
      assert.equal(request.method, 'POST');
      assert.match(request.url ?? '', /\/v1\/responses$/);
      if (!options.mixedTaskNotifications) assert.ok(observations.length < (options.peerMessaging ? 48 : 16));
      const body = record(JSON.parse(raw.toString('utf8')) as unknown);
      const input = (Array.isArray(body.input) ? body.input : []).map(record);
      const palette = options.uiGeneratedMessageIds ? uiPalette(body) : undefined;
      if (
        options.allowModelProbes &&
        isCodexModelProbeInput(input, options.modelProbeWorkspace?.())
      ) {
        assert.ok(probes.length < 8, 'bounded original-dialog model probes');
        // Native Codex may advertise built-in read-only tools; the scripted
        // preflight emits text only and never invents a tool outcome.
        probes.push({
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof record(body.reasoning).effort === 'string'
            ? { requestedEffort: String(record(body.reasoning).effort) }
            : {}),
          ...(typeof body.service_tier === 'string' ? { serviceTier: body.service_tier } : {}),
          advertisedToolCount: palette?.tools.length ?? flattenTools(body.tools).length,
        });
        const id = `TEST-codex-probe-${probes.length}`;
        const events = [
          { type: 'response.created', response: { id } },
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: `${id}-answer`,
              content: [{ type: 'output_text', text: 'OK' }],
            },
          },
          {
            type: 'response.completed',
            response: {
              id,
              usage: {
                input_tokens: 10,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
                total_tokens: 11,
              },
            },
          },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
        );
        return;
      }
      if (options.mixedTaskNotifications) assert.ok(observations.length + notificationObservations.length < (options.peerMessaging ? 48 : 16), 'finite mixed inference budget');
      let turn = '', turnText = '';
      let notice: ObservedMixedTaskNotice | undefined;
      let mixedGroup: MixedGroupTurn | undefined;
      for (const message of input.toReversed()) {
        if (message.role !== 'user') continue;
        const group = options.mixedGroups ? readMixedGroupTurn(message.content, 'bob') : undefined;
        const capture =
          options.captureFileUpdate && JSON.stringify(message.content).includes(CAPTURE_TURN);
        const match = /CODEX_TEAM_(ONE|TWO)/.exec(JSON.stringify(message.content));
        const peer = options.peerMessaging
          ? nativePeerTurn(JSON.stringify(message.content), 'bob')
          : undefined;
        if (options.mixedTaskNotifications) {
          const currentText = mixedNativeText(message.content);
          if (!mixedSemanticText(currentText)) continue;
          notice = options.mixedTaskNotifications(currentText);
          if (notice) {
            turn = 'TEST_TASK_NOTICE:' + notice.inputId;
            break;
          }
          assert.ok(group || peer || match, 'unrecognized CURRENT mixed input; no historical fallback');
        }
        if (group || capture || peer || match) {
          turnText = messageText(message) ?? '';
          mixedGroup = group;
          turn =
            group?.turn ??
            (capture
              ? options.captureFileUpdate?.phase?.() === 'assignment'
                ? CAPTURE_ASSIGNMENT
                : CAPTURE_TURN
              : (peer ?? match![0]));
          break;
        }
      }
      assert.ok(turn, 'actual native request retains deliberate TEST input');
      const step = counts.get(turn) ?? 0;
      const previousId = `native_${turn}_${step - 1}`;
      const previous = palette && step > 0
        ? linkedOutput(input, previousId, palette.exec !== undefined, issued.get(previousId)) : undefined;
      if (previous) assert.ok(issued.has(previousId), 'original emitted call exists');
      const previousValue = previous && palette?.exec ? codeModeResult(previous.output) : previous?.output;
      const previousReceipt = () => previous && palette?.exec
        ? codeModeReceipt(record(previousValue))
        : codexToolReceipt(previous ? previousValue : input.filter(item => item.type === 'function_call_output').at(-1)?.output);
      if ((options.mixedTaskNotifications || options.uiGeneratedMessageIds) && /_TEAM_(ONE|TWO)$/.test(turn))
        assert.ok(step <= (turn.endsWith('_ONE') ? 7 : 2), 'finite original business input; no replay');
      const incomingMessageId = /"messageId":"([^"\n]+)"/.exec(turnText)?.[1];
      const visibleReplyContract = turnText.includes('message_send tool to="user", including commandId and text') &&
        turnText.includes('Do not reuse the incoming messageId as a reply commandId') &&
        typeof incomingMessageId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(incomingMessageId);
      if (options.uiGeneratedMessageIds && turn === 'CODEX_TEAM_TWO')
        assert.ok(visibleReplyContract, 'original Composer reply contract reaches the actual native request');
      const nativeImage =
        options.nativeMessageImage && turn === 'CODEX_TEAM_TWO'
          ? assertNativeMessageImage(input, 'codex')
          : undefined;
      const groupActions = mixedGroup ? mixedGroupActions(mixedGroup) : undefined;
      if (groupActions) assert.ok(step <= groupActions.length, 'finite mixed group turn');
      const peerActions = options.peerMessaging ? nativePeerActions(turn, 'bob') : undefined;
      const capture = options.captureFileUpdate;
      if (capture && turn === CAPTURE_ASSIGNMENT)
        assert.equal(step, 0, 'one terminal-only assignment observation; no effects');
      if (capture && turn === CAPTURE_TURN) {
        assert.ok(
          step <= (capture.failedShell ? 3 : 4),
          'one bounded original native sequence, no replay'
        );
        const task = capture.taskId();
        assert.ok(
          task && task !== 'undefined',
          'actual Host canonical task ID captured before TaskStart dispatch'
        );
        if (step > 0) {
          const last = input.filter((item) => item.type === 'function_call_output').at(-1);
          assert.ok(last, 'prior native tool result required');
          if (step === 1) {
            const result = codexToolReceipt(last.output);
            assert.equal(result.id, task);
            assert.equal(result.status, 'in_progress');
            assert.equal(result.owner, 'bob');
          } else if (capture.failedShell && step === 2) {
            assertCaptureFailedShellOutput(last.output);
          } else if (capture.failedShell) {
            const result = codexToolReceipt(last.output);
            assert.equal(result.phase, 'completed');
            assert.equal(result.principalId, options.principalId?.() ?? `${options.memberName ?? 'bob'}-session`);
          } else if (step === 2) {
            assert.ok(
              JSON.stringify(last.output).includes(CAPTURE_BEFORE.trim().replaceAll('\n', '\\n')),
              'native read returns exact dirty before bytes'
            );
          } else if (step === 3) {
            assert.match(JSON.stringify(last.output), /Success\. Updated the following files/);
          } else {
            const result = codexToolReceipt(last.output);
            assert.equal(result.phase, 'completed');
            assert.equal(result.principalId, options.principalId?.() ?? 'bob-session');
          }
        }
      }
      const contextEffective = JSON.stringify([
        body.instructions,
        input.filter((item) => item.role === 'developer' || item.role === 'system'),
      ]).includes(CONTEXT_MARKER);
      assert.ok(
        contextEffective,
        'actual native request contains fixed role/team/workspace instructions'
      );
      const tools = palette?.tools ?? flattenTools(body.tools);
      let toolResultError = false;
      if (palette && ((turn === 'CODEX_TEAM_ONE' && step === 4) ||
        (turn === 'CODEX_TEAM_TWO' && step === 1)))
        toolResultError = commandExit(previousValue, palette.exec !== undefined,
          turn === 'CODEX_TEAM_ONE' ? 7 : 0) !== 0;
      if (mixedGroup && step > 0) {
        const last = input.filter((item) => item.type === 'function_call_output').at(-1);
        assertMixedGroupReceipt(mixedGroup, step, codexToolReceipt(last?.output));
      }
      if (
        (turn === 'CODEX_TEAM_ONE' && [1, 2, 3, 5, 6, 7].includes(step)) ||
        (turn === 'CODEX_TEAM_TWO' && step === 2) ||
        (peerActions && step > 0 && step <= peerActions.length)
      ) {
        const completed = previousReceipt();
        assert.equal(
          completed.phase,
          'completed',
          'native MCP action must succeed before scripted continuation'
        );
        assert.equal(completed.principalId, options.principalId?.() ?? `${options.memberName ?? 'bob'}-session`);
      }
      if (turn === 'CODEX_TEAM_ONE' && step === 1) {
        const receipt = previousReceipt();
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, options.principalId?.() ?? `${options.memberName ?? 'bob'}-session`);
        taskId = String(record(receipt.effects).taskId);
        assert.ok(taskId && taskId !== 'undefined');
      }
      const observation = {
        ...(nativeImage ? { nativeImage } : {}),
        turn,
        step,
        contextEffective,
        priorTurn: JSON.stringify(input).includes('CODEX_TEAM_ONE'),
        tools,
        ...(options.uiGeneratedMessageIds ? {
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof record(body.reasoning).effort === 'string' ? { requestedEffort: String(record(body.reasoning).effort) } : {}),
          toolResultError,
          visibleReplyContract,
          ...(incomingMessageId === undefined ? {} : { incomingMessageId }),
        } : {}),
        ...(options.captureHistoryMarkers ? { priorNativeToolIds: palette ? originalCallIds(input) : input.filter(item => item.type === 'function_call' &&
          typeof item.call_id === 'string' && /^native_CODEX_TEAM_ONE_[0-6]$/.test(item.call_id)).map(item => String(item.call_id)) } : {}),
      };
      if (notice) notificationObservations.push({ ...observation, notice });
      else observations.push(observation);
      const one = [
        {
          name: 'task_create',
          input: { commandId: 'codex-task-create', subject: 'Native Codex TEST task' },
        },
        { name: 'task_set_owner', input: { commandId: 'codex-task-assign', taskId, owner: options.memberName ?? 'bob' } },
        { name: 'task_start', input: { commandId: 'codex-task-start', taskId } },
        {
          name: 'exec_command',
          input: {
            cmd: "printf 'ONE\\n' >> native-effect.txt; exit 7",
            yield_time_ms: 1000,
            max_output_tokens: 500,
          },
        },
        {
          name: 'task_add_comment',
          input: {
            commandId: 'codex-task-comment',
            taskId,
            text: 'Codex native command wrote TEST bytes and exited seven.',
          },
        },
        { name: 'task_complete', input: { commandId: 'codex-task-complete', taskId } },
        {
          name: 'message_send',
          input: { commandId: 'codex-reply-one', to: 'user', text: 'REPLY_CODEX_ONE' },
        },
      ];
      const two = [
        {
          name: 'exec_command',
          input: {
            cmd: "printf 'TWO\\n' >> native-effect.txt",
            yield_time_ms: 1000,
            max_output_tokens: 500,
          },
        },
        {
          name: 'message_send',
          input: { commandId: 'codex-reply-two', to: 'user', text: 'REPLY_CODEX_TWO' },
        },
      ];
      const captureActions = capture
        ? turn === CAPTURE_ASSIGNMENT
          ? []
          : capture.failedShell
            ? [
                { name: 'task_get', input: { taskId: capture.taskId() } },
                {
                  name: 'exec_command',
                  input: {
                    cmd: CAPTURE_FAILED_COMMAND,
                    workdir: capture.workspace,
                    yield_time_ms: 1000,
                    max_output_tokens: 1000,
                  },
                },
                {
                  name: 'task_complete',
                  input: { commandId: 'codex-capture-complete', taskId: capture.taskId() },
                },
              ]
            : [
                { name: 'task_get', input: { taskId: capture.taskId() } },
                {
                  name: 'exec_command',
                  input: {
                    cmd: 'cat -- dirty.txt',
                    workdir: capture.workspace,
                    yield_time_ms: 1000,
                    max_output_tokens: 1000,
                  },
                },
                {
                  name: 'exec_command',
                  input: {
                    cmd: "apply_patch <<'PATCH'\n" + CAPTURE_PATCH + 'PATCH',
                    workdir: capture.workspace,
                    yield_time_ms: 1000,
                    max_output_tokens: 1000,
                  },
                },
                {
                  name: 'task_complete',
                  input: { commandId: 'codex-capture-complete', taskId: capture.taskId() },
                },
              ]
        : undefined;
      const action = notice ? undefined : (groupActions ??
        captureActions ??
        peerActions ??
        (turn === 'CODEX_TEAM_ONE' ? one : two))[step];
      let output: RecordValue;
      if (action && palette?.exec) output = codeModeCall(palette.exec, action, `native_${turn}_${step}`);
      else if (action) {
        const chosen = tools.find((tool) =>
          action.name === 'exec_command'
            ? tool.name === action.name
            : (tool.name === action.name && tool.namespace?.includes('team')) ||
              tool.name.endsWith(`__${action.name}`)
        );
        assert.ok(chosen, `actual Codex tool catalog contains ${action.name}`);
        output = {
          type: 'function_call',
          call_id: `native_${turn}_${step}`,
          name: chosen.name,
          ...(chosen.namespace ? { namespace: chosen.namespace } : {}),
          arguments: JSON.stringify(action.input),
        };
      } else
        output = {
          type: 'message',
          role: 'assistant',
          id: `TEST-final-${turn}`,
          content: [{ type: 'output_text', text: `DONE_${turn}` }],
        };
      counts.set(turn, step + 1);
      if (action && palette) {
        assert.equal(issued.has(String(output.call_id)), false);
        issued.set(String(output.call_id), output);
      }
      const id = `TEST-codex-response-${observations.length + notificationObservations.length}`;
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: output },
        {
          type: 'response.completed',
          response: {
            id,
            usage: {
              input_tokens: 10,
              input_tokens_details: null,
              output_tokens: 10,
              output_tokens_details: null,
              total_tokens: 20,
            },
          },
        },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      );
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'fixture-failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST Responses fixture rejected request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    observations,
    ...(options.mixedTaskNotifications ? { notificationObservations } : {}),
    probes,
    failures,
    ...(options.requestEvidenceDirectory ? { requests } : {}),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Pinned native command output must report failure before the model recovers. */
export function assertCaptureFailedShellOutput(output: unknown): void {
  assert.equal(typeof output, 'string');
  assert.match(String(output), /Process exited with code 7/);
  assert.match(String(output), /TEST_CAPTURE_FAILED_SHELL_EXECUTED/);
}
