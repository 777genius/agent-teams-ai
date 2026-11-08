import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
