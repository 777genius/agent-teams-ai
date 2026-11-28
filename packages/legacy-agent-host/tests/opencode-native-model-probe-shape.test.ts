import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isOpenCodeModelProbe,
  OPENCODE_V2_PROBE_STEP_LIMIT,
} from './fixtures/native-opencode-team/model-probe.ts';

const user = { role: 'user', content: 'Reply only OK. Do not use tools, access files or run commands.' };
const system = { role: 'system', content: 'TEST native environment only' };
const limit = { role: 'assistant', content: OPENCODE_V2_PROBE_STEP_LIMIT };

test('V1 retains its original one-user no-tool probe and rejects V2 assistant context', () => {
  assert.equal(isOpenCodeModelProbe({ messages: [system, user] }), true);
  assert.equal(isOpenCodeModelProbe({ messages: [system, user, limit] }), false);
});

test('V2 recognizes only its measured one-step native envelope around the exact probe input', () => {
  assert.equal(isOpenCodeModelProbe({ messages: [system, user, limit] }, 'v2'), true);
  assert.equal(isOpenCodeModelProbe({ tools: [], messages: [system,
    { ...user, content: [{ type: 'text', text: user.content }] }, limit] }, 'v2'), true);
  for (const messages of [
    [system, user], [system, user, { ...limit, content: limit.content + ' TEST arbitrary history' }],
    [system, user, { ...limit, tool_calls: [] }], [system, user, user, limit],
    [system, { ...user, content: 'OPENCODE_TEAM_ONE' }, limit],
    [system, user, { role: 'assistant', content: 'TEST previous reply' }, limit],
    [system, user, { role: 'tool', content: 'TEST prior execution' }, limit],
  ]) assert.equal(isOpenCodeModelProbe({ messages }, 'v2'), false);
});

test('neither generation treats advertised or malformed tools as a no-tool model probe', () => {
  for (const tools of [null, {}, [{ type: 'function', function: { name: 'TEST_tool' } }]]) {
    assert.equal(isOpenCodeModelProbe({ tools, messages: [system, user] }), false);
    assert.equal(isOpenCodeModelProbe({ tools, messages: [system, user, limit] }, 'v2'), false);
  }
});
