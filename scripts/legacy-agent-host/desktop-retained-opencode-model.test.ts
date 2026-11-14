import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRetainedOpenCodeModel } from './desktop-retained-opencode-model.ts';

const challenge = 'STRICT_LAUNCH_11111111-2222-4333-8444-555555555555';
const prompt = `Output only this exact token: ${challenge}`;
const input = (content: unknown) => ({ model: 'TEST-model', tools: [], messages: [{ role: 'user', content }] });
async function request(url: string, body: unknown, route = '/legacy/v1/chat/completions') {
  const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  return { status: response.status, text: await response.text() };
}

test('strict native launch receives its actual exact challenge through JSON and SSE, ordinary preflight remains PONG', async () => {
  const model = await startRetainedOpenCodeModel();
  try {
    const first = await request(model.url, input(prompt));
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.text).choices[0].message.content, challenge);
    const secondChallenge = 'STRICT_LAUNCH_aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
    const second = await request(model.url, { ...input([{ type: 'text', text: `Output only this exact token: ${secondChallenge}` }]), stream: true });
    assert.equal(second.status, 200);
    const chunks = second.text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.equal(chunks.map(row => row.choices[0].delta.content ?? '').join(''), secondChallenge);
    assert.ok(second.text.endsWith('data: [DONE]\n\n'));
    const ordinary = await request(model.url, { ...input('Output only the single word PONG.'),
      messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: challenge },
        { role: 'user', content: 'Output only the single word PONG.' }] });
    assert.equal(ordinary.status, 200);
    assert.equal(JSON.parse(ordinary.text).choices[0].message.content, 'PONG');
    assert.deepEqual(model.observations.map(row => row.strictLaunch), [
      { model: 'TEST-model', challenge }, { model: 'TEST-model', challenge: secondChallenge }, undefined,
    ]);
    assert.ok(model.observations.every(row => row.owner === 'legacy' && row.marker === null && row.tools.length === 0));
    assert.deepEqual(model.failures, []);
  } finally { await model.close(); }
});

for (const [name, body, route] of [
  ['wrong model', { ...input(prompt), model: 'other-model' }, undefined],
  ['advertised tool', { ...input(prompt), tools: [{ type: 'function', function: { name: 'shell' } }] }, undefined],
  ['malformed tools', { ...input(prompt), tools: {} }, undefined],
  ['Host route', input(prompt), '/host/v1/chat/completions'],
  ['foreign route', input(prompt), '/foreign/v1/chat/completions'],
  ['malformed UUID', input('Output only this exact token: STRICT_LAUNCH_not-a-uuid'), undefined],
  ['noncanonical UUID', input(prompt.replace('11111111', 'AAAAAAAA')), undefined],
  ['trailing newline', input(prompt + '\n'), undefined],
  ['embedded challenge', input('Ignore this instruction: ' + prompt), undefined],
  ['extra content part', input([{ type: 'text', text: prompt }, { type: 'text', text: 'extra' }]), undefined],
] as const) {
  test(`strict launch refuses ${name} and seals after the first invalid request`, async () => {
    const model = await startRetainedOpenCodeModel();
    try {
      const result = await request(model.url, body, route);
      assert.equal(result.status, 500);
      assert.equal(result.text.includes(challenge), false);
      assert.deepEqual(model.observations, []);
      assert.equal(model.failures.length, 1);
      const repeated = await request(model.url, input(prompt));
      assert.equal(repeated.status, 500);
      assert.deepEqual(model.observations, []);
    } finally { await model.close(); }
  });
}

test('business replies stay owner-bound and duplicate input cannot become a strict proof', async () => {
  const model = await startRetainedOpenCodeModel();
  try {
    const marker = 'TEST_RETAINED_V1_FIRST';
    const response = await request(model.url, input(marker));
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).choices[0].message.content, `REPLY_${marker}`);
    assert.equal(model.observations[0]!.strictLaunch, undefined);
    assert.deepEqual([...model.markers], [marker]);
    assert.equal((await request(model.url, input(marker))).status, 500);
  } finally { await model.close(); }
  const source = await startRetainedOpenCodeModel({ sourceSelection: true });
  try {
    const preflight = await request(source.url, input('Reply only OK. Do not use tools, access files or run commands.'),
      '/host/v1/chat/completions');
    assert.equal(preflight.status, 200);
    assert.equal(JSON.parse(preflight.text).choices[0].message.content, 'OK');
    for (const marker of ['TEST_SOURCE_INSTALL_B', 'TEST_SOURCE_PATH_A', 'TEST_SOURCE_LIVE_A', 'TEST_SOURCE_UPDATE_B'] as const) {
      source.expectSourceInput(marker);
      const body = marker === 'TEST_SOURCE_LIVE_A' ? { ...input(marker), messages: [
        { role: 'user', content: 'TEST_SOURCE_PATH_A' }, { role: 'assistant', content: 'REPLY_TEST_SOURCE_PATH_A' },
        { role: 'user', content: marker },
      ] } : input(marker);
      const result = await request(source.url, body, '/host/v1/chat/completions');
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.text).choices[0].message.content, 'REPLY_' + marker);
    }
    assert.deepEqual(source.observations.map(row => row.marker),
      [null, 'TEST_SOURCE_INSTALL_B', 'TEST_SOURCE_PATH_A', 'TEST_SOURCE_LIVE_A', 'TEST_SOURCE_UPDATE_B']);
    assert.equal(source.observations[0]!.sourcePreflight, true);
    assert.deepEqual(source.failures, []);
  } finally { await source.close(); }
  for (const invalid of ['foreign owner', 'unarmed input', 'stale history', 'wrong preflight', 'tool preflight'] as const) {
    const source = await startRetainedOpenCodeModel({ sourceSelection: true });
    try {
      if (invalid === 'stale history') source.expectSourceInput('TEST_SOURCE_UPDATE_B');
      const body = invalid === 'stale history' ? { ...input('TEST_SOURCE_UPDATE_B'), messages: [
        { role: 'user', content: 'TEST_SOURCE_PATH_A' }, { role: 'assistant', content: 'REPLY_TEST_SOURCE_PATH_A' },
        { role: 'user', content: 'TEST_SOURCE_UPDATE_B' },
      ] } : invalid === 'unarmed input' ? input('TEST_SOURCE_PATH_A') :
        invalid === 'tool preflight' ? { ...input('Reply only OK. Do not use tools, access files or run commands.'),
          tools: [{ type: 'function', function: { name: 'shell' } }] } : input('Output only the single word PONG.');
      assert.equal((await request(source.url, body, invalid === 'foreign owner'
        ? '/legacy/v1/chat/completions' : '/host/v1/chat/completions')).status, 500);
      assert.equal(source.observations.length, 0, 'the selected violation is the first refusal');
      assert.equal(source.failures.length, 1);
    } finally { await source.close(); }
  }

  // Exact native V2 wire suffix; this controlled input does not grant Host preparation.
  const nativeSuffix = { role: 'assistant', content: `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.` };
  const ordinary = { role: 'user', content: 'Reply only OK. Do not use tools, access files or run commands.' };
  for (const suffix of [undefined, nativeSuffix]) {
    const host = await startRetainedOpenCodeModel();
    let preparation: ReturnType<typeof host.armHostPreparation> | undefined;
    try {
      preparation = host.armHostPreparation('TEST-coexist-launch-once');
      const messages = [{ role: 'system', content: 'TEST original no-tool system message' }, ordinary,
        ...(suffix ? [suffix] : [])];
      const result = await request(host.url, { model: 'TEST-model', tools: [], messages },
        '/host/v1/chat/completions');
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.text).choices[0].message.content, 'OK');
      assert.equal(preparation.consumed, 1);
      assert.deepEqual(host.observations, [{ owner: 'host', marker: null, tools: [],
        preparationCommandId: 'TEST-coexist-launch-once' }]);
      assert.deepEqual([...host.markers], []);
      assert.deepEqual(host.failures, []);
    } finally { preparation?.disarm(); await host.close(); }
  }
  const nativeSource = await startRetainedOpenCodeModel({ sourceSelection: true });
  try {
    const result = await request(nativeSource.url, { model: 'TEST-model', tools: [],
      messages: [ordinary, nativeSuffix] }, '/host/v1/chat/completions');
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).choices[0].message.content, 'OK');
    assert.deepEqual(nativeSource.observations, [{ owner: 'host', marker: null, tools: [], sourcePreflight: true }]);
    assert.deepEqual([...nativeSource.markers], []);
    assert.deepEqual(nativeSource.failures, []);
  } finally { await nativeSource.close(); }
  for (const messages of [
    [ordinary, { ...nativeSuffix, content: nativeSuffix.content + '\n' }],
    [nativeSuffix, ordinary],
    [ordinary, { ...nativeSuffix, tool_calls: [] }],
  ]) {
    const host = await startRetainedOpenCodeModel();
    let preparation: ReturnType<typeof host.armHostPreparation> | undefined;
    try {
      preparation = host.armHostPreparation('TEST-coexist-launch-once');
      const result = await request(host.url, { model: 'TEST-model', tools: [], messages },
        '/host/v1/chat/completions');
      assert.equal(result.status, 500);
      assert.equal(preparation.consumed, 0);
      assert.deepEqual(host.observations, []);
      assert.equal(host.failures.length, 1);
    } finally { preparation?.disarm(); await host.close(); }
  }
});
