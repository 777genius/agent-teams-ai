import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { OpenCodeV2CredentialScope } from '../dist/adapters/providers/OpenCodeV2CredentialScope.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-credential-scope-')));
  const home = join(root, 'home'), data = join(root, 'data'), store = join(data, 'opencode');
  for (const path of [home, data, store]) mkdirSync(path, { mode: 0o700 });
  const file = join(store, 'auth.json');
  const selected = { environment: { HOME: home, XDG_DATA_HOME: data }, accountBinding: 'TEST-account' };
  let current = true;
  return {
    root, home, data, store, file,
    scope: () => new OpenCodeV2CredentialScope(selected, 'TEST-provider', () => current),
    write: (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }),
    revoke: () => { current = false; },
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

test('V2 key publication survives a fresh scope, preserves foreign credentials and only rolls back its own entry', t => {
  const f = fixture(); t.after(f.cleanup);
  const foreign = { type: 'oauth', access: 'TEST-foreign-token', refresh: 'TEST-foreign-refresh', expires: 123 };
  f.write({ 'TEST-other': foreign });
  const scope = f.scope(), pending = scope.prepare('TEST-private-key'), after = pending.publish();
  assert.equal(pending.before.isCurrent(), false);
  assert.equal(after.readKey(), 'TEST-private-key');
  assert.equal(f.scope().capture().readKey(), 'TEST-private-key');
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    'TEST-other': foreign, 'TEST-provider': { type: 'api', key: 'TEST-private-key' },
  });
  assert.equal(JSON.stringify(after).includes('TEST-private-key'), false);
  assert.throws(() => pending.publish(), { code: 'held' });
  scope.rollbackPublished('TEST-private-key', after, pending.before);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { 'TEST-other': foreign });
  assert.equal(f.scope().capture().present, false);
});

test('V2 refuses existing V1/auth changes and never overwrites a replacement during rollback', t => {
  const f = fixture(); t.after(f.cleanup);
  const scope = f.scope(), pending = scope.prepare('TEST-private-key');
  f.write({ 'TEST-provider': { type: 'api', key: 'TEST-independent-key' } });
  assert.throws(() => pending.publish(), { code: 'held' });
  assert.throws(() => scope.prepare('TEST-private-key'), { code: 'held' });
  f.write({});
  const own = scope.prepare('TEST-private-key'), published = own.publish();
  f.write({ 'TEST-provider': { type: 'oauth', access: 'TEST-independent-token' } });
  assert.equal(published.isCurrent(), false);
  assert.throws(() => scope.rollbackPublished('TEST-private-key', published, own.before), { code: 'held' });
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    'TEST-provider': { type: 'oauth', access: 'TEST-independent-token' },
  });
  f.write({});
  const alternative = join(f.home, '.local/share/opencode'); mkdirSync(alternative, { recursive: true, mode: 0o700 });
  writeFileSync(join(alternative, 'auth.json'), JSON.stringify({ 'TEST-provider': { type: 'api', key: 'TEST-private-key' } }), { mode: 0o600 });
  assert.throws(() => scope.prepare('TEST-private-key'), { code: 'held' }, 'same key in an independent V1 source is still occupied');
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {});
});

test('captured directories, symlinks and revoked owner cannot change the credential destination', t => {
  for (const mode of ['directory', 'symlink', 'revoked'] as const) {
    const f = fixture(); t.after(f.cleanup);
    f.write({});
    const scope = f.scope(), pending = scope.prepare('TEST-private-key');
    if (mode === 'directory') {
      renameSync(f.store, f.store + '-original'); mkdirSync(f.store, { mode: 0o700 });
      f.write({});
    }
    if (mode === 'symlink') {
      renameSync(f.file, f.file + '-original'); symlinkSync(f.file + '-original', f.file);
    }
    if (mode === 'revoked') f.revoke();
    assert.equal(pending.before.isCurrent(), false, mode);
    assert.throws(() => pending.publish(), { code: 'held' }, mode);
    assert.equal(readFileSync(f.file, 'utf8'), '{}');
  }
});
