import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contextCompactionScript,
  COMPACT_AUTHORIZATION,
  COMPACT_SEED,
  COMPACT_VERIFY,
  COMPACT_FOLLOWUP,
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

test('summary and current-context phases reject unrelated, stale or repeated inputs', () => {
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
});
