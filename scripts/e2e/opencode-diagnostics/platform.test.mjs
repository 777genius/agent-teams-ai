import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
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
  allocateIsolatedCdpPort,
  assertPortAvailable,
  windowsProcessListenerSnapshot,
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
test('one fresh Windows interpreter retains ordered original process and listener observations', () => {
  const launcher = { pid: 42, parent: 1, birth: '2026-09-10T01:00:00.0000000Z', executable: 'C:\\TEST\\app.exe' };
  const child = { pid: 43, parent: 42, birth: '2026-09-10T01:00:00.0000001Z' };
  const processQuery = "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress";
  const listenerQuery = 'Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "State = 2 AND LocalPort = 9222" -Property OwningProcess | Select-Object -ExpandProperty OwningProcess';
  let calls = 0;
  const execute = script => {
    calls++;
    assert.equal(script.split(processQuery).length, 2);
    assert.equal(script.split(listenerQuery).length, 2);
    assert(script.indexOf(processQuery) < script.indexOf(listenerQuery));
    return '\uFEFF' + JSON.stringify(calls === 1
      ? { processes: '\uFEFF' + JSON.stringify(launcher), listeners: '42\r\n42\r\n' }
      : { processes: JSON.stringify([launcher, child]), listeners: '43\r\n43\r\n' });
  };
  const first = windowsProcessListenerSnapshot(undefined, execute);
  assert.equal(calls, 1);
  assert.deepEqual(first, { processes: [launcher], listeners: [42] });
  const second = windowsProcessListenerSnapshot(undefined, execute);
  assert.equal(calls, 2);
  assert.deepEqual(second, { processes: [launcher, child], listeners: [43] });
  const tree = ownedTree(second.processes, launcher);
  sameIdentity(child, tree.find(row => row.pid === child.pid));
  assertListenerOwnership(second.listeners, tree);
  assert.throws(() => ownedTree(second.processes, { ...launcher, birth: 'reused' }));
  assert.throws(() => sameIdentity(child, { ...child, birth: 'reused' }));
  assert.throws(() => assertListenerOwnership([99], tree));
  assert.throws(() => assertListenerOwnership([43, 99], tree));
  assert.throws(() => assertListenerOwnership([], tree));
});
test('combined Windows observations reject malformed envelopes and preserve executor failure', () => {
  let calls = 0;
  const empty = () => { calls++; return JSON.stringify({ processes: '', listeners: '' }); };
  for (const port of [0, 1023, 65536, 1.5, NaN, '9222'])
    assert.throws(() => windowsProcessListenerSnapshot(port, empty));
  assert.equal(calls, 0, 'invalid port refuses before any observation');
  assert.deepEqual(windowsProcessListenerSnapshot(9222, empty), { processes: [], listeners: [] });
  assert.equal(calls, 1);
  const invalid = [null, [], 1, {}, { processes: '[]' }, { listeners: '' },
    { processes: '[]', listeners: '', extra: true }, { processes: [], listeners: '' },
    { processes: '[]', listeners: null }, { processes: 'not JSON', listeners: '' },
    { processes: '{"pid":42,"parent":1}', listeners: '' },
    { processes: '[{"pid":"42","parent":1,"birth":"TEST"}]', listeners: '' },
    { processes: '[]', listeners: 'not a pid' }, { processes: '[]', listeners: '0' }];
  for (const value of invalid) {
    let attempts = 0;
    assert.throws(() => windowsProcessListenerSnapshot(9222, () => { attempts++; return JSON.stringify(value); }));
    assert.equal(attempts, 1, 'invalid observation is never retried');
  }
  assert.throws(() => windowsProcessListenerSnapshot(9222, () => ''));
  const failure = new Error('TEST original interpreter failure');
  let attempts = 0;
  assert.throws(() => windowsProcessListenerSnapshot(9222, () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 1, 'executor failure is preserved without fallback');
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
test('isolated CDP port stays bound to the selected dev launcher', async () => {
  const port = await allocateIsolatedCdpPort();
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  await assertPortAvailable(port);
  assert.deepEqual(launchCommand('linux', port), {
    command: 'pnpm', args: ['dev', '--remoteDebuggingPort', String(port), '--noSandbox'],
  });
  assert.equal(launchCommand('win32', port).args.at(-1), `pnpm dev --remoteDebuggingPort ${port} --noSandbox`);
  assert.throws(() => launchCommand('win32', 0));
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

test('Windows phase observations use the original phase clocks and cannot bypass admission', () => {
  const source = readFileSync(new URL('../../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8');
  const start = 'const remaining = () => {', end = 'const within = async action => {';
  assert.equal(source.split(start).length, 2);
  assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start), to = source.indexOf(end);
  assert(to > from);
  const create = runInThisContext('(function(assert, performance, proof, writeSync) { ' +
    "let startedAt = 100, outerDeadline = 300100, activeDeadline, activePhase = 'prepare'; " +
    source.slice(from, to) +
    'return { begin, state: () => ({ activeDeadline, activePhase }) }; })');
  const phase = 'one-explicit-same-Main-Retry';
  for (const writerThrows of [false, true]) {
    const calls = [], lines = [], proof = { phases: [] };
    let now = 110;
    const original = create(assert, { now: () => { calls.push('clock'); return now++; } }, proof, (fd, line) => {
      calls.push('write'); assert.equal(fd, 1); lines.push(line);
      if (writerThrows) throw new Error('TEST private stdout failure');
    });
    assert.equal(original.begin(phase, 10000), undefined);
    assert.deepEqual(calls, ['clock', 'clock', 'write', 'clock']);
    assert.deepEqual(proof, { phases: [{ phase, atMs: 11, budgetMs: 10000 }] });
    assert.deepEqual(original.state(), { activeDeadline: 10110, activePhase: phase });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      kind: 'TEST_WINDOWS_PACKAGED_UI_PHASE', phase, atMs: 11, budgetMs: 10000,
    });
    assert(lines[0].endsWith('\n')); assert(Buffer.byteLength(lines[0], 'utf8') <= 512);
    assert.equal(lines[0].includes('TEST private stdout failure'), false);
  }

  const calls = [], proof = { phases: [] }, cutoff = new Error('TEST original cutoff');
  let now = 110;
  const expired = create({
    ok: (admitted, message) => {
      assert.equal(message, 'Original Windows UI phase expired: ' + phase);
      if (!admitted) throw cutoff;
    },
  }, { now: () => { calls.push('clock'); return now++; } }, proof, (_fd, line) => {
    calls.push('write'); assert.equal(JSON.parse(line).phase, phase);
    now = 10110;
  });
  assert.throws(() => expired.begin(phase, 10000), error => error === cutoff);
  assert.deepEqual(calls, ['clock', 'clock', 'write', 'clock']);
  assert.deepEqual(expired.state(), { activeDeadline: 10110, activePhase: phase });
  assert.deepEqual(proof.phases, [{ phase, atMs: 11, budgetMs: 10000 }],
    'a recorded phase does not grant admission or claim completion');

  const oversized = '界'.repeat(180), omitted = [], retained = { phases: [] };
  let clocks = 0;
  const bounded = create(assert, { now: () => { clocks++; return 110; } }, retained,
    (...args) => omitted.push(args));
  bounded.begin(oversized, 10000);
  assert.equal(clocks, 3); assert.deepEqual(omitted, []);
  assert.deepEqual(retained.phases, [{ phase: oversized, atMs: 10, budgetMs: 10000 }],
    'the byte bound changes only the diagnostic output');
});

test('Windows census observations preserve original results, refusals and bounded diagnostics', () => {
  const source = readFileSync(new URL('../../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const section = (start, end) => {
    assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
    const from = source.indexOf(start), to = source.indexOf(end);
    assert(to > from); return source.slice(from, to);
  };
  const proof = { censusReads: [], censusReadsTruncated: false }, calls = [], original = {};
  let now = 110;
  const observe = runInThisContext('(function(performance, proof) {' +
    "const startedAt=100, activePhase='one-explicit-same-Main-Retry';" +
    section('const observeCensus = (operation, read) => {', 'const captureCensus = () => {') +
    'return observeCensus;})')({ now: () => { calls.push('clock'); return now++; } }, proof);
  assert.equal(observe('process-census', () => { calls.push('read'); return original; }), original);
  assert.deepEqual(calls, ['clock', 'read', 'clock']);
  assert.deepEqual(proof.censusReads, [{
    phase: 'one-explicit-same-Main-Retry', operation: 'process-census', startMs: 10, endMs: 11, returned: true,
  }]);
  const refusal = new Error('TEST original census refusal');
  calls.length = 0;
  assert.throws(() => observe('process-listener-snapshot', () => {
    calls.push('read'); throw refusal;
  }), error => error === refusal);
  assert.deepEqual(calls, ['clock', 'read', 'clock']); assert.equal(proof.censusReads.at(-1).returned, false);
  proof.censusReads = Object.freeze([]);
  assert.throws(() => observe('process-census', () => { throw refusal; }), error => error === refusal);
  assert.equal(observe('process-census', () => original), original, 'diagnostic failure preserves success too');
  proof.censusReads = Array(512).fill(null);
  assert.equal(observe('process-census', () => original), original);
  assert.equal(proof.censusReads.length, 512); assert.equal(proof.censusReadsTruncated, true);
});

test('actual live Windows renderer guard refuses empty, foreign and stale listener observations', () => {
  const source = readFileSync(new URL('../../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = 'const assertOwnedRenderer = () => {', end = 'const readJson = async path => {';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start), to = source.indexOf(end);
  assert(to > from);
  const create = runInThisContext('(function(assert, check, observeCensus, windowsProcessListenerSnapshot, validateCensus, lineage, remaining) {' +
    source.slice(from, to) + 'return assertOwnedRenderer;})');
  const main = { pid: 42, parent: 1, birth: '2026-09-10T01:00:00.0000000Z' };
  const renderer = { pid: 43, parent: 42, birth: '2026-09-10T01:00:00.0000001Z' };
  const foreign = { pid: 99, parent: 1, birth: '2026-09-10T01:00:00.0000002Z' };
  const lineage = [main, renderer];
  const exercise = ({ census = [main, renderer, foreign], listeners = '43',
    initialError, executorError, censusError, closingError } = {}) => {
    const calls = [];
    const guard = create(assert, () => {
      calls.push('check'); if (initialError) throw initialError;
    }, (operation, read) => {
      calls.push(operation); return read();
    }, () => {
      calls.push('snapshot');
      return windowsProcessListenerSnapshot(9222, () => {
        calls.push('execute'); if (executorError) throw executorError;
        return JSON.stringify({ processes: JSON.stringify(census), listeners });
      });
    }, value => {
      calls.push('validate'); assert.deepEqual(value, census);
      if (censusError) throw censusError;
      return value;
    }, lineage, () => {
      calls.push('remaining'); if (closingError) throw closingError;
    });
    return { calls, run: () => { guard(); calls.push('admitted'); } };
  };
  const throughCensus = ['check', 'process-listener-snapshot', 'snapshot', 'execute', 'validate'];
  for (const listeners of ['43', '43\r\n43\r\n42\r\n']) {
    const current = exercise({ listeners });
    current.run();
    assert.deepEqual(current.calls, [...throughCensus, 'remaining', 'admitted']);
  }
  for (const options of [
    { listeners: '' },
    { listeners: '99' },
    { listeners: '43\n99' },
    { listeners: '44' },
    { census: [main, foreign] },
    { census: [main, { ...renderer, birth: 'reused' }, foreign] },
  ]) {
    const refused = exercise(options);
    assert.throws(refused.run, /CDP listener belongs to this original Main family/);
    assert.deepEqual(refused.calls, throughCensus, 'no final admission follows a refused listener set');
  }
  for (const [key, expected] of [
    ['initialError', ['check']],
    ['executorError', throughCensus.slice(0, -1)],
    ['censusError', throughCensus],
    ['closingError', [...throughCensus, 'remaining']],
  ]) {
    const failure = new Error('TEST original live guard refusal: ' + key);
    const refused = exercise({ [key]: failure });
    assert.throws(refused.run, error => error === failure);
    assert.deepEqual(refused.calls, expected, 'the original refusal stops before caller admission');
  }
});
