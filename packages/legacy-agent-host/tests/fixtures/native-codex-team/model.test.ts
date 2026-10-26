import { createHash } from 'node:crypto';
import { codexFailedShellCaptureFixture } from './capture.ts';
import { CAPTURE_FAILED_AFTER, assertCaptureFailedShellOutput } from './model.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAPTURE_BEFORE,
  CAPTURE_ASSIGNMENT,
  CAPTURE_TURN,
  CONTEXT_MARKER,
  REQUIRED_TOOLS,
  startCodexModel,
  isCodexModelProbeInput,
} from './model.ts';

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
