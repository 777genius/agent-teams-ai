import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapturedPromptSuggestionBinding } from '../dist/composition/createCapturedPromptSuggestionBinding.js';

import type { CapturedPromptSuggestion, CapturedPromptSuggestionNotice } from '../src/composition/createCapturedPromptSuggestionBinding.ts';
import type { MemberEntry } from '../src/composition/MemberEntry.ts';
import type { RuntimeOwner } from '../src/runtime/RuntimeOwner.ts';

const binding = Object.freeze({
  backendId: 'TEST-host', teamId: 'TEST-team-A',
  runId: 'TEST-run-A', memberId: 'TEST-member-A', generation: 'TEST-generation-A',
});
const candidate: CapturedPromptSuggestion = {
  provider: 'claude', sessionRef: 'TEST-session-A',
  inputId: 'TEST-input-A', operationRef: 'TEST-operation-A',
  nativeSessionRef: 'TEST-native-A', text: 'Verify the changes before merging',
};
const original = (phase: string, operationRef = candidate.operationRef) => ({
  phase,
  ...(phase === 'terminal' ? { terminal: 'succeeded' } : {}),
  operationRef,
  intent: {
    binding, inputId: 'TEST-input-A', deliveryId: 'TEST-input-A',
    messageId: 'TEST-message-A', content: 'TEST original human DM',
  },
});
function harness(provider: 'claude' | 'codex' = 'claude') {
  let active = true, human = true, attached = true;
  const rows: Array<ReturnType<typeof original>> = [original('consumed')];
  const snapshot = {
    attached,
    record: {
      nativeReady: true, sealed: false, phase: 'allocated',
      sessionRef: candidate.sessionRef, binding, inputs: rows,
    },
  };
  const notices: CapturedPromptSuggestionNotice[] = [];
  const entry = {
    binding,
    profile: { provider, sessionId: candidate.sessionRef },
    team: {
      definition: { members: [{ memberId: binding.memberId, name: 'alice', role: 'member' }] },
      owner: { isOriginalHumanDirectDelivery: () => human },
    },
  } as unknown as MemberEntry;
  const source = createCapturedPromptSuggestionBinding({
    entry,
    isCurrent: () => active,
    readRuntime: () => ({ ...snapshot, attached }) as unknown as ReturnType<RuntimeOwner['readCapturedSession']>,
    publish: value => { notices.push(value); },
  });
  return {
    source, notices, rows, binding,
    terminal(outcome: 'succeeded' | 'failed' = 'succeeded') {
      rows[0]!.phase = 'terminal';
      (rows[0] as unknown as {terminal: string}).terminal = outcome;
    },
    next(phase: 'claimed' | 'admitted' | 'cancelled') {
      rows.push({ ...original(phase, 'TEST-operation-B'), intent: {
        ...original(phase).intent, inputId: 'TEST-input-B', deliveryId: 'TEST-input-B', messageId: 'TEST-message-B',
      } });
    },
    setCurrent(value: boolean) { active = value; },
    setHuman(value: boolean) { human = value; },
    setAttached(value: boolean) { attached = value; },
  };
}
test('Claude push after result but before Runtime terminal is offered exactly once after existing feed progress', () => {
  const x = harness();
  assert.equal(x.source.eligible(candidate), true);
  x.source.offer(candidate);
  assert.equal(x.notices.length, 0, 'do not publish before durable Runtime terminal');
  x.source.flushPending();
  assert.equal(x.notices.length, 0, 'still awaiting original consumer result');
  x.terminal();
  x.source.flushPending();
  assert.equal(x.notices.length, 1);
  assert.deepEqual({
    teamId: x.notices[0]!.teamId, runId: x.notices[0]!.runId,
    memberId: x.notices[0]!.memberId, generation: x.notices[0]!.generation,
    messageId: x.notices[0]!.messageId,
    operationRef: x.notices[0]!.operationRef,
    completedTurnRef: x.notices[0]!.completedTurnRef,
  }, {
    teamId: binding.teamId, runId: binding.runId,
    memberId: binding.memberId, generation: binding.generation,
    messageId: 'TEST-message-A', operationRef: candidate.operationRef,
    completedTurnRef: candidate.operationRef,
  });
  x.source.flushPending();
  x.source.offer(candidate);
  assert.equal(x.notices.length, 1, 'duplicate late SDK event must be idempotent');
});

test('Codex candidate retains native turn identity and a cancelled never-run UI queue cannot supersede it', () => {
  const x = harness('codex');
  x.terminal();
  x.next('cancelled');
  x.source.offer({ ...candidate, provider: 'codex', nativeTurnRef: 'TEST-real-codex-turn-1' });
  assert.equal(x.notices[0]?.completedTurnRef, 'TEST-real-codex-turn-1');
  assert.equal(x.notices.length, 1);
});

test('later executed turn, changed generation or revoked human source fails closed', () => {
  const x = harness();
  x.source.offer(candidate);
  x.next('claimed');
  x.terminal();
  x.source.flushPending();
  assert.deepEqual(x.notices, [], 'a newer executed native turn revokes previous candidate');
  const y = harness();
  y.source.offer(candidate);
  y.setHuman(false);
  y.terminal();
  y.source.flushPending();
  assert.deepEqual(y.notices, [], 'permission/source withdrawn');
  const z = harness();
  z.source.offer(candidate);
  z.setCurrent(false);
  z.terminal();
  z.source.flushPending();
  assert.deepEqual(z.notices, [], 'restarted/runtime incarnation changed');
});

test('foreign native provider/session, wrong terminal and detached owner never publish', () => {
  const x = harness();
  x.terminal('failed');
  x.source.offer(candidate);
  x.source.offer({ ...candidate, sessionRef: 'TEST-other-session' });
  x.source.offer({ ...candidate, provider: 'codex' });
  assert.equal(x.notices.length, 0);
  const y = harness();
  y.setAttached(false);
  assert.equal(y.source.eligible(candidate), false);
  y.source.offer(candidate);
  assert.equal(y.notices.length, 0);
});
