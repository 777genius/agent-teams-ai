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
// Keep credential copies private; an unconfirmed goal Host close retains this owned tree.
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
let goalRun;
let goalWorkRemoved = false;
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
    if (scenario === 'autonomous-goal') {
      console.error('\n' + signal + ': requesting original Host cleanup within the existing wall deadline...');
      goalRun?.requestStop(signal);
      return;
    }
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
    // No numeric-PGID adoption after the captured leader exits. Detached native
    // custody is never inferred from this group, even on an exception path.
    goalRun?.killCapturedGroup();
    return;
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

// Run the goal's node:test file directly in its captured leader. Node's --test
// launcher installs a termination handler that would cut short Host disposal,
// even with --test-isolation=none. Ordinary suggestions keep their launcher.
const goalWallMs = 960_000;
const goalCleanupMs = scenario === 'autonomous-goal'
  ? (await import('../../../packages/legacy-agent-host/dist/contracts.js')).TEAM_HOST_DISPOSE_TIMEOUT_MS + 2_000 + 12_000
  : 0;
const observeGoalChild = (child) => {
  const start = performance.now();
  let cleanupAt, stopReason, spawnError, groupRetired = false, killed = false;
  child.once('error', error => { spawnError = error.message; });
  const groupState = () => {
    if (groupRetired || !child.pid) return 'absent';
    try { process.kill(-child.pid, 0); return 'present'; }
    catch (error) {
      if (error.code === 'ESRCH') { groupRetired = true; return 'absent'; }
      return 'unknown';
    }
  };
  const requestStop = (reason) => {
    if (cleanupAt !== undefined) return;
    cleanupAt = performance.now();
    stopReason = reason;
    // Only the original test leader receives TERM; it owns the Host's EOF and
    // full captured disposal budget. Repeated signals cannot shorten that budget.
    if (!spawnError && alive(child)) child.kill('SIGTERM');
  };
  const killCapturedGroup = () => {
    if (killed || spawnError || !alive(child) || groupState() !== 'present') return;
    killed = true;
    signalGroup(child, 'SIGKILL');
  };
  const settled = (async () => {
    let observedGroup;
    for (;;) {
      const now = performance.now();
      if (cleanupAt === undefined && now >= start + goalWallMs - goalCleanupMs)
        requestStop('outer-deadline');
      observedGroup = groupState();
      if (spawnError || !alive(child)) {
        // A leader exit is not proof that its attached Host has exited.
        cleanupAt ??= now;
        if (observedGroup === 'absent') break;
      }
      const until = Math.min(start + goalWallMs, cleanupAt === undefined
        ? start + goalWallMs - goalCleanupMs : cleanupAt + goalCleanupMs);
      if (now >= until) {
        killCapturedGroup();
        observedGroup = groupState();
        break;
      }
      await sleep(Math.max(1, Math.min(100, until - now)));
    }
    // On an unknown hard-boundary outcome, retaining this handle must not extend
    // the wall budget. A late private receipt cannot overwrite the public FAIL.
    child.unref();
    return { code: child.exitCode, signal: child.signalCode, spawnError,
      deadlineExpired: stopReason === 'outer-deadline', stopReason,
      processGroupObservedAbsent: observedGroup === 'absent', hardKillRequested: killed,
      originalLeaderExitObserved: !!spawnError || !alive(child) };
  })();
  return { requestStop, killCapturedGroup, settled };
};
if (interrupted) {
  removeWork();
  process.exit(130);
}
const runs = vendors.map((vendor) => {
  const receipt = join(receiptDir, stamp + '-' + (scenario === 'autonomous-goal' ? 'autonomous-goal-' : '') + vendor + '.json');
  const childReceipt = scenario === 'autonomous-goal' ? join(work, vendor + '.receipt.json') : receipt;
  const logPath = join(work, vendor + '.log');
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [...(scenario === 'autonomous-goal' ? [] : ['--test']), '--test-reporter=spec', scenario === 'autonomous-goal'
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
        REAL_RECEIPT: childReceipt,
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
  if (scenario === 'autonomous-goal') {
    goalRun = observeGoalChild(child);
    return goalRun.settled.then(result => ({ vendor, ...result, receipt, childReceipt, logPath }));
  }
  return new Promise((done) => {
    const finish = (code, signal, spawnError) => done({ vendor, code, signal, spawnError,
      receipt, childReceipt, logPath });
    child.once('error', (error) => finish(null, null, error.message));
    child.once('exit', (code, signal) => finish(code, signal));
  });
});

const results = await Promise.all(runs);
// A signal already started the shutdown (which exits 130); do not report half-killed runs as results.
if (interrupted && scenario !== 'autonomous-goal') await new Promise(() => {});
const writeReceipt = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const sanitizeLog = scenario === 'autonomous-goal'
  ? (await import('../../../packages/legacy-agent-host/dist/diagnostics/runtimeDiagnosticText.js')).sanitizeRuntimeDiagnosticText
  : undefined;
const rows = results.map(({ vendor, code, signal, spawnError, deadlineExpired, stopReason,
  processGroupObservedAbsent, hardKillRequested, originalLeaderExitObserved, receipt, childReceipt, logPath }) => {
  let data;
  try {
    data = JSON.parse(readFileSync(childReceipt, 'utf8'));
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
    Object.assign(data, { outerDeadlineMs: goalWallMs, hostCleanupAllowanceMs: goalCleanupMs,
      processGroupObservedAbsent, originalLeaderExitObserved, hardKillRequested, stopReason });
    if (deadlineExpired || interrupted || code !== 0 || signal || spawnError) {
      if (data.reason) data.testReason = data.reason;
      Object.assign(data, { status: 'fail', reason: deadlineExpired
        ? 'The outer autonomous-goal process deadline expired; original native cleanup was required.'
        : interrupted ? 'The autonomous-goal run was interrupted; original Host cleanup was required.'
          : 'The autonomous-goal test process did not exit successfully.' });
    }
    if (data.hostCleanupConfirmed !== true || !processGroupObservedAbsent) {
      data.testReason ??= data.reason;
      data.status = 'fail';
      data.runnerCleanupReason = data.hostCleanupConfirmed !== true
        ? 'Original Host cleanup is unconfirmed; detached native custody remains unknown.'
        : 'The original test process group was not observed absent within the cleanup budget.';
      data.reason ??= data.runnerCleanupReason;
    }
    writeReceipt(receipt, data);
  }
  return { vendor, data, receipt, logPath };
});
// Only the original Host receipt proves native cleanup. Group absence separately
// protects the attached test scope; neither one substitutes for the other.
if (scenario === 'autonomous-goal') {
  const removable = rows.every(row => row.data.hostCleanupConfirmed === true &&
    row.data.processGroupObservedAbsent === true);
  if (removable) {
    try { removeWork(); goalWorkRemoved = true; }
    catch { /* The failing cleanup fact is recorded below. */ }
  }
  for (const row of rows) {
    row.data.privateWorkRemoved = goalWorkRemoved;
    if (!goalWorkRemoved) {
      row.data.status = 'fail';
      row.data.runnerCleanupReason ??= 'Private TEST work was retained because cleanup is unconfirmed.';
      row.data.reason ??= row.data.runnerCleanupReason;
      row.data.retainedPrivateWork = work;
    }
    writeReceipt(row.receipt, row.data);
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
if (interrupted) process.exit(130);
if (statuses.includes('fail')) process.exit(1);
if (statuses.includes('inconclusive')) process.exit(flag('--strict') ? 1 : 3);
process.exit(0);
