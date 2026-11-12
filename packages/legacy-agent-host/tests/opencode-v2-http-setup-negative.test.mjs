// TEST-only negative: failed published SDK setup must leave no worker or temp root.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Snapshot published package bytes, not only immediate directory names.
// Follow the two explicitly selected package roots, but never recurse through
// dependency symlinks or outside the selected published package trees.
function snapshotPackageTree(root) {
  const entries = [];
  function visit(directory, relative) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push(['directory', name]);
        visit(path, name);
      } else if (entry.isFile()) {
        entries.push(['file', name, createHash('sha256').update(readFileSync(path)).digest('hex')]);
      } else if (entry.isSymbolicLink()) {
        entries.push(['symlink', name, readlinkSync(path)]);
      } else {
        entries.push(['special', name]);
      }
    }
  }
  visit(root, '');
  return entries;
}

test('published package snapshot detects nested mutation even with unchanged directory entries', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'TEST-v2-package-snapshot-'));
  try {
    const nested = join(fixture, 'nested');
    mkdirSync(nested);
    const file = join(nested, 'entry.mjs');
    writeFileSync(file, 'export const version = 1;\n');
    const before = snapshotPackageTree(fixture);
    writeFileSync(file, 'export const version = 2;\n');
    assert.notDeepEqual(snapshotPackageTree(fixture), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('failed published V2 SDK setup emits HOLD receipt and cleans only its TEST root', () => {
  const head = process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
  assert.match(head ?? '', /^[a-f0-9]{40}$/);
  const fixture = mkdtempSync(join(tmpdir(), 'TEST-v2-http-setup-fixture-'));
  try {
    const isolatedTemp = join(fixture, 'tmp');
    const emptySdkPrefix = join(fixture, 'empty-sdk-prefix');
    const receiptPath = join(fixture, 'failure-receipt.json');
    mkdirSync(isolatedTemp);
    mkdirSync(emptySdkPrefix);
    const before = readdirSync(isolatedTemp);
    assert.deepEqual(before, []);
    const attempt = spawnSync(process.execPath, [
      resolve('packages/legacy-agent-host/tests/opencode-v2-published-http-persist.mjs'),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: isolatedTemp,
        OPENCODE_V2_TEST_SOURCE_HEAD: head,
        OPENCODE_V2_TEST_SDK_PREFIX: emptySdkPrefix,
        OPENCODE_V2_TEST_HTTP_RECEIPT: receiptPath,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(attempt.error, undefined);
    assert.equal(attempt.signal, null);
    assert.notEqual(attempt.status, 0, 'a missing SDK must fail closed');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.kind, 'TEST_V2_HTTP_DURABLE_DISCOVERY');
    assert.equal(receipt.sourceHead, head);
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.modelTurnProven, false);
    assert.equal(receipt.cleanup, true);
    assert.equal(receipt.failure, 'TEST_published_HTTP_persist_unqualified');
    assert.deepEqual(receipt.steps, []);
    assert.deepEqual(readdirSync(isolatedTemp), before,
      'failed setup must leave no TEST server root');
    assert.deepEqual(readdirSync(emptySdkPrefix), [],
      'a failed TEST setup must not write into the shared SDK prefix');
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const [script, receiptVariable, failureKey, failure] of [
  ['opencode-v2-published-http-persist.mjs', 'OPENCODE_V2_TEST_HTTP_RECEIPT',
    'failure', 'TEST_published_HTTP_persist_unqualified'],
  ['opencode-v2-native-instructions.mjs', 'OPENCODE_V2_HOST_NATIVE_RECEIPT',
    'error', 'native_host_test_failed'],
]) {
  test(script + ' records namespace allocation failure before any process exists', () => {
    const head=process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
    assert.match(head??'',/^[a-f0-9]{40}$/);
    const fixture=mkdtempSync(join(tmpdir(),'TEST-v2-no-namespace-'));
    try {
      const receiptPath=join(fixture,'receipt.json');
      const prefix=join(fixture,'empty-prefix');
      mkdirSync(prefix);
      const attempt=spawnSync(process.execPath,[resolve('packages/legacy-agent-host/tests',script)],{
        cwd:process.cwd(),encoding:'utf8',timeout:10_000,
        env:{...process.env,TMPDIR:join(fixture,'missing-temp'),
          OPENCODE_V2_TEST_SOURCE_HEAD:head,OPENCODE_V2_TEST_SDK_PREFIX:prefix,
          [receiptVariable]:receiptPath},
      });
      assert.equal(attempt.error,undefined);
      assert.equal(attempt.signal,null);
      assert.notEqual(attempt.status,0);
      const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
      assert.equal(receipt[failureKey],failure);
      assert.equal(receipt.cleanup,true);
      assert.equal(receipt.qualified,false);
      assert.deepEqual(receipt.steps,[]);
      assert.equal(Object.hasOwn(receipt,'pid'),false);
      assert.deepEqual(readdirSync(prefix),[]);
      assert.equal(existsSync(join(fixture,'missing-temp')),false);
    } finally {rmSync(fixture,{recursive:true,force:true});}
  });
}

test('receipt IO failure preserves the first sanitized setup error and removes its namespace', () => {
  const head=process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
  assert.match(head??'',/^[a-f0-9]{40}$/);
  const fixture=mkdtempSync(join(tmpdir(),'TEST-v2-receipt-io-'));
  try {
    const temp=join(fixture,'tmp');
    const prefix=join(fixture,'empty-prefix');
    mkdirSync(temp);mkdirSync(prefix);
    const attempt=spawnSync(process.execPath,[resolve(
      'packages/legacy-agent-host/tests/opencode-v2-published-http-persist.mjs')],{
      cwd:process.cwd(),encoding:'utf8',timeout:10_000,
      env:{...process.env,TMPDIR:temp,OPENCODE_V2_TEST_SOURCE_HEAD:head,
        OPENCODE_V2_TEST_SDK_PREFIX:prefix,OPENCODE_V2_TEST_HTTP_RECEIPT:fixture},
    });
    assert.equal(attempt.error,undefined);
    assert.notEqual(attempt.status,0);
    assert.match(attempt.stderr,/Error: TEST_published_HTTP_persist_unqualified/);
    assert.doesNotMatch(attempt.stderr,/EISDIR|ENOENT/);
    assert.deepEqual(readdirSync(temp),[]);
  } finally {rmSync(fixture,{recursive:true,force:true});}
});

test('valid published SDK post-copy failure cannot modify its shared prefix', {
  skip: !process.env.OPENCODE_V2_TEST_SDK_PREFIX,
}, () => {
  const head = process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
  assert.match(head ?? '', /^[a-f0-9]{40}$/);
  const prefix = process.env.OPENCODE_V2_TEST_SDK_PREFIX;
  const sdkRoot = join(prefix, 'node_modules', '@opencode', 'sdk');
  const serverRoot = join(prefix, 'node_modules', '@opencode', 'server');
  // Shallow installation layout plus recursive content/digest snapshots of
  // the exact published SDK and server packages used by the worker.
  const shared = [prefix, join(prefix, 'node_modules')];
  const before = {
    layout: shared.map((dir) => readdirSync(dir).sort()),
    packages: [snapshotPackageTree(sdkRoot), snapshotPackageTree(serverRoot)],
  };
  const fixture = mkdtempSync(join(tmpdir(), 'TEST-v2-http-postcopy-fixture-'));
  try {
    const isolatedTemp = join(fixture, 'tmp');
    const receiptPath = join(fixture, 'failure-receipt.json');
    mkdirSync(isolatedTemp);
    const attempt = spawnSync(process.execPath, [
      resolve('packages/legacy-agent-host/tests/opencode-v2-published-http-persist.mjs'),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: isolatedTemp,
        OPENCODE_V2_TEST_SOURCE_HEAD: head,
        OPENCODE_V2_TEST_SDK_PREFIX: prefix,
        OPENCODE_V2_TEST_HTTP_RECEIPT: receiptPath,
        OPENCODE_V2_TEST_ABORT_AFTER_COPY: '1',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(attempt.error, undefined);
    assert.equal(attempt.signal, null);
    assert.notEqual(attempt.status, 0);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.failure, 'TEST_owned_worker_postcopy_failure');
    assert.equal(receipt.sourceHead, head);
    assert.equal(receipt.cleanup, true);
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.modelTurnProven, false);
    assert.match(receipt.testOwnedWorkerCopySha256, /^[a-f0-9]{64}$/);
    assert.ok(receipt.testOwnedWorkerPath.startsWith(isolatedTemp + '/TEST-opencode-v2-persist-'));
    assert.equal(existsSync(receipt.testOwnedWorkerPath), false);
    assert.deepEqual(readdirSync(isolatedTemp), [], 'owned worker root must be removed');
    assert.deepEqual({
      layout: shared.map((dir) => readdirSync(dir).sort()),
      packages: [snapshotPackageTree(sdkRoot), snapshotPackageTree(serverRoot)],
    }, before, 'valid published SDK bytes and layout must survive post-copy failure');
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
