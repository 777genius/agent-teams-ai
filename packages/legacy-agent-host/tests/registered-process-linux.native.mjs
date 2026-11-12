import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { createProcessCustody } from '../dist/composition/processCustody.js';
import { mkdtemp, realpath, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = join(import.meta.dirname, 'fixtures');
const [artifactDirectory, manifestSha256, actorPath, command, savedCapture, operation] = process.argv.slice(2);
assert.ok(artifactDirectory && manifestSha256 && actorPath);
const library = join(artifactDirectory, 'registered-process.node');
assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
assert.throws(() => createProcessCustody({ directory: artifactDirectory, manifestSha256: '0'.repeat(64) }),
  /artifact unavailable/, 'Wrong manifest never loads a native custody implementation');
const api = createProcessCustody({ directory: artifactDirectory, manifestSha256 });
assert.ok(api);
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
if (command === 'cold') {
  const capture = JSON.parse(await readFile(savedCapture, 'utf8'));
  const before = api.observe(capture);
  assert.equal(before, 'same-live');
  const result = operation === 'signal' ? api.signal(capture) : undefined;
  console.log(JSON.stringify({ before, result, workerPid: process.pid }));
} else {
  assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
  const workspace = await realpath(await mkdtemp('/tmp/TEST-linux-pidfd-'));
  const artifactSha256 = createHash('sha256').update(await readFile(library)).digest('hex');
  const proof = join(workspace, 'proof.ndjson');
  const log = fact => appendFile(proof, JSON.stringify(fact) + '\n', { mode: 0o600 });
  const exists = path => readFile(path).then(() => true, () => false);
  const until = async check => {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error('Finite native observation deadline');
      await delay(20);
    }
  };
  const roots = [], capsules = [];
  const registrar = { backendId: 'TEST-native', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
  const executablePath = await realpath(process.execPath);
  const executable = { path: executablePath, sha256: createHash('sha256').update(await readFile(executablePath)).digest('hex') };
  const start = async (name, mode) => {
    const child = spawn(process.execPath, [join(directory, 'registered-process-parent.ts'), 'root',
      workspace, actorPath, name, mode],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    void closed.catch(() => undefined);
    roots.push({ name, child, closed });
    const source = api.captureRoot(child, () => child.exitCode === null && child.signalCode === null);
    const image = api.readRootExecutable(child, executable);
    assert.equal(image.executablePath, executable.path); assert.equal(image.executableSha256, executable.sha256);
    assert.equal(image.pid, child.pid);
    child.stderr.on('data', () => {});
    const pid = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('Finite TEST actor publication deadline')), 3000);
      child.stdout.on('data', bytes => {
        text += bytes.toString(); const end = text.indexOf('\n');
        if (end >= 0) { clearTimeout(timer); resolve(JSON.parse(text.slice(0, end)).pid); }
      });
    });
    const capture = source.capture(pid, registrar); capsules.push(capture);
    return { name, child, closed, pid, root: capture.root, capture, source };
  };
  const worker = (capturePath, operation) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, artifactDirectory, manifestSha256, actorPath, 'cold', capturePath, operation],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  await log({ phase: 'start', scope: 'TEST Host composition/native pidfs proof; actual SDK and Desktop remain separate',
    kernel: { release: release(), platform: process.platform, arch: process.arch }, versions: process.versions, artifactSha256 });
  let completed = false;
  try {
    const same = await start('same', 'same'), owned = await start('owned', 'cross');
    const peer = await start('peer', 'cross'), drift = await start('drift', 'cross');
    assert.equal(same.capture.target.sessionId, same.root.sessionId);
    assert.notEqual(owned.capture.target.sessionId, owned.root.sessionId);
    assert.throws(() => owned.source.capture(peer.pid, registrar));
    const wrong = { ...owned.capture, target: { ...owned.capture.target, pidfdId: (BigInt(owned.capture.target.pidfdId) + 1n).toString() } };
    assert.equal(api.observe(wrong), 'stale'); assert.throws(() => api.signal(wrong));
    const wrongNamespace = { ...owned.capture, target: { ...owned.capture.target, pidNamespaceId: (BigInt(owned.capture.target.pidNamespaceId) + 1n).toString() } };
    assert.equal(api.observe(wrongNamespace), 'unknown'); assert.throws(() => api.signal(wrongNamespace));
    assert.equal(api.observe(owned.capture), 'same-live');
    await log({ phase: 'ownership-and-identity-negatives', same: same.capture, owned: owned.capture,
      peer: peer.capture, scope: 'No forced numeric PID churn; exact inode/namespace mismatch refused' });
    await writeFile(join(workspace, 'owned.bridge-exit'), '', { flag: 'wx' });
    await until(() => exists(join(workspace, 'owned.bridge-gone')));
    assert.throws(() => owned.source.capture(owned.pid, registrar), 'Orphan has no new lineage admission');
    assert.equal(api.observe(owned.capture), 'same-live');
    await writeFile(join(workspace, 'owned.root-exit'), '', { flag: 'wx' });
    await owned.closed;
    const capturePath = join(workspace, 'original-capture.json');
    const originalBytes = JSON.stringify(owned.capture);
    await writeFile(capturePath, originalBytes, { mode: 0o600, flag: 'wx' });
    const coldRead = await worker(capturePath, 'observe');
    assert.equal(coldRead.before, 'same-live');
    await log({ phase: 'requested-before-native', original: owned.capture });
    const coldSignal = await worker(capturePath, 'signal'); assert.equal(coldSignal.result, 'accepted');
    await until(async () => api.observe(owned.capture) === 'absent');
    await until(() => exists(join(workspace, 'owned.closed')));
    assert.equal(JSON.parse(await readFile(join(workspace, 'owned.closed'), 'utf8')).reason, 'SIGTERM');
    assert.equal(await readFile(capturePath, 'utf8'), originalBytes);
    assert.equal(api.observe(peer.capture), 'same-live');
    assert.equal(api.observe(same.capture), 'same-live');
    const replacementSelector = { ...owned.capture, target: { ...owned.capture.target, pid: peer.pid } };
    assert.equal(api.observe(replacementSelector), 'stale');
    assert.throws(() => api.signal(replacementSelector));
    assert.equal(api.observe(peer.capture), 'same-live');
    await writeFile(join(workspace, 'drift.drift'), '', { flag: 'wx' });
    await until(() => exists(join(workspace, 'drift.did-drift')));
    assert.equal(api.observe(drift.capture), 'unknown');
    assert.throws(() => api.signal(drift.capture));
    await log({ phase: 'proved', coldRead, coldSignal, originalTarget: 'absent', neighbor: 'same-live',
      sameSession: 'same-live', changedSession: 'unknown', nativeSignalCalls: 1 });
    completed = true;
  } finally {
    for (const row of roots) await writeFile(join(workspace, row.name + '.root-exit'), '', { flag: 'a' });
    await Promise.allSettled(roots.map(row => row.closed));
    const deadline = Date.now() + 15000;
    let cleaned = false;
    while (Date.now() < deadline) {
      if ((await Promise.all(roots.map(row => exists(join(workspace, row.name + '.closed'))))).every(Boolean) &&
          capsules.every(capture => ['absent', 'stale'].includes(api.observe(capture)))) { cleaned = true; break; }
      await delay(100);
    }
    await log({ phase: 'finite-cleanup', cleaned, completed,
      scope: 'Only original pidfd received one SIGTERM; all other TEST actors self-exited after their TTL' });
    assert.equal(cleaned, true);
    console.log(JSON.stringify({ workspace, completed, cleaned, artifactSha256, kernel: { release: release(), platform: process.platform, arch: process.arch } }));
  }
}
