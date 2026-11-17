import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { captureRuntimeControlAuthority } from '../dist/composition/runtimeControlAuthority.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import { fixture } from './native-member-actions-fixture.ts';

test('runtime control checks share one real Team lock and reread grant, binding and namespace each time', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const writer = acquireProfileWriterLease(f.root);
  const lock = join(f.store.directory, 'authority.lock');
  const team = join(f.root, 'teams', entry.team.definition.binding.teamName);
  let writerChecks = 0, publications = 0, namespaceTraversals = 0;
  const tokens: string[] = [];
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() {
      writerChecks++;
      assert.equal(fs.existsSync(lock), false, 'writer fence must precede the Team lock');
      writer.assertCurrent();
    }, isSealed: () => false });
  const link = fs.linkSync, directories = fs.readdirSync;
  const read = TeamOwnerStore.prototype.read;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === lock) publications++;
    return link(...args);
  });
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === team) namespaceTraversals++;
    return directories(...args);
  });
  t.mock.method(TeamOwnerStore.prototype, 'read', function<T>(this: TeamOwnerStore, name: string): T | undefined {
    if (this.directory === f.store.directory && name === 'state.json') {
      const [pid, , token] = fs.readFileSync(lock, 'utf8').split('\n');
      assert.equal(pid, String(process.pid));
      assert.match(token!, /^[a-f0-9-]{36}$/);
      tokens.push(token!);
    }
    return (read<T>).call(this, name);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  try {
    current();
    assert.equal(writerChecks, 1);
    assert.equal(publications, 1, 'grant revision and current control share one physical lock publication');
    assert.equal(tokens.length, 3, 'both original grant reads and original binding state read remain fresh');
    assert.equal(new Set(tokens).size, 1, 'all original reads retain the same canonical lock token');
    assert.equal(namespaceTraversals, 3, 'nested control still validates the original namespace');
    assert.equal(fs.existsSync(lock), false);
    const previous = tokens[0]; tokens.length = 0;
    await Promise.resolve();
    current();
    assert.equal(publications, 2);
    assert.equal(tokens.length, 3);
    assert.equal(new Set(tokens).size, 1);
    assert.notEqual(tokens[0], previous, 'a later check acquires a new original lock');
    assert.equal(namespaceTraversals, 6);
    assert.equal(fs.existsSync(lock), false);
    f.store.fenced(() => {
      const state = f.store.read<OwnerState>('state.json')!;
      state.members = state.members.filter(member => member.name !== 'alice');
      f.store.write('state.json', state);
    });
    tokens.length = 0;
    assert.throws(current, { code: 'forbidden' }, 'fresh stored roster refuses a removed runtime member');
    assert.equal(tokens.length, 3);
    assert.equal(fs.existsSync(lock), false);
  } finally { writer.release(); }
});

test('runtime control retains writer, sealed, immutable binding and actual grant refusals before allocation', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const original = entry.binding;
  const writer = acquireProfileWriterLease(f.root);
  let sealed = false, writerFailure: Error | undefined;
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() { if (writerFailure) throw writerFailure; writer.assertCurrent(); },
    isSealed: () => sealed });
  try {
    current();
    const fences = t.mock.method(TeamOwnerStore.prototype, 'fenced');
    const before = fences.mock.callCount();
    writerFailure = new Error('TEST original writer refusal');
    assert.throws(current, error => error === writerFailure);
    writerFailure = undefined;
    sealed = true; assert.throws(current, { code: 'forbidden' }); sealed = false;
    entry.binding = { ...original, generation: 'TEST-replacement' };
    assert.throws(current, { code: 'forbidden' }); entry.binding = original;
    assert.equal(fences.mock.callCount(), before, 'existing early refusals cannot publish a Team lock');
    f.human.revoke(entry.profile.principalId);
    assert.throws(current, { code: 'forbidden' }, 'current persisted grant revocation cannot be cached away');
  } finally { writer.release(); }
});

test('runtime control rejects a changed grant revision even when control permissions remain valid', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() {}, isSealed: () => false });
  current();
  f.store.fenced(() => {
    const state = f.store.read<OwnerState>('state.json')!;
    const grant = state.grants.find(value => value.principalId === entry.profile.principalId)!;
    grant.revision = (grant.revision ?? 1) + 1;
    f.store.write('state.json', state);
  });
  assert.equal(f.owner.authorizeRuntimeAccess(entry.profile.principalId, entry.binding, 'control'), true);
  assert.throws(current, { code: 'forbidden' });
});
