import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const lockPath = require.resolve('agent-teams-controller/src/internal/fileLock.js');
const atomicPath = require.resolve('agent-teams-controller/src/internal/atomicFile.js');
const canonical = require(lockPath);
const source = stripTypeScriptTypes(fs.readFileSync(
  new URL('./desktop-native-quit-ui-smoke.ts', import.meta.url), 'utf8'), { mode: 'strip' });

// Execute the current private TS bodies, not a copied scanner or a Desktop/provider import closure.
function declaration(name, async = false) {
  const value = source.match(new RegExp(`^${async ? 'async ' : ''}function ${name}\\b[\\s\\S]*?^}`, 'm'));
  assert.ok(value, `original ${name} declaration`);
  return value[0];
}
const recordSource = source.slice(source.indexOf('const record ='), source.indexOf('const json ='));
assert.ok(recordSource.startsWith('const record ='));
const snapshot = new Function('assert', 'readFileSync', 'readdirSync', 'acquireFileLockSync', 'join', 'console',
  `${recordSource}\n${declaration('assertRecordEntries')}\n${declaration('liveCommandFiles')}\nreturn liveCommandFiles;`);

function fixture(t, cleanup = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'TEST-quit-command-snapshot-'));
  const owner = join(root, 'hoststore/teams/test-desktop-backend/.host-owner');
  const directory = join(owner, 'commands');
  fs.mkdirSync(directory, { recursive: true });
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, owner, directory, authority: join(owner, 'authority') };
}
function reader(f, overrides = {}) {
  const counts = { scans: 0, reads: 0, acquisitions: 0, releases: 0 };
  function held() {
    assert.equal(fs.readFileSync(f.authority + '.lock', 'utf8').split('\n')[0], String(process.pid));
  }
  const read = snapshot(assert, (...args) => {
    counts.reads++; held(); return fs.readFileSync(...args);
  }, (...args) => {
    counts.scans++; held();
    if (overrides.scanError) throw overrides.scanError;
    return fs.readdirSync(...args);
  }, (scope, options) => {
    counts.acquisitions++;
    assert.equal(scope, f.authority);
    assert.deepEqual(options, { createParent: false, acquireTimeoutMs: 0 });
    if (overrides.acquireError) throw overrides.acquireError;
    const release = canonical.acquireFileLockSync(scope, options);
    return () => { try { release(); } finally { counts.releases++; } };
  }, join, { log() {} });
  return { read: () => read(f.root), counts };
}
function released(f) {
  assert.deepEqual(fs.readdirSync(f.owner).filter(name => name.startsWith('authority.lock')), []);
}

test('live Quit command read defers without scanning during the actual canonical atomic write', {
  timeout: 15_000,
}, async t => {
  const f = fixture(t, false), live = reader(f), signal = new SharedArrayBuffer(4);
  fs.writeFileSync(join(f.directory, 'a.json'), '{"commandId":"first"}');
  fs.writeFileSync(join(f.directory, 'b.json'), '{"commandId":"second"}');
  const worker = new Worker(`
    const { parentPort, workerData: d } = require('node:worker_threads');
    const fs = require('node:fs');
    const { withFileLockSync } = require(d.lockPath);
    const { writeJsonFileSync } = require(d.atomicPath);
    const rename = fs.renameSync, signal = new Int32Array(d.signal);
    let writes = 0;
    fs.renameSync = (from, to) => {
      if (to === d.target) {
        writes++;
        parentPort.postMessage({ kind: 'paused', temporary: require('node:path').basename(from) });
        Atomics.wait(signal, 0, 0, 10000);
        if (Atomics.load(signal, 0) !== 1) throw new Error('Finite writer was not released');
      }
      return rename(from, to);
    };
    try {
      withFileLockSync(d.authority, () => writeJsonFileSync(d.target, { commandId: 'third' }), { createParent: false });
      parentPort.postMessage({ kind: 'complete', writes });
    } finally { fs.renameSync = rename; parentPort.close(); }
  `, { eval: true, execArgv: [], workerData: {
    signal, lockPath, atomicPath, authority: f.authority, target: join(f.directory, 'c.json'),
  } });
  let pausedResolve, pausedReject, completeResolve, completeReject;
  const paused = new Promise((resolve, reject) => { pausedResolve = resolve; pausedReject = reject; });
  const complete = new Promise((resolve, reject) => { completeResolve = resolve; completeReject = reject; });
  let exited = false;
  const exit = new Promise(resolve => worker.once('exit', code => { exited = true; resolve(code); }));
  worker.on('message', value => {
    if (value.kind === 'paused') pausedResolve(value);
    if (value.kind === 'complete') completeResolve(value);
  });
  worker.on('error', error => { pausedReject(error); completeReject(error); });
  // Settle both message promises even if the worker fails before publishing the pause.
  void complete.catch(() => {});
  t.after(async () => {
    Atomics.store(new Int32Array(signal), 0, 1); Atomics.notify(new Int32Array(signal), 0);
    if (!exited) await worker.terminate();
    await exit;
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const atRename = await paused;
  try {
    assert.match(atRename.temporary, /^\.tmp\.[a-f0-9-]{36}$/);
    const entries = fs.readdirSync(f.directory, { withFileTypes: true });
    assert.equal(entries.length, 3);
    assert.ok(entries.every(entry => entry.isFile()));
    assert.equal(entries.filter(entry => /^[a-zA-Z0-9_-]+\.json$/.test(entry.name)).length, 2);
    assert.equal(live.read(), undefined);
    assert.equal(live.counts.scans, 0); assert.equal(live.counts.reads, 0);
  } finally {
    Atomics.store(new Int32Array(signal), 0, 1); Atomics.notify(new Int32Array(signal), 0);
  }
  assert.equal((await complete).writes, 1, 'one original producer write, no replay');
  assert.equal(await exit, 0);
  assert.deepEqual(live.read(), ['first', 'second', 'third'].map((commandId, index) => ({
    name: String.fromCharCode(97 + index) + '.json', value: { commandId },
  })));
  assert.equal(live.counts.scans, 1); assert.equal(live.counts.reads, 3); released(f);
});

test('live Quit busy acquisition stays inside the original 20s and 100ms poll', async t => {
  const f = fixture(t), live = reader(f);
  const release = canonical.acquireFileLockSync(f.authority, { createParent: false });
  let now = 0; const ticks = [];
  const tick = source.match(/^const tick =[^\n]+/m)?.[0]; assert.ok(tick);
  const until = new Function('Date', 'setTimeout', `${tick}\n${declaration('until', true)}\nreturn until;`)(
    { now: () => now }, (callback, ms) => { ticks.push(ms); now += ms; queueMicrotask(callback); });
  try {
    await assert.rejects(until(async () => live.read() !== undefined, 'original budget'), {
      message: 'original budget; no action retry',
    });
    assert.equal(now, 20_000); assert.equal(ticks.length, 200); assert.ok(ticks.every(ms => ms === 100));
    assert.equal(live.counts.acquisitions, 200); assert.equal(live.counts.scans, 0); assert.equal(live.counts.reads, 0);
  } finally { release(); }
  released(f);
});

test('live Quit strict persistent-entry refusals release the original fence', async t => {
  const cases = [
    ['unknown regular file', f => fs.writeFileSync(join(f.directory, 'unknown.txt'), '{}'), 'ERR_ASSERTION'],
    ['stale canonical temp', f => fs.writeFileSync(join(f.directory, '.tmp.01234567-89ab-4cde-8123-0123456789ab'), '{}'), 'ERR_ASSERTION'],
    ['directory', f => fs.mkdirSync(join(f.directory, 'bad.json')), 'ERR_ASSERTION'],
    ['malformed JSON', f => fs.writeFileSync(join(f.directory, 'bad.json'), '{'), 'SyntaxError'],
    ['null object', f => fs.writeFileSync(join(f.directory, 'bad.json'), 'null'), 'ERR_ASSERTION'],
    ['array object', f => fs.writeFileSync(join(f.directory, 'bad.json'), '[]'), 'ERR_ASSERTION'],
  ];
  for (const [name, install, kind] of cases) await t.test(name, child => {
    const f = fixture(child), live = reader(f); install(f);
    assert.throws(() => live.read(), error => kind === 'SyntaxError' ? error.name === kind : error.code === kind);
    assert.equal(live.counts.releases, 1); released(f);
  });
  await t.test('symlink', child => {
    const f = fixture(child), live = reader(f);
    // Directory junctions require no extra Windows symlink privilege and must also be refused.
    fs.mkdirSync(join(f.root, 'target'));
    fs.symlinkSync(join(f.root, 'target'), join(f.directory, 'bad.json'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => live.read(), { code: 'ERR_ASSERTION' });
    assert.equal(live.counts.releases, 1); released(f);
  });
});

test('live Quit exact 256-entry cap and acquisition-versus-scan errors stay fail closed', t => {
  const f = fixture(t), live = reader(f);
  for (let i = 0; i < 256; i++) fs.writeFileSync(join(f.directory, `${String(i).padStart(3, '0')}.json`), '{}');
  assert.equal(live.read().length, 256); released(f);
  fs.writeFileSync(join(f.directory, 'overflow.json'), '{}');
  assert.throws(() => live.read(), { code: 'ERR_ASSERTION' }); released(f);
  const denied = Object.assign(new Error('original acquisition refused'), { code: 'EACCES' });
  const acquisition = reader(f, { acquireError: denied });
  assert.throws(() => acquisition.read(), error => error === denied);
  assert.equal(acquisition.counts.scans, 0); released(f);
  const scanError = new Error(`File lock timeout: ${f.authority}`);
  const scanning = reader(f, { scanError });
  assert.throws(() => scanning.read(), error => error === scanError);
  assert.equal(scanning.counts.releases, 1); released(f);
});
