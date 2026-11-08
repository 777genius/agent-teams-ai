import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { verifySelectedProviderArchives } from './packaged-ci-provider-integrity.ts';

const archives = [
  ['@agent-teams/provider-implementations', 'vendor/provider-migration/codex-runtime-mcp-v1/agent-teams-provider-implementations-0.0.0.tgz'],
  ['@agent-teams/provider-session-contracts', 'vendor/provider-migration/finite-claude-custody-v1/agent-teams-provider-session-contracts-0.0.0.tgz'],
] as const;

function fixture(): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'provider-integrity-'));
  const paths: string[] = [];
  let lock = 'lockfileVersion: 9.0\n\npackages:\n';
  for (const [name, path] of archives) {
    const archive = join(root, path);
    mkdirSync(dirname(archive), { recursive: true });
    const bytes = Buffer.from('TEST archive ' + name);
    writeFileSync(archive, bytes);
    paths.push(archive);
    const sha = createHash('sha512').update(bytes).digest('base64');
    lock += "\n  '" + name + "@file:" + path + "':\n    resolution: {integrity: sha512-" + sha + ', tarball: file:' + path + '}\n    version: 0.0.0\n';
  }
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  return { root, paths };
}

test('selected archive bytes match locked SHA-512', (t) => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifySelectedProviderArchives(root));
});

test('each changed archive is rejected even with an unchanged lock', (t) => {
  const { root, paths } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of paths) {
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from('altered')]));
    assert.throws(() => verifySelectedProviderArchives(root), /differs from pnpm lock/);
    writeFileSync(file, original);
  }
});

test('missing, duplicated, malformed and redirected lock entries fail closed', (t) => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'pnpm-lock.yaml');
  const original = readFileSync(file, 'utf8');
  for (const changed of [
    original.replace(archives[0][0], '@invalid/provider'),
    original + original.slice(original.indexOf("  '" + archives[0][0] + '@file:')),
    original.replace('tarball: file:vendor/provider-migration/', 'tarball: file:vendor/other/'),
    original.replace('sha512-', 'sha256-'),
  ]) {
    writeFileSync(file, changed);
    assert.throws(() => verifySelectedProviderArchives(root));
  }
});


test('symlinked provider archive and symlinked parent fail closed with matching bytes', (t) => {
  // Windows symlink creation requires host privileges that are not guaranteed
  // on CI runners. The production guard still runs on every platform.
  if (process.platform === 'win32') {
    t.skip('POSIX symlink fixture; Windows archive integrity is checked separately');
    return;
  }
  const { root, paths } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = paths[0]!;
  const original = readFileSync(archive);

  // A matching digest must not make a symlinked archive acceptable.
  const otherFile = join(root, 'same-bytes.tgz');
  writeFileSync(otherFile, original);
  rmSync(archive);
  symlinkSync(otherFile, archive);
  assert.throws(() => verifySelectedProviderArchives(root), /Unsafe provider archive/);
  rmSync(archive);
  writeFileSync(archive, original);
  assert.doesNotThrow(() => verifySelectedProviderArchives(root));

  // A regular archive reached through a symlinked parent must not escape
  // the selected, canonical vendor directory even when its hash matches.
  const otherDir = join(root, 'outside-vendor');
  mkdirSync(otherDir);
  writeFileSync(join(otherDir, basename(archive)), original);
  rmSync(dirname(archive), { recursive: true, force: true });
  symlinkSync(otherDir, dirname(archive), 'dir');
  assert.throws(() => verifySelectedProviderArchives(root), /Unsafe provider archive/);
});

test('symlinked vendor root cannot relocate correctly hashed locked archives', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink fixture; Windows archive integrity is checked separately');
    return;
  }
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vendor = join(root, 'vendor');
  const elsewhere = join(root, 'relocated-vendor');
  // Before the root guard, both real paths followed this symlink and were
  // compared inside the relocated directory, so identical bytes passed.
  renameSync(vendor, elsewhere);
  symlinkSync(elsewhere, vendor, 'dir');
  assert.throws(() => verifySelectedProviderArchives(root), /Unsafe provider archive root/);
});

test('symlinked provider-migration root cannot relocate locked archives', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink fixture; Windows archive integrity is checked separately');
    return;
  }
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, 'vendor', 'provider-migration');
  const relocated = join(root, 'relocated-provider-migration');
  // Keep vendor itself intact: this independently exercises its child root guard.
  renameSync(original, relocated);
  symlinkSync(relocated, original, 'dir');
  assert.throws(() => verifySelectedProviderArchives(root), /Unsafe provider archive root/);
});
