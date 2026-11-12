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
});
