import {
  startNativeTeamModel,
  CONTEXT_MARKER as claudeContext,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { digest, effectId } from '../../packages/legacy-agent-host/dist/team/identity.js';
import {
  createMixedTaskNoticeReader,
  mixedBinding,
  type ObservedMixedTaskNotice,
} from '../../packages/legacy-agent-host/tests/fixtures/native-mixed-task-notifications.ts';
import { initialMixedBusinessTurns, mixedInputAccounting } from './desktop-mixed-input-proof.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  startCodexModel,
  CONTEXT_MARKER as codexContext,
} from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import {
  startOpenCodeModel,
  CONTEXT_MARKER as openCodeContext,
} from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import {
  mixedDesktopTeamName,
  readMixedCapturedPrincipal,
} from './desktop-mixed-native-fixture.ts';

const prompt = 'Reply only OK. Do not use tools, access files or run commands.';
const providers = [
  {
    provider: 'codex',
    start: startCodexModel,
    route: '/v1/responses',
    probe: {
      model: 'TEST-model',
      input: [{ role: 'user', content: prompt }],
      tools: [{ type: 'function', name: 'exec_command' }],
    },
    mixedHistory: {
      input: [
        { role: 'assistant', content: 'prior native output' },
        { role: 'user', content: prompt },
      ],
    },
    business: {
      input: [
        { role: 'developer', content: codexContext },
        { role: 'user', content: 'CODEX_TEAM_ONE' },
      ],
      tools: [
        {
          type: 'namespace',
          name: 'mcp__team',
          tools: [
            'task_create',
            'task_set_owner',
            'task_start',
            'task_add_comment',
            'task_complete',
            'message_send',
          ].map((name) => ({ name })),
        },
        { type: 'function', name: 'exec_command' },
      ],
    },
  },
  {
    provider: 'opencode',
    start: startOpenCodeModel,
    route: '/v1/chat/completions',
    probe: { model: 'TEST-model', messages: [{ role: 'user', content: prompt }], tools: [] },
    mixedHistory: {
      messages: [
        { role: 'assistant', content: 'prior native output' },
        { role: 'user', content: prompt },
      ],
    },
    business: {
      messages: [
        { role: 'system', content: openCodeContext },
        { role: 'user', content: 'OPENCODE_TEAM_ONE' },
      ],
      tools: [
        'task_create',
        'task_set_owner',
        'task_start',
        'task_add_comment',
        'task_complete',
        'message_send',
      ]
        .map((name) => ({ type: 'function', function: { name: 'team_' + name } }))
        .concat([{ type: 'function', function: { name: 'bash' } }]),
    },
  },
] as const;

for (const selected of providers) {
  test(`${selected.provider} opt-in finite probes never consume business turns or resolve a principal`, async (t) => {
    let principalReads = 0;
    const model = await selected.start({
      allowModelProbes: true,
      principalId: () => {
        principalReads++;
        throw new Error('no captured grant before launch');
      },
    });
    t.after(() => model.close());
    const send = (body: unknown) =>
      fetch(model.url + selected.route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (let i = 0; i < 8; i++) {
      const response = await send(selected.probe);
      assert.equal(response.status, 200);
      const wire = await response.text();
      assert.match(wire, /OK/);
      assert.doesNotMatch(wire, /function_call|tool_calls/);
    }
    assert.equal(model.probes.length, 8);
    assert.equal(principalReads, 0);
    assert.equal(model.observations.length, 0);
    const business = await send(selected.business);
    assert.equal(business.status, 200);
    assert.match(await business.text(), /task_create/);
    assert.equal(model.observations.length, 1, 'business step zero remains available after probes');
    const ninth = await send(selected.probe);
    assert.equal(ninth.status, 400);
    await ninth.text();
    assert.equal(model.probes.length, 8);
    assert.equal(model.failures.length, 1);
  });

  test(`${selected.provider} original default and prior assistant history cannot become model preflight success`, async (t) => {
    const original = await selected.start();
    const enabled = await selected.start({ allowModelProbes: true });
    t.after(() => Promise.all([original.close(), enabled.close()]));
    for (const [model, body] of [
      [original, selected.probe],
      [enabled, selected.mixedHistory],
    ] as const) {
      const response = await fetch(model.url + selected.route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      await response.text();
      assert.equal(model.probes.length, 0);
      assert.equal(model.observations.length, 0);
      assert.equal(model.failures.length, 1);
    }
  });
}

test('mixed principal callback requires exact canonical capture delivery and live registered grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner');
  await mkdir(directory, { recursive: true });
  const members = [
    { memberId: 'TEST-actual-lead', name: 'team-lead', role: 'lead' },
    {
      memberId: 'TEST-actual-codex',
      name: 'bob',
      role: 'member',
      settings: { providerId: 'codex' },
    },
    {
      memberId: 'TEST-actual-opencode',
      name: 'carol',
      role: 'member',
      settings: { providerId: 'opencode' },
    },
  ];
  const capture = {
    launchId: 'TEST-actual-run',
    members: members.map((member, index) => ({
      memberId: member.memberId,
      principalId: `agent:TEST-registered-${index}`,
      delivery: { runId: 'TEST-actual-run', memberId: member.memberId },
    })),
  };
  const grants = members.map((member, index) => ({
    memberName: member.name,
    principalId: capture.members[index]!.principalId,
    permissions: ['read', 'task.write', 'message.write', 'process.write'],
    revoked: false,
  }));
  const state = {
    savedSettings: { providerId: 'anthropic' },
    members,
    runtimeCaptures: [capture],
    grants,
  };
  const save = () => writeFile(join(directory, 'state.json'), JSON.stringify(state));
  await save();
  for (const [provider, principal] of [
    ['claude', 'agent:TEST-registered-0'],
    ['codex', 'agent:TEST-registered-1'],
    ['opencode', 'agent:TEST-registered-2'],
  ] as const)
    assert.equal(readMixedCapturedPrincipal(root, provider), principal);
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({
      ...state,
      members: members.map((member) =>
        member.name === 'bob' ? { ...member, settings: undefined } : member
      ),
    })
  );
  assert.throws(
    () => readMixedCapturedPrincipal(root, 'codex'),
    'missing peer settings remain invalid'
  );
  await save();
  assert.notEqual(readMixedCapturedPrincipal(root, 'codex'), 'bob-session');
  grants[1]!.revoked = true;
  await save();
  assert.throws(() => readMixedCapturedPrincipal(root, 'codex'));
  grants[1]!.revoked = false;
  capture.members[1]!.delivery.runId = 'TEST-other-run';
  await save();
  assert.throws(() => readMixedCapturedPrincipal(root, 'codex'));
});

// Known-shape canonical retained files exercise the TEST reader, never production admission/native effects.
async function notificationFiles(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner');
  for (const name of ['commands', 'task-plans', 'outbox'])
    await mkdir(join(directory, name), { recursive: true });
  const stateBinding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    teamName: mixedDesktopTeamName,
  };
  const bindings = ['team-lead', 'bob', 'carol'].map((memberId) => ({
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId,
    generation: '1',
  }));
  const state = {
    binding: stateBinding,
    members: bindings.map((binding) => ({
      name: binding.memberId,
      memberId: binding.memberId,
      delivery: { ...binding, teamName: mixedDesktopTeamName },
    })),
  };
  const sources: Record<
    string,
    {
      text: string;
      input: Record<string, unknown>;
      outbox: Record<string, unknown>;
      session: Record<string, unknown>;
      path: string;
    }
  > = {};
  for (const binding of bindings) {
    const actor = binding.memberId,
      commandId = 'TEST-notice-' + actor;
    const messageId = effectId('TEST-notice-message', actor),
      id = effectId('TEST-notice-input', actor);
    const content =
      actor === 'team-lead'
        ? '**Board complete** — original TEST board'
        : 'New task assigned to you: original TEST ' + actor;
    const fingerprint = digest({ commandId, actor });
    const receipt = {
      binding: stateBinding,
      commandId,
      fingerprint,
      phase: 'completed',
      taskPlanVersion: 1,
      command: {
        operation: actor === 'team-lead' ? 'task.lifecycle' : 'task.assign',
        payload: actor === 'team-lead' ? { action: 'complete' } : { owner: actor },
      },
      taskRecipients: [{ name: actor, delivery: binding }],
    };
    await writeFile(
      join(directory, 'commands', digest(commandId) + '.json'),
      JSON.stringify(receipt)
    );
    await writeFile(
      join(directory, 'task-plans', digest(commandId) + '.json'),
      JSON.stringify({
        commandId,
        fingerprint,
        notifications: [{ member: actor, messageId, content }],
      })
    );
    const intent = { binding, deliveryId: id, inputId: id, messageId, content };
    const input = {
      intent,
      fingerprint: digest(intent),
      operationRef: effectId('TEST-operation', actor),
      phase: 'claimed',
      preparation: { prefix: 'TEST captured original prefix\n' },
    };
    const outbox = {
      binding: { ...binding, teamName: mixedDesktopTeamName },
      commandId,
      deliveryId: id,
      inputId: id,
      messageId,
      content,
      phase: 'admitted',
      runtimeReceipt: {
        binding,
        fingerprint: input.fingerprint,
        operationRef: input.operationRef,
        phase: 'admitted',
      },
    };
    await writeFile(join(directory, 'outbox', id + '.json'), JSON.stringify(outbox));
    const session = { binding, inputs: [input] };
    const namespace = join(root, 'hoststore/runtime-sessions', digest(actor));
    await mkdir(namespace, { recursive: true });
    const path = join(namespace, digest(binding) + '.json');
    await writeFile(path, JSON.stringify(session));
    sources[actor] = { text: input.preparation.prefix + content, input, outbox, session, path };
  }
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  return {
    root,
    directory,
    state,
    bindings,
    sources,
    saveSession: async (actor: string) =>
      writeFile(sources[actor]!.path, JSON.stringify(sources[actor]!.session)),
  };
}
const noticeProviders = [
  {
    provider: 'claude',
    actor: 'team-lead',
    one: 'NATIVE_TEAM_ONE',
    two: 'NATIVE_TEAM_TWO',
    context: claudeContext,
    route: '/v1/messages',
    start: startNativeTeamModel,
  },
  {
    provider: 'codex',
    actor: 'bob',
    one: 'CODEX_TEAM_ONE',
    two: 'CODEX_TEAM_TWO',
    context: codexContext,
    route: '/v1/responses',
    start: startCodexModel,
  },
  {
    provider: 'opencode',
    actor: 'carol',
    one: 'OPENCODE_TEAM_ONE',
    two: 'OPENCODE_TEAM_TWO',
    context: openCodeContext,
    route: '/v1/chat/completions',
    start: startOpenCodeModel,
  },
] as const;
function noticeRequest(
  selected: (typeof noticeProviders)[number],
  current: string,
  toolOutput?: string
) {
  const history = [
    { role: 'user', content: selected.one },
    { role: 'assistant', content: 'original prior business output' },
    { role: 'user', content: current },
  ];
  if (selected.provider === 'claude')
    return {
      model: 'TEST-model',
      system: selected.context,
      output_config: { effort: 'medium' },
      tools: [
        'task_create',
        'task_set_owner',
        'task_start',
        'task_add_comment',
        'task_complete',
        'message_send',
      ]
        .map((name) => ({ name: 'mcp__team__' + name }))
        .concat([{ name: 'Bash' }]),
      messages: [
        ...history,
        ...(toolOutput === undefined
          ? []
          : [
              {
                role: 'user',
                content: [
                  { type: 'tool_result', tool_use_id: 'TEST-prior-tool', content: toolOutput },
                ],
              },
            ]),
      ],
    };
  if (selected.provider === 'codex')
    return {
      model: 'TEST-model',
      instructions: selected.context,
      tools: [
        'task_create',
        'task_set_owner',
        'task_start',
        'task_add_comment',
        'task_complete',
        'message_send',
      ]
        .map((name) => ({ type: 'function', name: 'mcp__team__' + name }))
        .concat([{ type: 'function', name: 'exec_command' }]),
      input: [
        ...history,
        ...(toolOutput === undefined
          ? []
          : [{ type: 'function_call_output', call_id: 'TEST-prior-tool', output: toolOutput }]),
      ],
    };
  return {
    model: 'TEST-model',
    messages: [
      { role: 'system', content: selected.context },
      ...history,
      ...(toolOutput === undefined ? [] : [{ role: 'tool', content: toolOutput }]),
    ],
    tools: [
      'task_create',
      'task_set_owner',
      'task_start',
      'task_add_comment',
      'task_complete',
      'message_send',
    ]
      .map((name) => ({ type: 'function', function: { name: 'team_' + name } }))
      .concat([{ type: 'function', function: { name: 'bash' } }]),
  };
}
for (const selected of noticeProviders) {
  test(`${selected.provider} CURRENT receipt-bound notice cannot replay historical business; transport IDs and business cap remain exact`, async (t) => {
    const f = await notificationFiles(t),
      source = f.sources[selected.actor]!;
    source.outbox.phase = 'pending';
    delete source.outbox.runtimeReceipt;
    await writeFile(
      join(f.directory, 'outbox', String(source.outbox.inputId) + '.json'),
      JSON.stringify(source.outbox)
    );
    const model = await selected.start({
      mixedGroups: true,
      mixedTaskNotifications: createMixedTaskNoticeReader(() => f.root, selected.actor),
      principalId: () => 'TEST-principal',
    });
    t.after(() => model.close());
    const send = async (body: unknown) =>
      fetch(model.url + selected.route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const response = await send(noticeRequest(selected, source.text));
    assert.equal(response.status, 200);
    const wires = [await response.text()];
    assert.match(wires[0]!, /DONE_TEST_TASK_NOTICE/);
    assert.doesNotMatch(wires[0]!, /"type":"tool_use"|"type":"function_call"|"tool_calls"/);
    assert.equal(model.observations.length, 0);
    assert.equal(model.notificationObservations?.length, 1);
    assert.equal(model.notificationObservations![0]!.notice.inputId, source.outbox.inputId);
    const receipt = JSON.stringify({
      phase: 'completed',
      principalId: 'TEST-principal',
      effects: { taskId: 'TEST-task' },
    });
    for (let step = 0; step < 3; step++) {
      const result = await send(
        noticeRequest(selected, selected.two, step === 0 ? undefined : receipt)
      );
      assert.equal(result.status, 200);
      wires.push(await result.text());
    }
    assert.deepEqual(
      model.observations.map((value) => [value.turn, value.step]),
      [
        [selected.two, 0],
        [selected.two, 1],
        [selected.two, 2],
      ]
    );
    const ids = wires.map(
      (wire) =>
        /"id":"((?:msg_native_team_|TEST-codex-response-|TEST-opencode-response-)\d+)"/.exec(
          wire
        )?.[1]
    );
    assert.ok(ids.every(Boolean));
    assert.equal(
      new Set(ids).size,
      4,
      'each business/notice inference has its own transport response ID'
    );
    const duplicate = await send(noticeRequest(selected, selected.two, receipt));
    assert.equal(duplicate.status, 400);
    await duplicate.text();
    assert.equal(model.observations.length, 3);
    assert.equal(model.notificationObservations?.length, 1);
    assert.match(model.failures[0]!, /finite original business/);
  });
  test(`${selected.provider} refuses a duplicate or unbound CURRENT notice instead of falling back to old business`, async (t) => {
    const f = await notificationFiles(t),
      source = f.sources[selected.actor]!;
    for (const kind of ['duplicate', 'unbound'] as const) {
      const model = await selected.start({
        mixedGroups: true,
        mixedTaskNotifications: createMixedTaskNoticeReader(() => f.root, selected.actor),
        principalId: () => 'TEST-principal',
      });
      t.after(() => model.close());
      const send = (current: string) =>
        fetch(model.url + selected.route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(noticeRequest(selected, current)),
        });
      if (kind === 'duplicate') {
        const first = await send(source.text);
        assert.equal(first.status, 200);
        await first.text();
      }
      const result = await send(kind === 'duplicate' ? source.text : source.text + ' unbound');
      assert.equal(result.status, 400);
      await result.text();
      assert.equal(model.observations.length, 0);
      assert.equal(model.notificationObservations?.length, kind === 'duplicate' ? 1 : 0);
      assert.equal(model.failures.length, 1);
    }
  });
}

test('mixed terminal accounting rejects extra business and uses the explicitly qualified Bob restart generation', async (t) => {
  const f = await notificationFiles(t);
  const modelRows: Record<
    string,
    { notificationObservations: { notice: ObservedMixedTaskNotice; contextEffective: boolean }[] }
  > = {};
  for (const [actor, provider, turn] of [
    ['team-lead', 'claude', 'NATIVE_TEAM_ONE'],
    ['bob', 'codex', 'CODEX_TEAM_ONE'],
    ['carol', 'opencode', 'OPENCODE_TEAM_ONE'],
  ] as const) {
    const source = f.sources[actor]!,
      notice = createMixedTaskNoticeReader(() => f.root, actor)(source.text)!;
    modelRows[provider] = { notificationObservations: [{ notice, contextEffective: true }] };
    source.input.phase = 'terminal';
    source.input.terminal = 'succeeded';
    const binding = mixedBinding(source.session.binding),
      id = effectId('TEST-business', actor);
    const intent = { binding, inputId: id, deliveryId: id, messageId: id, content: turn };
    const input = {
      intent,
      fingerprint: digest(intent),
      operationRef: effectId('TEST-business-operation', actor),
      phase: 'terminal',
      terminal: 'succeeded',
    };
    (source.session.inputs as unknown[]).unshift(input);
    await writeFile(
      join(f.directory, 'outbox', id + '.json'),
      JSON.stringify({
        binding: { ...binding, teamName: mixedDesktopTeamName },
        commandId: id,
        inputId: id,
        deliveryId: id,
        messageId: id,
        content: turn,
        phase: 'admitted',
        runtimeReceipt: {
          binding,
          fingerprint: input.fingerprint,
          operationRef: input.operationRef,
        },
      })
    );
    await f.saveSession(actor);
  }
  const models = modelRows as unknown as DesktopMixedModels,
    sessions = f.bindings.map((binding) => f.sources[binding.memberId]!.session);
  assert.equal(
    mixedInputAccounting(f.root, sessions, models, initialMixedBusinessTurns).ready,
    true
  );
  const pending = f.sources['team-lead']!.outbox,
    ack = pending.runtimeReceipt;
  pending.phase = 'pending';
  delete pending.runtimeReceipt;
  await writeFile(
    join(f.directory, 'outbox', String(pending.inputId) + '.json'),
    JSON.stringify(pending)
  );
  assert.equal(
    mixedInputAccounting(f.root, sessions, models, initialMixedBusinessTurns).ready,
    false,
    'terminal proof still requires the original admitted ACK'
  );
  pending.phase = 'admitted';
  pending.runtimeReceipt = ack;
  await writeFile(
    join(f.directory, 'outbox', String(pending.inputId) + '.json'),
    JSON.stringify(pending)
  );
  assert.equal(
    mixedInputAccounting(f.root, sessions, models, initialMixedBusinessTurns).ready,
    true
  );

  const lead = sessions[0]!,
    copy = structuredClone((lead.inputs as Record<string, unknown>[])[0]!);
  (lead.inputs as unknown[]).push(copy);
  assert.equal(
    mixedInputAccounting(f.root, sessions, models, initialMixedBusinessTurns).ready,
    false
  );
  (lead.inputs as unknown[]).pop();
  const originalBob = structuredClone(sessions[1]!);
  const originalOutbox = await readFile(
    join(f.directory, 'outbox', String(f.sources.bob!.outbox.inputId) + '.json')
  );
  const nextBinding = { ...f.bindings[1]!, generation: 'restart-TEST-original' },
    id = effectId('TEST-business-bob-restart');
  const intent = {
    binding: nextBinding,
    inputId: id,
    deliveryId: id,
    messageId: id,
    content: 'CODEX_TEAM_TWO',
  };
  const input = {
    intent,
    fingerprint: digest(intent),
    operationRef: effectId('TEST-operation-bob-restart'),
    phase: 'terminal',
    terminal: 'succeeded',
  };
  const currentBob = { binding: nextBinding, inputs: [input] };
  await writeFile(
    join(f.directory, 'outbox', id + '.json'),
    JSON.stringify({
      binding: { ...nextBinding, teamName: mixedDesktopTeamName },
      commandId: id,
      inputId: id,
      deliveryId: id,
      messageId: id,
      content: intent.content,
      phase: 'admitted',
      runtimeReceipt: {
        binding: nextBinding,
        fingerprint: input.fingerprint,
        operationRef: input.operationRef,
      },
    })
  );
  const current = [sessions[0]!, currentBob, sessions[2]!],
    turns = { ...initialMixedBusinessTurns, bob: ['CODEX_TEAM_TWO'] };
  assert.equal(
    mixedInputAccounting(f.root, current, models, turns).ready,
    false,
    'immutable original roster is not the current Restart generation'
  );
  assert.equal(
    mixedInputAccounting(f.root, current, models, turns, [
      f.bindings[0]!,
      nextBinding,
      f.bindings[2]!,
    ]).ready,
    true
  );
  assert.deepEqual(sessions[1], originalBob);
  assert.deepEqual(
    await readFile(join(f.directory, 'outbox', String(f.sources.bob!.outbox.inputId) + '.json')),
    originalOutbox
  );
});

async function anotherNotice(
  f: Awaited<ReturnType<typeof notificationFiles>>,
  actor: string,
  index: number
) {
  const source = f.sources[actor]!,
    commandId = 'TEST-notice-' + actor + '-' + index,
    id = effectId(commandId);
  const messageId = effectId('message', commandId),
    content = String(source.outbox.content) + ' ' + index;
  const fingerprint = digest({ commandId, actor });
  const receipt = JSON.parse(
    await readFile(join(f.directory, 'commands', digest('TEST-notice-' + actor) + '.json'), 'utf8')
  ) as Record<string, unknown>;
  await writeFile(
    join(f.directory, 'commands', digest(commandId) + '.json'),
    JSON.stringify({ ...receipt, commandId, fingerprint })
  );
  await writeFile(
    join(f.directory, 'task-plans', digest(commandId) + '.json'),
    JSON.stringify({
      commandId,
      fingerprint,
      notifications: [{ member: actor, messageId, content }],
    })
  );
  const intent = {
    ...(source.input.intent as Record<string, unknown>),
    binding: mixedBinding(source.session.binding),
    inputId: id,
    deliveryId: id,
    messageId,
    content,
  };
  const input: Record<string, unknown> = {
    ...source.input,
    intent,
    fingerprint: digest(intent),
    operationRef: effectId('operation', commandId),
    phase: 'claimed',
  };
  delete input.terminal;
  const outbox = {
    ...source.outbox,
    commandId,
    inputId: id,
    deliveryId: id,
    messageId,
    content,
    runtimeReceipt: {
      binding: intent.binding,
      fingerprint: input.fingerprint,
      operationRef: input.operationRef,
    },
  };
  await writeFile(join(f.directory, 'outbox', id + '.json'), JSON.stringify(outbox));
  (source.session.inputs as unknown[]).push(input);
  await f.saveSession(actor);
  return { input, text: 'TEST captured original prefix\n' + content };
}
test('Mixed inference capacity keeps independent model probes bounded without admitting a seventeenth notice', async (t) => {
  for (const selected of providers) {
    const f = await notificationFiles(t),
      actor = selected.provider === 'codex' ? 'bob' : 'carol';
    const specification = noticeProviders.find((value) => value.provider === selected.provider)!;
    const source = f.sources[actor]!,
      model = await selected.start({
        allowModelProbes: true,
        mixedGroups: true,
        mixedTaskNotifications: createMixedTaskNoticeReader(() => f.root, actor),
      });
    t.after(() => model.close());
    const send = (body: unknown) =>
      fetch(model.url + selected.route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    let current = { input: source.input, text: source.text };
    for (let index = 0; index < 16; index++) {
      const result = await send(noticeRequest(specification, current.text));
      assert.equal(result.status, 200);
      await result.text();
      current.input.phase = 'terminal';
      current.input.terminal = 'succeeded';
      await f.saveSession(actor);
      current = await anotherNotice(f, actor, index + 1);
    }
    assert.equal(model.notificationObservations?.length, 16);
    assert.equal(model.observations.length, 0);
    const probe = await send(selected.probe);
    assert.equal(probe.status, 200);
    await probe.text();
    assert.equal(model.probes.length, 1);
    const extra = await send(noticeRequest(specification, current.text));
    assert.equal(extra.status, 400);
    await extra.text();
    assert.equal(model.notificationObservations?.length, 16);
    assert.equal(model.failures.length, 1);
  }
});

test('Claude CURRENT notice accepts only complete reminder transport around the exact original input', async (t) => {
  const f = await notificationFiles(t),
    selected = noticeProviders[0],
    source = f.sources['team-lead']!;
  // Verbatim transport block retained in this run's actual Member SDK request.
  const reminder =
    '<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>';
  const cases: { label: string; content: unknown; status: number }[] = [
    {
      label: 'actual leading SDK text block',
      status: 200,
      content: [
        { type: 'text', text: reminder + '\n' },
        { type: 'text', text: source.text },
      ],
    },
    {
      label: 'complete leading and trailing wrappers',
      status: 200,
      content: reminder + '\n\n' + source.text + '\n\n' + reminder,
    },
    {
      label: 'unknown prefix',
      status: 400,
      content: 'UNKNOWN\n' + reminder + '\n\n' + source.text,
    },
    {
      label: 'unknown suffix',
      status: 400,
      content: reminder + '\n\n' + source.text + '\nUNKNOWN',
    },
    {
      label: 'unknown text between wrappers',
      status: 400,
      content: reminder + '\nUNKNOWN\n' + reminder + '\n\n' + source.text,
    },
    {
      label: 'truncated wrapper',
      status: 400,
      content: '<system-reminder>unfinished\n' + source.text,
    },
    {
      label: 'duplicate canonical input',
      status: 400,
      content: reminder + '\n\n' + source.text + source.text,
    },
    { label: 'bare whitespace mutation', status: 400, content: '\n\n' + source.text + '\n' },
    {
      label: 'canonical prefix omitted',
      status: 400,
      content: reminder + '\n\n' + String((source.input.intent as Record<string, unknown>).content),
    },
  ];
  for (const { label, content, status } of cases) {
    const model = await startNativeTeamModel({
      mixedGroups: true,
      mixedTaskNotifications: createMixedTaskNoticeReader(() => f.root, 'team-lead'),
      principalId: () => 'TEST-principal',
    });
    try {
      const send = () =>
        fetch(model.url + selected.route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...noticeRequest(selected, source.text),
            messages: [
              { role: 'user', content: selected.one },
              { role: 'assistant', content: 'original prior business output' },
              { role: 'user', content },
            ],
          }),
        });
      const response = await send();
      assert.equal(response.status, status, label);
      const wire = await response.text();
      assert.equal(model.observations.length, 0, 'no historical business fallback');
      assert.equal(model.notificationObservations?.length, status === 200 ? 1 : 0);
      if (status === 200) {
        assert.match(wire, /DONE_TEST_TASK_NOTICE/);
        assert.doesNotMatch(wire, /"type":"tool_use"|"type":"function_call"|"tool_calls"/);
        assert.equal(model.notificationObservations![0]!.notice.inputId, source.outbox.inputId);
        const replay = await send();
        assert.equal(replay.status, 400, 'decorated original input cannot replay');
        await replay.text();
        assert.equal(model.notificationObservations?.length, 1);
        assert.match(model.failures[0]!, /notification inference is not replayed/);
      } else {
        assert.match(model.failures[0]!, /unrecognized CURRENT mixed input/);
      }
      assert.equal(model.failures.length, 1);
    } finally {
      await model.close();
    }
  }
});
