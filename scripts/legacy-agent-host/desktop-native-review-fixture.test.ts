import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReviewChunks } from '@agent-teams/task-change-ledger/review-text';
import {
  prepareNativeReviewWorkspace,
  readNativeReviewSeed,
  assertNativeReviewBackgroundCompletion,
} from './desktop-native-review-fixture.ts';
import {
  startNativeReviewModel,
  REVIEW_BOOTSTRAP,
  REVIEW_TASK_SUBJECT,
  REVIEW_WORK_TERMINAL_STEP,
} from './desktop-native-review-model.ts';
import { prepareDesktopProofMode } from './desktop-proof-mode.ts';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

function notification(task: string, tool: string): string {
  return `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>${task}</task-id>` +
    `<tool-use-id>${tool}</tool-use-id><status>completed</status></task-notification>`;
}
async function postModel(url: string, text: string, receipt?: unknown, tool = 'TEST-result', isError = false) {
  return fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: CONTEXT_MARKER,
      tools: ['mcp__team__task_create', 'Read', 'Edit', 'Write', 'Bash', 'mcp__team__message_send'].map(name => ({ name })),
      messages: [{ role: 'user', content: [{ type: 'text', text }, ...(receipt === undefined ? [] : [{
        type: 'tool_result', tool_use_id: tool, is_error: isError,
        content: typeof receipt === 'string' ? receipt : JSON.stringify(receipt),
      }])] }] }) });
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'workspace'));
  await prepareNativeReviewWorkspace(root);
  return root;
}
test('native review setup stages only dirty workspace/index bytes, never a Task or ledger', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = await readNativeReviewSeed(root);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.before);
  assert.equal(buildReviewChunks(seed.before, seed.after).length, 2);
  assert.equal(seed.mixed, seed.intermediate);
  assert.deepEqual((await readdir(root)).sort(), [
    'home',
    'native-review-post-hook.ts',
    'native-review-ui-seed.json',
    'workspace',
  ]);
  assert.deepEqual(await readFile(join(root, 'native-review-post-hook.ts')),
    await readFile(join(import.meta.dirname, 'desktop-native-review-post-hook.ts')));
  await assert.rejects(
    readFile(
      join(
        root,
        'hoststore/teams/test-desktop-backend/.host-evidence/.board-task-changes/events/TEST-task.jsonl'
      )
    )
  );
});

test('model scripts generic Task creation then one foreground tool per Task Start response without writing files', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = await readNativeReviewSeed(root);
  const model = await startNativeReviewModel({
    workspace: () => join(root, 'workspace'),
    principalId: () => 'agent:TEST-unit',
  });
  t.after(() => model.close());
  const tools = ['mcp__team__task_create', 'Read', 'Edit', 'Write', 'Bash', 'mcp__team__message_send'].map(
    (name) => ({ name })
  );
  const ask = async (text: string, receipt?: unknown, isError = false, toolId = 'TEST-unit-result') => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          ...(receipt === undefined
            ? []
            : [
                {
                  type: 'tool_result',
                  content: typeof receipt === 'string' ? receipt : JSON.stringify(receipt),
                  tool_use_id: toolId,
                  is_error: isError,
                },
              ]),
        ],
      },
    ];
    const response = await fetch(model.url + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', system: CONTEXT_MARKER, messages, tools }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    const starts = events.filter((event) => event.type === 'content_block_start');
    assert.equal(starts.length, 1, 'single tool/text block, never parallel tool batch');
    const block = starts[0].content_block;
    const delta = events.find((event) => event.type === 'content_block_delta').delta;
    return block.type === 'tool_use'
      ? { ...block, input: JSON.parse(delta.partial_json) }
      : { ...block, text: delta.text };
  };
  const created = await ask(REVIEW_BOOTSTRAP);
  assert.equal(created.name, 'mcp__team__task_create');
  assert.equal(created.input.owner, 'alice');
  assert.equal(created.input.taskId, undefined, 'Task ID comes only from canonical MCP response');
  const ended = await ask(REVIEW_BOOTSTRAP, {
    phase: 'completed',
    principalId: 'agent:TEST-unit',
    effects: { taskId: 'TEST-unit-real-response' },
  });
  assert.equal(ended.type, 'text');
  assert.equal(model.taskId(), 'TEST-unit-real-response');
  const work = `Original Task Start: ${REVIEW_TASK_SUBJECT}`;
  assert.equal((await ask(work)).name, 'Read');
  const first = await ask(work, seed.before),
    second = await ask(work, 'Edit succeeded');
  assert.equal(first.name, 'Edit');
  assert.equal(second.name, 'Edit');
  assert.equal(first.input.replace_all, false);
  assert.equal(second.input.replace_all, false);
  assert.equal(first.input.file_path, seed.filePath);
  assert.equal(second.input.file_path, seed.filePath);
  const intermediate = seed.before.replace(first.input.old_string, first.input.new_string);
  assert.equal(intermediate, seed.intermediate);
  assert.equal(intermediate.replace(second.input.old_string, second.input.new_string), seed.after);
  const failed = await ask(work, 'Edit succeeded');
  assert.equal(failed.name, 'Bash'); assert.equal(failed.input.run_in_background, undefined);
  assert.match(failed.input.command, /native-review-failed\.txt; exit 7$/);
  const write = await ask(work, 'TEST actual failure', true);
  assert.equal(write.name, 'Write'); assert.equal(write.input.file_path, seed.partialCoverage!.writePath);
  const background = await ask(work, 'Write succeeded');
  assert.equal(background.name, 'Bash'); assert.equal(background.input.run_in_background, true);
  assert.match(background.input.command, /native-review-background\.txt$/);
  assert.equal((await ask(work, 'Command running in background with ID: TEST-background.\n' + notification('TEST-background', 'native_review_work_5'), false, 'native_review_work_5')).name, 'mcp__team__message_send');
  assert.equal(
    (await ask(work, { phase: 'completed', principalId: 'agent:TEST-unit', effects: {} })).type,
    'text'
  );
  assert.equal(
    await readFile(seed.filePath, 'utf8'),
    seed.before,
    'local model only emits responses; native SDK must perform actual effects in E2E'
  );
  assert.deepEqual(model.observations.filter(row => row.turn === 'work').map(row => row.step),
    Array.from({ length: REVIEW_WORK_TERMINAL_STEP + 1 }, (_, index) => index));
  assert.equal(await readFile(seed.partialCoverage!.failedPath, 'utf8'), seed.partialCoverage!.failedBefore);
  assert.equal(await readFile(seed.partialCoverage!.backgroundPath, 'utf8'), seed.partialCoverage!.backgroundBefore);
  assert.equal(await readFile(seed.partialCoverage!.hookSidePath, 'utf8'), seed.partialCoverage!.hookBefore);
  const settings = JSON.parse(await readFile(join(root, 'workspace/.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Write');
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].timeout, 10);
  assert.equal(settings.hooks.PostToolUseFailure[0].matcher, 'Bash');
  assert.deepEqual(settings.hooks.PostToolUseFailure[0].hooks, settings.hooks.PostToolUse[0].hooks);
  assert.equal(seed.partialCoverage!.failedAfter, 'FAILED_BEFORE\nFAILED\nFAILED_HOOK\n');
  assert.equal(await readFile(seed.partialCoverage!.failureHookPath!, 'utf8'), seed.partialCoverage!.failureHookBefore);
  assert.deepEqual(model.failures, []);
  const ack = await ask(notification('TEST-background', 'native_review_work_5'));
  assert.deepEqual(ack, { type: 'text', text: 'ACK_NATIVE_REVIEW_BACKGROUND' });
  assert.equal(model.observations.length, 11);
  assert.equal(model.observations.at(-1)!.turn, 'background-notification');
  const repeated = await postModel(model.url, notification('TEST-background', 'native_review_work_5'));
  assert.equal(repeated.status, 400);
  assert.match(model.failures[0]!, /one exact background completion ACK/);
  assert.equal(model.observations.length, 11, 'no repeated model action');
});

test('late completion cannot acknowledge a different task or tool, or replay the work script', async (t) => {
  for (const [task, tool] of [['TEST-other', 'native_review_work_5'], ['TEST-background', 'native_review_work_4']]) {
    await t.test(`${task}/${tool}`, async (t) => {
      const model = await startNativeReviewModel({ workspace: () => '/TEST/never-used', principalId: () => 'agent:TEST-unit' });
      t.after(() => model.close());
      const receipt = { phase: 'completed', principalId: 'agent:TEST-unit', effects: { taskId: 'TEST-real' } };
      assert.equal((await postModel(model.url, REVIEW_BOOTSTRAP)).status, 200);
      assert.equal((await postModel(model.url, REVIEW_BOOTSTRAP, receipt)).status, 200);
      for (let step = 0; step <= REVIEW_WORK_TERMINAL_STEP; step++) {
        const result = step === 6 ? 'Command running in background with ID: TEST-background.' : step === 7 ? receipt : 'TEST-result';
        assert.equal((await postModel(model.url, REVIEW_TASK_SUBJECT, step === 0 ? undefined : result,
          step === 6 ? 'native_review_work_5' : 'TEST-result', step === 4)).status, 200);
      }
      assert.equal((await postModel(model.url, notification(task!, tool!))).status, 400);
      assert.match(model.failures[0]!, /exact original background task\/tool completion/);
      assert.equal(model.observations.length, 10, 'no ACK or effect for unrelated native notification');
    });
  }
});

test('model refuses work before canonical Task creation and seals after the first malformed input', async (t) => {
  const model = await startNativeReviewModel({
    workspace: () => '/TEST/never-used',
    principalId: () => 'agent:TEST-unit',
  });
  t.after(() => model.close());
  const response = await fetch(model.url + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system: CONTEXT_MARKER,
      messages: [{ role: 'user', content: REVIEW_TASK_SUBJECT }],
      tools: [{ name: 'Read' }],
    }),
  });
  assert.equal(response.status, 400);
  assert.match(model.failures[0]!, /create the real Task before original Start/);
  assert.deepEqual(model.observations, []);
});

test('native review cold mode opens no model server and never uses the synthetic ledger fixture mode', async () => {
  const mode = await prepareDesktopProofMode('native-review-readback-ui', () => {
    throw new Error('cold readback must not read a native principal');
  });
  assert.equal(mode.nativeReviewMode, true);
  assert.equal(mode.nativeReviewReadbackMode, true);
  assert.equal(mode.reviewUiMode, false);
  assert.equal(mode.launchDialogMode, false);
  assert.equal(mode.model, undefined);
  assert.equal(mode.uiMode, true);
});

test('positive native review background oracle rejects a gap, wrong execution and duplicate completion', () => {
  const expected = { toolUseId: 'native_review_work_5', nativeTaskRef: 'TEST-background', taskId: 'TEST-product-task',
    taskStartCommandId: 'TEST-start', inputId: 'TEST-input', operationRef: 'TEST-operation', sessionRef: 'TEST-session',
    binding: { backendId: 'TEST-owner', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'alice-id', generation: '1' } };
  const cause = { ...expected, provenance: { reviewableComplete: false } };
  const event = { toolUseId: expected.toolUseId, causalBinding: cause, toolStatus: 'succeeded' };
  const registration = { toolUseId: expected.toolUseId, causalBinding: cause, nativeTaskRef: expected.nativeTaskRef,
    nativeRunRef: 'TEST-native-run', captureBoundary: 'native-background-registration' };
  const terminal = { ...registration, captureBoundary: 'native-task-notification', outcome: 'succeeded' };
  assert.deepEqual(assertNativeReviewBackgroundCompletion([event], [registration, terminal], expected),
    { event, registration, terminal });
  assert.throws(() => assertNativeReviewBackgroundCompletion([], [{ ...registration, message: 'Native capture gap: background' }], expected));
  assert.throws(() => assertNativeReviewBackgroundCompletion([event], [registration], expected));
  assert.throws(() => assertNativeReviewBackgroundCompletion([event, event], [registration, terminal], expected));
  assert.throws(() => assertNativeReviewBackgroundCompletion([event], [registration, terminal, terminal], expected));
  for (const patch of [ { nativeTaskRef: 'TEST-other-task' }, { nativeRunRef: 'TEST-other-run' }, { outcome: 'failed' } ])
    assert.throws(() => assertNativeReviewBackgroundCompletion([event], [registration, { ...terminal, ...patch }], expected));
  for (const field of ['taskId', 'taskStartCommandId', 'inputId', 'operationRef', 'sessionRef', 'toolUseId'])
    assert.throws(() => assertNativeReviewBackgroundCompletion([event], [registration, { ...terminal,
      causalBinding: { ...cause, [field]: 'TEST-foreign' } }], expected));
  assert.throws(() => assertNativeReviewBackgroundCompletion([event], [registration, { ...terminal,
    causalBinding: { ...cause, binding: { ...expected.binding, generation: '2' } } }], expected));
});
