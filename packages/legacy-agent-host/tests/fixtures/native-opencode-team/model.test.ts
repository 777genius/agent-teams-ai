import { createHash } from 'node:crypto';
import { opencodeFailedShellCaptureFixture } from './capture.ts';
import { CAPTURE_FAILED_AFTER, assertCaptureFailedShellOutput } from './model.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAPTURE_BEFORE,
  CAPTURE_TURN,
  CAPTURE_ASSIGNMENT,
  CONTEXT_MARKER,
  REQUIRED_TOOLS,
  startOpenCodeModel,
} from './model.ts';

const tools = [...REQUIRED_TOOLS.map((name) => `team_${name}`), 'bash'].map((name) => ({
  type: 'function',
  function: { name },
}));

test('OpenCode inference oracle requires native context/catalog and scripts two sequential business turns', async () => {
  const model = await startOpenCodeModel();
  try {
    const first: unknown[] = [
      { role: 'system', content: CONTEXT_MARKER },
      { role: 'user', content: 'OPENCODE_TEAM_ONE' },
    ];
    async function next(messages: unknown[]) {
      const response = await fetch(`${model.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, tools }),
      });
      assert.equal(response.status, 200);
      const wire = await response.text();
      const line = wire.split('\n').find((value) => value.startsWith('data: {'));
      assert.ok(line);
      return JSON.parse(line.slice(6)).choices[0].delta as {
        content?: string;
        tool_calls?: { function: { name: string; arguments: string } }[];
      };
    }
    const create = await next(first);
    assert.equal(create.tool_calls?.[0]?.function.name, 'team_task_create');
    first.push({
      role: 'tool',
      content: JSON.stringify({
        phase: 'completed',
        principalId: 'carol-session',
        effects: { taskId: 'TEST-canonical-task' },
      }),
    });
    const names: string[] = [];
    for (let step = 1; step <= 7; step++) {
      const delta = await next(first);
      if (delta.tool_calls) {
        names.push(delta.tool_calls[0]!.function.name);
        const args = JSON.parse(delta.tool_calls[0]!.function.arguments) as { taskId?: string };
        if (step !== 3 && step !== 6) assert.equal(args.taskId, 'TEST-canonical-task');
      } else assert.equal(delta.content, 'DONE_OPENCODE_TEAM_ONE');
    }
    assert.deepEqual(names, [
      'team_task_set_owner',
      'team_task_start',
      'bash',
      'team_task_add_comment',
      'team_task_complete',
      'team_message_send',
    ]);
    const second = [...first, { role: 'user', content: 'OPENCODE_TEAM_TWO' }];
    assert.equal((await next(second)).tool_calls?.[0]?.function.name, 'bash');
    assert.equal((await next(second)).tool_calls?.[0]?.function.name, 'team_message_send');
    assert.equal((await next(second)).content, 'DONE_OPENCODE_TEAM_TWO');
    assert.equal(model.observations.length, 11);
    assert.ok(model.observations.every((item) => item.contextEffective));
    assert.ok(
      model.observations
        .filter((item) => item.turn === 'OPENCODE_TEAM_TWO')
        .every((item) => item.priorTurn)
    );
    assert.deepEqual(model.failures, []);
  } finally {
    await model.close();
  }
});

test('OpenCode inference oracle seals on absent member context instead of returning fake work', async () => {
  const model = await startOpenCodeModel();
  try {
    for (const context of ['', CONTEXT_MARKER]) {
      const response = await fetch(`${model.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tools,
          messages: [
            { role: 'system', content: context },
            { role: 'user', content: 'OPENCODE_TEAM_ONE' },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /fixture rejected/);
    }
    assert.equal(model.observations.length, 0);
    assert.equal(model.failures.length, 2);
  } finally {
    await model.close();
  }
});

test('native capture assignment has no tools, then original TaskStart reads and edits once', async () => {
  let phase: 'assignment' | 'task-start' = 'assignment';
  const workspace = '/private/tmp/TEST-native-opencode-capture-model/workspace';
  const model = await startOpenCodeModel({
    captureFileUpdate: { workspace, taskId: () => 'TEST-task', phase: () => phase },
  });
  const messages: unknown[] = [
    { role: 'system', content: CONTEXT_MARKER },
    { role: 'user', content: CAPTURE_TURN },
  ];
  const next = async () => {
    const response = await fetch(model.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        tools: ['read', 'edit'].map((name) => ({ type: 'function', function: { name } })),
      }),
    });
    assert.equal(response.status, 200);
    const wire = await response.text();
    const line = wire.split('\n').find((value) => value.startsWith('data: {'));
    assert.ok(line);
    return JSON.parse(line.slice(6)).choices[0].delta as {
      content?: string;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  };
  try {
    assert.deepEqual(await next(), { role: 'assistant', content: 'DONE_' + CAPTURE_ASSIGNMENT });
    phase = 'task-start';
    messages.push({ role: 'user', content: 'Start ' + CAPTURE_TURN });
    const read = await next();
    assert.equal(read.tool_calls?.[0]?.function.name, 'read');
    assert.deepEqual(JSON.parse(read.tool_calls![0]!.function.arguments), {
      filePath: workspace + '/dirty.txt',
    });
    messages.push({
      role: 'tool',
      content: '<content>1: TEST clean anchor\n2: TEST dirty preimage\n3: TEST tail</content>',
    });
    const edit = await next();
    assert.equal(edit.tool_calls?.[0]?.function.name, 'edit');
    assert.equal(edit.tool_calls?.[0]?.id, 'TEST_' + CAPTURE_TURN + '_1');
    assert.deepEqual(JSON.parse(edit.tool_calls![0]!.function.arguments), {
      filePath: workspace + '/dirty.txt',
      oldString: 'TEST dirty preimage',
      newString: 'TEST native foreground patched',
    });
    messages.push({ role: 'tool', content: 'Edit applied successfully.' });
    assert.equal((await next()).content, 'DONE_' + CAPTURE_TURN);
    assert.deepEqual(
      model.observations.map(({ turn, step }) => ({ turn, step })),
      [
        { turn: CAPTURE_ASSIGNMENT, step: 0 },
        ...[0, 1, 2].map((step) => ({ turn: CAPTURE_TURN, step })),
      ]
    );
    assert.deepEqual(model.failures, []);
  } finally {
    await model.close();
  }
});

test('native capture oracle refuses stale read bytes before offering any edit', async () => {
  const workspace = '/private/tmp/TEST-native-opencode-capture-model/workspace';
  const model = await startOpenCodeModel({
    captureFileUpdate: { workspace, taskId: () => 'TEST-task', phase: () => 'task-start' },
  });
  const messages: unknown[] = [
    { role: 'system', content: CONTEXT_MARKER },
    { role: 'user', content: CAPTURE_TURN },
  ];
  const next = () =>
    fetch(model.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        tools: ['read', 'edit'].map((name) => ({ type: 'function', function: { name } })),
      }),
    });
  try {
    const read = await next();
    assert.equal(read.status, 200);
    await read.text();
    messages.push({ role: 'tool', content: 'TEST wrong stale bytes' });
    const refused = await next();
    assert.equal(refused.status, 400);
    await refused.text();
    assert.equal(model.observations.length, 1);
    assert.equal(model.failures.length, 1);
  } finally {
    await model.close();
  }
});

test('failed-shell pure oracle refuses success, copied native identity and authored promotion', () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const native = {
    provider: 'opencode',
    windowRef: 'TEST-original-window',
    exitCode: 7,
    commandSha256: hash('TEST actual native command'),
    nativeSessionId: 'ses_TEST',
    nativeInputId: 'msg_INPUT',
    messageId: 'msg_TOOL',
    partId: 'prt_TOOL',
    callId: 'TEST_' + CAPTURE_TURN + '_0',
    status: 'completed',
    inputOutcome: 'succeeded',
    startedAt: 10,
    completedAt: 20,
  };
  const row = {
    toolUseId: 'TEST_' + CAPTURE_TURN + '_0',
    toolStatus: 'failed',
    source: 'shell_snapshot',
    executionSeq: 0,
    causalBinding: { toolName: 'Bash', provenance: { reviewableComplete: false }, native },
    before: { sha256: hash(CAPTURE_BEFORE) },
    after: { sha256: hash(CAPTURE_FAILED_AFTER) },
  };
  opencodeFailedShellCaptureFixture.assertNativeEvent(row);
  assert.throws(() =>
    opencodeFailedShellCaptureFixture.assertNativeEvent({ ...row, nativeCaptureProof: {} })
  );
  assert.throws(() =>
    opencodeFailedShellCaptureFixture.assertNativeEvent({
      ...row,
      causalBinding: { ...row.causalBinding, native: { ...native, exitCode: 0 } },
    })
  );
  assert.throws(() =>
    opencodeFailedShellCaptureFixture.assertNativeEvent({ ...row, toolUseId: 'TEST-copied-tool' })
  );
  assert.throws(() =>
    opencodeFailedShellCaptureFixture.assertNativeEvent({
      ...row,
      causalBinding: { ...row.causalBinding, native: { ...native, status: 'unknown' } },
    })
  );
  assert.throws(() =>
    opencodeFailedShellCaptureFixture.assertNativeEvent({
      ...row,
      after: { sha256: hash('TEST wrong final') },
    })
  );
  assert.equal(assertCaptureFailedShellOutput('(no output)'), 'opaque-no-output');
  assert.equal(
    assertCaptureFailedShellOutput('TEST_CAPTURE_FAILED_SHELL_EXECUTED\n'),
    'marker-text'
  );
  assert.throws(() => assertCaptureFailedShellOutput('TEST denied tool before execution'));
});

test('failed-shell continuation accepts only observed shapes and rejects contradictory tool output', () => {
  for (const output of [
    'TEST_CAPTURE_FAILED_SHELL_EXECUTED but command denied',
    'TEST_CAPTURE_FAILED_SHELL_EXECUTED exit 0',
    '(no output) exit 0',
    '',
    null,
    { output: 'TEST_CAPTURE_FAILED_SHELL_EXECUTED', exit: 0 },
    { output: '(no output)', exit: 7 },
  ])
    assert.throws(() => assertCaptureFailedShellOutput(output));
});
