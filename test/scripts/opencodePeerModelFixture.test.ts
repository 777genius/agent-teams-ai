import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createPeerModelFixture } from '../../scripts/e2e/opencode-peer-model-fixture.ts';
import type { PeerAction, PeerCandidate } from '../../scripts/e2e/opencode-peer-model-fixture.ts';
import type { Decision, Json } from '../../scripts/e2e/group-chat-model-server.ts';

const teamName = 'TEST-peer-team';
const nonce = '10000000-0000-4000-8000-000000000001';
const reverseNonce = '10000000-0000-4000-8000-000000000002';
const seedId = '20000000-0000-4000-8000-000000000001';
const challengeId = '30000000-0000-4000-8000-000000000001';
const reportId = '40000000-0000-4000-8000-000000000001';
const ackId = '50000000-0000-4000-8000-000000000001';
const tools = [{ function: { name: 'agent-teams_message_send' } }];
const origin = { teamName, from: 'alice', to: 'user', source: 'runtime_delivery', relayOfMessageId: seedId };
const seedText = 'PEER_SEED:alice:bob:' + nonce;
function prompt(text: string, envelope: Json = origin): Json {
  const ordered = { teamName: envelope.teamName, to: envelope.to, from: envelope.from,
    source: envelope.source, relayOfMessageId: envelope.relayOfMessageId };
  return { role: 'user', content: [
    '<opencode_app_message_delivery>',
    'Required message_send argument envelope: ' + JSON.stringify(ordered) + '. Copy every value exactly.',
    '</opencode_app_message_delivery>',
    '<opencode_inbound_app_message>', text, '</opencode_inbound_app_message>',
  ].join('\n') };
}
function retry(envelope: Json = origin): Json {
  return prompt('<opencode_delivery_retry>\nRetry attempt 2/3 for inbound app messageId "' + seedId + '".\nThe app still has no correlated visible reply proof for this message.\n</opencode_delivery_retry>', envelope);
}
function result(call: Decision, messageId: string, patch: Json = {}): Json {
  const input = call.input!;
  return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({
    deliveredToInbox: true, messageId,
    message: { from: input.from, to: input.to, text: input.text, messageId,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.relayOfMessageId === undefined ? {} : { relayOfMessageId: input.relayOfMessageId }) },
    ...patch,
  }) };
}
function fixture() {
  const candidates = new Map<string, PeerCandidate>([[nonce, { from: 'alice', to: 'bob' }],
    [reverseNonce, { from: 'bob', to: 'alice' }]]);
  const actions = new Map<string, PeerAction>();
  const seedReports = new Map<string, PeerAction>();
  const decide = createPeerModelFixture({ teamName, candidates, actions, seedReports });
  const turn = (...messages: Json[]) => decide({ messages, tools });
  return { candidates, actions, seedReports, turn };
}

test('original seed needs an independent real correlated report after its challenge', () => {
  const f = fixture(), seed = prompt(seedText);
  const challenge = f.turn(seed)!;
  assert.equal(challenge.name, 'agent-teams_message_send');
  assert.deepEqual(challenge.input, { teamName, from: 'alice', to: 'bob', text: 'CHALLENGE:' + nonce });
  assert.deepEqual(f.turn(seed), challenge, 'no tool result does not advance');
  const challengeResult = result(challenge, challengeId);
  const report = f.turn(seed, challengeResult)!;
  assert.notEqual(report.id, challenge.id);
  assert.equal(report.name, challenge.name);
  assert.deepEqual(report.input, { ...origin, text: 'Sent the requested peer challenge CHALLENGE:' + nonce + ' to bob.', summary: 'Peer challenge sent to bob' });
  assert.equal(f.actions.size, 1);
  assert.equal(f.seedReports.size, 0);
  assert.equal(f.candidates.get(nonce)?.seedMessageId, seedId);
  assert.equal(f.turn(seed, challengeResult, result(report, reportId))?.text, '');
  assert.equal(f.actions.size, 1);
  assert.equal(f.seedReports.get('seed-report:' + nonce)?.messageId, reportId);
  assert.equal(f.turn(seed, challengeResult, result(report, reportId))?.name, undefined);
  assert.equal(f.turn(retry())?.name, undefined);
});

test('wrong, missing or changed original envelope cannot borrow a seed', () => {
  const f = fixture();
  for (const envelope of [{ ...origin, teamName: 'TEST-other' }, { ...origin, from: 'bob' },
    { ...origin, to: 'bob' }, { ...origin, source: 'user' }, { ...origin, relayOfMessageId: '' }]) {
    assert.equal(f.turn(prompt(seedText, envelope))?.name, undefined);
  }
  assert.equal(f.turn(prompt('PEER_SEED:bob:alice:' + nonce))?.name, undefined);
  assert.equal(f.turn(prompt('PEER_SEED:alice:bob:' + reverseNonce))?.name, undefined);
  assert.equal(f.candidates.get(nonce)?.seedMessageId, undefined);
  assert.equal(f.turn(prompt(seedText))?.name, 'agent-teams_message_send');
  assert.equal(f.turn(prompt(seedText, { ...origin, relayOfMessageId: 'TEST-changed' }))?.name, undefined);
  assert.equal(f.candidates.get(nonce)?.seedMessageId, seedId);
});

test('only a matching successful physical tool result advances; old and ambiguous results do not', () => {
  const f = fixture(), seed = prompt(seedText), challenge = f.turn(seed)!;
  const ok = result(challenge, challengeId);
  assert.deepEqual(f.turn(ok, seed), challenge, 'result before current user frame is stale');
  assert.deepEqual(f.turn(seed, { ...ok, tool_call_id: 'unrelated' }), challenge);
  for (const bad of [{ ...ok, is_error: true }, result(challenge, challengeId, { deliveredToInbox: false }),
    result(challenge, challengeId, { message: { from: 'bob', to: 'alice', text: 'wrong', messageId: challengeId } }),
    { ...ok, content: 'tool failed' }]) {
    assert.equal(f.turn(seed, bad)?.name, undefined);
    assert.equal(f.actions.size, 0);
  }
  assert.equal(f.turn(seed, ok, ok)?.name, undefined);
  assert.equal(f.actions.size, 0);
  assert.equal(f.turn(retry())?.name, undefined, 'watchdog must not resend an unconfirmed challenge');
  const report = f.turn(seed, ok)!;
  assert.equal(report.input?.to, 'user');
  assert.equal(f.turn(seed, ok, result(report, reportId, { deliveredToInbox: false }))?.name, undefined);
  assert.equal(f.seedReports.size, 0);
});

test('watchdog repairs only the missing report for the captured human input', () => {
  const f = fixture(), seed = prompt(seedText), challenge = f.turn(seed)!;
  const report = f.turn(seed, result(challenge, challengeId))!;
  assert.equal(f.turn(retry({ ...origin, from: 'bob' }))?.name, undefined);
  assert.equal(f.turn(retry({ ...origin, relayOfMessageId: 'TEST-other-seed' }))?.name, undefined);
  assert.deepEqual(f.turn(retry()), report);
  assert.equal(f.actions.size, 1);
  assert.equal(f.turn(retry(), result(report, reportId))?.text, '');
  assert.equal(f.seedReports.size, 1);
  assert.equal(f.turn(retry())?.name, undefined);
});

test('peer challenge and silent ACK retain their own physical origin, not the human report', () => {
  const f = fixture(), seed = prompt(seedText), challenge = f.turn(seed)!;
  f.turn(seed, result(challenge, challengeId));
  const peerOrigin = { teamName, from: 'bob', to: 'alice', source: 'runtime_delivery', relayOfMessageId: challengeId };
  const inbound = prompt('CHALLENGE:' + nonce, peerOrigin);
  assert.equal(f.turn(prompt('CHALLENGE:' + nonce, { ...peerOrigin, relayOfMessageId: 'TEST-other' }))?.name, undefined);
  const ack = f.turn(inbound)!;
  assert.deepEqual(ack.input, { ...peerOrigin, text: 'ACK:' + nonce });
  assert.equal(f.turn(inbound, result(ack, ackId))?.text, '');
  assert.equal(f.actions.size, 2);
  assert.equal(f.seedReports.size, 0);
  assert.equal(f.turn(prompt('ACK:' + nonce, { ...peerOrigin, from: 'alice', to: 'bob', relayOfMessageId: ackId }))?.text, '');
  assert.equal(f.actions.size, 2);
});

test('tool-result content and reminders cannot replace the original user frame', () => {
  const f = fixture(), seed = prompt(seedText), challenge = f.turn(seed)!;
  const ok = result(challenge, challengeId);
  const anthropic = { role: 'user', content: [
    { type: 'tool_result', tool_use_id: challenge.id, content: ok.content },
    { type: 'text', text: '<system-reminder>PEER_SEED:bob:alice:' + reverseNonce + '</system-reminder>' },
  ] };
  assert.equal(f.turn(seed, anthropic)?.input?.to, 'user');
  assert.equal(f.actions.size, 1);
  assert.equal(f.candidates.get(reverseNonce)?.seedMessageId, undefined);
});
