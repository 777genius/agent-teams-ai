import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stageLinuxNodeExec } from './buildLinuxNodeExec.mjs';
import {
  captureLinuxNodeExecArtifact, validateLinuxNodeExecArtifact,
} from '../../src/main/utils/linuxNodeExecArtifact.ts';

const repository = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const identity = (pid) => {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { group: Number(fields[2]), birth: fields[19] };
};
const absent = (pid, original) => {
  try { return identity(pid).birth !== original.birth; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; }
};
function bounded(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
function retainedChild(owned, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (stdout.includes('TEST_NODE_READY')) resolve(); });
    child.once('error', reject);
    child.once('close', () => reject(new Error('Original Node exited before its ready marker')));
  });
  const selected = { child, closed,
    started: bounded(ready, 10_000, 'Original Node readiness timeout'),
    completed: bounded(closed, 15_000, 'Original Node close timeout') };
  // Refusal and intentionally held cases need not consume both observations.
  void selected.started.catch(() => {}); void selected.completed.catch(() => {});
  owned.add(selected);
  return selected;
}
async function stopOriginal(selected) {
  if (!selected) return;
  if (selected.child.exitCode === null && selected.child.signalCode === null)
    selected.child.kill('SIGTERM');
  await bounded(selected.closed, 10_000, 'Original child cleanup was not confirmed');
}

test('Linux Node stage closes inherited socket FDs before original Node entry and preserves custody', {
  skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 60_000,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-linux-node-exec-')));
  const node = realpathSync(process.env.HOST_NODE_EXEC_TARGET || process.execPath);
  const nodeSha256 = sha(node), env = {
    HOME: root, PATH: dirname(node) + ':/usr/bin:/bin', TEST_EXEC_SENTINEL: 'TEST-exact-environment',
  };
  let sibling, held, cleanupPromise;
  const owned = new Set();
  const cleanup = () => cleanupPromise ??= (async () => {
    const results = await Promise.allSettled([...owned].map(stopOriginal));
    assert.equal(results.every((result) => result.status === 'fulfilled'), true,
      'All original children must confirm close; keep the private fixture if cleanup is unknown');
    rmSync(root, { recursive: true, force: true });
  })();
  t.after(cleanup);
  try {
    const stage = stageLinuxNodeExec({ outputDirectory: join(root, 'artifact') });
    assert.ok(stage);
    const driver = join(root, 'TEST-inherit-sockets');
    execFileSync(realpathSync('/usr/bin/cc'), [
      '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror',
      join(repository, 'tools/linux-node-exec/inherited-fds-fixture.c'), '-o', driver,
    ], { timeout: 30_000, stdio: 'pipe' });
    const entry = join(root, 'TEST-node-entry.mjs');
    writeFileSync(entry, [
      "import {readlinkSync} from 'node:fs';",
      "const link=fd=>{try{return readlinkSync('/proc/self/fd/'+fd)}catch(e){if(e.code==='ENOENT')return null;throw e}};",
      "process.stdout.write(JSON.stringify({event:'TEST_NODE_READY',pid:process.pid,ppid:process.ppid,execPath:process.execPath,argv:process.argv,cwd:process.cwd(),sentinel:process.env.TEST_EXEC_SENTINEL,home:process.env.HOME,fd52:link(52),fd4096:link(4096)})+'\\n');",
      "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>{input+=value;if(input.length>4096)process.exit(122)});",
      "process.stdin.on('end',()=>{process.stderr.write('TEST_STDERR\\n');process.stdout.write(JSON.stringify({event:'TEST_EOF',input})+'\\n')});",
    ].join('\n'), { mode: 0o600 });
    sibling = retainedChild(owned, node, ['-e', "process.stdout.write('TEST_NODE_READY\\n');setInterval(()=>{},1000)"], { cwd: root, env });
    await sibling.started;
    const siblingIdentity = identity(sibling.child.pid);

    for (const mode of ['normal', 'fallback']) {
      await t.test(mode + ': original PID, arguments, environment, stdio and high descriptors', async () => {
        validateLinuxNodeExecArtifact(stage);
        const selected = retainedChild(owned, driver, [mode, stage.path, '--', node, entry, 'TEST literal ; $ value'], {
          cwd: root, env, detached: true,
        });
        try {
          await selected.started;
          const original = identity(selected.child.pid);
          selected.child.stdin.end('TEST original stdin\n');
          const result = await selected.completed;
          assert.equal(result.code, 0); assert.equal(result.signal, null);
          const lines = result.stdout.trim().split('\n');
          const driverLine = /^TEST_DRIVER (\d+) (\d+) (\d+)$/.exec(lines[0]);
          assert.ok(driverLine);
          const first = JSON.parse(lines[1]), last = JSON.parse(lines[2]);
          assert.equal(Number(driverLine[1]), selected.child.pid);
          assert.equal(first.pid, selected.child.pid);
          assert.equal(Number(driverLine[2]), original.group);
          assert.equal(original.group, selected.child.pid);
          assert.equal(first.ppid, process.pid);
          assert.equal(first.execPath, node);
          assert.deepEqual(first.argv, [node, entry, 'TEST literal ; $ value']);
          assert.equal(first.cwd, root); assert.equal(first.home, root);
          assert.equal(first.sentinel, env.TEST_EXEC_SENTINEL);
          assert.equal(first.fd52, null); assert.equal(first.fd4096, null);
          assert.deepEqual(last, { event: 'TEST_EOF', input: 'TEST original stdin\n' });
          assert.equal(result.stderr, 'TEST_STDERR\n');
          assert.equal(absent(selected.child.pid, original), true);
          assert.deepEqual(identity(sibling.child.pid), siblingIdentity);
        } finally { await stopOriginal(selected); }
      });
    }

    await t.test('unexpected close_range refusal never reaches target Node', async () => {
      const selected = retainedChild(owned, driver, ['refuse', stage.path, '--', node, entry], { cwd: root, env });
      const result = await selected.completed;
      assert.equal(result.code, 125); assert.equal(result.signal, null);
      assert.match(result.stdout, /^TEST_DRIVER /);
      assert.equal(result.stdout.includes('TEST_NODE_READY'), false);
      assert.equal(result.stderr, 'Agent Teams: isolated Node launch failed\n');
      assert.deepEqual(identity(sibling.child.pid), siblingIdentity);
    });

    await t.test('Stop remains on the original child; a live sibling survives', async () => {
      held = retainedChild(owned, driver, ['normal', stage.path, '--', node, entry], { cwd: root, env, detached: true });
      await held.started;
      const original = identity(held.child.pid);
      held.child.kill('SIGTERM');
      const result = await held.completed;
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(absent(held.child.pid, original), true);
      assert.deepEqual(identity(sibling.child.pid), siblingIdentity);
    });

    await t.test('a replaced manifest or image cannot become the captured launcher', () => {
      const bad = join(root, 'changed');
      mkdirSync(bad, { mode: 0o755 });
      copyFileSync(join(stage.directory, 'manifest.json'), join(bad, 'manifest.json'));
      copyFileSync(stage.path, join(bad, 'node-exec')); chmodSync(join(bad, 'node-exec'), 0o755);
      const captured = captureLinuxNodeExecArtifact(bad);
      const manifest = JSON.parse(readFileSync(join(bad, 'manifest.json'), 'utf8'));
      writeFileSync(join(bad, 'manifest.json'), JSON.stringify({ ...manifest, sourceSha256: '0'.repeat(64) }));
      assert.throws(() => validateLinuxNodeExecArtifact(captured));
      assert.throws(() => captureLinuxNodeExecArtifact(bad));
      copyFileSync(join(stage.directory, 'manifest.json'), join(bad, 'manifest.json'));
      writeFileSync(join(bad, 'node-exec'), 'TEST changed image');
      assert.throws(() => captureLinuxNodeExecArtifact(bad));
    });
    assert.equal(sha(node), nodeSha256);
  } finally {
    await cleanup();
  }
});
