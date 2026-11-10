import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const moduleUrl = new URL('./windows-native.mts', import.meta.url);
const childOptions = {
  encoding: 'utf8' as const,
  env: { GITHUB_ACTIONS: 'false' },
  timeout: 10_000,
  maxBuffer: 32_768,
};

void test('importing native helpers cannot intercept another controller cleanup CLI', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(moduleUrl.href)}); process.stdout.write('imported');`,
      '--',
      '--cleanup',
      'TEST-missing-cleanup-ownership.json',
    ],
    childOptions
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'imported');
  assert.equal(result.stderr, '');
});

void test('direct native cleanup still rejects a non-GHA invocation before file or native access', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(moduleUrl), '--cleanup', 'TEST-missing-cleanup-ownership.json'],
    childOptions
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /'false' !== 'true'/u);
  assert.equal(result.stdout, '');
});
