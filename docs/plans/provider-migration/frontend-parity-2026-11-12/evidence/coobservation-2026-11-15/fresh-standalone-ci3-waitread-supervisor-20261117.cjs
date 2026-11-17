'use strict';
// TEST-only, one admitted standalone RED/GREEN attempt; no application or provider launch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const STAGE = '/workspace/scratch/c714-waitread-ci3-controls-20261117';
const SCOPE = '/workspace/scratch/c714-waitread-ci3-20261117';
const NODE = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node';
const WORK = path.join(SCOPE, 'source');
const EVIDENCE = path.join(SCOPE, 'evidence');
const RUNNER = path.join(STAGE, 'waitread-supervisor.cjs');
const BINDING = path.join(STAGE, 'waitread-binding.json');
const ADMISSION = path.join(STAGE, 'execution-admission.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mono = () => process.hrtime.bigint();
const supervisorStarted = mono();
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const identity = data => ({
  bytes: data.length, sha256: sha(data),
  gitBlob: crypto.createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex'),
});
function metadata(p) {
  const s = fs.lstatSync(p, { bigint: true });
  assert(!s.isSymbolicLink(), 'no symlink: ' + p);
  return { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
    device: String(s.dev), inode: String(s.ino), mode: Number(s.mode & 0o777n),
    uid: String(s.uid), gid: String(s.gid), nlink: String(s.nlink), bytes: Number(s.size),
    mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
}
function regular(p, mode = 0o644) {
  const m = metadata(p);
  assert.equal(m.type, 'file'); assert.equal(m.mode, mode); assert.equal(m.nlink, '1');
  return { metadata: m, identity: identity(fs.readFileSync(p)) };
}
function noLinkedAncestors(p) {
  let current = '/';
  for (const part of p.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const m = metadata(current); assert.equal(m.type, 'directory');
  }
  assert.equal(fs.realpathSync(p), p);
}
function census(root) {
  const rows = [];
  function visit(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = prefix ? prefix + '/' + name : name;
      const p = path.join(root, rel), m = metadata(p);
      assert(['file', 'directory'].includes(m.type), 'regular tree only');
      if (m.type === 'directory') {
        assert.equal(m.mode, 0o755); rows.push({ path: rel, metadata: m }); visit(p, rel);
      } else rows.push({ path: rel, ...regular(p) });
    }
  }
  visit(root, ''); return rows;
}
function sourceCensus(files) {
  const rows = census(WORK), actual = rows.filter(r => r.identity);
  assert.deepEqual(actual.map(r => r.path), files.map(f => f.path).sort());
  for (const f of files) assert.deepEqual(actual.find(r => r.path === f.path).identity, f.pin);
  assert.deepEqual(rows.filter(r => !r.identity).map(r => r.path),
    ['scripts', 'scripts/legacy-agent-host']);
  return rows;
}
function exactNode(pin) {
  assert.equal(fs.realpathSync(NODE), NODE);
  const m = metadata(NODE);
  assert.equal(m.type, 'file'); assert.equal(m.mode, 0o755);
  const rawInode = BigInt(m.inode), expectedInode = BigInt(pin.inode);
  assert(rawInode >= -(1n << 63n) && rawInode < (1n << 63n), 'Node signed64 inode');
  assert(expectedInode >= 0n && expectedInode < (1n << 64n), 'Node unsigned64 inode pin');
  const inode = { rawSigned64: m.inode, canonicalUnsigned64: String(BigInt.asUintN(64, rawInode)) };
  assert.equal(inode.canonicalUnsigned64, pin.inode, 'Node inode');
  for (const k of ['device', 'uid', 'gid', 'mtimeNs', 'ctimeNs'])
    assert.equal(m[k], pin[k], 'Node ' + k);
  assert.equal(m.bytes, pin.bytes);
  const digest = sha(fs.readFileSync(NODE)); assert.equal(digest, pin.sha256);
  return { path: NODE, realpath: NODE, metadata: m, inode, sha256: digest };
}
function proc(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const end = raw.lastIndexOf(')'), tail = raw.slice(end + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: tail[0], ppid: Number(tail[1]),
      group: Number(tail[2]), session: Number(tail[3]), start: tail[19] };
  } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return null; throw e; }
}
function ownGroup(group) {
  const rows = [];
  for (const name of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    const p = proc(name);
    if (!p || (p.group !== group && p.session !== group)) continue;
    try {
      const uid = String(fs.statSync('/proc/' + name, { bigint: true }).uid);
      const exe = fs.readlinkSync('/proc/' + name + '/exe');
      const argv = fs.readFileSync('/proc/' + name + '/cmdline').toString().split('\0').filter(Boolean);
      rows.push({ ...p, uid, exe, argv });
    } catch (e) {
      const current = proc(name);
      if (['ENOENT', 'ESRCH'].includes(e.code) && !current) continue;
      rows.push({ ...(current || p), inspectionError: String(e.message) });
    }
  }
  return rows.sort((a, b) => a.pid - b.pid);
}
function admitOwned(row, group, observed) {
  const prior = observed && observed.get(row.pid + ':' + row.start);
  if (row.state === 'Z' && row.inspectionError && prior && !prior.inspectionError) {
    assert.equal(row.group, group); assert.equal(row.session, group); return prior;
  }
  assert.equal(row.group, group); assert.equal(row.session, group);
  assert.equal(row.uid, String(process.getuid())); assert.equal(row.exe, NODE);
  assert(!row.inspectionError, 'complete original process identity required'); return row;
}
function rawWrite(name, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(path.join(EVIDENCE, name), body, { flag: 'wx', mode: 0o644 });
  return identity(body);
}
function parseTap(text, expected) {
  assert(text.startsWith('TAP version 13\n'), 'complete pinned TAP header');
  const matches = [...text.matchAll(/^(not ok|ok) (\d+) - (.+)$/gm)];
  assert.equal(matches.length, 10, 'all ten leaf results, no substitute result');
  const starts = [...text.matchAll(/^# Subtest: (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(starts, expected.map(x => x.title), 'full ordered subtest inventory');
  const rows = matches.map((m, i) => {
    const wanted = expected[i], block = text.slice(m.index, i + 1 < matches.length ? matches[i + 1].index : text.length);
    assert.equal(Number(m[2]), i + 1); assert.equal(m[3], wanted.title);
    const outcome = m[1] === 'ok' ? 'PASS' : 'FAIL'; assert.equal(outcome, wanted.result);
    if (outcome === 'FAIL') {
      assert(/\n\s+failureType: ['"]?testCodeFailure['"]?\s*\n/.test(block));
      assert(/\n\s+code: ['"]?ERR_ASSERTION['"]?\s*\n/.test(block));
      const operator = wanted.signature === 'missing-rejection' ? 'rejects' : 'deepStrictEqual';
      assert(new RegExp('\\n\\s+operator: [\\x27\\x22]?' + operator + '[\\x27\\x22]?\\s*\\n').test(block));
      if (wanted.signature === 'missing-rejection') {
        assert(block.includes('Missing expected rejection.'));
        assert(block.includes('UI read timed out: TEST original generic read deadline; no mutation retry'));
      }
      else {
        assert(block.includes('late values never enter readiness'));
        assert(/\n\s+actual:\s*\n\s+0: false\s*\n/.test(block));
        assert(/\n\s+expected:\s*\n\s+actual:/.test(block));
      }
    }
    return { number: i + 1, title: m[3], outcome, signature: wanted.signature || null };
  });
  assert(!/^Bail out!/m.test(text)); assert(!/^ {1,}(?:not ok|ok) \d+ - /m.test(text));
  for (const [name, count] of Object.entries({
    tests: 10, suites: 0, pass: expected.filter(x => x.result === 'PASS').length,
    fail: expected.filter(x => x.result === 'FAIL').length, cancelled: 0, skipped: 0, todo: 0,
  })) {
    const values = [...text.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
    assert.equal(values.length, 1, 'one complete ' + name + ' counter'); assert.equal(Number(values[0][1]), count);
  }
  assert.equal([...text.matchAll(/^1\.\.10$/gm)].length, 1);
  return rows;
}
let binding, admission, stageBefore, stageRootBefore, scopeCreated = false, active = null, interrupted = null;
const receipt = { schemaVersion: 1, kind: 'TEST-standalone-waitread-original-attempt',
  status: 'NOT_ADMITTED', phases: [], attemptSpent: true, runtimeQualified: false,
  whole149Qualified: false, catalog43Qualified: false, renderer85Qualified: false, wholeE2EQualified: false };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; });
const supervisorTimer = setTimeout(() => { interrupted = 'ORIGINAL_SUPERVISOR_WALL_DEADLINE'; }, 135000);
function assertSupervisorAdmission(label) {
  assert(!interrupted && mono() - supervisorStarted < 135000000000n,
    'original supervisor deadline forbids admission: ' + label);
}
function writeAll(fd, body) {
  let offset = 0;
  while (offset < body.length) { const written = fs.writeSync(fd, body, offset, body.length - offset); assert(written > 0); offset += written; }
}
async function cleanup(phase) {
  if (!active) return;
  const a = active;
  if (a.cleanupStarted === undefined) {
    a.cleanupStarted = mono(); a.cleanupDeadline = a.cleanupStarted + 4000000000n;
  }
  const until = a.cleanupDeadline;
  phase.cleanup ||= { triggered: true, signals: [], originalGroup: a.pid,
    startedMonotonicNs: String(a.cleanupStarted), deadlineMonotonicNs: String(until),
    invocations: 0, unownedMembers: [], snapshots: [] };
  phase.cleanup.invocations++;
  const signalOwned = signal => {
    for (const saved of a.observed.values()) {
      if (mono() >= until) break;
      const current = proc(saved.pid);
      if (!current || current.start !== saved.start) continue;
      if (current.group !== a.pid || current.session !== a.pid) {
        phase.cleanup.escapedOriginal = current; continue;
      }
      if (mono() >= until) break;
      try { process.kill(saved.pid, signal); phase.cleanup.signals.push({ pid: saved.pid, start: saved.start, signal }); }
      catch (e) { if (e.code !== 'ESRCH') phase.cleanup.signalError = String(e.message); }
    }
  };
  try {
    const snapshot = ownGroup(a.pid);
    phase.cleanup.snapshots.push(snapshot);
    phase.cleanup.initialSnapshot ||= snapshot;
    for (const row of snapshot) {
      try { const admitted = admitOwned(row, a.pid, a.observed); a.observed.set(row.pid + ':' + row.start, admitted); }
      catch (e) { phase.cleanup.unownedMembers.push({ process: row, error: String(e.message) }); }
    }
    if (mono() < until && a.termAttemptedAt === undefined) {
      a.termAttemptedAt = mono(); signalOwned('SIGTERM');
    }
    const killAt = a.termAttemptedAt === undefined ? until : a.termAttemptedAt + 250000000n;
    while (mono() < until && mono() < killAt) {
      const remainingNs = (killAt < until ? killAt : until) - mono();
      if (remainingNs > 0n) await sleep(Math.min(25, Math.max(1, Number(remainingNs) / 1e6)));
    }
    if (mono() < until && !a.killAttempted) { a.killAttempted = true; signalOwned('SIGKILL'); }
    while (mono() < until) {
      const rows = ownGroup(a.pid);
      if (a.close && rows.length === 0 && [...a.observed.values()].every(p => {
        const current = proc(p.pid); return !current || current.start !== p.start;
      })) break;
      const remainingNs = until - mono();
      if (remainingNs > 0n) await sleep(Math.min(25, Math.max(1, Number(remainingNs) / 1e6)));
    }
    phase.cleanup.deadlineExpired = mono() >= until;
    phase.cleanup.remaining = ownGroup(a.pid);
    phase.cleanup.close = a.close || null;
    phase.cleanup.originalPidsRemaining = [...a.observed.values()].filter(p => {
      const current = proc(p.pid); return current && current.start === p.start;
    });
    a.child.stdout.destroy(); a.child.stderr.destroy();
    active = null;
  } finally {
    // Preserve the complete captured identities even if cleanup itself fails.
    phase.processIdentities = [...a.observed.values()];
    phase.cleanup.elapsedMs = Number(mono() - a.cleanupStarted) / 1e6;
  }
}
async function phaseRun(plan, files) {
  const phase = { label: plan.label, status: 'STARTED', argv: binding.testArgv,
    cwd: WORK, environment: binding.childEnvironment, sourceBefore: sourceCensus(files), sourceRootBefore: metadata(WORK),
    nodeBefore: exactNode(binding.node), processSamples: [], processIdentities: [], startedAt: new Date().toISOString() };
  receipt.phases.push(phase);
  const before = mono(), deadline = before + BigInt(binding.phaseWallMs) * 1000000n;
  const stdoutPath = path.join(EVIDENCE, plan.label + '.stdout.tap');
  const stderrPath = path.join(EVIDENCE, plan.label + '.stderr.txt');
  const out = fs.openSync(stdoutPath, 'wx', 0o644), err = fs.openSync(stderrPath, 'wx', 0o644);
  let bytes = 0, overflow = false, captureError = null;
  try { assertSupervisorAdmission(plan.label + ' child spawn'); }
  catch (e) {
    phase.status = 'REFUSED_BEFORE_CHILD_ADMISSION'; phase.error = String(e.stack || e);
    fs.closeSync(out); fs.closeSync(err);
    phase.stdout = regular(stdoutPath); phase.stderr = regular(stderrPath);
    phase.elapsedMs = Number(mono() - before) / 1e6; rawWrite(plan.label + '.phase.json', phase);
    throw e;
  }
  const child = spawn(NODE, binding.testArgv, { cwd: WORK, env: binding.childEnvironment,
    detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  active = { child, pid: child.pid, observed: new Map(), close: null, error: null };
  const a = active;
  child.on('error', e => { a.error = String(e.message); });
  child.on('close', (code, signal) => { a.close = { code, signal }; });
  for (const [stream, fd] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => {
    try { writeAll(fd, chunk); bytes += chunk.length; if (bytes > binding.outputLimitBytes) overflow = true; }
    catch (e) { captureError = String(e.message); }
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('error', e => { captureError = String(e.message); });
  try {
    assert(Number.isSafeInteger(a.pid), 'original child pid required');
    const leader = proc(a.pid); assert(leader, 'original child identity required');
    assert.equal(leader.group, a.pid); assert.equal(leader.session, a.pid);
    phase.originalLeader = leader;
    while (!a.close) {
      if (interrupted) throw Error('supervisor interrupted: ' + interrupted);
      if (a.error) throw Error('spawn error: ' + a.error);
      if (captureError) throw Error('raw capture error: ' + captureError);
      if (overflow) throw Error('full raw output exceeded admitted limit');
      if (mono() >= deadline) throw Error('original parent wall deadline expired');
      const rows = ownGroup(a.pid);
      phase.processSamples.push({ elapsedMs: Number(mono() - before) / 1e6, processes: rows });
      for (const row of rows) { const admitted = admitOwned(row, a.pid, a.observed); a.observed.set(row.pid + ':' + row.start, admitted); }
      await sleep(25);
    }
    assert(!interrupted && !a.error && !captureError && !overflow);
    assert(mono() < deadline, 'close observed within original wall bound');
    const remaining = ownGroup(a.pid);
    assert.deepEqual(remaining, [], 'ordinary original detached group exit');
    for (const saved of a.observed.values()) {
      const current = proc(saved.pid); assert(!current || current.start !== saved.start, 'original pid absent');
    }
    assert(a.observed.size >= 1, 'at least original process was observed completely');
    assert(a.observed.has(a.pid + ':' + phase.originalLeader.start), 'complete original leader captured');
    phase.exit = a.close; assert.equal(a.close.signal, null); assert.equal(a.close.code, plan.exitCode);
    phase.cleanup = { triggered: false, ordinaryExit: true, remaining: [], originalPidsRemaining: [] };
    phase.processIdentities = [...a.observed.values()];
    active = null;
    fs.fsyncSync(out); fs.fsyncSync(err);
    phase.stdout = regular(stdoutPath); phase.stderr = regular(stderrPath);
    phase.tests = parseTap(fs.readFileSync(stdoutPath, 'utf8'), plan.tests);
    phase.sourceAfter = sourceCensus(files); assert.deepEqual(phase.sourceAfter, phase.sourceBefore);
    phase.sourceRootAfter = metadata(WORK); assert.deepEqual(phase.sourceRootAfter, phase.sourceRootBefore);
    phase.nodeAfter = exactNode(binding.node); assert.deepEqual(phase.nodeAfter, phase.nodeBefore);
    assert.deepEqual(census(STAGE), stageBefore, 'controls remain unchanged');
    assert.deepEqual(metadata(STAGE), stageRootBefore, 'control root remains unchanged');
    phase.status = plan.label === 'RED' ? 'PASS_EXPECTED_DISCRIMINATOR' : 'PASS_FIXED_STANDALONE10';
  } catch (e) {
    phase.status = 'INCOMPLETE'; phase.error = String(e.stack || e);
    await cleanup(phase);
    try { phase.sourceAfter = sourceCensus(files); phase.sourceRootAfter = metadata(WORK); } catch (x) { phase.sourceAfterError = String(x.message); }
    try { phase.nodeAfter = exactNode(binding.node); } catch (x) { phase.nodeAfterError = String(x.message); }
    throw e;
  } finally {
    fs.closeSync(out); fs.closeSync(err);
    phase.elapsedMs = Number(mono() - before) / 1e6;
    phase.stdout = regular(stdoutPath); phase.stderr = regular(stderrPath);
    rawWrite(plan.label + '.phase.json', phase);
  }
}
async function main() {
  assert.equal(process.argv.length, 4); assert.deepEqual(process.execArgv, []);
  assert.equal(process.execPath, NODE); assert.equal(__filename, RUNNER); assert.equal(process.cwd(), '/');
  assert.deepEqual(Object.keys(process.env), [], 'parent starts with exec -c and no Node environment injection');
  assert(/^[a-f0-9]{64}$/.test(process.argv[2])); assert(/^[a-f0-9]{64}$/.test(process.argv[3]));
  noLinkedAncestors(STAGE); noLinkedAncestors('/workspace/scratch');
  stageRootBefore = metadata(STAGE); assert.equal(stageRootBefore.mode, 0o755);
  stageBefore = census(STAGE); assert.deepEqual(stageBefore.map(r => r.path),
    ['execution-admission.json', 'waitread-binding.json', 'waitread-supervisor.cjs']);
  const rawBinding = fs.readFileSync(BINDING), rawAdmission = fs.readFileSync(ADMISSION);
  assert.equal(sha(rawBinding), process.argv[2]); assert.equal(sha(rawAdmission), process.argv[3]);
  binding = JSON.parse(rawBinding); admission = JSON.parse(rawAdmission);
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.scope, SCOPE); assert.equal(binding.stage, STAGE);
  assert.deepEqual(identity(fs.readFileSync(RUNNER)), binding.runner);
  assert.equal(admission.schemaVersion, 1); assert.equal(admission.verdict, 'ACCEPT_EXACT_CONTROL_PUBLICATION_FOR_ONE_FRESH_STANDALONE_ATTEMPT');
  assert.equal(admission.bindingSha256, sha(rawBinding)); assert.deepEqual(admission.runner, binding.runner);
  assert.equal(admission.sourceCommit, binding.sourceCommit);
  assert.deepEqual(admission.sourceActualGate, binding.sourceActualGate);
  assert.equal(admission.scope, SCOPE); assert.equal(admission.stage, STAGE);
  assert.equal(admission.attemptToken, binding.attemptToken);
  assert.equal(admission.controlParent, binding.sourceCommit);
  for (const k of ['controlCommit', 'controlTree', 'controlDocsTree', 'controlProposal'])
    assert(/^[a-f0-9]{40}$/.test(admission[k]), 'exact actual ' + k);
  for (const k of ['rootActual', 'independentActual']) {
    assert(/^[a-f0-9]{40}$/.test(admission[k].gitBlob));
    assert(/^[a-f0-9]{64}$/.test(admission[k].sha256)); assert(admission[k].bytes > 0);
  }
  assert.equal(admission.fullReadbacksAccepted, true); assert.equal(admission.originalAttemptsStillSpent, true);
  receipt.binding = identity(rawBinding); receipt.admission = identity(rawAdmission);
  receipt.sourceCommit = binding.sourceCommit; receipt.controlCommit = admission.controlCommit;
  receipt.scope = SCOPE; receipt.nodeBefore = exactNode(binding.node); receipt.controlsBefore = stageBefore;
  receipt.controlsRootBefore = stageRootBefore;
  assert.equal(binding.phaseWallMs, 60000); assert.equal(binding.supervisorWallMs, 135000);
  assert.equal(binding.outputLimitBytes, 8 * 1024 * 1024); process.umask(0o022);
  assert.deepEqual(binding.testArgv, ['--test', '--test-reporter=tap', 'scripts/legacy-agent-host/desktop-ui-controls-deadline.test.ts']);
  assert.deepEqual(binding.childEnvironment, { PATH: path.dirname(NODE), LANG: 'C.UTF-8', TZ: 'UTC' });
  assert.deepEqual(binding.phases.map(p => p.label), ['RED', 'GREEN']);
  assertSupervisorAdmission('exclusive new scope');
  fs.mkdirSync(SCOPE, { recursive: false, mode: 0o755 }); scopeCreated = true;
  fs.mkdirSync(WORK, { mode: 0o755 }); fs.mkdirSync(EVIDENCE, { mode: 0o755 });
  rawWrite('admission.json', { binding: receipt.binding, admission: receipt.admission,
    sourceCommit: binding.sourceCommit, controlCommit: admission.controlCommit, node: receipt.nodeBefore });
  for (const file of binding.redFiles) {
    assert(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
    const body = Buffer.from(file.body, 'utf8'); assert.deepEqual(identity(body), file.pin);
    const target = path.join(WORK, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    assertSupervisorAdmission('original source materialization: ' + file.path);
    fs.writeFileSync(target, body, { flag: 'wx', mode: 0o644 });
  }
  assert.deepEqual(binding.redFiles.map(f => f.path).sort(),
    ['package.json', 'scripts/legacy-agent-host/desktop-ui-controls-deadline.test.ts', 'scripts/legacy-agent-host/desktop-ui-controls.ts']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(WORK, 'package.json'), 'utf8')).type, 'module');
  receipt.initialSource = sourceCensus(binding.redFiles); receipt.initialSourceRoot = metadata(WORK);
  assert.equal(receipt.initialSourceRoot.mode, 0o755); receipt.status = 'ADMITTED';
  await phaseRun(binding.phases[0], binding.redFiles);
  assert.equal(receipt.phases[0].status, 'PASS_EXPECTED_DISCRIMINATOR');
  assertSupervisorAdmission('RED to GREEN transition');
  const controls = path.join(WORK, 'scripts/legacy-agent-host/desktop-ui-controls.ts');
  const before = sourceCensus(binding.redFiles);
  assert.deepEqual(before, receipt.phases[0].sourceAfter);
  const fixed = Buffer.from(binding.greenControls.body, 'utf8');
  assert.deepEqual(identity(fixed), binding.greenControls.pin);
  assertSupervisorAdmission('fixed controls open');
  const fd = fs.openSync(controls, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd, { bigint: true }), old = before.find(r => r.path === binding.greenControls.path);
    assert.equal(String(s.ino), old.metadata.inode); assert.equal(String(s.dev), old.metadata.device);
    assert.equal(String(s.nlink), '1');
    assertSupervisorAdmission('fixed controls write');
    writeAll(fd, fixed); fs.ftruncateSync(fd, fixed.length); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const greenFiles = binding.redFiles.map(f => f.path === binding.greenControls.path ? binding.greenControls : f);
  const after = sourceCensus(greenFiles);
  for (const row of before) if (row.path !== binding.greenControls.path)
    assert.deepEqual(after.find(r => r.path === row.path), row, 'only controls may change');
  receipt.transition = { before, after, onlyChangedPath: binding.greenControls.path };
  rawWrite('transition.json', receipt.transition);
  await phaseRun(binding.phases[1], greenFiles);
  receipt.finalSource = sourceCensus(greenFiles);
  assert.deepEqual(receipt.finalSource, receipt.phases[1].sourceAfter);
  receipt.controlsAfter = census(STAGE); assert.deepEqual(receipt.controlsAfter, stageBefore);
  receipt.controlsRootAfter = metadata(STAGE); assert.deepEqual(receipt.controlsRootAfter, stageRootBefore);
  receipt.finalSourceRoot = metadata(WORK); assert.deepEqual(receipt.finalSourceRoot, receipt.initialSourceRoot);
  receipt.nodeAfter = exactNode(binding.node); assert.deepEqual(receipt.nodeAfter, receipt.nodeBefore);
  assert(!interrupted && mono() - supervisorStarted < BigInt(binding.supervisorWallMs) * 1000000n);
  receipt.status = 'PASS_BOUNDED_STANDALONE_RED_GREEN'; receipt.runtimeQualified = true;
}
main().catch(async e => {
  receipt.status = scopeCreated ? 'INCOMPLETE_SPENT' : 'REFUSED_BEFORE_SCOPE_ADMISSION_SPENT';
  receipt.runtimeQualified = false; receipt.error = String(e.stack || e);
  if (scopeCreated) {
    try { receipt.failureSourceCensus = census(WORK); receipt.failureSourceRoot = metadata(WORK); } catch (x) { receipt.failureSourceCensusError = String(x.message); }
    try { receipt.failureControlsCensus = census(STAGE); receipt.failureControlsRoot = metadata(STAGE); } catch (x) { receipt.failureControlsCensusError = String(x.message); }
  }
  if (active) {
    try { await cleanup(receipt.phases[receipt.phases.length - 1] || receipt); }
    catch (x) { receipt.cleanupError = String(x.stack || x); }
  }
}).finally(() => {
  clearTimeout(supervisorTimer);
  receipt.finishedAt = new Date().toISOString(); receipt.interrupted = interrupted;
  receipt.supervisorElapsedMs = Number(mono() - supervisorStarted) / 1e6;
  if (interrupted) { receipt.status = 'INCOMPLETE_SPENT'; receipt.runtimeQualified = false; }
  if (scopeCreated) {
    try { rawWrite('receipt.json', receipt); }
    catch (e) { receipt.status = 'INCOMPLETE_SPENT'; receipt.runtimeQualified = false; receipt.retentionError = String(e.message); }
  }
  writeAll(1, Buffer.from(JSON.stringify({ status: receipt.status, receipt: scopeCreated ? path.join(EVIDENCE, 'receipt.json') : null,
    phases: receipt.phases.map(p => ({ label: p.label, status: p.status, exit: p.exit || null })),
    error: receipt.error || receipt.retentionError || null, refusal: scopeCreated ? null : receipt }) + '\n'));
  process.exit(receipt.runtimeQualified ? 0 : 1);
});
