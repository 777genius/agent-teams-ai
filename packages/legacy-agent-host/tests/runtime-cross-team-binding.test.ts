import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../dist/runtime/identity.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../dist/runtime/contracts.js';

import { validateCrossTeamIntent } from '../dist/cross-team/validateCrossTeamIntent.js';
import { crossTeamIntentFingerprint } from '../dist/cross-team/TeamCrossTeamCommands.js';
import { crossTeamPublicOutboxRow } from '../dist/cross-team/crossTeamRecords.js';
import { assertCrossTeamOutboxRowFits, pageCrossTeamOutbox } from '../dist/cross-team/pageCrossTeamOutbox.js';
import { MAX_CROSS_TEAM_ENVELOPE_BYTES } from '../dist/cross-team/contracts.js';
import { effectId } from '../dist/team/identity.js';
import type { CapturedCrossTeamIntent } from '../dist/cross-team/contracts.js';

function crossIntent(text: string): CapturedCrossTeamIntent {
  const side = (teamId: string) => ({
    resourceRef: `TEST-${teamId}-resource`, teamResourceRef: `TEST-${teamId}-team-resource`,
    teamId, teamName: teamId, principalId: 'human', grantRevision: 1, actor: 'user',
    scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId,
      runId: `${teamId}-run`, memberId: null, generation: null },
  });
  const original = {
    commandId: 'TEST-cross-unicode',
    pair: { ownerId: 'TEST-host', ownerRevision: '1', ownerFingerprint: 'a'.repeat(64),
      source: side('alpha'), target: { ...side('beta'),
        recipient: { memberId: 'lead', name: 'lead', runId: 'beta-run', generation: '1' } } },
    request: { fromMember: 'user', text, messageId: 'TEST-cross-unicode',
      conversationId: 'TEST-original-conversation' },
    timestamp: '2026-11-27T00:00:00.000Z',
    targetCommandId: effectId('cross-team-inbox', 'alpha', 'beta', 'TEST-cross-unicode'),
  };
  return { ...original, authorityFingerprint: crossTeamIntentFingerprint(original) };
}

for (const [label, text] of [
  ['40k CJK beyond the old serialized envelope', '漢'.repeat(40_000)],
  ['50k ASCII', 'a'.repeat(50_000)],
  ['50k CJK', '漢'.repeat(50_000)],
  ['50k UTF-16 units of emoji', '😀'.repeat(25_000)],
] as const) test(`cross-Team original intent accepts ${label} without changing its bytes`, () => {
  const intent = crossIntent(text);
  const original = JSON.stringify(intent);
  assert.doesNotThrow(() => validateCrossTeamIntent(intent));
  assert.equal(JSON.stringify(intent), original);
});

/** Keep the semantic50k length while varying only JSON escape overhead. */
function textForSerializedBytes(bytes: number, serialize: (text: string) => string): string {
  const delta = bytes - Buffer.byteLength(serialize('x'.repeat(50_000)), 'utf8');
  const controls = Math.floor(delta / 5), newlines = delta % 5;
  assert.ok(delta >= 0 && controls + newlines <= 50_000);
  const text = '\u0001'.repeat(controls) + '\n'.repeat(newlines) + 'x'.repeat(50_000 - controls - newlines);
  assert.equal(text.length, 50_000);
  assert.equal(Buffer.byteLength(serialize(text), 'utf8'), bytes);
  return text;
}

test('active cross-Team replies preserve captured Runtime binding across property order without selecting a stale generation', () => {
  const binding: RuntimeBinding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'dana-id',
    generation: '1',
  };
  // CrossTeamComposition reconstructs this shape from the authenticated sender.
  const sender = {
    memberId: binding.memberId,
    runId: binding.runId,
    generation: binding.generation,
  };
  const reconstructed = { backendId: binding.backendId, teamId: binding.teamId, ...sender };
  const intent = {
    binding,
    deliveryId: 'TEST-original-delivery',
    inputId: 'TEST-original-delivery',
    messageId: 'TEST-original-cross-message',
    content: 'TEST original cross-Team request',
  };
  const record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config: {
      tenantId: 'TEST-owner',
      projectId: 'TEST-project',
      sessionId: 'TEST-native-session',
      generation: 1,
      configRevision: 'TEST-config',
      requiredCapabilities: ['session.conversation'],
    },
    openFingerprint: 'TEST-open',
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    sessionRef: 'TEST-session',
    inputs: [
      {
        intent,
        fingerprint: deliveryFingerprint(intent),
        operationRef: 'TEST-native-operation',
        phase: 'consumed',
      },
    ],
    interactions: [],
  };
  const entry = { binding };
  let reads = 0,
    current = true,
    sourceAvailable = true;
  const sourceUnavailable = new Error('TEST original Runtime source unavailable');
  // Exercise the public selection method with a controlled owned-session seam;
  // no constructor, endpoint, filesystem, provider or native process is created.
  const subject = Object.create(RuntimeTeamCoordinator.prototype) as RuntimeTeamCoordinator;
  Object.assign(subject, {
    captures: {
      assertAvailable(teamId: string) {
        assert.equal(teamId, binding.teamId);
        if (!sourceAvailable) throw sourceUnavailable;
      },
    },
    entries: new Map([[runtimeDigest(binding), entry]]),
    isCurrent: (candidate: unknown) => current && candidate === entry,
    runtime: {
      readSession(candidate: RuntimeBinding) {
        reads++;
        assert.deepEqual(normalizeBinding(candidate), binding);
        return { record, attached: true };
      },
    },
  });
  assert.deepEqual(
    subject.crossTeamActiveInputs(reconstructed),
    [intent],
    'same captured member input supplies the original reply hint'
  );
  assert.equal(reads, 1);
  const observed = subject.crossTeamActiveInputs(binding);
  observed[0]!.content = 'TEST caller modification';
  assert.equal(
    record.inputs[0]!.intent.content,
    'TEST original cross-Team request',
    'returned immutable delivery is copied'
  );
  assert.deepEqual(subject.crossTeamActiveInputs({ ...reconstructed, generation: '2' }), []);
  assert.equal(reads, 2, 'stale generation never reads a different session');
  current = false;
  assert.deepEqual(subject.crossTeamActiveInputs(reconstructed), []);
  assert.equal(reads, 2, 'revoked captured member remains unavailable');
  current = true;
  sourceAvailable = false;
  assert.throws(() => subject.crossTeamActiveInputs(reconstructed), sourceUnavailable);
  assert.equal(reads, 2, 'unavailable original source is refused before reading a session');
});

test('cross-Team retained intent uses the exact private envelope boundary and preserves hold on malformed old records', () => {
  const serialize = (text: string) => JSON.stringify(crossIntent(text));
  for (const extra of [-1, 0, 1]) {
    const intent = crossIntent(textForSerializedBytes(MAX_CROSS_TEAM_ENVELOPE_BYTES + extra, serialize));
    if (extra > 0) assert.throws(() => validateCrossTeamIntent(intent), { code: 'hold' });
    else assert.doesNotThrow(() => validateCrossTeamIntent(intent));
  }
  assert.throws(() => validateCrossTeamIntent(crossIntent('a'.repeat(50_001))), { code: 'hold' });
  assert.throws(() => validateCrossTeamIntent(crossIntent('\u0001'.repeat(50_000))), { code: 'hold' });
  const changed = crossIntent('TEST original');
  changed.pair.target.recipient.generation = '2';
  assert.throws(() => validateCrossTeamIntent(changed), { code: 'hold' });
});

test('a freshly admitted near-limit row stays whole after growing history needs a signed continuation', () => {
  const rowForText = (text: string) => crossTeamPublicOutboxRow(crossIntent(text));
  const wrapper = { kind: 'cross-team-outbox', rows: [], revision: '0'.repeat(64), nextCursor: null };
  const rowBytes = MAX_CROSS_TEAM_ENVELOPE_BYTES - Buffer.byteLength(JSON.stringify(wrapper)) - 256 - 1;
  const serialize = (text: string) => JSON.stringify(rowForText(text));
  const row = rowForText(textForSerializedBytes(rowBytes, serialize));
  const original = JSON.stringify(row);
  assert.doesNotThrow(() => assertCrossTeamOutboxRowFits(row));
  assert.equal(JSON.stringify(row), original);
  assert.doesNotThrow(() => assertCrossTeamOutboxRowFits(rowForText(textForSerializedBytes(rowBytes - 1, serialize))));
  assert.throws(() => assertCrossTeamOutboxRowFits(rowForText(textForSerializedBytes(rowBytes + 1, serialize))),
    { code: 'invalid' });
  const next = { ...rowForText('TEST next'.repeat(256)), messageId: 'TEST-next-row' };
  const rows = [row, next], options = { key: 'TEST-page-key', authorityFingerprint: 'b'.repeat(64), rows };
  const page = pageCrossTeamOutbox(options);
  assert.deepEqual(page.rows, [row]);
  assert.ok(page.nextCursor);
  const remainder = pageCrossTeamOutbox({ ...options, cursor: page.nextCursor });
  assert.deepEqual(remainder.rows, [next]);
  assert.equal(remainder.nextCursor, null);
  assert.equal(Buffer.byteLength(JSON.stringify(page)) <= MAX_CROSS_TEAM_ENVELOPE_BYTES, true);
  assert.equal(JSON.stringify(rows[0]), original);
});

test('old cross-Team cursor signing, revision and public field order remain the same', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ...crossTeamPublicOutboxRow(crossIntent(String(index).repeat(48_000))),
    messageId: 'TEST-old-' + index,
  }));
  const key = 'TEST-old-key', authorityFingerprint = 'c'.repeat(64);
  // Captured from the exact1e64 published projector and compiled page before P1 changes.
  const revision = '8bf274d44bef25899c0dac51c7d112c9e9e3bec854dd4b27cea527c36f9367b4';
  const cursor = '5.2d49340c2ee243c92f80d1edd01ee549527f36c6a2f0fc651e4319455a181237';
  const first = pageCrossTeamOutbox({ key, authorityFingerprint, rows });
  assert.equal(first.revision, revision);
  assert.equal(first.nextCursor, cursor);
  assert.deepEqual(first.rows, rows.slice(0, 5));
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(hash(first), 'd15dd9838d1058538450b21d4cd43e0205009ee7e240819fa2cfb03e323154ff');
  assert.equal(hash(rows[0]), '6bcfa27c4c38f58bae129e51490cdcd0214ca3210eefbc458f25944d8fb35510');
  const second = pageCrossTeamOutbox({ key, authorityFingerprint, rows, cursor });
  assert.equal(hash(second), 'ada913d01a0004d8a1afc1c4c0ff55f9315eae0d23967ff4c260b5be63f596a0');
  assert.deepEqual(second, {
    kind: 'cross-team-outbox', rows: rows.slice(5), revision, nextCursor: null,
  });
  assert.deepEqual(Object.keys(rows[0]!), [
    'messageId', 'fromTeamResourceRef', 'toTeamResourceRef', 'fromTeamName', 'toTeamName',
    'fromMember', 'toMember', 'conversationId', 'text', 'timestamp', 'chainDepth',
  ]);
});
