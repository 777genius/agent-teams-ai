import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertCapturedCommandSystem,
  assertNativeReviewExpansion,
  contextCompactionScript,
  COMPACT_AUTHORIZATION,
  COMPACT_SEED,
  COMPACT_VERIFY,
  COMPACT_FOLLOWUP,
  REVIEW_ARGS,
} from './model.ts';
import type { CompactionPhase } from './model.ts';

const request = (text: string) => ({
  model: 'claude-sonnet-4-6',
  system: 'TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1',
  messages: [{ role: 'user', content: text }],
});
const prefix =
  'Internal standing context restored after provider context compaction.\n{"name":"bob"}\nTEST-current-task-id TEST_M10_CURRENT_TASK_AFTER_COMPACT\n';

test('finite localhost script requires original authorization and exact durable prefix; it emits no tools or SPI events', () => {
  let phase: CompactionPhase = 'seed';
  const model = contextCompactionScript({
    phase: () => phase,
    taskId: () => 'TEST-current-task-id',
    preparedInput: () => ({ prefix, originalContent: 'TURN ACTION MODE: ASK\n' + COMPACT_VERIFY }),
  });
  assert.deepEqual(model.respond(request(COMPACT_SEED), []), {
    type: 'text',
    text: `ACK_${COMPACT_SEED}`,
  });
  phase = 'compact';
  assert.equal(
    model.respond(
      {
        ...request(COMPACT_AUTHORIZATION),
        messages: [
          { role: 'assistant', content: `ACK_${COMPACT_SEED}` },
          { role: 'user', content: COMPACT_AUTHORIZATION },
        ],
      },
      []
    ).type,
    'text'
  );
  phase = 'verify';
  assert.equal(
    model.respond(request(prefix + 'TURN ACTION MODE: ASK\n' + COMPACT_VERIFY), [
      'mcp__team__task_get',
    ]).type,
    'text'
  );
  phase = 'followup';
  assert.equal(model.respond(request(COMPACT_FOLLOWUP), []).type, 'text');
  assert.deepEqual(
    model.requests.map((row) => row.phase),
    ['seed', 'compact', 'verify', 'followup']
  );
  assert.throws(() => model.respond(request(COMPACT_FOLLOWUP), []), /bounded/);
});

test('native script rejects unrelated, stale, repeated or unexpanded inputs', () => {
  const model = (phase: CompactionPhase) =>
    contextCompactionScript({
      phase: () => phase,
      taskId: () => 'TEST-current-task-id',
      preparedInput: () => ({
        prefix,
        originalContent: 'TURN ACTION MODE: ASK\n' + COMPACT_VERIFY,
      }),
    });
  assert.throws(() => model('seed').respond(request('unrelated'), []), /explicit original/);
  assert.throws(() => model('compact').respond(request(`ACK_${COMPACT_SEED}`), []), /authorized/);
  assert.throws(
    () => model('compact').respond(request(COMPACT_AUTHORIZATION), []),
    /genuine prior/
  );
  assert.throws(
    () => model('verify').respond(request('TURN ACTION MODE: ASK\n' + COMPACT_VERIFY), []),
    /exact durable/
  );
  assert.throws(
    () =>
      model('verify').respond(
        request(prefix + prefix + 'TURN ACTION MODE: ASK\n' + COMPACT_VERIFY),
        []
      ),
    /one reminder/
  );
  assert.throws(
    () => model('followup').respond(request(prefix + COMPACT_FOLLOWUP), []),
    /not injected again/
  );
  const duplicate = model('seed');
  duplicate.respond(request(COMPACT_SEED), []);
  assert.throws(() => duplicate.respond(request(COMPACT_SEED), []), /duplicate native/);

  const target = `Review target: \`${REVIEW_ARGS}\``;
  const diff = '## Phase 0 — Gather the diff';
  const recipe = `${target}\n\n${diff}`;
  for (const text of [`/review ${REVIEW_ARGS}`, target, `${diff}\n${REVIEW_ARGS}`,
    `Review target: \`TEST-wrong-target\`\n${diff}`])
    assert.throws(() => assertNativeReviewExpansion(request(text)), /native builtin review/);
  assert.throws(() => assertNativeReviewExpansion({ ...request('/review ' + REVIEW_ARGS), system: recipe }),
    /native builtin review/);
  assert.throws(() => assertNativeReviewExpansion({ ...request(''), messages: [
    { role: 'assistant', content: recipe },
  ] }), /native builtin review/);
  assert.throws(() => assertNativeReviewExpansion({ ...request(''), messages: [
    { role: 'user', content: target }, { role: 'user', content: diff },
  ] }), /native builtin review/);
  assertNativeReviewExpansion({ ...request(''), messages: [
    { role: 'user', content: [{ type: 'text', text: recipe }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'TEST-p03-review-tool', content: 'TEST-result' }] },
  ] });
  assert.equal(model('review').respond(request(recipe), ['mcp__team__message_send']).type, 'tool_use');
});

test('named command context refusal exposes only closed marker-location facts', () => {
  const marker = 'TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1';
  const privateText = 'TEST_R15_RAW_PROMPT_MUST_NOT_LEAK';
  const body = {
    system: privateText,
    messages: [
      { role: 'user', content: marker + privateText },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', input: { marker, privateText } }],
      },
      {
        role: privateText + '_role',
        content: [{ type: privateText + '_block', text: marker }],
      },
    ],
  };
  assert.throws(
    () => assertCapturedCommandSystem(body, 'review'),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      const prefix = 'named native command keeps captured team system configuration; ';
      assert.ok(error.message.startsWith(prefix));
      const facts = error.message.slice(prefix.length);
      assert.ok(Buffer.byteLength(facts) <= 2_048);
      assert.equal(facts.includes(privateText), false);
      assert.equal(facts.includes(marker), false);
      assert.deepEqual(JSON.parse(facts), {
        phase: 'review',
        bodySha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        systemSha256: createHash('sha256').update(JSON.stringify(body.system)).digest('hex'),
        systemShape: 'string',
        markerBlocks: {
          user: { text: 1, tool_use: 0, tool_result: 0, other: 0 },
          assistant: { text: 0, tool_use: 1, tool_result: 0, other: 0 },
          system: { text: 0, tool_use: 0, tool_result: 0, other: 0 },
          other: { text: 0, tool_use: 0, tool_result: 0, other: 1 },
        },
      });
      return true;
    }
  );
});
