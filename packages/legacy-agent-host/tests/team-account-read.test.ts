import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { captureTeamAccountRead } from '../dist/composition/captureTeamAccountRead.js';
import { captureRuntimeControlAuthority } from '../dist/composition/runtimeControlAuthority.js';
import { fixture } from './native-member-actions-fixture.ts';

test('one synchronous account inspection shares its Team token while every source and grant read stays fresh', async t => {
  const f = await fixture(t), entry = f.entries.values().next().value!;
  const writer = acquireProfileWriterLease(f.root);
  const lock = join(f.store.directory, 'authority.lock');
  const team = join(f.root, 'teams', entry.team.definition.binding.teamName);
  const credential = join(f.root, 'TEST-account.json');
  fs.writeFileSync(credential, 'TEST-account-A');
  const current = captureRuntimeControlAuthority({ entry, principalId: 'profile-admin',
    assertWriter: () => writer.assertCurrent(), isSealed: () => false });
  const account = captureTeamAccountRead({ entry, principalId: 'profile-admin', assertCurrent: current });
  let publications = 0, namespaceReads = 0, reading = false;
  const tokens: string[] = [], observedFiles: string[] = [];
  const link = fs.linkSync, directories = fs.readdirSync, read = TeamOwnerStore.prototype.read;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === lock) publications++;
    return link(...args);
  });
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === team) namespaceReads++;
    return directories(...args);
  });
  t.mock.method(TeamOwnerStore.prototype, 'read', function<T>(this: TeamOwnerStore, name: string): T | undefined {
    if (reading && this.directory === f.store.directory && name === 'state.json') {
      const [pid, , token] = fs.readFileSync(lock, 'utf8').split('\n');
      assert.equal(pid, String(process.pid));
      assert.match(token!, /^[a-f0-9-]{36}$/);
      tokens.push(token!);
    }
    return (read<T>).call(this, name);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const inspect = () => {
    reading = true;
    try {
      for (let index = 0; index < 6; index++) {
        current();
        observedFiles.push(fs.readFileSync(credential, 'utf8'));
      }
      return observedFiles.at(-1);
    } finally { reading = false; }
  };
  try {
    inspect();
    const baselineReads = namespaceReads, baselineGrants = tokens.length;
    assert.equal(publications, 6);
    assert.equal(new Set(tokens).size, 6);
    publications = 0; namespaceReads = 0; tokens.length = 0; observedFiles.length = 0;
    assert.equal(account(inspect), 'TEST-account-A');
    assert.equal(publications, 2, 'one original prelude fence and one held account fence replace repeated lock publication');
    assert.equal(tokens.length, baselineGrants, 'all original inner state/grant reads remain');
    assert.equal(new Set(tokens).size, 1, 'every nested authority read retains the exact same physical lock');
    assert.ok(namespaceReads > baselineReads, 'nested namespace validation remains, including outer boundary checks');
    assert.equal(observedFiles.length, 6, 'no account read is memoized');
    const previous = tokens[0];
    assert.equal(fs.existsSync(lock), false, 'the account fence ends before returning');
    await Promise.resolve();
    fs.writeFileSync(credential, 'TEST-account-B');
    tokens.length = 0; observedFiles.length = 0;
    assert.equal(account(inspect), 'TEST-account-B');
    assert.equal(new Set(tokens).size, 1);
    assert.notEqual(tokens[0], previous, 'a later invocation captures a new physical token');
    assert.deepEqual(observedFiles, Array(6).fill('TEST-account-B'));
  } finally { writer.release(); }
});

test('the account fence retains the explicitly selected actor instead of substituting the member principal', async t => {
  const f = await fixture(t), entry = f.entries.values().next().value!;
  const account = captureTeamAccountRead({ entry, principalId: 'TEST-other-A-grant', assertCurrent() {} });
  assert.equal(account(() => 'TEST-value'), 'TEST-value');
  f.human.revoke('TEST-other-A-grant');
  assert.equal(f.owner.withLaunchAuthority(entry.profile.principalId, 'read', () => true), true);
  assert.throws(() => account(() => assert.fail('revoked actor cannot inspect an account')), { code: 'forbidden' });
});

test('grant revocation during a held account read refuses its result before release', async t => {
  const f = await fixture(t), entry = f.entries.values().next().value!;
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() {}, isSealed: () => false });
  const account = captureTeamAccountRead({ entry, principalId: entry.profile.principalId, assertCurrent: current });
  assert.throws(() => account(() => {
    current();
    f.human.revoke(entry.profile.principalId);
    return 'TEST-value-must-not-escape';
  }), { code: 'forbidden' });
  assert.equal(fs.existsSync(join(f.store.directory, 'authority.lock')), false);
});

test('a changed namespace during the same held account inspection still fails closed',
  { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t), entry = f.entries.values().next().value!;
    const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
      assertWriter() {}, isSealed: () => false });
    const account = captureTeamAccountRead({ entry, principalId: entry.profile.principalId, assertCurrent: current });
    const changed = join(f.root, 'teams', entry.team.definition.binding.teamName, 'TEST-foreign-link');
    try {
      assert.throws(() => account(() => {
        current();
        fs.symlinkSync(f.root, changed, 'dir');
        return 'TEST-value-must-not-escape';
      }), { code: 'hold' });
    } finally { fs.rmSync(changed, { force: true }); }
    assert.equal(fs.existsSync(join(f.store.directory, 'authority.lock')), false);
  });

test('writer refusal and replaced captured Team cannot publish a new account fence', async t => {
  const f = await fixture(t), entry = f.entries.values().next().value!;
  const original = entry.team, failure = new Error('TEST writer/source revoked');
  let denied = false, checks = 0, publications = 0;
  const account = captureTeamAccountRead({ entry, principalId: 'profile-admin', assertCurrent() {
    checks++;
    if (denied) throw failure;
  } });
  const link = fs.linkSync, lock = join(f.store.directory, 'authority.lock');
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === lock) publications++;
    return link(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  denied = true;
  assert.throws(() => account(() => assert.fail('revoked writer cannot inspect')), error => error === failure);
  assert.equal(checks, 1); assert.equal(publications, 0);
  denied = false; entry.team = { ...original };
  try {
    assert.throws(() => account(() => assert.fail('replacement cannot inspect')), { code: 'forbidden' });
    assert.equal(checks, 1); assert.equal(publications, 0);
  } finally { entry.team = original; }
});
