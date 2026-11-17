import { createHash } from 'node:crypto';
import { codexFailedShellCaptureFixture } from './capture.ts';
import { CAPTURE_FAILED_AFTER, assertCaptureFailedShellOutput } from './model.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupMcpTools } from '../../../dist/mcp/groupChatTools.js';
import { formatToolResult } from '../../../dist/mcp/toolDefinition.js';
import { readGroupList } from '../../../dist/group-chats/publicValues.js';
import { nativeToolReceipt } from '../native-claude-team/model.ts';
import { assertMixedGroupReceipt, MIXED_GROUP_INPUT } from '../native-mixed-groups.ts';

import {
  CAPTURE_BEFORE,
  CAPTURE_ASSIGNMENT,
  CAPTURE_TURN,
  CONTEXT_MARKER,
  REQUIRED_TOOLS,
  startCodexModel,
  isCodexModelProbeInput,
} from './model.ts';

test('Mixed list consumes actual MCP DTO arrays and pinned Codex structured output without weakening receipts', async () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const groups = readGroupList([
    {
      id,
      name: 'TEST mixed group',
      createdAt: '2026-10-28T00:00:00Z',
      membership: { kind: 'fixed', memberNames: ['team-lead', 'bob', 'carol'] },
      archivedAt: null,
      memberNames: ['team-lead', 'bob', 'carol'],
      availableRecipientNames: ['team-lead', 'bob', 'carol'],
      canSend: true,
    },
  ]);
  const list = createGroupMcpTools({
    list: async () => groups,
    async execute() {
      throw new Error('No mutation in list formatter verification');
    },
    lookup() {
      throw new Error('No lookup in list formatter verification');
    },
  }).find((tool) => tool.definition.name === 'group_chat_list')!;
  const result = formatToolResult(await list.invoke({}), list.mutation);
  assert.deepEqual(result.structuredContent, { result: groups });
  const group = { actor: 'bob' as const, turn: 'TEST group', context: { groupChatId: id } };
  assertMixedGroupReceipt(group, 1, result.content, nativeToolReceipt);
  const structured = JSON.stringify(result.structuredContent);
  assertMixedGroupReceipt(group, 1, structured, nativeToolReceipt);
  assert.throws(() => nativeToolReceipt(result.content), /missing or incomplete/);
  assert.deepEqual(nativeToolReceipt(structured), {}, 'generic object receipt guard is unchanged');
  for (const invalid of [
    JSON.stringify({ code: 'FORBIDDEN', message: id }),
    JSON.stringify({ result: groups, isError: true }),
    JSON.stringify({ result: 'not a list' }),
    JSON.stringify(42),
    JSON.stringify([{ id }]),
    JSON.stringify([{ ...groups[0], id: '20000000-0000-4000-8000-000000000001', name: id }]),
    JSON.stringify([groups[0], groups[0]]),
    '{"result":[',
    structured + '\nUNKNOWN',
    JSON.stringify({ result: groups }) + ' '.repeat(256 * 1024),
    [
      { type: 'text', text: structured },
      { type: 'text', text: structured },
    ],
  ])
    assert.throws(() => assertMixedGroupReceipt(group, 1, invalid, nativeToolReceipt));

  const context = {
    to: 'bob',
    from: 'user',
    source: 'user_sent',
    text: MIXED_GROUP_INPUT,
    groupChatProtocolVersion: 1,
    groupChatId: id,
    messageId: id + ':g:' + 'a'.repeat(24),
    groupMessageId: id,
    groupRunKey: 'host-group-v1:' + 'b'.repeat(64),
    groupRecipientRunKeys: { bob: 'host-group-v1:' + 'b'.repeat(64) },
  };
  const model = await startCodexModel({ mixedGroups: true });
  const input: unknown[] = [{ role: 'user', content: 'Group context: ' + JSON.stringify(context) }];
  const next = () =>
    fetch(model.url + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instructions: CONTEXT_MARKER,
        input,
        tools: [
          { type: 'function', name: 'mcp__team__group_chat_list' },
          { type: 'function', name: 'mcp__team__group_chat_react' },
        ],
      }),
    });
  try {
    const first = await next();
    assert.equal(first.status, 200);
    assert.match(await first.text(), /mcp__team__group_chat_list/);
    // Pinned c138 models.rs2316-2323 prefers structuredContent; tools/context.rs adds timing.
    input.push({
      type: 'function_call_output',
      output: 'Wall time: 0.0001 seconds\nOutput:\n' + structured,
    });
    const second = await next();
    assert.equal(second.status, 200);
    assert.match(await second.text(), /mcp__team__group_chat_react/);
    assert.deepEqual(
      model.observations.map((row) => row.step),
      [0, 1]
    );
    assert.deepEqual(model.failures, []);
  } finally {
    await model.close();
  }
});

test('Codex oracle refuses a failed MCP reply instead of fabricating a successful final turn', async () => {
  const model = await startCodexModel();
  const input: Record<string, unknown>[] = [
    { role: 'developer', content: CONTEXT_MARKER },
    { role: 'user', content: 'CODEX_TEAM_TWO' },
  ];
  const next = () =>
    fetch(model.url + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'namespace', name: 'mcp__team', tools: REQUIRED_TOOLS.map((name) => ({ name })) },
        ],
      }),
    });
  try {
    const bash = await next();
    assert.equal(bash.status, 200);
    await bash.text();
    input.push({ type: 'function_call_output', output: 'TEST completed Bash' });
    const reply = await next();
    assert.equal(reply.status, 200);
    await reply.text();
    input.push({
      type: 'function_call_output',
      output: JSON.stringify({ message: 'TEST native MCP HTTP transport failure' }),
    });
    const rejected = await next();
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /fixture rejected/);
    assert.equal(model.observations.length, 2, 'no successful final continuation is emitted');
    assert.equal(model.failures.length, 1);
  } finally {
    await model.close();
  }

  // Synthetic HTTP oracle checks only; approval, checkpoint and cancellation still require native D.
  for (const candidate of [false, true]) {
    const selectedModel = 'TEST-native-selected-model';
    const bounded = await startCodexModel(candidate ? { candidate169: { selectedModel: () => selectedModel } } : {});
    const history: Record<string, unknown>[] = [{ role: 'developer', content: CONTEXT_MARKER }];
    const abort = new AbortController();
    const request = () => fetch(bounded.url + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ model: selectedModel, input: history, tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'namespace', name: 'mcp__team', tools: REQUIRED_TOOLS.map(name => ({ name })) },
      ] }),
    });
    try {
      for (const label of ['ONE', 'TWO'] as const) {
        history.push({ role: 'user', content: 'CODEX_TEAM_' + label });
        const toolCount = label === 'ONE' ? 7 : 2;
        for (let step = 0; step <= toolCount; step += 1) {
          if (candidate && label === 'TWO' && step === toolCount) {
            let settled = false;
            const held = request().finally(() => { settled = true; });
            void held.catch(() => {});
            const deadline = Date.now() + 1000;
            while (!bounded.candidateFinalHeld() && Date.now() < deadline)
              await new Promise<void>(resolve => setTimeout(resolve, 5));
            assert.equal(bounded.candidateFinalHeld(), true);
            assert.equal(settled, false, 'original final response has no synthetic terminal or headers');
            assert.equal(bounded.observations.length, 11, 'no added inference request');
            abort.abort();
            await assert.rejects(held, { name: 'AbortError' });
            continue;
          }
          const response = await request();
          assert.equal(response.status, 200);
          const packets = (await response.text()).split('\n')
            .filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
          const event = packets.find(packet => packet.type === 'response.output_item.done');
          assert.ok(event && typeof event.item === 'object' && event.item !== null);
          const item = event.item as Record<string, unknown>;
          history.push(item);
          if (step === toolCount) {
            assert.equal(item.type, 'message');
            continue;
          }
          assert.equal(item.type, 'function_call');
          const args = JSON.parse(String(item.arguments)) as Record<string, unknown>;
          if (label === 'ONE' && step === 3) {
            assert.equal(args.cmd, "printf 'ONE\\n' >> native-effect.txt; exit 7");
            assert.equal(args.sandbox_permissions, candidate ? 'require_escalated' : undefined);
            assert.equal(args.justification, candidate
              ? 'TEST one-shot original command approval before the ONE effect' : undefined);
          }
          history.push({ type: 'function_call_output', call_id: item.call_id,
            output: item.name === 'exec_command'
              ? 'Process exited with code ' + (label === 'ONE' ? 7 : 0) + '\nOutput:\n'
              : JSON.stringify({ phase: 'completed', principalId: 'bob-session', effects: { taskId: 'TEST-task' } }) });
        }
      }
      assert.deepEqual(bounded.failures, []);
      assert.equal(bounded.observations.length, 11);
      assert.equal(bounded.candidateFinalHeld(), candidate);
      if (candidate) {
        assert.ok(bounded.observations.every(row => row.requestedModel === selectedModel));
        assert.ok(bounded.observations.filter(row => row.turn === 'CODEX_TEAM_TWO')
          .every(row => row.priorNativeToolIds?.length === 7));
        assert.equal(bounded.observations.filter(row => row.toolResultError).length, 1);
      }
    } finally {
      abort.abort();
      await bounded.close();
    }
  }

  // Source selection holds the same A response; this HTTP fixture cannot attest native custody.
  let finalReceiptObserved: () => void = () => assert.fail('original receipt observer installed');
  const finalReceipt = new Promise<void>((resolve) => { finalReceiptObserved = resolve; });
  let observingFinal = false;
  const source = await startCodexModel({
    sourceSelection: true,
    allowModelProbes: true,
    uiGeneratedMessageIds: true,
    captureHistoryMarkers: true,
    memberName: 'alice',
    principalId: () => {
      if (observingFinal) finalReceiptObserved();
      return 'alice-session';
    },
  });
  const abort = new AbortController();
  let selectedModel = 'TEST-source-A-model';
  let history: Record<string, unknown>[] = [];
  const request = (input = history) => fetch(source.url + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
    body: JSON.stringify({ model: selectedModel, input, tools: [
      { type: 'function', name: 'exec_command' },
      { type: 'namespace', name: 'mcp__team', tools: REQUIRED_TOOLS.map(name => ({ name })) },
    ] }),
  });
  try {
    assert.equal(source.firstFinalHeld(), false);
    assert.throws(() => source.releaseFirstFinal(), /original live final response released once/);
    for (const label of ['ONE', 'TWO'] as const) {
      if (label === 'TWO') selectedModel = 'TEST-source-B-model';
      const probe = await request([{
        role: 'user', content: 'Reply only OK. Do not use tools, access files or run commands.',
      }]);
      assert.equal(probe.status, 200);
      assert.match(await probe.text(), /"text":"OK"/);
      history = [
        { role: 'developer', content: CONTEXT_MARKER },
        { role: 'user', content: 'CODEX_TEAM_' + label },
      ];
      const toolCount = label === 'ONE' ? 7 : 2;
      for (let step = 0; step <= toolCount; step += 1) {
        let response: Response;
        if (label === 'ONE' && step === 7) {
          observingFinal = true;
          let settled = false;
          const held = request().finally(() => { settled = true; });
          void held.catch(() => {});
          await Promise.race([finalReceipt, held.then(() => assert.fail('original A final held'))]);
          observingFinal = false;
          assert.equal(source.firstFinalHeld(), true);
          assert.equal(settled, false, 'same final HTTP response has no headers before release');
          assert.equal(source.observations.length, 8);
          assert.equal(source.probes.length, 1);
          source.releaseFirstFinal();
          assert.equal(source.firstFinalHeld(), false);
          assert.throws(() => source.releaseFirstFinal(), /original live final response released once/);
          response = await held;
        } else response = await request();
        assert.equal(response.status, 200);
        const packets = (await response.text()).split('\n')
          .filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
        const event = packets.find(packet => packet.type === 'response.output_item.done');
        assert.ok(event && typeof event.item === 'object' && event.item !== null);
        const item = event.item as Record<string, unknown>;
        history.push(item);
        if (step === toolCount) {
          assert.equal(item.type, 'message');
          assert.deepEqual(item.content, [{ type: 'output_text', text: 'DONE_CODEX_TEAM_' + label }]);
          continue;
        }
        assert.equal(item.type, 'function_call');
        history.push({ type: 'function_call_output', call_id: item.call_id,
          output: item.name === 'exec_command'
            ? 'Process exited with code ' + (label === 'ONE' ? 7 : 0) + '\nOutput:\n'
            : JSON.stringify({ phase: 'completed', principalId: 'alice-session', effects: { taskId: 'TEST-source-task' } }) });
      }
    }
    assert.deepEqual(source.failures, []);
    assert.equal(source.observations.length, 11);
    assert.deepEqual(source.probes.map(row => row.requestedModel), ['TEST-source-A-model', 'TEST-source-B-model']);
    assert.ok(source.observations.filter(row => row.turn === 'CODEX_TEAM_ONE')
      .every(row => row.requestedModel === 'TEST-source-A-model'));
    assert.ok(source.observations.filter(row => row.turn === 'CODEX_TEAM_TWO').every(row =>
      row.requestedModel === 'TEST-source-B-model' && !row.priorTurn &&
      row.priorNativeToolIds?.length === 0 && row.incomingMessageId === undefined && !row.visibleReplyContract));
    assert.equal(source.firstFinalHeld(), false);
    assert.equal(source.candidateFinalHeld(), false);
  } finally {
    abort.abort();
    await source.close();
  }

});

test('capture fixture completes assignment without effects before independent TaskStart read/update', async () => {
  const workspace = '/private/tmp/TEST-native-codex-capture-model/workspace';
  let phase: 'assignment' | 'task-start' = 'assignment';
  const model = await startCodexModel({
    captureFileUpdate: { workspace, taskId: () => 'TEST-canonical-task', phase: () => phase },
  });
  const input: Record<string, unknown>[] = [
    { role: 'developer', content: CONTEXT_MARKER },
    { role: 'user', content: `Task #TEST-canonical-task: ${CAPTURE_TURN}` },
  ];
  const next = () =>
    fetch(model.url + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        tools: [
          { type: 'function', name: 'exec_command' },
          {
            type: 'namespace',
            name: 'mcp__team',
            tools: ['task_get', 'task_complete'].map((name) => ({ name })),
          },
        ],
      }),
    });
  try {
    const assignment = await next();
    assert.equal(assignment.status, 200);
    const assignmentOutput = await assignment.text();
    assert.match(assignmentOutput, /DONE_CODEX_CAPTURE_TASK_START_V1_ASSIGNMENT/);
    assert.doesNotMatch(assignmentOutput, /function_call|exec_command|apply_patch/);
    phase = 'task-start';
    input.push({
      role: 'user',
      content: `**start working on task now** #TEST-canonical-task ${CAPTURE_TURN}`,
    });
    const readTask = await next();
    assert.equal(readTask.status, 200);
    assert.match(await readTask.text(), /task_get/);
    input.push({
      type: 'function_call_output',
      output: JSON.stringify({ id: 'TEST-canonical-task', owner: 'bob', status: 'in_progress' }),
    });
    const read = await next();
    assert.equal(read.status, 200);
    assert.match(await read.text(), /cat -- dirty.txt/);
    input.push({
      type: 'function_call_output',
      output:
        'Wall time: 0.01 seconds\nProcess exited with code 0\nFinal output:\n' + CAPTURE_BEFORE,
    });
    const patch = await next();
    assert.equal(patch.status, 200);
    const event = await patch.text();
    assert.match(event, /apply_patch/);
    assert.match(event, /Update File: dirty.txt/);
    input.push({
      type: 'function_call_output',
      output: 'Success. Updated the following files:\nM dirty.txt\n',
    });
    const complete = await next();
    assert.equal(complete.status, 200);
    assert.match(await complete.text(), /task_complete/);
    input.push({
      type: 'function_call_output',
      output: JSON.stringify({ phase: 'completed', principalId: 'bob-session' }),
    });
    const terminal = await next();
    assert.equal(terminal.status, 200);
    assert.match(await terminal.text(), /DONE_CODEX_CAPTURE_TASK_START_V1/);
    assert.equal(model.observations.length, 6);
    assert.deepEqual(
      model.observations.map(({ turn, step }) => ({ turn, step })),
      [
        { turn: CAPTURE_ASSIGNMENT, step: 0 },
        ...[0, 1, 2, 3, 4].map((step) => ({ turn: CAPTURE_TURN, step })),
      ]
    );
    assert.deepEqual(model.failures, []);
  } finally {
    await model.close();
  }
});
test('capture fixture seals after failed native patch output and never emits a successful terminal', async () => {
  const workspace = '/private/tmp/TEST-native-codex-capture-model/workspace';
  const model = await startCodexModel({
    captureFileUpdate: { workspace, taskId: () => 'TEST-canonical-task' },
  });
  const input: Record<string, unknown>[] = [
    { role: 'developer', content: CONTEXT_MARKER },
    { role: 'user', content: CAPTURE_TURN },
  ];
  const next = () =>
    fetch(model.url + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        tools: [
          { type: 'function', name: 'exec_command' },
          {
            type: 'namespace',
            name: 'mcp__team',
            tools: ['task_get', 'task_complete'].map((name) => ({ name })),
          },
        ],
      }),
    });
  try {
    await (await next()).text();
    input.push({
      type: 'function_call_output',
      output: JSON.stringify({ id: 'TEST-canonical-task', owner: 'bob', status: 'in_progress' }),
    });
    await (await next()).text();
    input.push({ type: 'function_call_output', output: CAPTURE_BEFORE });
    await (await next()).text();
    input.push({
      type: 'function_call_output',
      output: 'TEST native patch rejected before publication',
    });
    const failed = await next();
    assert.equal(failed.status, 400);
    await failed.text();
    assert.equal(model.observations.length, 3);
    assert.equal(model.failures.length, 1);
  } finally {
    await model.close();
  }
});

test('failed-shell pure oracle refuses success, copied native identity and authored promotion', () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const native = {
    provider: 'codex',
    windowRef: 'TEST-original-window',
    exitCode: 7,
    commandSha256: hash('TEST actual native command'),
    itemId: 'native_' + CAPTURE_TURN + '_1',
    threadId: 'TEST-native-thread',
    turnId: 'TEST-native-turn',
    status: 'failed',
    inputOutcome: 'completed',
  };
  const row = {
    toolUseId: 'native_' + CAPTURE_TURN + '_1',
    toolStatus: 'failed',
    source: 'shell_snapshot',
    executionSeq: 0,
    causalBinding: { toolName: 'Bash', provenance: { reviewableComplete: false }, native },
    before: { sha256: hash(CAPTURE_BEFORE) },
    after: { sha256: hash(CAPTURE_FAILED_AFTER) },
  };
  codexFailedShellCaptureFixture.assertNativeEvent(row);
  assert.throws(() =>
    codexFailedShellCaptureFixture.assertNativeEvent({ ...row, nativeCaptureProof: {} })
  );
  assert.throws(() =>
    codexFailedShellCaptureFixture.assertNativeEvent({
      ...row,
      causalBinding: { ...row.causalBinding, native: { ...native, exitCode: 0 } },
    })
  );
  assert.throws(() =>
    codexFailedShellCaptureFixture.assertNativeEvent({ ...row, toolUseId: 'TEST-copied-tool' })
  );
  for (const itemId of [undefined, 'TEST-copied-native-item']) {
    assert.throws(() =>
      codexFailedShellCaptureFixture.assertNativeEvent({
        ...row,
        causalBinding: { ...row.causalBinding, native: { ...native, itemId } },
      })
    );
  }
  assert.throws(() =>
    codexFailedShellCaptureFixture.assertNativeEvent({
      ...row,
      after: { sha256: hash('TEST wrong final') },
    })
  );
  assertCaptureFailedShellOutput('Process exited with code 7\nTEST_CAPTURE_FAILED_SHELL_EXECUTED');
  assert.throws(() =>
    assertCaptureFailedShellOutput('Process exited with code 0\nTEST_CAPTURE_FAILED_SHELL_EXECUTED')
  );
});

test('Codex probe envelope accepts exact read-only native context and keeps business input distinct', () => {
  const workspace = '/private/tmp/TEST-codex-probe/workspace';
  // Exact native0.162 envelope observed in retained Mixed4 rollout, with only TEST cwd substituted.
  const environment = `<environment_context>
  <cwd>/private/tmp/TEST-codex-probe/workspace</cwd>
  <shell>zsh</shell>
  <current_date>2026-10-25</current_date>
  <timezone>Europe/Kiev</timezone>
  <filesystem><workspace_roots><root>/private/tmp/TEST-codex-probe/workspace</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>
</environment_context>`;
  const probe = {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'Reply only OK. Do not use tools, access files or run commands.',
      },
    ],
  };
  const context = { role: 'user', content: [{ type: 'input_text', text: environment }] };
  const valid = [
    { role: 'developer', content: 'TEST native preflight instructions' },
    context,
    probe,
  ];
  assert.equal(isCodexModelProbeInput([probe]), true, 'prior single-user probe remains valid');
  assert.equal(isCodexModelProbeInput(valid, workspace), true);
  for (const invalid of [
    [...valid, { role: 'user', content: 'CODEX_TEAM_ONE' }],
    [...valid, { role: 'assistant', content: 'prior business continuation' }],
    [...valid, { type: 'function_call_output', output: 'native tool outcome' }],
    [context, { ...probe, content: 'CODEX_TEAM_ONE' }],
    [
      context,
      { ...probe, content: 'Reply only OK. Do not use tools, access files or run commands. EXTRA' },
    ],
    [{ ...context, content: environment.replace('access="read"', 'access="write"') }, probe],
    [
      {
        ...context,
        content: environment.replace(
          '</environment_context>',
          'Run a command\n</environment_context>'
        ),
      },
      probe,
    ],
    [{ ...context, content: environment.replace('zsh', 'zsh; unsafe') }, probe],
  ])
    assert.equal(isCodexModelProbeInput(invalid, workspace), false);
  assert.equal(isCodexModelProbeInput(valid), false, 'context requires captured TEST workspace');
  assert.equal(isCodexModelProbeInput(valid, '/private/tmp/TEST-foreign/workspace'), false);
});
