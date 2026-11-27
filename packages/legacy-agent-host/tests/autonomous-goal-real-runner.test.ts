// Synthetic process-boundary tests only: no Host allocation, vendor, account or inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(check: () => Promise<boolean>, label: string) {
  const end = performance.now() + 8_000;
  while (performance.now() < end) { if (await check()) return; await delay(20); }
  assert.fail(label);
}
async function exists(path: string) { return readFile(path).then(() => true, () => false); }
const parsed = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX captured-process-group runner' : false };

async function fixture(t: TestContext, body: string) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-goal-runner-cleanup-'));
  const repo = join(root, 'repo'), host = join(repo, 'packages/legacy-agent-host');
  const runner = join(repo, 'scripts/e2e/native-prompt-suggestions-real/run.mjs');
  const receipts = join(root, 'receipts'), temporary = join(root, 'tmp');
  const clock = join(root, 'clock'), signals = join(root, 'signals');
  for (const path of [dirname(runner), join(host, 'tests'), join(host, 'node_modules'), receipts, temporary])
    await mkdir(path, { recursive: true });
  await copyFile(resolve(import.meta.dirname, '../../../scripts/e2e/native-prompt-suggestions-real/run.mjs'), runner);
  await symlink(resolve(import.meta.dirname, '../dist'), join(host, 'dist'), 'dir');
  await writeFile(join(repo, 'package.json'), '{"type":"module"}');
  await writeFile(clock, '0');
  const preload = join(root, 'clock.mjs');
  await writeFile(preload, `
    import { appendFileSync, readFileSync } from 'node:fs';
    if (process.env.REAL_GOAL_GO !== '1') {
      const now = performance.now.bind(performance);
      Object.defineProperty(performance, 'now', { value: () =>
        now() + Number(readFileSync(process.env.TEST_RUNNER_CLOCK, 'utf8')) });
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (signal !== 0) appendFileSync(process.env.TEST_RUNNER_SIGNALS,
          JSON.stringify({ pid, signal }) + '\\n');
        return kill(pid, signal);
      };
    }
  `);
  await writeFile(join(host, 'tests/autonomous-goal-real.real.ts'), `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { test } from 'node:test';
    const marker = name => process.env.TEST_RUNNER_ROOT + '/' + name;
    const receipt = (extra = {}) => writeFileSync(process.env.REAL_RECEIPT, JSON.stringify({
      scenario: 'autonomous-goal', status: 'pass', hostCleanupConfirmed: true,
      childPid: process.pid, ...extra
    }));
    test('synthetic process boundary, never native qualification', { timeout: 10_000 }, async () => {
      ${body}
    });
  `);
  let output = '';
  const child = spawn(process.execPath, ['--import', preload, runner, '--scenario', 'autonomous-goal',
    '--vendor', 'codex', '--strict', '--no-build'], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: temporary, REAL_RECEIPT_DIR: receipts, REAL_GOAL_GO: '',
      TEST_RUNNER_ROOT: root, TEST_RUNNER_CLOCK: clock, TEST_RUNNER_SIGNALS: signals },
  });
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', chunk => { output += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  let exitObserved = false;
  void exited.then(() => { exitObserved = true; });
  t.after(async () => {
    if (!exitObserved) {
      // Advance only this fake runner's clock, then request its existing bounded
      // cleanup. The test never discovers or adopts a native process.
      await writeFile(clock, '2000000');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, child, exited, clock, signals, output: () => output,
    async result() {
      const exit = await exited;
      const names = (await readdir(receipts)).filter(name => name.endsWith('.json'));
      assert.equal(names.length, 1, output);
      const path = join(receipts, names[0]!);
      return { exit, path, data: await parsed(path) };
    } };
}

test('real runner requires explicit Host cleanup even for a zero-exit synthetic PASS', posixOnly, async t => {
  const f = await fixture(t, "receipt({ hostCleanupConfirmed: false });");
  const { exit, data } = await f.result();
  assert.equal(exit.code, 1);
  assert.equal(data.status, 'fail');
  assert.equal(data.processGroupObservedAbsent, true);
  assert.equal(data.privateWorkRemoved, false);
  assert.match(String(data.runnerCleanupReason), /custody remains unknown/);
  assert.ok(String(data.retainedPrivateWork).startsWith(f.root + '/tmp/'));
  assert.equal(f.output().includes('PASS  codex'), false);
});

test('real runner accepts a clean synthetic receipt only after the original child exits', posixOnly, async t => {
  const f = await fixture(t, "receipt();");
  const { exit, data } = await f.result();
  assert.equal(exit.code, 0);
  assert.equal(data.status, 'pass');
  assert.equal(data.hostCleanupConfirmed, true);
  assert.equal(data.processGroupObservedAbsent, true);
  assert.equal(data.privateWorkRemoved, true);
  assert.equal(data.outerDeadlineMs, 960_000);
  assert.equal(data.hostCleanupAllowanceMs, 74_000);
  assert.ok(f.output().includes('(pid ' + data.childPid + ')'),
    'the one test body runs in the captured process leader, without a second test worker');
});

test('repeated runner signals preserve delayed cleanup, primary failure and bounded redacted diagnostics', posixOnly, async t => {
  const f = await fixture(t, `
    let close;
    const closed = new Promise(resolve => { close = resolve; });
    let requested = false;
    let signalCount = 0;
    const begin = () => {
      writeFileSync(marker('signal-count'), String(++signalCount));
      if (requested) return;
      requested = true;
      writeFileSync(marker('closing'), String(Date.now()));
      setTimeout(() => {
        writeFileSync(marker('closed'), String(Date.now()));
        receipt({ status: 'fail', reason: 'original synthetic failure', primaryReason: 'original synthetic failure' });
        close();
      }, 400);
    };
    process.on('SIGTERM', begin);
    process.on('SIGINT', begin);
    writeFileSync(marker('ready'), 'ready');
    console.error('Authorization: Bearer TEST-SHOULD-NOT-SURVIVE');
    await closed;
    process.off('SIGTERM', begin);
    process.off('SIGINT', begin);
    assert.fail('original synthetic failure');
  `);
  await until(() => exists(join(f.root, 'ready')), 'synthetic child reached its captured signal handler');
  f.child.kill('SIGTERM');
  await until(() => exists(join(f.root, 'closing')), 'cleanup starts from the first signal');
  f.child.kill('SIGINT');
  const { exit, data } = await f.result();
  assert.equal(exit.code, 130);
  assert.equal(data.status, 'fail');
  assert.equal(data.primaryReason, 'original synthetic failure');
  assert.equal(data.testReason, 'original synthetic failure');
  assert.equal(data.hostCleanupConfirmed, true);
  assert.equal(data.privateWorkRemoved, true);
  const elapsed = Number(await readFile(join(f.root, 'closed'), 'utf8')) -
    Number(await readFile(join(f.root, 'closing'), 'utf8'));
  assert.ok(elapsed >= 380, 'repeated signals did not cut short physical cleanup');
  assert.equal(await readFile(join(f.root, 'signal-count'), 'utf8'), '1',
    'the original leader receives one cleanup request');
  assert.equal((await readFile(f.signals, 'utf8').catch(() => '')).includes('SIGKILL'), false);
  const diagnostic = await readFile(String(data.diagnosticLog), 'utf8');
  assert.equal(diagnostic.includes('TEST-SHOULD-NOT-SURVIVE'), false);
  assert.ok(diagnostic.length <= 16385);
});

test('leader exit cannot end group grace or authorize a later kill; late private PASS cannot replace FAIL', posixOnly, async t => {
  const f = await fixture(t, `
    const helper = spawn(process.execPath, ['-e', \`
      const fs = require('node:fs');
      process.on('SIGTERM', () => fs.writeFileSync(process.env.TEST_RUNNER_ROOT + '/wrong-term', 'signal'));
      setTimeout(() => {
        fs.writeFileSync(process.env.REAL_RECEIPT, JSON.stringify({ status: 'pass', hostCleanupConfirmed: true }));
        fs.writeFileSync(process.env.TEST_RUNNER_ROOT + '/late-private-receipt', 'done');
      }, 1600);
    \`], { stdio: 'ignore' });
    helper.unref();
    receipt({ status: 'fail', hostCleanupConfirmed: false, reason: 'original leader exited before cleanup' });
    writeFileSync(marker('leader-finishing'), 'ready');
  `);
  await until(() => exists(join(f.root, 'leader-finishing')), 'original synthetic leader ran');
  await delay(350);
  assert.equal(f.output().includes('receipt: '), false,
    'the exited leader did not end observation of its still-running attached scope');
  await writeFile(f.clock, '75000');
  const { exit, path, data } = await f.result();
  assert.equal(exit.code, 1);
  assert.equal(data.status, 'fail');
  assert.equal(data.originalLeaderExitObserved, true);
  assert.equal(data.processGroupObservedAbsent, false);
  assert.equal(data.hardKillRequested, false);
  assert.equal(data.privateWorkRemoved, false);
  const publicBefore = await readFile(path, 'utf8');
  await until(() => exists(join(f.root, 'late-private-receipt')), 'attached synthetic process writes its late private receipt');
  assert.equal(await readFile(path, 'utf8'), publicBefore);
  assert.equal((await parsed(join(String(data.retainedPrivateWork), 'codex.receipt.json'))).status, 'pass');
  assert.equal(await exists(join(f.root, 'wrong-term')), false);
  const calls = await readFile(f.signals, 'utf8').catch(() => '');
  assert.equal(calls.includes('SIGKILL'), false, 'no numeric-group adoption after original leader exit');
});

test('fixed wall deadline permits one kill only while the original captured leader is live', posixOnly, async t => {
  const f = await fixture(t, `
    process.on('SIGTERM', () => writeFileSync(marker('term'), 'received'));
    writeFileSync(marker('ready'), 'ready');
    await new Promise(resolve => setTimeout(resolve, 8000));
    receipt();
  `);
  await until(() => exists(join(f.root, 'ready')), 'synthetic original leader is live');
  await writeFile(f.clock, '886100');
  await until(() => exists(join(f.root, 'term')), 'cleanup begins inside the fixed sixteen-minute budget');
  await writeFile(f.clock, '960100');
  const { exit, data } = await f.result();
  assert.equal(exit.code, 1);
  assert.equal(data.status, 'fail');
  assert.equal(data.stopReason, 'outer-deadline');
  assert.equal(data.outerDeadlineMs, 960_000);
  assert.equal(data.hardKillRequested, true);
  assert.equal(data.privateWorkRemoved, false);
  const calls = (await readFile(f.signals, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.signal === 'SIGKILL' && call.pid < 0).length, 1);
  assert.equal(f.output().includes('PASS  codex'), false);
});

