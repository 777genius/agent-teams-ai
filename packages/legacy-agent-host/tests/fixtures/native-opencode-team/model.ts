import { readMixedGroupTurn, mixedGroupActions, assertMixedGroupReceipt, type MixedGroupTurn } from '../native-mixed-groups.ts';
// Finite Chat Completions inference oracle. Actual OpenCode must execute the
// offered MCP/Bash tools; this server never writes product or workspace files.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nativePeerTurn, nativePeerActions } from '../native-peers.ts';

import { nativeToolReceipt, record } from '../native-claude-team/model.ts';

export const CONTEXT_MARKER = 'TEST_OPENCODE_CAPTURED_MEMBER_CONTEXT_V1';
export const REQUIRED_TOOLS = [
  'task_create',
  'task_set_owner',
  'task_start',
  'task_add_comment',
  'task_complete',
  'message_send',
];

export const CAPTURE_TURN = 'OPENCODE_CAPTURE_TASK_START_V1';
export const CAPTURE_ASSIGNMENT = CAPTURE_TURN + '_ASSIGNMENT';
export const CAPTURE_BEFORE = 'TEST clean anchor\nTEST dirty preimage\nTEST tail\n';
export const CAPTURE_AFTER = 'TEST clean anchor\nTEST native foreground patched\nTEST tail\n';
export interface CaptureFileUpdateScenario {
  workspace: string;
  taskId(): string;
  phase(): 'assignment' | 'task-start';
}
export async function startOpenCodeModel(
  options: { mixedGroups?: boolean; peerMessaging?: boolean; captureFileUpdate?: CaptureFileUpdateScenario; allowModelProbes?: boolean; principalId?: () => string } = {}
) {
  assert.ok(!(options.peerMessaging && options.captureFileUpdate));
  if (options.captureFileUpdate)
    assert.match(
      options.captureFileUpdate.workspace,
      /\/TEST-native-opencode-capture-[^/]+\/workspace$/
    );

  const probes: { requestedModel?: string; requestedEffort?: string }[] = [];
  const observations: {
    turn: string;
    step: number;
    contextEffective: boolean;
    priorTurn: boolean;
    tools: string[];
  }[] = [];
  const failures: string[] = [];
  const counts = new Map<string, number>();
  let taskId: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0, 'oracle seals after its first protocol failure');
      assert.equal(request.method, 'POST');
      assert.match(request.url ?? '', /\/v1\/chat\/completions$/);
      assert.ok(
        observations.length < (options.peerMessaging ? 48 : 16),
        'finite model request budget'
      );
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes < 2_000_000);
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const user = messages.filter(item => item.role === 'user');
      const probeText = user.length === 1 && messages.every(item => item.role === 'user' || item.role === 'system')
        ? typeof user[0]?.content === 'string' ? user[0].content
          : Array.isArray(user[0]?.content) && user[0].content.every(raw => record(raw).type === 'text' && typeof record(raw).text === 'string')
            ? user[0].content.map(raw => String(record(raw).text)).join('\n') : undefined
        : undefined;
      if (options.allowModelProbes && probeText === 'Reply only OK. Do not use tools, access files or run commands.' && (!Array.isArray(body.tools) || body.tools.length === 0)) {
        assert.ok(probes.length < 8, 'bounded original-dialog model probes');
        probes.push({ ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof body.reasoning_effort === 'string' ? { requestedEffort: body.reasoning_effort } : {}) });
        const event = (delta: Record<string, unknown>, finish: string | null) => ({ id: `TEST-opencode-probe-${probes.length}`, object: 'chat.completion.chunk', created: 1700000000,
          model: typeof body.model === 'string' ? body.model : 'TEST-model', choices: [{ index: 0, delta, finish_reason: finish }] });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`);
        response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`); response.end('data: [DONE]\n\n'); return;
      }
      let turn = '';
      let mixedGroup: MixedGroupTurn | undefined;
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const group = options.mixedGroups ? readMixedGroupTurn(message.content, 'carol') : undefined;
        const capture =
          options.captureFileUpdate && JSON.stringify(message.content).includes(CAPTURE_TURN);
        const match = /OPENCODE_TEAM_(ONE|TWO)/.exec(JSON.stringify(message.content));
        const peer = options.peerMessaging
          ? nativePeerTurn(JSON.stringify(message.content), 'carol')
          : undefined;
        if (group || capture || peer || match) {
          mixedGroup = group;
          turn = group?.turn ?? (capture
            ? options.captureFileUpdate!.phase() === 'assignment'
              ? CAPTURE_ASSIGNMENT
              : CAPTURE_TURN
            : (peer ?? match![0]));
          break;
        }
      }
      assert.ok(turn, 'native request retains deliberate TEST business input');
      const step = counts.get(turn) ?? 0;
      const groupActions = mixedGroup ? mixedGroupActions(mixedGroup) : undefined;
      if (groupActions) assert.ok(step <= groupActions.length, 'finite mixed group turn');
      const peerActions = options.peerMessaging ? nativePeerActions(turn, 'carol') : undefined;
      const capture = options.captureFileUpdate;
      if (capture && turn === CAPTURE_ASSIGNMENT)
        assert.equal(step, 0, 'one assignment terminal, no tools/effects');
      if (capture && turn === CAPTURE_TURN) {
        assert.ok(step <= 2, 'one native read/edit/final input; no replay');
        assert.ok(capture.taskId(), 'original Host canonical task captured before TaskStart');
        if (step > 0) {
          const last = messages.filter((item) => item.role === 'tool').at(-1);
          assert.ok(last);
          const output = JSON.stringify(last.content);
          if (step === 1)
            assert.ok(
              output.includes('TEST dirty preimage') &&
                !output.includes('TEST native foreground patched'),
              'native read observes dirty preimage'
            );
          else
            assert.ok(
              output.includes('Edit applied successfully.'),
              'native edit must succeed before terminal'
            );
        }
      }
      const contextEffective = JSON.stringify(
        messages.filter((item) => item.role === 'system')
      ).includes(CONTEXT_MARKER);
      assert.ok(contextEffective, 'native model request contains selected member instructions');
      const tools = (Array.isArray(body.tools) ? body.tools : [])
        .map(record)
        .map((tool) => String(record(tool.function).name));
      if (mixedGroup && step > 0) {
        const last = messages.filter(item => item.role === 'tool').at(-1);
        assertMixedGroupReceipt(mixedGroup, step, nativeToolReceipt(last?.content));
      }
      if (
        (turn === 'OPENCODE_TEAM_ONE' && [1, 2, 3, 5, 6, 7].includes(step)) ||
        (turn === 'OPENCODE_TEAM_TWO' && step === 2) ||
        (peerActions && step > 0 && step <= peerActions.length)
      ) {
        const result = messages.filter((item) => item.role === 'tool').at(-1);
        const completed = nativeToolReceipt(result?.content);
        assert.equal(
          completed.phase,
          'completed',
          'native MCP action must succeed before scripted continuation'
        );
        assert.equal(completed.principalId, options.principalId?.() ?? 'carol-session');
      }
      if (turn === 'OPENCODE_TEAM_ONE' && step === 1) {
        const result = messages.filter((item) => item.role === 'tool').at(-1);
        const receipt = nativeToolReceipt(result?.content);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, options.principalId?.() ?? 'carol-session');
        taskId = String(record(receipt.effects).taskId);
        assert.ok(taskId && taskId !== 'undefined');
      }
      observations.push({
        turn,
        step,
        contextEffective,
        priorTurn: JSON.stringify(messages).includes('OPENCODE_TEAM_ONE'),
        tools,
      });
      const first = [
        {
          name: 'task_create',
          input: { commandId: 'opencode-task-create', subject: 'Native OpenCode TEST task' },
        },
        {
          name: 'task_set_owner',
          input: { commandId: 'opencode-task-assign', taskId, owner: 'carol' },
        },
        { name: 'task_start', input: { commandId: 'opencode-task-start', taskId } },
        {
          name: 'bash',
          input: {
            command: "printf 'ONE\\n' >> native-effect.txt; exit 7",
            description: 'TEST partial effect and failed shell exit',
          },
        },
        {
          name: 'task_add_comment',
          input: {
            commandId: 'opencode-task-comment',
            taskId,
            text: 'OpenCode native Bash wrote TEST bytes and exited seven.',
          },
        },
        { name: 'task_complete', input: { commandId: 'opencode-task-complete', taskId } },
        {
          name: 'message_send',
          input: { commandId: 'opencode-reply-one', to: 'user', text: 'REPLY_OPENCODE_ONE' },
        },
      ];
      const second = [
        {
          name: 'bash',
          input: {
            command: "printf 'TWO\\n' >> native-effect.txt",
            description: 'TEST second sequential input',
          },
        },
        {
          name: 'message_send',
          input: { commandId: 'opencode-reply-two', to: 'user', text: 'REPLY_OPENCODE_TWO' },
        },
      ];
      const captureActions = capture
        ? turn === CAPTURE_ASSIGNMENT
          ? []
          : [
              { name: 'read', input: { filePath: capture.workspace + '/dirty.txt' } },
              {
                name: 'edit',
                input: {
                  filePath: capture.workspace + '/dirty.txt',
                  oldString: 'TEST dirty preimage',
                  newString: 'TEST native foreground patched',
                },
              },
            ]
        : undefined;
      const action = (groupActions ?? captureActions ??
        peerActions ??
        (turn === 'OPENCODE_TEAM_ONE' ? first : second))[step];
      let delta: Record<string, unknown>;
      if (action) {
        const chosen = tools.find((name) =>
          ['bash', 'read', 'edit'].includes(action.name)
            ? name === action.name
            : name === `team_${action.name}`
        );
        assert.ok(chosen, `actual OpenCode catalog contains ${action.name}`);
        delta = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `TEST_${turn}_${step}`,
              type: 'function',
              function: { name: chosen, arguments: JSON.stringify(action.input) },
            },
          ],
        };
      } else delta = { role: 'assistant', content: `DONE_${turn}` };
      counts.set(turn, step + 1);
      const event = (value: Record<string, unknown>, finish: string | null) => ({
        id: `TEST-opencode-response-${observations.length}`,
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'TEST-model',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(event(delta, null))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, action ? 'tool_calls' : 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'fixture-failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST Chat Completions fixture rejected request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    observations,
    probes,
    failures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
