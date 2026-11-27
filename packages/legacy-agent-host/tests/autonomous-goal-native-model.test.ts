// HTTP oracle tests only. These do not qualify a vendor CLI or create native file effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolResult } from '../dist/mcp/toolDefinition.js';
import {
  CONTEXT_MARKER as claudeContext,
  startNativeTeamModel,
} from './fixtures/native-claude-team/model.ts';
import {
  CONTEXT_MARKER as codexContext,
  startCodexModel,
} from './fixtures/native-codex-team/model.ts';
import {
  CONTEXT_MARKER as openCodeContext,
  startOpenCodeModel,
} from './fixtures/native-opencode-team/model.ts';
import {
  goalRow,
  nativeGoalObjective,
  nativeGoalScript,
  readNativeGoalToolValue,
} from './fixtures/native-autonomous-goal/model.ts';
import type {
  NativeGoalInput,
  NativeGoalProvider,
} from './fixtures/native-autonomous-goal/model.ts';

type Row = Record<string, unknown>;
type Answer = { id: string; name: string; input: Row; native: Row } | { text: string };
const actors = { claude: 'alice', codex: 'bob', opencode: 'carol' } as const;
const logicalTools = [
  'goal_status',
  'goal_propose',
  'task_create',
  'task_list',
  'task_start',
  'task_add_comment',
  'task_complete',
];
function bodyFor(provider: NativeGoalProvider, messages: Row[]) {
  if (provider === 'claude')
    return {
      model: 'claude-opus-4-6',
      output_config: { effort: 'medium' },
      system: claudeContext,
      messages,
      tools: ['Bash', ...logicalTools.map((name) => 'mcp__team__' + name)].map((name) => ({
        name,
        input_schema: { type: 'object' },
      })),
    };
  if (provider === 'codex')
    return {
      model: 'mock-model',
      instructions: codexContext,
      input: messages,
      tools: [
        { name: 'exec_command', type: 'function' },
        ...logicalTools.map((name) => ({ type: 'function', name: 'mcp__team__' + name })),
      ],
    };
  return {
    model: 'TEST-model',
    messages: [{ role: 'system', content: openCodeContext }, ...messages],
    tools: ['bash', ...logicalTools.map((name) => 'team_' + name)].map((name) => ({
      type: 'function',
      function: { name, parameters: { type: 'object' } },
    })),
  };
}
function answerFor(provider: NativeGoalProvider, wire: string): Answer {
  const events = wire
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => goalRow(JSON.parse(line.slice(6))));
  if (provider === 'claude') {
    const start = events.find((event) => event.type === 'content_block_start');
    assert.ok(start);
    const block = goalRow(start.content_block);
    const delta = goalRow(events.find((event) => event.type === 'content_block_delta')!.delta);
    if (block.type === 'text') return { text: String(delta.text) };
    const input = goalRow(JSON.parse(String(delta.partial_json)));
    return { id: String(block.id), name: String(block.name), input, native: { ...block, input } };
  }
  if (provider === 'codex') {
    const output = goalRow(
      events.find((event) => event.type === 'response.output_item.done')!.item
    );
    if (output.type === 'message')
      return { text: String(goalRow((output.content as unknown[])[0]).text) };
    return {
      id: String(output.call_id),
      name: String(output.name),
      input: goalRow(JSON.parse(String(output.arguments))),
      native: output,
    };
  }
  const delta = goalRow(goalRow((events[0]!.choices as unknown[])[0]).delta);
  if (typeof delta.content === 'string') return { text: delta.content };
  const call = goalRow((delta.tool_calls as unknown[])[0]);
  const tool = goalRow(call.function);
  return {
    id: String(call.id),
    name: String(tool.name),
    input: goalRow(JSON.parse(String(tool.arguments))),
    native: delta,
  };
}
async function fixture(
  provider: NativeGoalProvider,
  stop = false,
  delegate = false,
  worker = false
) {
  const actor = actors[provider];
  let current: NativeGoalInput = {
    inputId: 'TEST-input-first',
    operationRef: 'TEST-operation-first',
    goalId: 'TEST-current-goal',
    content: nativeGoalObjective(stop),
    rootInput: !worker,
    stopped: false,
  };
  const script = nativeGoalScript({
    actor,
    lead: worker ? (actor === 'alice' ? 'bob' : 'alice') : actor,
    mode: delegate ? 'delegate' : 'do',
    workspace: '/TEST-native-goal-unit/workspace',
    workers: [worker ? actor : actor === 'bob' ? 'carol' : 'bob'],
    current: () => current,
  });
  const model =
    provider === 'claude'
      ? await startNativeTeamModel({ autonomousGoal: script })
      : provider === 'codex'
        ? await startCodexModel({ autonomousGoal: script })
        : await startOpenCodeModel({ autonomousGoal: script });
  const messages: Row[] = [{ role: 'user', content: current.content }];
  const path =
    provider === 'claude'
      ? '/v1/messages'
      : provider === 'codex'
        ? '/v1/responses'
        : '/v1/chat/completions';
  const raw = () =>
    fetch(model.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor(provider, messages)),
    });
  return {
    script,
    model,
    messages,
    raw,
    current: () => current,
    nextInput(inputId: string, content: string, rootInput = false) {
      current = {
        ...current,
        inputId,
        content,
        rootInput,
        operationRef: 'TEST-operation-' + inputId,
      };
      messages.push({ role: 'user', content });
    },
    stop() {
      current = { ...current, stopped: true };
    },
    async next() {
      const response = await raw();
      assert.equal(response.status, 200, JSON.stringify(model.failures));
      return answerFor(provider, await response.text());
    },
    result(answer: Answer, value: unknown, shell = false, id?: string) {
      assert.ok('id' in answer);
      const originalId = id ?? answer.id;
      const formatted = shell ? undefined : formatToolResult(value, false);
      if (provider === 'claude')
        messages.push(
          { role: 'assistant', content: [answer.native] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: originalId,
                content: shell ? String(value) : formatted!.content,
              },
            ],
          }
        );
      else if (provider === 'codex')
        messages.push(answer.native, {
          type: 'function_call_output',
          call_id: originalId,
          output: shell ? String(value) : JSON.stringify(formatted!.structuredContent),
        });
      else
        messages.push(answer.native, {
          role: 'tool',
          tool_call_id: originalId,
          content: shell ? String(value) : JSON.stringify(value),
        });
    },
    status() {
      return {
        goalId: current.goalId,
        disposition: 'active',
        objective: nativeGoalObjective(stop),
      };
    },
  };
}
const tool = (answer: Answer, name: string) => {
  assert.ok('id' in answer);
  assert.ok(
    answer.name === name || answer.name.endsWith('__' + name) || answer.name.endsWith('_' + name)
  );
  return answer;
};
async function held(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'bounded original HTTP response hold');
    await new Promise<void>((done) => setTimeout(done, 5));
  }
}

for (const provider of ['claude', 'codex', 'opencode'] as const) {
  test(
    'native goal ' + provider + ' oracle preserves original tool ids across two productive inputs',
    async () => {
      const f = await fixture(provider);
      try {
        const read = tool(await f.next(), 'goal_status');
        f.result(read, f.status());
        const first = tool(
          await f.next(),
          provider === 'claude' ? 'Bash' : provider === 'codex' ? 'exec_command' : 'bash'
        );
        assert.match(String(first.input.command ?? first.input.cmd), /draft\.txt/u);
        f.result(first, 'TEST_NATIVE_GOAL_FILE_OK', true);
        assert.ok('text' in (await f.next()));
        f.nextInput(
          'TEST-input-second',
          'Continue the accepted objective TEST-current-goal. Continuation 1.'
        );
        const secondRead = tool(await f.next(), 'goal_status');
        f.result(secondRead, f.status());
        const second = tool(
          await f.next(),
          provider === 'claude' ? 'Bash' : provider === 'codex' ? 'exec_command' : 'bash'
        );
        assert.match(String(second.input.command ?? second.input.cmd), /result\.txt/u);
        f.result(second, 'TEST_NATIVE_GOAL_FILE_OK', true);
        const proposal = tool(await f.next(), 'goal_propose');
        assert.equal(proposal.input.result, 'TEST verified native two-stage result');
        assert.match(String(proposal.input.commandId), /TEST-current-goal/u);
        f.result(proposal, { goalId: 'TEST-current-goal', disposition: 'finalizing' });
        assert.ok('text' in (await f.next()));
        assert.deepEqual(
          [...new Set(f.script.observations.map((row) => row.inputId))],
          ['TEST-input-first', 'TEST-input-second']
        );
        assert.deepEqual(f.model.failures, []);
      } finally {
        await f.model.close();
      }
    }
  );

  test(
    'native goal ' + provider + ' oracle holds only the original response until Stop settlement',
    async () => {
      const f = await fixture(provider, true);
      try {
        const read = tool(await f.next(), 'goal_status');
        f.result(read, f.status());
        const write = tool(
          await f.next(),
          provider === 'claude' ? 'Bash' : provider === 'codex' ? 'exec_command' : 'bash'
        );
        f.result(write, 'TEST_NATIVE_GOAL_FILE_OK', true);
        let returned = false;
        const pending = f.next().then((answer) => {
          returned = true;
          return answer;
        });
        await held(() => f.script.heldInputIds().length === 1);
        assert.equal(returned, false);
        f.stop();
        f.script.releaseHeld();
        assert.ok('text' in (await pending));
        assert.throws(
          () => f.script.respond(provider, bodyFor(provider, f.messages)),
          /after explicit Stop/u
        );
        assert.throws(() => f.script.releaseHeld(), /exactly once/u);
        assert.deepEqual(f.model.failures, []);
      } finally {
        if (f.script.heldInputIds().length) f.script.releaseHeld();
        await f.model.close();
      }
    }
  );

  test(
    'native goal ' +
      provider +
      ' worker uses its actual task and actor receipts through both stages',
    async () => {
      const f = await fixture(provider, false, true, true);
      const actor = actors[provider];
      const task = {
        id: 'TEST-worker-task',
        subject: 'TEST native goal TEST-current-goal artifact for ' + actor,
        owner: actor,
        status: 'pending',
      };
      const receipt = {
        phase: 'completed',
        principalId: actor + '-session',
        effects: { taskId: task.id },
      };
      try {
        const status = tool(await f.next(), 'goal_status');
        f.result(status, f.status());
        const list = tool(await f.next(), 'task_list');
        assert.equal(list.input.owner, actor);
        f.result(list, [task]);
        const start = tool(await f.next(), 'task_start');
        assert.equal(start.input.taskId, task.id);
        f.result(start, receipt);
        const first = tool(
          await f.next(),
          provider === 'claude' ? 'Bash' : provider === 'codex' ? 'exec_command' : 'bash'
        );
        f.result(first, 'TEST_NATIVE_GOAL_FILE_OK', true);
        const comment = tool(await f.next(), 'task_add_comment');
        f.result(comment, receipt);
        assert.ok('text' in (await f.next()));
        f.nextInput(
          'TEST-worker-second',
          'Continue the accepted objective TEST-current-goal. Continuation 1.'
        );
        const secondStatus = tool(await f.next(), 'goal_status');
        f.result(secondStatus, f.status());
        const secondList = tool(await f.next(), 'task_list');
        f.result(secondList, [{ ...task, status: 'in_progress' }]);
        const second = tool(
          await f.next(),
          provider === 'claude' ? 'Bash' : provider === 'codex' ? 'exec_command' : 'bash'
        );
        f.result(second, 'TEST_NATIVE_GOAL_FILE_OK', true);
        const complete = tool(await f.next(), 'task_complete');
        assert.equal(complete.input.taskId, task.id);
        f.result(complete, receipt);
        assert.ok('text' in (await f.next()));
        assert.deepEqual(f.model.failures, []);
      } finally {
        await f.model.close();
      }
    }
  );

  test(
    'native goal ' +
      provider +
      ' oracle rejects an old input marker behind a different current input',
    async () => {
      const f = await fixture(provider);
      try {
        f.messages.push({ role: 'user', content: 'TEST unrelated newer human input' });
        assert.equal((await f.raw()).status, 400);
        assert.equal(f.script.observations.length, 0);
        assert.match(f.model.failures.join('\n'), /CURRENT native user input/u);
      } finally {
        await f.model.close();
      }
    }
  );
}

test('native delegated goal reads only current-goal tasks, preserving the prior accepted goal inventory', async () => {
  const f = await fixture('claude', false, true);
  try {
    f.nextInput(
      'TEST-lead-followup',
      'Continue the accepted objective TEST-current-goal. Continuation 1.'
    );
    const status = tool(await f.next(), 'goal_status');
    f.result(status, f.status());
    const inventory = tool(await f.next(), 'task_list');
    const old = {
      id: 'TEST-old-task',
      subject: 'TEST native goal TEST-previous-goal artifact for bob',
      owner: 'bob',
      status: 'completed',
    };
    const current = {
      id: 'TEST-current-task',
      subject: 'TEST native goal TEST-current-goal artifact for bob',
      owner: 'bob',
      status: 'in_progress',
    };
    f.result(inventory, [old, current]);
    assert.ok('text' in (await f.next()), 'old accepted work never satisfies the new active goal');
    f.nextInput('TEST-board-complete', 'TEST original Board complete notification');
    const finalStatus = tool(await f.next(), 'goal_status');
    f.result(finalStatus, f.status());
    const finalInventory = tool(await f.next(), 'task_list');
    f.result(finalInventory, [old, { ...current, status: 'completed' }]);
    const verify = tool(await f.next(), 'Bash');
    assert.match(String(verify.input.command), /happy-bob-result\.txt/u);
    assert.ok(
      !String(verify.input.command).includes('>'),
      'Delegate verifies the worker artifact without writing it'
    );
    f.result(verify, 'TEST_NATIVE_GOAL_FILE_OK', true);
    const proposal = tool(await f.next(), 'goal_propose');
    f.result(proposal, { goalId: 'TEST-current-goal', disposition: 'finalizing' });
    assert.ok('text' in (await f.next()));
    assert.deepEqual(f.model.failures, []);
  } finally {
    await f.model.close();
  }
});

test('native goal oracle requires the exact original result id and a completed MCP receipt', async () => {
  for (const wrongId of [true, false]) {
    const f = await fixture('claude');
    try {
      const read = tool(await f.next(), 'goal_status');
      f.result(
        read,
        wrongId ? f.status() : { error: { code: 'forbidden' } },
        false,
        wrongId ? 'TEST-another-call' : read.id
      );
      assert.equal((await f.raw()).status, 400);
      assert.equal(f.script.observations.length, 1, 'failed evidence cannot advance the script');
    } finally {
      await f.model.close();
    }
  }
  const f = await fixture('claude', false, true);
  try {
    const read = tool(await f.next(), 'goal_status');
    f.result(read, f.status());
    const create = tool(await f.next(), 'task_create');
    f.result(create, { phase: 'held', effects: { taskId: 'TEST-uncommitted-task' } });
    assert.equal((await f.raw()).status, 400);
    assert.equal(f.script.observations.length, 2);
  } finally {
    await f.model.close();
  }
});

test('native goal parser retains actual compact array and structured MCP wrappers without accepting errors', () => {
  const rows = [{ id: 'TEST-task', subject: 'TEST original task' }];
  assert.deepEqual(readNativeGoalToolValue(JSON.stringify(rows)), rows);
  assert.deepEqual(
    readNativeGoalToolValue('Wall time: 0.1 seconds\nOutput:\n' + JSON.stringify({ result: rows })),
    rows
  );
  assert.deepEqual(
    readNativeGoalToolValue([
      { type: 'text', text: JSON.stringify({ phase: 'completed', result: rows }) },
    ]),
    { phase: 'completed', result: rows }
  );
  for (const bad of [
    '{"result":',
    '{"error":{"code":"hold"}}',
    '{"isError":true,"result":[]}',
    'not JSON',
  ])
    assert.throws(() => readNativeGoalToolValue(bad));
});
