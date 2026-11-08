import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import lock from '../managed-git.lock.json' with { type: 'json' };
import { gitExecutable, validateArchiveEntries } from './stage-managed-git.mjs';

test('pinned Git runtime includes every desktop release target and immutable digests', () => {
  assert.deepEqual(Object.keys(lock.assets).sort(), [
    'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64',
  ]);
  assert.equal(lock.tag, 'v2.56.0-2');
  for (const asset of Object.values(lock.assets)) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.match(asset.filename, /^dugite-native-v2\.56\.0-a44aeca-.+\.tar\.gz$/);
  }
});

test('archive path validator rejects traversal and absolute names', () => {
  assert.doesNotThrow(() => validateArchiveEntries(['./bin/git', 'etc/gitconfig', 'libexec/git-core/git-lfs']));
  for (const entry of ['../outside', '/tmp/escape', './bin/../../outside', 'C:/outside', '..\\escape']) {
    assert.throws(() => validateArchiveEntries([entry]), /Unsafe Git archive member/);
  }
});

test('packaged Git entrypoints match Dugite Native native layouts', () => {
  assert.equal(gitExecutable('darwin-arm64', '/bundle'), path.join('/bundle', 'bin', 'git'));
  assert.equal(gitExecutable('linux-x64', '/bundle'), path.join('/bundle', 'bin', 'git'));
  assert.equal(gitExecutable('win32-x64', '/bundle'), path.join('/bundle', 'cmd', 'git.exe'));
  assert.equal(gitExecutable('win32-arm64', '/bundle'), path.join('/bundle', 'cmd', 'git.exe'));
});
