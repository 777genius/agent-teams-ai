'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');

const native = require('..');
const packageRoot = path.resolve(__dirname, '..');
const fixtureBase = path.join(packageRoot, '.test-tmp-r810');
let runRoot;

before(() => {
  fs.mkdirSync(fixtureBase, { recursive: true });
  runRoot = fs.mkdtempSync(path.join(fixtureBase, 'run-'));
});

after(() => {
  fs.rmSync(runRoot, { recursive: true, force: true });
});

function fixture(name) {
  const root = path.join(runRoot, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function waitFor(child, expected) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.type === 'error') {
        cleanup();
        reject(Object.assign(new Error(message.message), { code: message.code }));
      } else if (message.type === expected) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`worker exited before ${expected}: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function worker(root, target = 'state.json', marker = 'active-v3', environment = {}) {
  const child = fork(path.join(__dirname, 'worker.js'), [], {
    env: { ...process.env, ...environment },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await waitFor(child, 'ready');
  child.send({ command: 'acquire', root, target, marker });
  const message = await waitFor(child, 'result');
  return { child, result: message.result };
}

async function settle(instance, command = 'release', record) {
  instance.child.send({ command, record });
  await waitFor(instance.child, command === 'release' ? 'released' : 'abandoned');
}

test('acquire, contend, publish release, and reacquire with stable owner', async () => {
  const root = fixture('lifecycle');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const first = await worker(root);
  assert.equal(first.result.status, 'acquired');
  const contender = await worker(root);
  assert.equal(contender.result.status, 'contended');
  await settle(first, 'release', 'released-v3');
  const markerPath = path.join(root, 'state.json.lock');
  const released = fs.readFileSync(markerPath, 'utf8');
  assert.match(released, /^agent-teams-desktop-file-lock-v3\nowner-key:[0-9a-f]{32}\n/);
  assert.match(released, /r-bytes:11\nreleased-v3$/);
  const next = await worker(root);
  assert.equal(next.result.status, 'acquired');
  assert.equal(next.result.ownerKey, first.result.ownerKey);
  await settle(next);
  assert.equal(fs.existsSync(markerPath), true);
});

test('SIGKILL releases the operating-system lock', { skip: process.platform === 'win32' }, async () => {
  const root = fixture('sigkill');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const holder = await worker(root);
  assert.equal(holder.result.status, 'acquired');
  const exited = new Promise((resolve) => holder.child.once('exit', resolve));
  holder.child.kill('SIGKILL');
  await exited;
  const replacement = await worker(root);
  assert.equal(replacement.result.status, 'acquired');
  await settle(replacement);
});

test('target inode atomic replacement does not change lock authority', async () => {
  const root = fixture('target-replacement');
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, 'old');
  const scope = native.captureScope(root);
  const acquired = native.tryAcquire(scope, 'state.json', 'active');
  assert.equal(acquired.status, 'acquired');
  fs.writeFileSync(path.join(root, 'new.json'), 'new');
  fs.renameSync(path.join(root, 'new.json'), target);
  native.assertOwned(acquired.leaseId);
  const contender = await worker(root);
  assert.equal(contender.result.status, 'contended');
  native.release(acquired.leaseId);
  native.closeScope(scope);
});

test('authority is independent of HOME-local state', async () => {
  const root = fixture('different-homes');
  const homeA = path.join(runRoot, 'home-a');
  const homeB = path.join(runRoot, 'home-b');
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const holder = await worker(root, 'state.json', 'active', { HOME: homeA });
  const contender = await worker(root, 'state.json', 'active', { HOME: homeB });
  assert.equal(holder.result.status, 'acquired');
  assert.equal(contender.result.status, 'contended');
  await settle(holder);
  assert.deepEqual(fs.readdirSync(homeA), []);
  assert.deepEqual(fs.readdirSync(homeB), []);
});

test('does not scan more than 5000 unrelated directory entries', () => {
  const root = fixture('no-scan');
  for (let index = 0; index < 5001; index += 1) {
    fs.writeFileSync(path.join(root, `unrelated-${index}`), 'x');
  }
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const scope = native.captureScope(root);
  const acquired = native.tryAcquire(scope, 'state.json', 'active');
  assert.equal(acquired.status, 'acquired');
  native.release(acquired.leaseId);
  native.closeScope(scope);
});

test('unknown, V1/V2, and publishing artifacts remain untouched and uncertain', () => {
  for (const [name, suffix, content] of [
    ['unknown', '.lock', 'unknown-format'],
    ['v1', '.lock', '123\n9007199254740991\nagent-teams-legacy-authoritative-v1\ntoken\n'],
    ['v2', '.lock', '123\n9007199254740991\nagent-teams-legacy-authoritative-v2\ntoken\n'],
    ['publishing', '.lock.publishing', 'partial-old-publication'],
  ]) {
    const root = fixture(`legacy-${name}`);
    fs.writeFileSync(path.join(root, 'state.json'), '{}');
    const artifact = path.join(root, `state.json${suffix}`);
    fs.writeFileSync(artifact, content);
    const scope = native.captureScope(root);
    const result = native.tryAcquire(scope, 'state.json', 'active');
    assert.equal(result.status, 'uncertain');
    assert.equal(fs.readFileSync(artifact, 'utf8'), content);
    native.closeScope(scope);
  }
});

test('scope substitution fails closed without writing a replacement tree', () => {
  const root = fixture('scope-substitution');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const scope = native.captureScope(root);
  const moved = `${root}-original`;
  fs.renameSync(root, moved);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'state.json'), 'replacement');
  const result = native.tryAcquire(scope, 'state.json', 'active');
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
  native.closeScope(scope);
});

test('symlink scope and target-parent escapes are rejected without outside writes',
     { skip: process.platform === 'win32' }, () => {
  const realRoot = fixture('symlink-real');
  const scopeLink = path.join(runRoot, 'symlink-scope');
  fs.symlinkSync(realRoot, scopeLink, 'dir');
  assert.throws(() => native.captureScope(scopeLink), { code: 'ERR_FILE_LOCK_UNCERTAIN' });

  const root = fixture('symlink-target');
  const outside = fixture('symlink-outside');
  fs.writeFileSync(path.join(outside, 'state.json'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'nested'), 'dir');
  const scope = native.captureScope(root);
  const result = native.tryAcquire(scope, 'nested/state.json', 'active');
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(fs.readdirSync(outside), ['state.json']);
  native.closeScope(scope);
});

test('target-parent substitution invalidates ownership without writing replacement tree', () => {
  const root = fixture('parent-substitution');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'state.json'), '{}');
  const scope = native.captureScope(root);
  const acquired = native.tryAcquire(scope, 'nested/state.json', 'active');
  assert.equal(acquired.status, 'acquired');
  fs.renameSync(path.join(root, 'nested'), path.join(root, 'nested-original'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'state.json'), 'replacement');
  assert.throws(() => native.assertOwned(acquired.leaseId), { code: 'ERR_FILE_LOCK_OWNERSHIP_LOST' });
  native.abandon(acquired.leaseId);
  native.closeScope(scope);
  assert.deepEqual(fs.readdirSync(path.join(root, 'nested')), ['state.json']);
});

test('concurrent first publication exposes only one complete final marker', async () => {
  const root = fixture('atomic-publication');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const attempts = await Promise.all(Array.from({ length: 8 }, () => worker(root)));
  const acquired = attempts.filter((attempt) => attempt.result.status === 'acquired');
  assert.equal(acquired.length, 1);
  for (const attempt of attempts) {
    if (attempt !== acquired[0]) assert.equal(attempt.result.status, 'contended');
  }
  const entries = fs.readdirSync(root);
  assert.equal(entries.filter((entry) => entry === 'state.json.lock').length, 1);
  assert.equal(entries.some((entry) => entry.startsWith('.atflv3-')), false);
  assert.match(fs.readFileSync(path.join(root, 'state.json.lock'), 'utf8'),
               /^agent-teams-desktop-file-lock-v3\nowner-key:[0-9a-f]{32}\na-bytes:9\nactive-v3$/);
  await settle(acquired[0]);
});

test('bounded unsupported capability returns a typed status without fallback', () => {
  const root = fixture('unsupported');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const scope = native.captureScope(root);
  const result = native.tryAcquire(scope, 'state.json', 'x'.repeat(4097));
  assert.equal(result.status, 'unsupported');
  assert.match(result.message, /4096/);
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
  native.closeScope(scope);
});

test('raw descriptors never cross the synchronous JS boundary', () => {
  const root = fixture('api-shape');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const scope = native.captureScope(root);
  assert.equal(typeof scope, 'bigint');
  const acquired = native.tryAcquire(scope, 'state.json', 'active');
  assert.deepEqual(Object.keys(acquired).sort(), ['leaseId', 'ownerKey', 'status']);
  assert.equal(typeof acquired.leaseId, 'bigint');
  assert.equal(typeof acquired.ownerKey, 'string');
  native.abandon(acquired.leaseId);
  native.closeScope(scope);
});

test('hard-linked or modified marker authority fails closed', () => {
  const hardlinkRoot = fixture('hardlink-marker');
  fs.writeFileSync(path.join(hardlinkRoot, 'state.json'), '{}');
  let scope = native.captureScope(hardlinkRoot);
  let acquired = native.tryAcquire(scope, 'state.json', 'active');
  assert.equal(acquired.status, 'acquired');
  native.release(acquired.leaseId);
  native.closeScope(scope);
  fs.linkSync(path.join(hardlinkRoot, 'state.json.lock'), path.join(hardlinkRoot, 'alias.lock'));
  scope = native.captureScope(hardlinkRoot);
  assert.equal(native.tryAcquire(scope, 'state.json', 'active').status, 'uncertain');
  native.closeScope(scope);

  const modifiedRoot = fixture('modified-marker');
  fs.writeFileSync(path.join(modifiedRoot, 'state.json'), '{}');
  scope = native.captureScope(modifiedRoot);
  acquired = native.tryAcquire(scope, 'state.json', 'active');
  assert.equal(acquired.status, 'acquired');
  const marker = path.join(modifiedRoot, 'state.json.lock');
  const descriptor = fs.openSync(marker, 'r+');
  fs.writeSync(descriptor, 'X', 0, 'utf8');
  fs.closeSync(descriptor);
  assert.throws(() => native.assertOwned(acquired.leaseId), {
    code: 'ERR_FILE_LOCK_OWNERSHIP_LOST',
  });
  native.abandon(acquired.leaseId);
  native.closeScope(scope);
});
