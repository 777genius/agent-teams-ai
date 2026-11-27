#!/usr/bin/env node
// One-command REAL Claude/Codex proof through the original captured Host.
// See README.md. Exit codes: 0 pass, 1 fail, 3 inconclusive (vendor/account/quota, never "green").
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const hostPackage = join(repo, 'packages/legacy-agent-host');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
if (flag('--help') || flag('-h')) {
  console.log([
    'Usage: pnpm test:real:suggestions [--vendor claude|codex|all] [--rounds N] [--no-build] [--strict]',
    '  --scenario autonomous-goal  bounded real lead/member completion + separate Stop (one explicit vendor)',
    '  --preflight  autonomous-goal only: binary/account/disk checks, no inference, exit 3 (not qualified)',
    '  --vendor   which real vendor(s) to prove (default: all, run in parallel)',
    '  --rounds   max conversation turns per member before reporting "vendor silent" (default 6)',
    '  --no-build skip rebuilding the Host (default: rebuild so the proof matches the source)',
    '  --strict   treat inconclusive as failure (CI-like)',
    'Env: REAL_CLAUDE_BIN, REAL_CODEX_BIN (>= 0.169.0), REAL_CLAUDE_MODEL, REAL_CODEX_MODEL, REAL_RECEIPT_DIR',
  ].join('\n'));
  process.exit(0);
}
const scenario = option('--scenario', 'suggestions');
if (!['suggestions', 'autonomous-goal'].includes(scenario) ||
    (flag('--preflight') && scenario !== 'autonomous-goal')) {
  console.error('Use --scenario suggestions|autonomous-goal; --preflight is available only for autonomous-goal.');
  process.exit(2);
}
const wanted = option('--vendor', 'all');
if (!['all', 'claude', 'codex'].includes(wanted)) {
  console.error('--vendor must be claude, codex or all (got ' + wanted + ')');
  process.exit(2);
}
const vendors = wanted === 'all' ? ['claude', 'codex'] : [wanted];
if (scenario === 'autonomous-goal' && vendors.length !== 1) {
  console.error('The bounded autonomous-goal canary requires one explicit --vendor claude|codex per invocation.');
  process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(
    'Node >= 24 is required to run the Host tests (this is ' + process.version + '); try the pinned 24.21.0'
  );
  process.exit(2);
}
if (!existsSync(join(hostPackage, 'node_modules'))) {
  console.error('Dependencies are missing. Run pnpm install first.');
  process.exit(2);
}

const receiptDir = process.env.REAL_RECEIPT_DIR ?? join(homedir(), '.cache/agent-teams-real-e2e');
mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
// Everything holding credential copies lives under one directory that this runner always removes.
const work = mkdtempSync(join(tmpdir(), 'agent-teams-real-e2e-'));
const children = [];
const alive = (child) => child.exitCode === null && child.signalCode === null;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const signalGroup = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
};
const removeWork = () =>
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
let cleaning;
let interrupted = false;
// Stop the original test/Host group before deleting its temporary credential
// copies. Native providers may have detached scopes: only Host cleanup proves
// those released, and an unconfirmed Host close must remain a failing receipt.
const cleanup = () =>
  (cleaning ??= (async () => {
    for (const child of children) if (alive(child)) signalGroup(child, 'SIGTERM');
    for (const until = Date.now() + 20_000; children.some(alive) && Date.now() < until; )
      await sleep(200);
    for (const child of children) signalGroup(child, 'SIGKILL'); // sweeps orphans of an exited leader too
    await sleep(300);
    removeWork();
  })());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    interrupted = true;
    console.error('\n' + signal + ': stopping real runs and removing credential copies...');
    cleanup().then(
      () => process.exit(130),
      (error) => {
        console.error('cleanup failed, remove ' + work + ' manually: ' + error);
        process.exit(130);
      }
    );
  });
// Synchronous last resort (an exception path); the async cleanup above is the normal one.
process.on('exit', () => {
  if (scenario === 'autonomous-goal') {
    for (const child of children) signalGroup(child, 'SIGKILL');
  }
  try {
    removeWork();
  } catch {
    // reported by the explicit cleanup path
  }
});

if (!flag('--no-build')) {
  process.stdout.write('Building the captured Host... ');
  const pnpm = process.env.npm_execpath
    ? { command: process.execPath, prefix: [process.env.npm_execpath] }
    : { command: 'pnpm', prefix: [] };
  const build = spawnSync(
    pnpm.command,
    [...pnpm.prefix, '--filter', '@agent-teams/legacy-agent-host', 'build'],
    { cwd: repo, encoding: 'utf8' }
  );
  if (build.status !== 0) {
    console.log('FAILED');
    console.error((build.stdout + build.stderr).split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
  console.log('ok');
}

const runs = vendors.map((vendor) => {
  const receipt = join(receiptDir, stamp + '-' + (scenario === 'autonomous-goal' ? 'autonomous-goal-' : '') + vendor + '.json');
  const logPath = join(work, vendor + '.log');
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(
    process.execPath,
    ['--test', '--test-reporter=spec', scenario === 'autonomous-goal'
      ? 'tests/autonomous-goal-real.real.ts' : 'tests/native-prompt-suggestions-real.real.ts'],
    {
      cwd: hostPackage,
      // stdio goes to a file: a dead parent pipe (SIGPIPE) must never kill a long vendor run.
      stdio: ['ignore', fd, fd],
      detached: true,
      env: {
        ...process.env,
        REAL_VENDOR_GO: '1',
        REAL_VENDOR: vendor,
        REAL_RECEIPT: receipt,
        REAL_WORK_DIR: work,
        ...(scenario === 'autonomous-goal' ? { REAL_GOAL_GO: '1',
          ...(flag('--preflight') ? { REAL_GOAL_PREFLIGHT_ONLY: '1' } : {}) } : {}),
        ...(option('--rounds') ? { REAL_MAX_ROUNDS: option('--rounds') } : {}),
      },
    }
  );
  closeSync(fd);
  children.push(child);
  console.log('started ' + vendor + ' (pid ' + child.pid + ')');
  let deadlineExpired = false;
  let forcedKill;
  // The outer deadline also covers a stuck RPC, test teardown or an unhandled native child.
  const deadline = scenario === 'autonomous-goal' ? setTimeout(() => {
    deadlineExpired = true;
    signalGroup(child, 'SIGTERM');
    forcedKill = setTimeout(() => signalGroup(child, 'SIGKILL'), 10_000);
  }, 960_000) : undefined;
  return new Promise((done) => {
    const finish = (code, signal, spawnError) => {
      clearTimeout(deadline);
      clearTimeout(forcedKill);
      done({ vendor, code, signal, spawnError, deadlineExpired, receipt, logPath });
    };
    child.once('error', (error) => finish(null, null, error.message));
    child.once('exit', (code, signal) => finish(code, signal));
  });
});

const results = await Promise.all(runs);
// A signal already started the shutdown (which exits 130); do not report half-killed runs as results.
if (interrupted) await new Promise(() => {});
const writeReceipt = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const sanitizeLog = scenario === 'autonomous-goal'
  ? (await import('../../../packages/legacy-agent-host/dist/diagnostics/runtimeDiagnosticText.js')).sanitizeRuntimeDiagnosticText
  : undefined;
const rows = results.map(({ vendor, code, signal, spawnError, deadlineExpired, receipt, logPath }) => {
  let data;
  try {
    data = JSON.parse(readFileSync(receipt, 'utf8'));
  } catch {
    data = { status: 'fail', reason: 'no receipt written (exit ' + code + ')' };
  }
  if (scenario === 'autonomous-goal') {
    // Keep bounded redacted evidence before deleting the TEST tree containing
    // credential copies. Raw native output never survives the owned cleanup.
    try {
      const fd = openSync(logPath, 'r');
      let bytes;
      try {
        const buffer = Buffer.alloc(65536);
        bytes = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
      } finally { closeSync(fd); }
      const diagnosticLog = receipt + '.diagnostic.log';
      writeFileSync(diagnosticLog, (sanitizeLog(bytes.toString('utf8'), 16384) ?? '[No safe diagnostic text]') + '\n', { mode: 0o600 });
      data.diagnosticLog = diagnosticLog;
    } catch { data.diagnosticLogUnavailable = true; }
    data.childExitCode = code;
    data.childSignal = signal;
    data.outerDeadlineMs = 960_000;
    if (deadlineExpired || code !== 0 || signal || spawnError) {
      if (data.reason) data.testReason = data.reason;
      Object.assign(data, { status: 'fail', reason: deadlineExpired
        ? 'The outer autonomous-goal process deadline expired; original native cleanup was required.'
        : 'The autonomous-goal test process did not exit successfully.' });
    }
    writeReceipt(receipt, data);
  }
  return { vendor, data, receipt, logPath };
});
// A goal PASS is printed only after owned process-group and credential-copy cleanup completes.
if (scenario === 'autonomous-goal') {
  try {
    await cleanup();
  } catch {
    for (const row of rows) {
      Object.assign(row.data, { status: 'fail', reason: 'The runner could not confirm owned canary cleanup.' });
      writeReceipt(row.receipt, row.data);
    }
  }
}

const label = { pass: 'PASS', fail: 'FAIL', inconclusive: 'INCONCLUSIVE' };
console.log('');
for (const { vendor, data, receipt, logPath } of rows) {
  const turns = Array.isArray(data.turns) ? data.turns : [];
  const offers = turns.filter((turn) => turn.offered).length;
  const evidence = data.scenario === 'autonomous-goal'
    ? 'completion=' + (data.success?.status ?? 'unproven') + ' stop=' + (data.stop?.status ?? 'unproven') + ' overnight=false'
    : 'turns=' + turns.length + ' offers=' + offers;
  console.log((label[data.status] ?? data.status) + '  ' + vendor + '  ' +
    (data.version ? 'v' + data.version + ' ' : '') + (data.model ?? '') + '  ' +
    (((data.durationMs ?? 0) / 1000) | 0) + 's  ' + evidence);
  if (data.reason) console.log('      reason: ' + data.reason);
  for (const turn of turns.filter((candidate) => candidate.offered))
    console.log('      suggestion (' + turn.member + ', round ' + turn.round + '): ' + JSON.stringify(turn.text));
  for (const warning of data.warnings ?? []) console.log('      warning: ' + warning);
  console.log('      receipt: ' + receipt);
  if (scenario !== 'autonomous-goal' && data.status === 'fail' && !existsSync(receipt)) {
    console.log(readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n'));
  }
}
// Keep the receipt directory bounded.
const old = readdirSync(receiptDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .slice(0, -40);
for (const name of old) rmSync(join(receiptDir, name), { force: true });

const statuses = rows.map((row) => row.data.status);
if (scenario !== 'autonomous-goal') await cleanup();
if (statuses.includes('fail')) process.exit(1);
if (statuses.includes('inconclusive')) process.exit(flag('--strict') ? 1 : 3);
process.exit(0);
