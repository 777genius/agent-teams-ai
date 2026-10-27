import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
