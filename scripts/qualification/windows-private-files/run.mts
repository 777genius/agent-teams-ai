import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(directory, 'snapshot-manifest.json'), 'utf8')) as {
  snapshots: { fixture: string; sha256: string }[];
};
assert.equal(manifest.snapshots.length, 2);
for (const snapshot of manifest.snapshots) {
  assert(['fixtures/privateFiles.ts', 'fixtures/windowsPrivateAcl.ts'].includes(snapshot.fixture));
  assert.equal(createHash('sha256').update(readFileSync(path.join(directory, snapshot.fixture))).digest('hex'), snapshot.sha256);
}
const output = mkdtempSync(path.join(tmpdir(), 'filesystem-qualification-build-'));
try {
  const compiler = process.env.FILESYSTEM_QUALIFICATION_COMPILER ?? path.join(directory, 'node_modules/@typescript/native/bin/tsc');
  const types = spawnSync(process.execPath, [compiler, '--noEmit', '-p', path.join(directory, 'tsconfig.json')], { stdio: 'inherit' });
  assert.equal(types.status, 0, 'Strict qualification contracts must typecheck');
  const build = spawnSync(process.execPath, [compiler, '-p', path.join(directory, 'tsconfig.json'), '--outDir', output], { stdio: 'inherit' });
  assert.equal(build.status, 0, 'Exact fixtures must compile');
  const test = spawnSync(process.execPath, ['--test', path.join(output, 'native.test.js')], { stdio: 'inherit' });
  if (test.error) throw test.error;
  process.exitCode = test.status ?? 1;
  if (process.platform !== 'win32') console.log('Native Windows qualification PENDING: Linux executes no ACL tests.');
} finally {
  rmSync(output, { recursive: true, force: true });
}
