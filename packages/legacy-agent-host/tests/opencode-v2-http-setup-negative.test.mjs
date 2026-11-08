// TEST-only negative: failed published SDK setup must leave no worker or temp root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
