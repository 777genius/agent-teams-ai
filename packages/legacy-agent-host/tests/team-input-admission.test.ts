import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { teamCommandPath } from '../dist/team/commandEntries.js';
import { formatTeamMessage } from '../dist/team/formatTeamMessage.js';
import { captureHostCostCommand } from '../dist/team/hostCostCommand.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { CommandReceipt, TeamCommand } from '../dist/team/contracts.js';
import type { TeamInputPreflight } from '../dist/team/ports.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, inputPreflight?: TeamInputPreflight) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-input-admission-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-input-backend', teamId: 'TEST-input-team', teamName: 'test-input' };
  class InterruptedStore extends TeamOwnerStore {
    failPrepared = false;
    override write(name: string, value: unknown): void {
      super.write(name, value);
      const receipt = value as Partial<CommandReceipt>;
      if (this.failPrepared && receipt.command?.operation === 'message.send' && receipt.phase === 'prepared') {
        this.failPrepared = false;
        throw new Error('TEST prepared original before product');
      }
    }
  }
  const store = new InterruptedStore(root, binding.teamName);
  const options: FilesystemTeamOwnerOptions = {
    root, binding, store,
    members: ['lead', 'alice'].map(name => ({ name, memberId: name + '-id',
      role: name === 'lead' ? 'lead' : 'member',
      delivery: { ...binding, runId: 'TEST-run', memberId: name + '-id', generation: '1' } })),
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'admin'] },
      { principalId: 'alice', memberName: 'alice', permissions: ['read', 'message.write'] },
    ],
    ...(inputPreflight ? { inputPreflight } : {}),
  };
  const owner = createFilesystemTeamOwner(options);
  return { root, binding, store, options, owner, human: owner.connect('human') };
}
function command(commandId: string, text: string): Extract<TeamCommand, { operation: 'message.send' }> {
  return { commandId, operation: 'message.send', payload: { to: 'alice', text } };
}

test('standalone Team refuses known 90k UTF-8 input before any receipt, inbox or outbox', t => {
  const f = fixture(t), input = command('TEST-cjk-default', '界'.repeat(30_000));
  const before = f.store.productFingerprint(f.binding.teamName);
  assert.equal(input.payload.text.length, 30_000);
  assert.equal(Buffer.byteLength(input.payload.text), 90_000);
  assert.throws(() => f.human.execute(input), { code: 'invalid' });
  assert.equal(f.store.read(teamCommandPath(input.commandId)), undefined);
  assert.equal(f.store.productFingerprint(f.binding.teamName), before);
  assert.deepEqual(f.human.pendingDeliveries(), []);
});

test('capable captured preflight retains complete ASCII, Cyrillic, CJK and emoji input bytes', t => {
  for (const [index, text] of ['a'.repeat(50_000), 'Я'.repeat(50_000), '界'.repeat(30_000), '界'.repeat(50_000), '🙂'.repeat(25_000)].entries()) {
    const seen: Parameters<TeamInputPreflight>[0][] = [];
    const f = fixture(t, input => { seen.push(structuredClone(input)); return Buffer.byteLength(input.content) <= 256 * 1024; });
    const input = command('TEST-unicode-' + index, text);
    const receipt = f.human.execute(input);
    assert.equal(receipt.phase, 'completed');
    const intents = f.human.pendingDeliveries();
    assert.equal(intents.length, 1); assert.equal(intents[0]!.content, text);
    assert.ok(seen.length > 0, 'actual Team publication invokes its captured input policy');
    assert.ok(seen.every(value => value.content === text && value.binding.memberId === 'alice-id' && value.binding.generation === '1'));
  }
});

test('the exact rich envelope boundary is checked before publication, with no truncation', t => {
  for (const spare of [-1, 0, 1]) {
    const input = command('TEST-rich-bound', '界'.repeat(300));
    input.payload = { ...input.payload, messageId: input.commandId, actionMode: 'ask', summary: 'Краткое описание',
      taskRefs: [{ taskId: 'TEST-task', displayId: '42', teamName: 'test-input' }] };
    const expected = formatTeamMessage(input.payload, 'user', input.commandId, 'member');
    const limit = Buffer.byteLength(expected) + spare;
    assert.ok(Buffer.byteLength(input.payload.text) < limit);
    const seen: string[] = [];
    const f = fixture(t, value => { seen.push(value.content); return Buffer.byteLength(value.content) <= limit; });
    const before = f.store.productFingerprint(f.binding.teamName);
    if (spare < 0) {
      assert.throws(() => f.human.execute(input), { code: 'invalid' });
      assert.equal(f.store.read(teamCommandPath(input.commandId)), undefined);
      assert.equal(f.store.productFingerprint(f.binding.teamName), before);
      assert.deepEqual(f.human.pendingDeliveries(), []);
    } else {
      assert.equal(f.human.execute(input).phase, 'completed');
      assert.equal(f.human.pendingDeliveries()[0]!.content, expected);
    }
    assert.ok(seen.length > 0); assert.ok(seen.every(value => value === expected));
  }
});

test('completed original replay does not acquire a changed input policy', t => {
  let reject = false, calls = 0;
  const f = fixture(t, input => { calls++; if (reject) throw new Error('TEST new profile unavailable'); return Buffer.byteLength(input.content) <= 256 * 1024; });
  const input = command('TEST-replay-large', '界'.repeat(30_000));
  const receipt = f.human.execute(input), before = f.store.productFingerprint(f.binding.teamName);
  const original = JSON.stringify(f.store.read(teamCommandPath(input.commandId)));
  reject = true; const admittedCalls = calls;
  const cold = createFilesystemTeamOwner(f.options).connect('human');
  assert.deepEqual(cold.execute(input), receipt);
  assert.equal(calls, admittedCalls);
  assert.equal(JSON.stringify(f.store.read(teamCommandPath(input.commandId))), original);
  assert.equal(f.store.productFingerprint(f.binding.teamName), before);
  assert.equal(cold.pendingDeliveries().length, 1);
});

test('a retained original message stays held before product effects when its exact input no longer fits', t => {
  let limit = 256 * 1024;
  const f = fixture(t, input => Buffer.byteLength(input.content) <= limit);
  const input = command('TEST-retained-large', '界'.repeat(30_000));
  f.store.failPrepared = true;
  assert.throws(() => f.human.execute(input), /prepared original/);
  const original = f.human.lookup(input.commandId)!;
  const before = f.store.productFingerprint(f.binding.teamName);
  limit = 64 * 1024;
  assert.throws(() => createFilesystemTeamOwner(f.options).connect('human').execute(input), { code: 'hold' });
  const held = f.human.lookup(input.commandId)!;
  assert.equal(held.phase, 'held'); assert.equal(held.fingerprint, original.fingerprint);
  assert.deepEqual(held.effects, original.effects);
  assert.equal(f.store.productFingerprint(f.binding.teamName), before);
  assert.deepEqual(f.human.pendingDeliveries(), []);
  limit = 256 * 1024;
  const recovered = createFilesystemTeamOwner(f.options).connect('human').execute(input);
  assert.equal(recovered.phase, 'completed'); assert.equal(recovered.fingerprint, original.fingerprint);
  assert.deepEqual(recovered.effects, original.effects);
  assert.equal(f.human.pendingDeliveries()[0]!.content, input.payload.text);
});

test('human inbox replies and Host cost output do not acquire a native input budget', t => {
  const f = fixture(t, () => { assert.fail('product-only output has no native input admission'); });
  const reply = command('TEST-human-reply', '界'.repeat(30_000)); reply.payload.to = 'user';
  assert.equal(f.owner.connect('alice').execute(reply).phase, 'completed');
  const cost = command('TEST-host-cost', '/cost');
  cost.payload = { to: 'lead', text: '/cost', messageId: cost.commandId, nativeCommand: true };
  const { teamName: _teamName, ...binding } = f.options.members[0]!.delivery!;
  assert.equal(f.human.execute(cost, () => captureHostCostCommand({ binding,
    stats: { inputTokens: 7, outputTokens: 5, gaps: [] }, now: 10_000 })).phase, 'completed');
  assert.deepEqual(f.human.pendingDeliveries(), []);
});

test('explicit native slash input is checked from byte zero without a rich-message prefix', t => {
  for (const limit of [7, 8]) {
    const seen: string[] = [];
    const f = fixture(t, input => { seen.push(input.content); return Buffer.byteLength(input.content) <= limit; });
    const input = command('TEST-native-compact', '/compact');
    input.payload = { to: 'lead', text: '/compact', messageId: input.commandId, nativeCommand: true };
    if (limit === 7) {
      assert.throws(() => f.human.execute(input), { code: 'invalid' });
      assert.equal(f.human.lookup(input.commandId), undefined);
      assert.deepEqual(f.human.pendingDeliveries(), []);
    } else {
      assert.equal(f.human.execute(input).phase, 'completed');
      assert.equal(f.human.pendingDeliveries()[0]!.content, '/compact');
    }
    assert.ok(seen.length > 0); assert.ok(seen.every(content => content === '/compact'));
  }
});
