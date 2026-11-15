import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { closeSync, fstatSync, openSync, writeSync } from 'node:fs';
import { verifyLinuxChildExecInput } from '../../../src/main/utils/linuxChildLaunchSelection.ts';
import { createProcessCustody } from '../dist/composition/processCustody.js';
import { createLinuxWarmProcess } from '../dist/process/LinuxWarmProcess.js';
import { loadProcessNativeArtifact } from '../dist/process/loadProcessNativeArtifact.js';
import { readPackagedLinuxProcessArtifact } from '../dist/process/readPackagedProcessArtifact.js';
import { mkdtemp, realpath, readFile, writeFile, appendFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = join(import.meta.dirname, 'fixtures');
const [artifactDirectory, manifestSha256, actorPath, command, savedCapture, operation] = process.argv.slice(2);
assert.ok(artifactDirectory && manifestSha256 && actorPath);
const library = join(artifactDirectory, 'registered-process.node');
assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
assert.throws(() => createProcessCustody({ directory: artifactDirectory, manifestSha256: '0'.repeat(64) }),
  /artifact unavailable/, 'Wrong manifest never loads a native custody implementation');
// TEST exercises retained descriptors on modern kernels too; product selection has no override.
const explicitWarm = command === 'warm' || command === 'cold-warm';
const artifact = { directory: artifactDirectory, manifestSha256 };
const loaded = explicitWarm ? loadProcessNativeArtifact(readPackagedLinuxProcessArtifact(artifact)) : undefined;
const api = loaded ? createLinuxWarmProcess(loaded.native, loaded.assertBinary) : createProcessCustody(artifact);
assert.ok(api);
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
if (command === 'cold' || command === 'cold-warm') {
  const capture = JSON.parse(await readFile(savedCapture, 'utf8'));
  const before = api.observe(capture);
  assert.equal(before, capture.version === 4 ? 'unknown' : 'same-live');
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
    const image = 'readRootExecutable' in api ? api.readRootExecutable(child, executable)
      : api.rootEvidence(child).measure();
    assert.equal(image.executablePath, executable.path);
    if ('executableSha256' in image) assert.equal(image.executableSha256, executable.sha256);
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
    assert.deepEqual(source.capture(pid, registrar), capture, 'Original live duplicate keeps one capture identity');
    return { name, child, closed, pid, root: capture.root, capture, source };
  };
  const worker = (capturePath, operation) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, artifactDirectory, manifestSha256, actorPath,
      explicitWarm ? 'cold-warm' : 'cold', capturePath, operation],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  await log({ phase: 'start', scope: 'TEST original process custody; actual SDK and Desktop remain separate',
    selection: explicitWarm ? 'TEST internal warm owner' : 'Host automatic kernel capability',
    kernel: { release: release(), platform: process.platform, arch: process.arch }, versions: process.versions, artifactSha256 });

  // Raw TEST stdio injects the exact high descriptor. Product adapters accept only 0–2.
  const proveIsolatedChild = async () => {
    const pin = { manifestPath: process.env.LEGACY_LINUX_CHILD_EXEC_MANIFEST,
      manifestSha256: process.env.LEGACY_LINUX_CHILD_EXEC_SHA256 };
    assert.ok(pin.manifestPath && pin.manifestSha256);
    const selected = verifyLinuxChildExecInput(pin);
    const helper = join(selected.manifestPath, '../linux-child-exec');
    const high = 64, marker = 'original-high-descriptor';
    const fd = openSync(join(workspace, 'original-parent-fd'), 'wx+', 0o600);
    const original = fstatSync(fd, { bigint: true });
    const identity = { dev: String(original.dev), ino: String(original.ino) };
    const children = [];
    const launch = (target, args, isolated, options = {}) => new Promise((resolve, reject) => {
      const channels = Array.from({ length: high + 1 }, () => 'ignore');
      channels[0] = 'pipe'; channels[1] = 'pipe'; channels[2] = 'pipe'; channels[3] = 'pipe'; channels[high] = fd;
      const argv = isolated ? ['--linux-child-exec-v1', target, 'TEST-captured-node', ...args] : args;
      const child = spawn(isolated ? helper : target, argv, { cwd: workspace, detached: true,
        argv0: isolated ? helper : 'TEST-captured-node', stdio: channels,
        env: { ...process.env, TEST_CHILD_EXEC_ORIGINAL: marker } });
      const row = { child, closed: undefined }; children.push(row);
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), status = Buffer.alloc(0), failure;
      let signaled = false;
      const stop = error => { failure ??= error; child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop(new Error('Original helper TEST child deadline')), 3000);
      row.closed = new Promise(done => child.once('close', done));
      child.once('error', error => { failure ??= error; });
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr], ['status', child.stdio[3]]]) {
        stream.on('data', chunk => {
          const prior = name === 'stdout' ? stdout : name === 'stderr' ? stderr : status;
          if (prior.length + chunk.length > (name === 'status' ? 12 : 8192)) {
            stop(new Error('Original helper TEST output bound')); return;
          }
          const next = Buffer.concat([prior, chunk]);
          if (name === 'stdout') stdout = next; else if (name === 'stderr') stderr = next; else status = next;
          if (options.cancel && name === 'stdout' && stdout.includes(10) && !signaled) {
            signaled = true; child.kill('SIGTERM');
          }
        });
        stream.once('error', error => stop(error));
      }
      child.stdin.on('error', () => {}); // Missing target can close stdin before its original small write.
      child.stdin.end('original-stdin');
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ child, code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), status, signaled });
      });
    });
    const descriptorRead = `const fs=require('node:fs'); const expected=${JSON.stringify(identity)};
      let same=false; try {const s=fs.fstatSync(${high},{bigint:true});
        same=String(s.dev)===expected.dev&&String(s.ino)===expected.ino;} catch(e){if(e.code!=='EBADF')throw e;}`;
    const target = descriptorRead + `
      const cp=require('node:child_process'); const chunks=[];
      process.stdin.on('data',b=>chunks.push(b)); process.stdin.on('end',()=>{
        const descendant=cp.spawnSync(process.execPath,['-e',${JSON.stringify(descriptorRead + "process.stdout.write(JSON.stringify({same}));")}],
          {encoding:'utf8',timeout:1000,maxBuffer:8192});
        if(descendant.error||descendant.status!==0)throw new Error('Original descendant failed');
        const stat=fs.readFileSync('/proc/self/stat','utf8'); const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
        process.stderr.write('original-stderr');
        process.stdout.write(JSON.stringify({same,childSame:JSON.parse(descendant.stdout).same,pid:process.pid,
          ppid:process.ppid,group:Number(fields[2]),argv0:process.argv0,argv:process.argv.slice(1),
          cwd:process.cwd(),marker:process.env.TEST_CHILD_EXEC_ORIGINAL,input:Buffer.concat(chunks).toString()})+'\\n');
      });`;
    try {
      writeSync(fd, marker);
      const control = await launch(process.execPath, ['-e', target, 'original argument'], false);
      assert.equal(control.code, 0);
      assert.equal(JSON.parse(control.stdout).same, true, 'The raw original high-fd injection must be observable');
      const isolated = await launch(process.execPath, ['-e', target, 'original argument'], true);
      const observed = JSON.parse(isolated.stdout);
      assert.deepEqual(observed, { same: false, childSame: false, pid: isolated.child.pid, ppid: process.pid,
        group: isolated.child.pid, argv0: 'TEST-captured-node', argv: ['original argument'],
        cwd: workspace, marker, input: 'original-stdin' });
      assert.equal(isolated.code, 0); assert.equal(isolated.signal, null);
      assert.equal(isolated.stderr, 'original-stderr'); assert.equal(isolated.status.length, 0);
      for (const [targetPath, errno] of [[join(workspace, 'missing-target'), 2], [join(workspace, 'denied-target'), 13]]) {
        if (errno === 13) await writeFile(targetPath, 'must never execute', { flag: 'wx', mode: 0o400 });
        const failed = await launch(targetPath, [], true);
        assert.equal(failed.code, 111); assert.equal(failed.signal, null);
        assert.equal(failed.stdout, ''); assert.equal(failed.stderr, '');
        assert.equal(failed.status.length, 12); assert.equal(failed.status.readUInt32BE(0), 0x41544c58);
        assert.deepEqual([...failed.status.subarray(4, 8)], [1, 3, 0, 0]);
        assert.equal(failed.status.readUInt32LE(8), errno);
      }
      const exited = await launch(process.execPath, ['-e', 'process.exit(111)'], true);
      assert.equal(exited.code, 111); assert.equal(exited.status.length, 0, 'Target exit is not an exec errno');
      const script = join(workspace, 'original-shell-script');
      await writeFile(script, 'printf "original-script\\n"\n', { flag: 'wx', mode: 0o500 });
      await chmod(script, 0o500);
      const fallback = await launch(script, [], true);
      assert.equal(fallback.code, 0); assert.equal(fallback.stdout, 'original-script\n');
      const cancelled = await launch(process.execPath, ['-e',
        "process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');setInterval(()=>{},1000)"], true, { cancel: true });
      assert.equal(JSON.parse(cancelled.stdout).pid, cancelled.child.pid);
      assert.equal(cancelled.signaled, true); assert.equal(cancelled.signal, 'SIGTERM');
      assert.equal(cancelled.status.length, 0);
      const after = fstatSync(fd, { bigint: true });
      assert.equal(after.dev, original.dev); assert.equal(after.ino, original.ino);
      writeSync(fd, '-parent-still-usable');
      assert.equal(await readFile(join(workspace, 'original-parent-fd'), 'utf8'), marker + '-parent-still-usable');
      assert.deepEqual(verifyLinuxChildExecInput(pin), selected);
      await log({ phase: 'isolated-same-child-launch', completed: true, parentUnchanged: true,
        helperSha256: selected.binarySha256, originalChildPid: isolated.child.pid,
        exactHighDescriptorAbsent: true, descendantDescriptorAbsent: true,
        scope: 'Native child isolation only; Main integration and executable-byte race qualification remain separate' });
    } finally {
      for (const row of children)
        if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGKILL');
      await Promise.all(children.map(row => row.closed));
      closeSync(fd);
    }
  };

  let completed = false;
  try {
    await proveIsolatedChild();
    const same = await start('same', 'same'), owned = await start('owned', 'cross');
    const peer = await start('peer', 'cross'), drift = await start('drift', 'cross');
    const leader = await start('leader', 'cross');
    const warm = owned.capture.version === 4;
    assert.equal(warm || owned.capture.version === 3, true);
    assert.equal(same.capture.target.sessionId, same.root.sessionId);
    assert.notEqual(owned.capture.target.sessionId, owned.root.sessionId);
    assert.throws(() => owned.source.capture(peer.pid, registrar));
    const wrong = warm ? { ...owned.capture, captureKey: '33333333-3333-4333-8333-333333333333' }
      : { ...owned.capture, target: { ...owned.capture.target, pidfdId: (BigInt(owned.capture.target.pidfdId) + 1n).toString() } };
    assert.equal(api.observe(wrong), warm ? 'unknown' : 'stale');
    if (warm) assert.equal(api.signal(wrong), 'refused'); else assert.throws(() => api.signal(wrong));
    const wrongNamespace = { ...owned.capture, target: { ...owned.capture.target, pidNamespaceId: (BigInt(owned.capture.target.pidNamespaceId) + 1n).toString() } };
    if (explicitWarm) assert.throws(() => api.observe(wrongNamespace));
    else assert.equal(api.observe(wrongNamespace), 'unknown');
    assert.throws(() => api.signal(wrongNamespace));
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
    assert.equal(coldRead.before, warm ? 'unknown' : 'same-live');
    await log({ phase: 'requested-before-native', original: owned.capture });
    const coldSignal = await worker(capturePath, 'signal');
    assert.equal(coldSignal.result, warm ? 'refused' : 'accepted');
    if (warm) assert.equal(api.signal(owned.capture), 'accepted', 'Only the retained original owner can signal');
    await until(async () => api.observe(owned.capture) === 'absent');
    await until(() => exists(join(workspace, 'owned.closed')));
    assert.equal(JSON.parse(await readFile(join(workspace, 'owned.closed'), 'utf8')).reason, 'SIGTERM');
    assert.equal(await readFile(capturePath, 'utf8'), originalBytes);
    assert.equal(api.observe(peer.capture), 'same-live');
    assert.equal(api.observe(same.capture), 'same-live');
    const replacementSelector = { ...owned.capture, target: { ...owned.capture.target, pid: peer.pid } };
    assert.equal(api.observe(replacementSelector), warm ? 'unknown' : 'stale');
    if (warm) assert.equal(api.signal(replacementSelector), 'refused');
    else assert.throws(() => api.signal(replacementSelector));
    assert.equal(api.observe(peer.capture), 'same-live');
    await writeFile(join(workspace, 'drift.drift'), '', { flag: 'wx' });
    await until(() => exists(join(workspace, 'drift.did-drift')));
    assert.equal(api.observe(drift.capture), 'unknown');
    assert.throws(() => api.signal(drift.capture));
    await writeFile(join(workspace, 'leader.thread-exit'), '', { flag: 'wx' });
    await until(() => api.observe(leader.capture) === 'unknown');
    assert.equal(await exists(join(workspace, 'leader.closed')), false, 'The original worker is still alive');
    assert.throws(() => api.signal(leader.capture), 'A dead thread-group leader is not whole-process exit proof');
    assert.equal(await exists(join(workspace, 'leader.closed')), false);
    await log({ phase: 'live-worker-after-thread-leader-exit', original: leader.capture,
      observation: 'unknown', signal: 'refused', workerClosed: false });
    await log({ phase: 'proved', captureVersion: owned.capture.version, coldRead, coldSignal,
      originalTarget: 'absent', neighbor: 'same-live',
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
