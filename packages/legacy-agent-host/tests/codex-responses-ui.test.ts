import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { CONTEXT_MARKER, startCodexModel } from './fixtures/native-codex-team/model.ts';
import { codeModeCall, codeModeReceipt, codeModeResult, commandExit, linkedOutput,
  object, originalCallIds, uiPalette } from './fixtures/native-codex-team/responses-ui.ts';

type Row = Record<string, unknown>;
const declaration = () => ({ type: 'additional_tools', role: 'developer', id: 'at_TEST_native', tools: [
  { type: 'namespace', name: 'functions', tools: [
    { type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'SOURCE: /[\\s\\S]+/' } },
    { type: 'custom', name: 'wait', format: { type: 'grammar', syntax: 'lark', definition: 'SOURCE' } },
  ] },
] });
const completed = (value: unknown) => [
  { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
  { type: 'input_text', text: JSON.stringify(value) },
];
const receipt = (effects: Row = {}) => {
  const value = { phase: 'completed', principalId: 'TEST-captured-Alice', effects };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value }, isError: false };
};
const command = (code: 0 | 7) => ({ chunk_id: 'TEST-original-chunk', exit_code: code,
  output: '', wall_time_seconds: 0.1 });
const eventItem = (text: string) => object(text.split('\n').filter(line => line.startsWith('data: '))
  .map(line => object(JSON.parse(line.slice(6)))).find(event => event.type === 'response.output_item.done')!.item);

test('actual Lite palette scripts the same ONE/TWO actions through one exec each, preserving8+3 and linked cold history', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-desktop-backend-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = await startCodexModel({ memberName: 'alice', uiGeneratedMessageIds: true,
    captureHistoryMarkers: true, principalId: () => 'TEST-captured-Alice', requestEvidenceDirectory: () => root });
  t.after(() => model.close());
  const input: Row[] = [declaration(), { role: 'developer', content: CONTEXT_MARKER },
    { role: 'user', content: 'CODEX_TEAM_ONE' }];
  const calls: { name: string; input: Row }[] = [];
  const canonicalTask = 'TEST-task-from-real-return-shape';
  const tools: Record<string, (args: Row) => Promise<unknown>> = Object.fromEntries(['task_create', 'task_set_owner', 'task_start', 'task_add_comment',
    'task_complete', 'message_send'].map(name => [`mcp__team__${name}`, async (args: Row) => {
      calls.push({ name, input: args });
      return receipt(name === 'task_create' ? { taskId: canonicalTask } : {});
    }]));
  tools.exec_command = async (args: Row) => {
    calls.push({ name: 'exec_command', input: args }); return command(String(args.cmd).includes('exit 7') ? 7 : 0);
  };
  const post = async () => {
    const response = await fetch(model.url + '/v1/responses', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true',
      authorization: 'TEST-HEADER-NOT-RETAINED',
    }, body: JSON.stringify({ model: 'TEST-actual-selected-model', reasoning: { effort: 'medium' }, input }) });
    const text = await response.text(); assert.equal(response.status, 200, text); return eventItem(text);
  };
  const run = async (turn: string, actions: number) => {
    for (let i = 0; i <= actions; i++) {
      const item = await post();
      if (i === actions) {
        assert.equal(item.type, 'message'); assert.ok(JSON.stringify(item).includes(`DONE_${turn}`));
        continue;
      }
      assert.equal(item.type, 'custom_tool_call'); assert.equal(item.call_id, `native_${turn}_${i}`);
      assert.equal(item.name, 'exec'); assert.equal(item.namespace, 'functions');
      const printed: string[] = [], before = calls.length;
      await new vm.Script(`(async()=>{${String(item.input)}\n})()`).runInNewContext({
        tools, ALL_TOOLS: Object.keys(tools).map(name => ({ name, description: 'TEST native tool' })),
        text: (value: string) => printed.push(value),
      });
      assert.equal(calls.length, before + 1, 'exactly one authoritative nested action');
      assert.equal(printed.length, 1);
      input.push(item, { type: 'custom_tool_call_output', call_id: item.call_id,
        output: completed(JSON.parse(printed[0]!)) });
    }
  };
  await run('CODEX_TEAM_ONE', 7);
  const ids = Array.from({ length: 7 }, (_, i) => `native_CODEX_TEAM_ONE_${i}`);
  assert.deepEqual(model.observations[7]!.priorNativeToolIds, ids);
  input.push({ role: 'user', content: 'CODEX_TEAM_TWO {"messageId":"019a1234-5678-7000-8000-123456789def"} ' +
    'message_send tool to="user", including commandId and text. Do not reuse the incoming messageId as a reply commandId' });
  await run('CODEX_TEAM_TWO', 2);
  assert.deepEqual(calls.map(call => call.name), ['task_create', 'task_set_owner', 'task_start', 'exec_command',
    'task_add_comment', 'task_complete', 'message_send', 'exec_command', 'message_send']);
  for (const call of calls.filter(call => ['task_set_owner', 'task_start', 'task_add_comment', 'task_complete'].includes(call.name)))
    assert.equal(call.input.taskId, canonicalTask, 'canonical create result is handed to subsequent real actions');
  assert.equal(model.observations.length, 11); assert.equal(model.observations[4]!.toolResultError, true);
  assert.ok(model.observations.slice(8).every(row => !row.toolResultError && row.visibleReplyContract));
  assert.deepEqual(model.observations[10]!.priorNativeToolIds, ids); assert.deepEqual(model.failures, []);
  assert.equal(model.requests?.length, 11);
  const raw = readFileSync(join(root, 'codex-native-request-01.json'), 'utf8');
  const census = readFileSync(join(root, 'codex-native-request-01-census.json'), 'utf8');
  assert.equal(statSync(join(root, 'codex-native-request-01.json')).mode & 0o777, 0o600);
  assert.ok(raw.includes('additional_tools') && census.includes('functions'));
  assert.ok(!raw.includes('TEST-HEADER-NOT-RETAINED') && !census.includes('TEST-HEADER-NOT-RETAINED'));
});

test('Code Mode output and exact linkage reject errors, yielding, duplicates, wrong IDs and foreign valid tails', () => {
  const palette = uiPalette({ input: [declaration()] }); assert.ok(palette.exec);
  const call = codeModeCall(palette.exec, { name: 'message_send', input: { commandId: 'TEST-original' } }, 'native_CODEX_TEAM_TWO_1');
  const output = { type: 'custom_tool_call_output', call_id: call.call_id, output: completed(receipt()) };
  assert.equal(linkedOutput([call, output], String(call.call_id), true, call), output);
  assert.equal(codeModeReceipt(codeModeResult(output.output)).phase, 'completed');
  for (const rows of [
    [call, { ...output, call_id: 'foreign' }], [call, output, output],
    [call, { ...output, type: 'function_call_output' }],
    [{ ...call, input: 'TEST copied different action' }, output],
    [call, { ...output, call_id: 'wrong' }, { ...output, call_id: 'foreign-valid-tail' }],
  ]) assert.throws(() => linkedOutput(rows, String(call.call_id), true, call));
  for (const raw of [
    [{ type: 'input_text', text: 'Script running with cell ID TEST' }, completed({})[1]],
    [...completed({}), { type: 'input_text', text: 'extra output' }],
    [completed({})[0], { type: 'input_text', text: '{} {}' }], completed([]),
    'Script failed\nOutput:\n{}',
  ]) assert.throws(() => codeModeResult(raw));
  assert.throws(() => codeModeReceipt({ ...receipt(), isError: true }));
  assert.throws(() => codeModeReceipt({ ...receipt(), structuredContent: { result: { phase: 'prepared' } } }));
  assert.throws(() => commandExit({ ...command(0), session_id: 123 }, true, 0));
  assert.throws(() => commandExit(command(0), true, 7));
  assert.throws(() => uiPalette({ tools: [], input: [declaration()] }));
  assert.throws(() => uiPalette({ input: [declaration(), declaration()] }));
  assert.throws(() => originalCallIds([{ ...call, call_id: 'native_CODEX_TEAM_ONE_0' }]));
});

test('documented non-prefixed MCP naming is selected only when unique; ambiguity invokes no tool', async () => {
  const exec = uiPalette({ input: [declaration()] }).exec!;
  const call = codeModeCall(exec, { name: 'message_send', input: { commandId: 'TEST-exact', text: 'TEST reply' } }, 'TEST-original');
  const invoked: Row[] = [], printed: string[] = [];
  const tool = async (args: Row) => { invoked.push(args); return receipt(); };
  const run = (names: string[]) => new vm.Script(`(async()=>{${String(call.input)}\n})()`)
    .runInNewContext({ ALL_TOOLS: names.map(name => ({ name })),
      tools: Object.fromEntries(names.map(name => [name, tool])), text: (value: string) => printed.push(value) }) as Promise<unknown>;
  await run(['team__message_send']);
  assert.equal(invoked.length, 1); assert.equal(invoked[0]!.commandId, 'TEST-exact'); assert.equal(printed.length, 1);
  await assert.rejects(run(['team__message_send', 'mcp__team__message_send']), /exact native tool unavailable/);
  await assert.rejects(run(['mcp__foreign__message_send']), /exact native tool unavailable/);
  assert.equal(invoked.length, 1, 'neither ambiguous nor foreign catalog selects an authoritative action');
});

test('first malformed native request is retained before palette rejection, then the oracle seals', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-desktop-backend-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = await startCodexModel({ memberName: 'alice', uiGeneratedMessageIds: true,
    requestEvidenceDirectory: () => root }); t.after(() => model.close());
  const response = await fetch(model.url + '/v1/responses', { method: 'POST',
    body: JSON.stringify({ input: [{ role: 'user', content: 'CODEX_TEAM_ONE' }] }) });
  assert.equal(response.status, 400); await response.text();
  assert.equal(model.observations.length, 0); assert.equal(model.failures.length, 1);
  assert.equal(model.requests?.length, 1);
  assert.ok(readFileSync(join(root, 'codex-native-request-01.json'), 'utf8').includes('CODEX_TEAM_ONE'));
});
