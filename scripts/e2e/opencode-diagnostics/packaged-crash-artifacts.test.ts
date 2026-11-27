import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectPackagedCrashArtifacts,
  CRASH_ARTIFACT_LIMITS,
} from './packaged-crash-artifacts.ts';

import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  mkdirSync(userData);
  const manifest = { root, userData, platform: 'win32', packaged: true, run: 'cold' };
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, userData, crashes: path.join(userData, 'crashes'), manifest };
}

test('missing and empty original crash directories remain explicit observations', (t) => {
  const f = fixture(t);
  const absent = collectPackagedCrashArtifacts(f.root);
  assert.equal(absent.state, 'absent');
  assert.deepEqual(absent.dumps, []);
  assert.equal(lstatSync(f.userData).isDirectory(), true);
  mkdirSync(f.crashes);
  const empty = collectPackagedCrashArtifacts(f.root);
  assert.equal(empty.state, 'empty');
  assert.deepEqual(empty.dumps, []);
  for (const receipt of [absent, empty])
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(f.root, receipt.outputDirectory!, 'receipt.json'), 'utf8')),
      receipt
    );
});

test('retains the whole stable original dump with its digest, size and source timestamp', (t) => {
  const f = fixture(t);
  const pending = path.join(f.crashes, 'pending');
  mkdirSync(pending, { recursive: true });
  const source = path.join(pending, 'TEST-original.dmp');
  const bytes = Buffer.from('MDMP\0TEST original crash bytes\xff', 'latin1');
  writeFileSync(source, bytes);
  writeFileSync(path.join(pending, 'metadata.json'), 'TEST unrelated metadata');
  const before = lstatSync(source);
  const receipt = collectPackagedCrashArtifacts(f.root);
  assert.equal(receipt.state, 'collected');
  assert.equal(receipt.association, 'original-test-profile-only');
  assert.equal(receipt.dumps.length, 1);
  const dump = receipt.dumps[0]!;
  assert.equal(dump.source, 'pending/TEST-original.dmp');
  assert.equal(dump.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(dump.bytes, bytes.length);
  assert.equal(dump.mtimeMs, before.mtimeMs);
  assert.deepEqual(readFileSync(path.join(f.root, dump.artifact)), bytes);
  assert.deepEqual(readFileSync(source), bytes);
  assert.deepEqual(readdirSync(pending).sort(), ['TEST-original.dmp', 'metadata.json']);
});

test('refuses a crash directory or nested junction pointing outside the original profile', (t) => {
  for (const nested of [false, true]) {
    const f = fixture(t);
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'TEST-foreign-crashes-')));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const source = path.join(outside, 'TEST-private.dmp');
    writeFileSync(source, 'TEST must not be collected');
    if (nested) mkdirSync(f.crashes);
    symlinkSync(outside, nested ? path.join(f.crashes, 'pending') : f.crashes, 'junction');
    const receipt = collectPackagedCrashArtifacts(f.root);
    assert.equal(receipt.state, 'error');
    assert.deepEqual(receipt.dumps, []);
    assert.equal(readFileSync(source, 'utf8'), 'TEST must not be collected');
  }
});

test('reports an oversized dump without copying or truncating any source bytes', (t) => {
  const f = fixture(t);
  mkdirSync(f.crashes);
  const source = path.join(f.crashes, 'TEST-large.dmp');
  writeFileSync(source, 'TEST original');
  truncateSync(source, CRASH_ARTIFACT_LIMITS.fileBytes + 1);
  const receipt = collectPackagedCrashArtifacts(f.root);
  assert.equal(receipt.state, 'over-limit');
  assert.deepEqual(receipt.dumps, []);
  assert.equal(lstatSync(source).size, CRASH_ARTIFACT_LIMITS.fileBytes + 1);
  assert.deepEqual(readdirSync(path.join(f.root, receipt.outputDirectory!)), ['receipt.json']);
});

test('rejects a manifest bound to another root or userData before creating diagnostic output', (t) => {
  for (const field of ['root', 'userData'] as const) {
    const f = fixture(t);
    writeFileSync(
      path.join(f.root, 'manifest.json'),
      JSON.stringify({
        ...f.manifest,
        [field]: path.join(f.root, 'TEST-other-profile'),
      })
    );
    const before = readdirSync(f.root).sort();
    const receipt = collectPackagedCrashArtifacts(f.root);
    assert.equal(receipt.state, 'error');
    assert.equal(receipt.reason, 'misbound-manifest');
    assert.deepEqual(receipt.dumps, []);
    assert.equal(receipt.outputDirectory, undefined);
    assert.deepEqual(readdirSync(f.root).sort(), before);
  }
});
