import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAPTURE_BEFORE,
  CAPTURE_ASSIGNMENT,
  CAPTURE_TURN,
  CONTEXT_MARKER,
  REQUIRED_TOOLS,
  startCodexModel,
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
