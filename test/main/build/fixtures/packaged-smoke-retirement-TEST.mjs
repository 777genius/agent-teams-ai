// Native procfs retirement regression. The injected boundary controls timing;
// the retiring case gets EACCES from the kernel and checks independent metadata.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = fileURLToPath(import.meta.url);

async function worker(helper, mode) {
  assert.notEqual(process.getuid(), 0, 'The kernel permission race requires an unprivileged user');
  const { createPackagedSmokeOwnership } = await import(pathToFileURL(helper).href);
  const ownership = createPackagedSmokeOwnership();
  const originalLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(line);
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready\\n");setTimeout(()=>process.exit(90),10000)'],
    {
      env: { PATH: '/usr/bin:/bin', ...ownership.environment },
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  const originalOpen = fs.openSync;
  const originalKill = process.kill;
  const signals = [];
  const native = () => {
    try {
      const raw = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      const fields = raw
        .slice(raw.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return { pid: child.pid, birth: fields[19], state: fields[0] };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
      throw error;
    }
  };
  let first;
  let terminal;
  let rawError;
  let hookCalled = false;
  let sampleError;
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });
    first = native();
    assert(first && !/^[ZX]/.test(first.state));
    assert(ownership.begin(child.pid).some((identity) => identity.pid === child.pid));
    fs.openSync = function (pathname, ...args) {
      if (pathname !== `/proc/${child.pid}/environ` || (hookCalled && mode !== 'live'))
        return originalOpen.call(this, pathname, ...args);
      hookCalled = true;
      assert.equal(native()?.birth, first.birth);
      if (mode === 'retired') {
        // A synchronous inventory keeps Node from reaping the child while the
        // independent oracle observes the same-generation native zombie.
        originalKill(child.pid, 'SIGTERM');
        const deadline = Date.now() + 1000;
        do {
          terminal = native();
          if (!terminal || /^[ZX]/.test(terminal.state)) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        } while (Date.now() < deadline);
        assert(terminal && /^[ZX]/.test(terminal.state));
        assert.equal(terminal.birth, first.birth);
        try {
          return originalOpen.call(this, pathname, ...args);
        } catch (error) {
          rawError = error.code;
          throw error;
        }
      }
      // Only the I/O refusal is injected for the negative control. The real
      // process stays alive at its independently verified native birth.
      terminal = native();
      rawError = 'EACCES';
      throw Object.assign(new Error('TEST denied environment inspection'), { code: rawError });
    };
    process.kill = (pid, signal) => {
      if (signal !== 0) signals.push({ pid, signal });
      return originalKill(pid, signal);
    };
    syncBuiltinESMExports();
    try {
      ownership.sample();
    } catch (error) {
      sampleError = error.message;
    }
    assert(hookCalled);
    assert.equal(rawError, 'EACCES');
    if (mode === 'retired') {
      assert.equal(sampleError, undefined);
      assert.deepEqual(ownership.finish().remaining, []);
    } else {
      assert.match(sampleError, /Unable to inspect packaged smoke ownership/);
      assert.equal(native()?.birth, first.birth);
      assert(!/^[ZX]/.test(native().state));
      assert.throws(
        () => ownership.signal('SIGKILL'),
        /Unable to inspect packaged smoke ownership/
      );
      assert.throws(() => ownership.finish(), /Unable to inspect packaged smoke ownership/);
      assert.equal(
        logs.some((line) => line.includes('"phase":"final"')),
        false
      );
    }
    assert.deepEqual(signals, [], 'An inspection refusal must never grant signal authority');
  } finally {
    fs.openSync = originalOpen;
    process.kill = originalKill;
    syncBuiltinESMExports();
    console.log = originalLog;
    const still = native();
    if (first && still?.birth === first.birth && !/^[ZX]/.test(still.state))
      originalKill(child.pid, 'SIGKILL');
    await closed;
  }
  assert.equal(native(), null);
  console.log(
    JSON.stringify({
      mode,
      nativePermissionRace: mode === 'retired',
      liveRefused: mode === 'live',
      ownedRemaining: [],
    })
  );
}

async function driver(mode) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-retirement-TEST-'));
  try {
    // Root bypasses this procfs permission check. Copy only the test helper and
    // executable into a disposable traversable directory before dropping uid.
    fs.chmodSync(sandbox, 0o755);
    const helper = path.join(sandbox, 'helper.ts');
    const workerPath = path.join(sandbox, 'worker.mjs');
    fs.copyFileSync(
      path.resolve(
        import.meta.dirname,
        '../../../../scripts/electron-builder/packagedSmokeOwnedProcesses.ts'
      ),
      helper
    );
    fs.copyFileSync(fixture, workerPath);
    const root = process.getuid() === 0;
    const executable = root ? path.join(sandbox, 'node') : process.execPath;
    if (root) {
      fs.copyFileSync(process.execPath, executable);
      fs.chmodSync(executable, 0o755);
    }
    const output = await new Promise((resolve, reject) => {
      execFile(
        executable,
        [workerPath, '--worker', helper, mode],
        {
          cwd: sandbox,
          env: { PATH: '/usr/bin:/bin' },
          ...(root ? { uid: 65534, gid: 65534 } : {}),
          encoding: 'utf8',
          timeout: 12_000,
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          else resolve(stdout);
        }
      );
    });
    process.stdout.write(output);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

assert.equal(process.platform, 'linux');
if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4]);
else await driver(process.argv[2]);
