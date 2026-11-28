import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createInstallFailureTracker,
  isRetryableInstallFailure,
} from '../../scripts/ci/install-dependencies-with-retry.mjs';

const installer = fileURLToPath(new URL('../../scripts/ci/install-dependencies-with-retry.mjs', import.meta.url));

function testInstaller(t) {
  const root = mkdtempSync(join(tmpdir(), 'TEST-frozen-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const receipt = join(root, 'argv.ndjson');
  const peer = join(bin, 'TEST-pnpm.mjs');
  writeFileSync(peer, `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TEST_PNPM_RECEIPT, JSON.stringify(process.argv.slice(2)) + '\\n', { mode: 0o600 });
`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = process.platform === 'win32'
    ? '@echo off\r\n"%TEST_PNPM_NODE%" "%~dp0TEST-pnpm.mjs" %*\r\n'
    : '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(peer) + ' "$@"\n';
  writeFileSync(join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), command, { mode: 0o700 });
  // PATH contains only the finite TEST peer: failure cannot select a real installer.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key.toLowerCase() !== 'path' && key !== 'NODE_OPTIONS'));
  Object.assign(env, { PATH: bin, TEST_PNPM_NODE: process.execPath, TEST_PNPM_RECEIPT: receipt });
  return {
    run: args => spawnSync(process.execPath, [installer, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    }),
    rows: () => existsSync(receipt)
      ? readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

test('original frozen install retains its lockfile and selects only the explicit serial lifecycle option', t => {
  const fixture = testInstaller(t);
  for (const args of [[], ['--child-concurrency=1']]) {
    const result = fixture.run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(fixture.rows(), [
    ['install', '--frozen-lockfile'],
    ['install', '--frozen-lockfile', '--child-concurrency=1'],
  ]);
});

test('unknown or duplicate frozen-install options refuse before any TEST installer is allocated', t => {
  const fixture = testInstaller(t);
  for (const args of [['--no-frozen-lockfile'], ['--child-concurrency=1', '--child-concurrency=1']]) {
    const result = fixture.run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported frozen-install option/);
    assert.deepEqual(fixture.rows(), []);
  }
});

test('long unfinished engine warning does not turn a transient 503 into a terminal failure', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stderr', '[WARN] ' + 'x'.repeat(600));
  tracker.observe('stderr', ' Unsupported engine\nERR_PNPM_FETCH_503\n');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: false,
  });
});

test('next fatal engine line is not masked by a prior long warning', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stderr', '[WARN] ' + 'x'.repeat(600) + ' Unsupported engine\n');
  tracker.observe('stderr', 'Unsupported ');
  tracker.observe('stderr', 'engine\nERR_PNPM_FETCH_503');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: true,
  });
});

test('404 marker fragmented across chunks within one stream is terminal', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stderr', 'ERR_PNPM_FETCH_4');
  tracker.observe('stderr', '04\nERR_PNPM_FETCH_503');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: true,
  });
});

test('separate output streams cannot fabricate a 404 marker', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stdout', 'ERR_PNPM_FETCH_4');
  tracker.observe('stderr', '04\n');
  tracker.observe('stdout', '\nERR_PNPM_FETCH_503');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: false,
  });
});

test('whole-output classifier distinguishes long warning from fatal engine', () => {
  assert.equal(isRetryableInstallFailure(
    '[WARN] ' + 'x'.repeat(600) + ' Unsupported engine\nERR_PNPM_FETCH_503'
  ), true);
  assert.equal(isRetryableInstallFailure('Unsupported engine\nERR_PNPM_FETCH_503'), false);
});
