import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeToolReceipt } from './model.ts';

test('native structured MCP receipt survives appended SDK reminders and JSON punctuation in strings', () => {
  const receipt = {
    schemaVersion: 1,
    phase: 'completed',
    principalId: 'alice-session',
    effects: { taskId: 'native-created-id' },
    result: { task: { id: 'native-created-id' } },
    subject: 'A { brace } and \\"quoted\\" text',
  };
  const text =
    JSON.stringify({ result: receipt }) +
    '\n\n<system-reminder>Keep tool-call identity.</system-reminder>';
  assert.deepEqual(nativeToolReceipt([{ type: 'text', text }]), receipt);
  assert.deepEqual(nativeToolReceipt(text), receipt);
  assert.deepEqual(nativeToolReceipt(JSON.stringify(receipt)), receipt);
  assert.throws(() => nativeToolReceipt('{"result":'), /missing or incomplete/);
});

// These exercise the local oracle's admission boundary; native execution is proved separately.
test('model probe admission is opt-in, exact, tool-free, and independently bounded', async () => {
  const { startNativeTeamModel } = await import('./model.ts');
  const probePrompt = 'Reply only OK. Do not use tools, access files or run commands.';
  const request = (url: string, content: unknown, tools: unknown[] = []) =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content }],
        tools,
      }),
    });
  const disabled = await startNativeTeamModel();
  try {
    assert.equal((await request(disabled.url, probePrompt)).status, 400);
  } finally {
    await disabled.close();
  }
  for (const [content, tools] of [
    ['Reply only OK.', []],
    [probePrompt + ' extra', []],
    [probePrompt, [{ name: 'Bash' }]],
  ] as const) {
    const rejected = await startNativeTeamModel({ allowModelProbes: true });
    try {
      assert.equal((await request(rejected.url, content, [...tools])).status, 400);
    } finally {
      await rejected.close();
    }
  }
  const enabled = await startNativeTeamModel({ allowModelProbes: true });
  try {
    for (let count = 0; count < 8; count++) {
      const response = await request(
        enabled.url,
        count % 2 ? [
          { type: 'text', text: '<system-reminder>TEST SDK reminder</system-reminder>' },
          { type: 'text', text: probePrompt },
        ] : probePrompt
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), /"text":"OK"/);
    }
    assert.equal(enabled.observations.length, 0);
    assert.deepEqual(
      enabled.probes,
      Array.from({ length: 8 }, () => ({
        requestedModel: 'claude-opus-4-6',
        requestedEffort: 'medium',
      }))
    );
    assert.equal((await request(enabled.url, probePrompt)).status, 400);
    assert.match(enabled.failures[0]!, /probe request budget/);
  } finally {
    await enabled.close();
  }
});

// Current native Opus adds a system-role transport message beside the one authorized SDK input.
test('model probe accepts the SDK system envelope while rejecting additional input and nontext wrappers', async () => {
  const { startNativeTeamModel } = await import('./model.ts');
  const prompt = 'Reply only OK. Do not use tools, access files or run commands.';
  const user = { role: 'user', content: prompt };
  const system = { role: 'system', content: [{ type: 'text', text: 'TEST SDK system wrapper' }] };
  const cases: [unknown[], unknown[], number][] = [
    [[user, system], [], 200],
    [[system, user], [], 200],
    [[user, system, { role: 'user', content: prompt }], [], 400],
    [[user, { role: 'assistant', content: 'TEST extra assistant' }], [], 400],
    [[user, { role: 'tool', content: 'TEST extra tool result' }], [], 400],
    [[user, { role: 'system', content: [{ type: 'tool_result', content: 'TEST' }] }], [], 400],
    [[{ role: 'user', content: prompt + ' extra' }, system], [], 400],
    [[user, system], [{ name: 'Bash' }], 400],
  ];
  for (const [messages, tools, status] of cases) {
    const fixture = await startNativeTeamModel({ allowModelProbes: true });
    try {
      const response = await fetch(`${fixture.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', messages, tools }) });
      assert.equal(response.status, status);
      assert.equal(fixture.probes.length, status === 200 ? 1 : 0);
    } finally { await fixture.close(); }
  }
});

test('conversation MCP receipts require the current trusted capture principal', async () => {
  const { CONTEXT_MARKER, REQUIRED_TOOLS, startNativeTeamModel } = await import('./model.ts');
  let principal = 'agent:TEST-first';
  const model = await startNativeTeamModel({ principalId: () => principal });
  const messages: unknown[] = [{ role: 'user', content: 'NATIVE_TEAM_ONE' }];
  const post = () =>
    fetch(`${model.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: CONTEXT_MARKER,
        messages,
        tools: REQUIRED_TOOLS.map((name) => ({ name: `mcp__team__${name}` })),
      }),
    });
  try {
    assert.equal((await post()).status, 200);
    principal = 'agent:TEST-current';
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: JSON.stringify({
            phase: 'completed',
            principalId: principal,
            effects: { taskId: 'TEST-task' },
          }),
        },
      ],
    });
    assert.equal((await post()).status, 200);
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: JSON.stringify({ phase: 'completed', principalId: 'alice-session' }),
        },
      ],
    });
    assert.equal((await post()).status, 400);
    assert.equal(model.observations.length, 2);
    assert.equal(model.failures.length, 1);
  } finally {
    await model.close();
  }
});

// This admits only exact deliberate tokens and original native receipts, not fabricated native evidence.
test('additive member oracle keeps original lookup identity and rejects failed or foreign receipts', async () => {
  const { nativeMemberCreationScript, NATIVE_MEMBER } = await import('./member-creation.ts');
  const input = {
    commandId: NATIVE_MEMBER.commandId,
    expectedRosterRevision: 'a'.repeat(64),
    member: { name: NATIVE_MEMBER.name, providerId: 'anthropic' as const, model: 'TEST-model' },
  };
  const make = () =>
    nativeMemberCreationScript(
      {
        capture: () => ({ input, model: 'TEST-model', effort: 'medium' }),
        principalId: (name) => `agent:${name}`,
      },
      nativeToolReceipt
    );
  const tools = ['team_member_create', 'team_member_create_lookup', 'message_send'].map(
    (name) => `mcp__team__${name}`
  );
  const body = (content: unknown[] = []) => ({
    system: 'TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1',
    messages: [
      { role: 'user', content: `${NATIVE_MEMBER.create}\nTURN ACTION MODE: DO` },
      ...(content.length ? [{ role: 'user', content }] : []),
    ],
  });
  const result = {
    commandId: input.commandId,
    memberId: 'TEST-new-member',
    name: NATIVE_MEMBER.name,
    revision: 'b'.repeat(64),
    phase: 'completed',
  };
  const observed = (step: number, value: unknown, is_error = false) => [
    {
      type: 'tool_result',
      tool_use_id: `native_member_${NATIVE_MEMBER.create}_${step}`,
      content: JSON.stringify(value),
      is_error,
    },
  ];
  const fixture = make();
  assert.equal(
    fixture.respond({ messages: [{ role: 'user', content: 'ordinary input' }] }, tools),
    undefined
  );
  assert.deepEqual(fixture.respond(body(), tools)?.input, input);
  assert.equal(
    fixture.respond(body(observed(0, result)), tools)?.name,
    'mcp__team__team_member_create_lookup'
  );
  assert.deepEqual(fixture.respond(body(observed(1, result)), tools)?.input, {
    commandId: 'TEST-native-new-peer-work',
    to: NATIVE_MEMBER.name,
    text: NATIVE_MEMBER.work,
  });
  assert.deepEqual(fixture.observations[2]?.originalLookup, result);
  const bad = make();
  bad.respond(body(), tools);
  assert.throws(() => bad.respond(body(observed(0, result, true)), tools));
  const mismatched = make();
  mismatched.respond(body(), tools);
  assert.throws(() =>
    mismatched.respond(body(observed(0, { ...result, commandId: 'other' })), tools)
  );
  const changed = make();
  changed.respond(body(), tools);
  changed.respond(body(observed(0, result)), tools);
  assert.throws(() =>
    changed.respond(body(observed(1, { ...result, memberId: 'replacement' })), tools)
  );
});

test('additive member oracle requires current roster once and retains exact actor and original input budgets', async () => {
  const { nativeMemberCreationScript, NATIVE_MEMBER } = await import('./member-creation.ts');
  const make = () =>
    nativeMemberCreationScript(
      {
        capture: () => ({
          input: {
            commandId: NATIVE_MEMBER.commandId,
            expectedRosterRevision: 'a'.repeat(64),
            member: { name: NATIVE_MEMBER.name, providerId: 'anthropic' },
          },
          model: 'TEST-model',
          effort: 'medium',
        }),
        principalId: (name) => `agent:${name}`,
      },
      nativeToolReceipt
    );
  const tools = ['mcp__team__message_send'];
  const body = (text: string, result?: unknown) => ({
    model: 'TEST-model',
    output_config: { effort: 'medium' },
    system: 'TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1',
    messages: [
      { role: 'user', content: text },
      ...(result
        ? [
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: `native_member_${NATIVE_MEMBER.work}_0`,
                  content: JSON.stringify(result),
                },
              ],
            },
          ]
        : []),
    ],
  });
  assert.throws(() => make().respond(body(NATIVE_MEMBER.next), tools));
  const reminder = 'Internal standing context restored after provider context compaction.';
  assert.equal(
    make().respond(body(`${reminder} "name":"${NATIVE_MEMBER.name}" ${NATIVE_MEMBER.next}`), tools)
      ?.type,
    'tool_use'
  );
  assert.throws(() => make().respond(body(`${reminder} ${NATIVE_MEMBER.followup}`), tools));
  for (const effort of [undefined, 'high']) {
    const rejected = make();
    rejected.respond(body(`${NATIVE_MEMBER.create} TURN ACTION MODE: DO`), [
      'mcp__team__team_member_create',
    ]);
    assert.throws(() =>
      rejected.respond({ ...body(NATIVE_MEMBER.work), output_config: { effort } }, tools)
    );
  }
  const peer = make();
  peer.respond(body(`${NATIVE_MEMBER.create} TURN ACTION MODE: DO`), [
    'mcp__team__team_member_create',
  ]);
  peer.respond(body(NATIVE_MEMBER.work), tools);
  assert.throws(() =>
    peer.respond(
      body(NATIVE_MEMBER.work, { phase: 'completed', principalId: 'agent:team-lead' }),
      tools
    )
  );
});
