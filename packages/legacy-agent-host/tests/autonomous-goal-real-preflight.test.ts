// Real goal preflight boundary with owned fake executables; no vendor/account/inference.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

const run = promisify(execFile);
async function fixture(t: TestContext, version: string) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-goal-native-preflight-'));
  const account = join(root, 'account'), work = join(root, 'work');
  await mkdir(account, { mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  const auth = join(account, 'auth.json');
  await writeFile(auth, '{}', { mode: 0o600 });
  const binary = join(root, 'codex-test.mjs'), marker = join(root, 'account-probed');
  const allocation = join(root, 'unexpected-native-open');
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') console.log('codex-cli ${version}');
else if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  writeFileSync(${JSON.stringify(marker)}, 'owned fake account probe'); console.log('TEST fake account');
} else { writeFileSync(${JSON.stringify(allocation)}, 'unexpected allocation'); process.exitCode = 7; }
`);
  await chmod(binary, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, work, auth, marker, allocation, env: { ...process.env,
    REAL_CODEX_BIN: binary, CODEX_HOME: account, REAL_CODEX_MODEL: 'TEST-fake-model', TMPDIR: root } };
}
const exists = (path: string) => readFile(path).then(() => true, () => false);

test('goal discovery accepts the existing 0.162 policy while ordinary suggestions retain their 0.169 minimum',
  { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false }, async t => {
  const f = await fixture(t, '0.162.0');
  const discovery = new URL('./fixtures/real-vendor/discovery.ts', import.meta.url).href;
  const invoke = async (purpose?: 'autonomous-goal') => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      import { discoverTarget } from ${JSON.stringify(discovery)};
      try {
        const target = await discoverTarget('codex', ${JSON.stringify(purpose)});
        console.log(JSON.stringify({ ok: true, version: target.version }));
      } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, reason: error.message })); }
    `], { env: f.env, timeout: 10_000 });
    return JSON.parse(stdout) as { ok: boolean; version?: string; code?: string };
  };
  const ordinary = await invoke();
  assert.equal(ordinary.ok, false);
  assert.equal(ordinary.code, 'binary-too-old');
  assert.equal(await exists(f.marker), false);
  const goal = await invoke('autonomous-goal');
  assert.deepEqual(goal, { ok: true, version: '0.162.0' });
  assert.equal(await exists(f.marker), true);
  assert.equal(await exists(f.allocation), false);
  assert.equal(await readFile(f.auth, 'utf8'), '{}');
});

test('actual goal preflight refuses unsupported Linux 0.169 before account probing or profile/Host allocation',
  { skip: process.platform !== 'linux' ? 'the unsupported Linux tuple is the regression' : false }, async t => {
  const f = await fixture(t, '0.169.0');
  const receipt = join(f.root, 'receipt.json');
  await run(process.execPath, ['--test-reporter=spec',
    resolve(import.meta.dirname, 'autonomous-goal-real.real.ts')], {
    cwd: resolve(import.meta.dirname, '..'), timeout: 15_000, env: { ...f.env,
      REAL_GOAL_GO: '1', REAL_GOAL_PREFLIGHT_ONLY: '1', REAL_VENDOR: 'codex',
      REAL_RECEIPT: receipt, REAL_WORK_DIR: f.work },
  });
  const data = JSON.parse(await readFile(receipt, 'utf8')) as Record<string, unknown>;
  assert.equal(data.status, 'inconclusive');
  assert.equal(data.reasonCode, 'app-not-built');
  assert.match(String(data.reason), /does not qualify Codex 0\.169\.0 on linux/);
  assert.equal(data.failurePhase, 'provider-discovery');
  assert.equal(data.hostCleanupConfirmed, true);
  assert.equal(data.nativeOpens, undefined);
  assert.equal(await exists(f.marker), false);
  assert.equal(await exists(f.allocation), false);
  assert.deepEqual(await readdir(f.work), []);
  assert.equal(await readFile(f.auth, 'utf8'), '{}');
});

