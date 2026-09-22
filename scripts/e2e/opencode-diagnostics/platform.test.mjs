import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  parseWindowsProcesses,
  windowsCleanupEvidence,
  parseUnixProcesses,
  parseListeners,
  ownedTree,
  sameIdentity,
  assertListenerOwnership,
  fixtureShim,
  isolatedEnvironment,
  launchCommand,
} from './platform.mjs';

test('OS process and listener output parsing fails closed', () => {
  assert.deepEqual(
    parseWindowsProcesses('\uFEFF{"pid":42,"parent":1,"birth":"2026-09-10T01:02:03.1234567Z"}'),
    [{ pid: 42, parent: 1, birth: '2026-09-10T01:02:03.1234567Z' }]
  );
  assert.deepEqual(parseWindowsProcesses('[]'), []);
  assert.equal(
    parseUnixProcesses(' 42  1 Thu Sep 10 01:02:03 2026\n')[0].birth,
    'Thu Sep 10 01:02:03 2026'
  );
  assert.deepEqual(parseListeners('42\r\n42\r\n99\r\n'), [42, 99]);
  assert.throws(() => parseWindowsProcesses('{"pid":42,"parent":1}'));
  assert.throws(() => parseUnixProcesses('garbage'));
  assert.throws(() => parseListeners('not a pid'));
});
test('ownership rejects stale launchers, reused child PIDs and unrelated listeners', () => {
  const launcher = { pid: 42, parent: 1, birth: '2026-09-10T01:00:00.0000000Z' };
  const child = { pid: 43, parent: 42, birth: '2026-09-10T01:00:00.0000001Z' };
  const tree = ownedTree(
    [launcher, child, { pid: 99, parent: 1, birth: '2026-09-10T01:00:01.0000000Z' }],
    launcher
  );
  assert.deepEqual(tree, [launcher, child]);
  const stale = { pid: 90, parent: 43, birth: '2026-09-10T01:00:00.0000000Z' };
  assert.deepEqual(ownedTree([launcher, child, stale], launcher), [launcher, child]);
  assert.deepEqual(
    ownedTree(
      [launcher, { ...stale, parent: 42, birth: '2026-09-09T00:00:00.0000000Z' }],
      launcher
    ),
    [launcher]
  );
  assertListenerOwnership([43], tree);
  for (const ids of [[], [99], [43, 99], [42]])
    assert.throws(() => assertListenerOwnership(ids, tree));
  assert.throws(() => ownedTree([{ ...launcher, birth: 'reused' }, child], launcher));
  assert.throws(() => ownedTree([child], launcher));
  assert.throws(() => sameIdentity(child, { ...child, birth: 'reused' }));
});
test('native shims quote absolute paths with spaces and reject expansion syntax', () => {
  const shim = fixtureShim(
    'C:\\Program Files\\node.exe',
    'C:\\test & fixture\\fixture.cjs',
    'opencode',
    'win32'
  );
  assert(
    shim.includes('"C:\\Program Files\\node.exe" "C:\\test & fixture\\fixture.cjs" opencode %*')
  );
  assert(shim.includes('DisableDelayedExpansion'));
  assert.throws(() => fixtureShim('C:\\%evil%\\node.exe', 'C:\\fixture.cjs', 'opencode', 'win32'));
  assert.throws(() => fixtureShim('/node', '/fixture', 'agent', 'linux'));
  assert.equal(launchCommand('win32').args[0], '/d');
});
test('environment drops inherited provider/config and runtime overrides', () => {
  const data = {
    home: '/test/home',
    temp: '/test/tmp',
    bin: '/test/bin',
    userData: '/test/user',
    node: '/node',
    opencode: '/test/opencode',
    orchestrator: '/test/orchestrator',
  };
  const env = isolatedEnvironment(data, {
    Path: '/tools',
    ProgramFiles: 'C:\\Program Files',
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    OPENAI_API_KEY: 'secret',
    OPENCODE_CONFIG: '/real',
    CLAUDE_DEV_RUNTIME_ROOT: '/real',
    NODE_OPTIONS: '--require evil',
    APPDATA: '/real',
  });
  assert.equal(env.ProgramFiles, 'C:\\Program Files');
  assert.equal(env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CLAUDE_DEV_RUNTIME_ROOT, undefined);
  assert.equal(env.OPENCODE_BIN_PATH, data.opencode);
  assert.equal(env.HOME, data.home);
  assert(env.APPDATA.startsWith(path.normalize(data.home)));
});
test('real fixture permits diagnostic queries only, and Unix shim handles spaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-test space-'));
  try {
    const script = path.join(root, 'fixture.cjs');
    await copyFile(new URL('./fixture.cjs', import.meta.url), script);
    await writeFile(path.join(root, 'scenario'), 'ready');
    const run = (role, ...args) =>
      spawnSync(process.execPath, [script, role, ...args], { encoding: 'utf8' });
    assert.equal(run('opencode', '--version').stdout.trim(), '1.16.0');
    for (const role of ['opencode', 'orchestrator', 'unknown']) {
      for (const args of [['run'], ['--version', 'run'], ['runtime', 'launch'], ['auth', 'login']])
        assert.equal(run(role, ...args).status, 64);
    }
    const status = JSON.parse(
      run('orchestrator', 'runtime', 'status', '--json', '--provider', 'opencode', '--summary')
        .stdout
    );
    assert(Object.values(status.providers).every((p) => p.capabilities.teamLaunch === false));
    await writeFile(path.join(root, 'scenario'), 'version-exit');
    assert.equal(run('opencode', '--version').status, 9);
    if (process.platform !== 'win32') {
      const shim = path.join(root, 'opencode');
      await writeFile(shim, fixtureShim(process.execPath, script, 'opencode'), { mode: 0o755 });
      assert.equal(spawnSync(shim, ['--version']).status, 9);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout fixture stays live until its owning test terminates it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-timeout-'));
  let child;
  try {
    const script = path.join(root, 'fixture.cjs');
    await copyFile(new URL('./fixture.cjs', import.meta.url), script);
    await writeFile(path.join(root, 'scenario'), 'version-timeout');
    child = spawn(process.execPath, [script, 'opencode', '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Fixture did not enter timeout scenario')),
        5000
      );
      child.once('error', reject);
      child.stderr.once('data', (data) => {
        clearTimeout(timer);
        assert.match(String(data), /waiting for fixture/);
        resolve();
      });
    });
    assert.equal(child.exitCode, null);
    child.kill();
    await exit;
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows cleanup evidence retains current PID through independent read-only queries', { skip: process.platform !== 'win32' }, () => {
  const evidence = windowsCleanupEvidence([process.pid]);
  assert(evidence.cim.some(entry => entry.pid === process.pid && entry.creationDate));
  assert(evidence.native.some(entry => entry.pid === process.pid && entry.startTime && entry.hasExited === false));
  assert(Array.isArray(evidence.tcp));
});
