// Disposable Node-only fixture. Never launches Electron, an agent, or a user project.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const [mode, scriptPath] = process.argv.slice(2);
const { terminateChild } = require(scriptPath)._internal;
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
    { stdio: ['ignore', ${JSON.stringify(mode === 'silent-descendant' ? 'ignore' : 'inherit')}, ${JSON.stringify(mode === 'silent-descendant' ? 'ignore' : 'inherit')}, 'ipc'] });
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
}, 3000);
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
  await terminateChild(child, closed, process.platform, 100);
  assert.equal(closeSeen, true);
  assert.equal(child.stdout.readableEnded, true);
  assert.equal(child.stderr.readableEnded, true);
  if (mode === 'silent-descendant') {
    assert.ok(descendantPid);
    // Orphans can remain as zombies until Linux PID 1 reaps them. Verify they
    // cannot execute, rather than mistaking an unreaped PID for a live process.
    const deadline = Date.now() + 1000;
    let running = true;
    while (running && Date.now() < deadline) {
      const status = spawnSync('ps', ['-p', String(descendantPid), '-o', 'stat='], {
        encoding: 'utf8',
      });
      assert.ifError(status.error);
      assert.ok(status.status === 0 || status.status === 1);
      running = status.stdout.trim() !== '' && !status.stdout.trim().startsWith('Z');
      if (running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running, false, 'silent descendant survived shutdown');
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
