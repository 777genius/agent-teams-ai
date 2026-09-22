// Disposable Node-only fixture. Never launches Electron, an agent, or a user project.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const [mode, scriptPath] = process.argv.slice(2);
const { terminateChild } = require(scriptPath)._internal;
const silentDescendant = mode === 'silent-descendant' || mode === 'delayed-kill';
const descendantSource = `
  process.on('SIGTERM', () => {});
  // Last-resort fixture lifetime, even if the outer test runner is interrupted.
  setTimeout(() => process.exit(1), 6000);
  process.send('ready');
  process.disconnect();
`;
const leaderSource =
  mode === 'normal'
    ? `
  console.log('fixture-ready');
  setTimeout(() => process.exit(1), 6000);
`
    : `
  const descendant = require('node:child_process').spawn(process.execPath,
    ['-e', ${JSON.stringify(descendantSource)}],
    { stdio: ['ignore', ${JSON.stringify(silentDescendant ? 'ignore' : 'inherit')}, ${JSON.stringify(silentDescendant ? 'ignore' : 'inherit')}, 'ipc'] });
  descendant.once('message', () => {
    console.log('descendant-pid:' + descendant.pid);
    console.log('fixture-ready');
    if (${JSON.stringify(mode)} === 'already-exited') process.exit(0);
  });
  setTimeout(() => process.exit(1), 6000);
`;
const child = spawn(process.execPath, ['-e', leaderSource], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let closeSeen = false;
let descendantPid;
const exited = new Promise((resolve) => child.once('exit', resolve));
const closed = new Promise((resolve) =>
  child.once('close', () => {
    closeSeen = true;
    resolve();
  })
);
const cleanup = () => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};
const watchdog = setTimeout(() => {
  console.error('TEST watchdog expired');
  process.exitCode = 1;
  cleanup();
}, 7000);
async function run() {
  await new Promise((resolve, reject) => {
    let log = '';
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      log += chunk;
      const pidMatch = /descendant-pid:(\d+)/.exec(log);
      if (pidMatch) descendantPid = Number(pidMatch[1]);
      if (log.includes('fixture-ready')) resolve();
    });
    child.stderr.resume();
  });
  if (mode === 'already-exited') {
    await exited;
    assert.equal(closeSeen, false);
  }
  const originalKill = process.kill;
  if (mode === 'delayed-kill') {
    process.kill = (pid, signal) => {
      if (pid === -child.pid && signal === 'SIGKILL') {
        // Model asynchronous signal delivery without letting the fixture escape cleanup.
        setTimeout(() => {
          try {
            originalKill.call(process, pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }, 75);
        return true;
      }
      return originalKill.call(process, pid, signal);
    };
  }
  try {
    await terminateChild(child, closed, process.platform, 2000);
  } finally {
    process.kill = originalKill;
  }
  assert.equal(closeSeen, true);
  assert.equal(child.stdout.readableEnded, true);
  assert.equal(child.stderr.readableEnded, true);
  if (silentDescendant) {
    assert.ok(descendantPid);
    const status = spawnSync('ps', ['-p', String(descendantPid), '-o', 'stat='], {
      encoding: 'utf8',
    });
    assert.ifError(status.error);
    assert.ok(status.status === 0 || status.status === 1);
    const state = status.stdout.trim();
    assert.ok(state === '' || /^[ZX]/.test(state), 'silent descendant survived shutdown');
  }
  console.log('cleanup verified: close=true');
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    clearTimeout(watchdog);
  });
