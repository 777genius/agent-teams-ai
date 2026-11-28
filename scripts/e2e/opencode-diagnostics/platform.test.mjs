import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MessageChannel, Worker } from 'node:worker_threads';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  parseWindowsProcesses,
  processes,
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
  windowsProcessSnapshot,
  windowsQueryChildren,
  createWindowsProcessObserver,
  createWindowsProcessObservationClient,
  serveWindowsProcessObserver,
} from './platform.mjs';
import { retainPackagedLineage, packagedOrphanObservation } from './packaged.mjs';

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
test('captured PID census rejects unknown birth without rejecting unrelated system rows', () => {
  const known = { pid: 42, parent: 1, birth: '2026-09-10T01:02:03.1234567Z' };
  const system = { pid: 0, parent: 0, birth: null };
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([system, known]), [42]), [known]);
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([system]), [42]), []);
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([system, known]), []), [known]);
  const reused = { ...known, birth: '2026-09-10T01:02:04.1234567Z' };
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([system, reused]), [42]), [reused]);
  for (const birth of [null, undefined, '', 'unavailable', 123]) {
    assert.throws(() => parseWindowsProcesses(
      JSON.stringify([system, { ...known, birth }]), [42]), /Invalid OS process birth identity/);
  }
  assert.deepEqual(parseWindowsProcesses('[]', Array(500).fill(42)), []);
});
test('captured PID census validates bounded positive integers before an OS read', () => {
  for (const requiredPids of [null, {}, '42', [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1],
    ['42; exit 0'], Array(501).fill(42)]) {
    assert.throws(() => processes(requiredPids), /Invalid required process PIDs/);
    assert.throws(() => parseWindowsProcesses('[]', requiredPids), /Invalid required process PIDs/);
  }
});
test('one fresh Windows interpreter retains ordered original process and listener observations', () => {
  const launcher = { pid: 42, parent: 1, birth: '2026-09-10T01:00:00.0000000Z', executable: 'C:\\TEST\\app.exe' };
  const child = { pid: 43, parent: 42, birth: '2026-09-10T01:00:00.0000001Z' };
  const processQuery = "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress";
  const listenerQuery = "Get-CimInstance -Namespace 'Root\\StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter \"LocalPort = 9222 AND State = 2\" | Select-Object -ExpandProperty OwningProcess";
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

test('selected Windows port query retains complete fresh process and owner observations', () => {
  const launcher = { pid: 42, parent: 1, birth: '2026-09-10T01:00:00.0000000Z' };
  const child = { pid: 43, parent: 42, birth: '2026-09-10T01:00:00.0000001Z' };
  const foreign = { pid: 99, parent: 1, birth: '2026-09-10T01:00:00.0000002Z' };
  const reused = { ...child, birth: '2026-09-10T01:00:00.0000003Z' };
  const processQuery = "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress";
  const expectedScript = port => '$TESTProcessOutput = ' + processQuery + ';\n' +
    "$TESTListenerOutput = Get-CimInstance -Namespace 'Root\\StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter \"LocalPort = " +
    port + ' AND State = 2" | Select-Object -ExpandProperty OwningProcess;\n' +
    '[pscustomobject]@{ processes = [string]$TESTProcessOutput; ' +
    'listeners = [string]($TESTListenerOutput -join [Environment]::NewLine) } | ConvertTo-Json -Compress';
  const observations = [
    { processes: [launcher, child, foreign], listeners: '43\r\n43\r\n', owners: [43] },
    { processes: [launcher, child, foreign], listeners: '43\r\n99\r\n43\r\n99\r\n', owners: [43, 99] },
    { processes: [launcher, reused, foreign], listeners: '43\r\n', owners: [43] },
    { processes: [launcher, foreign], listeners: '99\r\n99\r\n', owners: [99] },
  ];
  const ports = [undefined, 43127, undefined, 43127];
  let calls = 0;
  const samples = observations.map((observation, index) => {
    const result = windowsProcessListenerSnapshot(ports[index], script => {
      calls++;
      // Exact wiring only: native provider filtering and address-family coverage require Windows.
      assert.equal(script, expectedScript(ports[index] ?? 9222));
      return JSON.stringify({ processes: JSON.stringify(observation.processes), listeners: observation.listeners });
    });
    assert.equal(calls, index + 1, 'every observation uses one fresh executor call');
    assert.deepEqual(result, { processes: observation.processes, listeners: observation.owners });
    return result;
  });
  assertListenerOwnership(samples[0].listeners, ownedTree(samples[0].processes, launcher));
  assert.throws(() => assertListenerOwnership(samples[1].listeners, ownedTree(samples[1].processes, launcher)));
  assert.throws(() => sameIdentity(child, samples[2].processes.find(row => row.pid === child.pid)));
  assert.throws(() => assertListenerOwnership(samples[3].listeners, ownedTree(samples[3].processes, launcher)));
  assert.equal(calls, observations.length);
});
test('Windows listener executor failures never admit partial output or fall back', () => {
  const complete = JSON.stringify({ processes: '[{"pid":42,"parent":1,"birth":"TEST"}]', listeners: '43\r\n' });
  const failures = [
    Object.assign(new Error('TEST listener provider failed after output'), {
      stdout: complete, stderr: 'TEST provider failure', status: 1,
    }),
    Object.assign(new Error('TEST listener namespace unavailable'), {
      stdout: '{"processes":"[]","listeners":"43', stderr: 'TEST missing namespace', status: 1,
    }),
    Object.assign(new Error('TEST listener interpreter timed out'), {
      stdout: complete, stderr: 'TEST timeout after output', status: null, signal: 'SIGTERM', code: 'ETIMEDOUT',
    }),
  ];
  for (const failure of failures) {
    const fields = { ...failure };
    let calls = 0;
    assert.throws(() => windowsProcessListenerSnapshot(43127, () => {
      calls++; throw failure;
    }), error => error === failure);
    assert.equal(calls, 1, 'partial stdout never creates an accepted observation or retry');
    assert.deepEqual({ ...failure }, fields);
  }
});

test('Windows observer capture binds the executing query inside each original read', () => {
  const driver = { pid: 100, parent: 90, birth: '2026-01-01T00:00:01.0000000Z' };
  const observer = { pid: 300, parent: 100, birth: '2026-01-01T00:00:03.0000000Z' };
  const child = { pid: 301, parent: 300, birth: '2026-01-01T00:00:03.0000001Z' };
  const census = [driver, observer, child], scripts = [];
  const execute = script => {
    scripts.push(script);
    assert.equal(script.split('Get-CimInstance Win32_Process').length, 2);
    assert.equal(script.split('observerPid = [int]$PID').length, 2);
    assert.doesNotMatch(script, /Get-Process|Start-Process|Start-Sleep/);
    const listeners = script.includes('MSFT_NetTCPConnection');
    assert.equal(script.split('MSFT_NetTCPConnection').length, listeners ? 2 : 1);
    if (listeners) assert.ok(script.indexOf('Win32_Process') < script.indexOf('MSFT_NetTCPConnection'));
    return '\uFEFF' + JSON.stringify({
      processes: JSON.stringify(census), observerPid: observer.pid,
      ...(listeners ? { listeners: '100\r\n' } : {}),
    });
  };
  const processOnly = windowsProcessSnapshot(execute);
  assert.deepEqual(processOnly, { processes: census, observer });
  const combined = windowsProcessListenerSnapshot(9222, execute, true);
  assert.deepEqual(combined, { processes: census, listeners: [100], observer });
  assert.equal(scripts.length, 2, 'one existing query per call, without fallback');
  assert.deepEqual(windowsQueryChildren(combined.processes, combined.observer, driver), [child]);
  assert.deepEqual(census, [driver, observer, child], 'observations do not alter the original rows');
});

test('Windows observer envelopes reject absent, ambiguous and malformed query identities', () => {
  const observer = { pid: 300, parent: 100, birth: '2026-01-01T00:00:03.0000000Z' };
  const valid = { processes: JSON.stringify([observer]), observerPid: observer.pid };
  const invalid = [
    { ...valid, observerPid: undefined }, { ...valid, observerPid: null },
    { ...valid, observerPid: '300' }, { ...valid, observerPid: 0 }, { ...valid, observerPid: 300.5 },
    { ...valid, observerPid: 301 }, { ...valid, processes: '[]' },
    { ...valid, processes: JSON.stringify([observer, observer]) },
    { ...valid, processes: JSON.stringify([{ ...observer, parent: 0 }]) },
    { ...valid, processes: JSON.stringify([{ ...observer, birth: 'reused' }]) },
    { ...valid, processes: JSON.stringify([{ ...observer, birth: '2026-02-30T00:00:03.0000000Z' }]) },
    { ...valid, processes: JSON.stringify([{ ...observer, birth: '2026-01-01T00:00:03Z' }]) },
    { ...valid, extra: true }, { ...valid, processes: [] },
  ];
  for (const value of invalid) for (const combined of [false, true]) {
    let calls = 0;
    const execute = () => {
      calls++;
      return JSON.stringify({ ...value, ...(combined ? { listeners: '' } : {}) });
    };
    assert.throws(() => combined ? windowsProcessListenerSnapshot(9222, execute, true) : windowsProcessSnapshot(execute));
    assert.equal(calls, 1, 'invalid self evidence cannot trigger another query');
  }
  let calls = 0;
  assert.throws(() => windowsProcessListenerSnapshot(9222, () => { calls++; }, 'true'));
  assert.equal(calls, 0, 'observer mode must be explicit before observation');
  const failure = new Error('TEST original observer interpreter refusal');
  for (const combined of [false, true]) {
    calls = 0;
    const execute = () => { calls++; throw failure; };
    assert.throws(() => combined ? windowsProcessListenerSnapshot(9222, execute, true) : windowsProcessSnapshot(execute),
      error => error === failure);
    assert.equal(calls, 1, 'original executor failure propagates unchanged');
  }
});

test('actual Windows census guard explains only current query children without App or signal authority', () => {
  const source = readFileSync(new URL('../../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = 'const validateCensus = (snapshot, observer) => {', end = 'const observeCensus = (operation, read) => {';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start), to = source.indexOf(end); assert.ok(to > from);
  const create = runInThisContext('(function(assert, controllerIdentity, driverIdentity, main, proof, history,' +
    'ownedTree, sameIdentity, retainPackagedLineage, packagedOrphanObservation, windowsQueryChildren, remaining) {' +
    "let lineage=history; const acceptingExit=false, activePhase='TEST original phase';" +
    source.slice(from, to) + 'return { validate: validateCensus, lineage: () => lineage };})');
  const controller = { pid: 90, parent: 80, birth: '2026-01-01T00:00:00.0000000Z' };
  const driver = { pid: 100, parent: 90, birth: '2026-01-01T00:00:01.0000000Z' };
  const main = { pid: 200, parent: 100, birth: '2026-01-01T00:00:02.0000000Z' };
  const oldParent = { pid: 300, parent: 200, birth: '2026-01-01T00:00:03.0000000Z' };
  const observer = { pid: 300, parent: 100, birth: '2026-01-01T00:00:04.0000000Z' };
  const child = { pid: 301, parent: 300, birth: '2026-01-01T00:00:04.0000001Z' };
  const census = [controller, driver, main, observer, child];
  const originalHistory = retainPackagedLineage([], [main, oldParent], 100).records;
  const original = packagedOrphanObservation(originalHistory, census);
  assert.equal(original.candidates.length, 1);
  assert.equal(original.candidates[0].relation, 'ambiguous-parent-identity', 'generic ambiguity oracle stays strict');
  const exercise = ({ snapshot = census, self = observer, history = originalHistory, entries = [] } = {}) => {
    const proof = { queryExplanations: entries }, calls = [];
    const guard = create(assert, controller, driver, main, proof, history,
      ownedTree, sameIdentity, (previous, proven) => retainPackagedLineage(previous, proven, 200),
      packagedOrphanObservation, windowsQueryChildren, () => { calls.push('original cutoff'); });
    return { proof, calls, lineage: guard.lineage, run: () => guard.validate(snapshot, self) };
  };
  const current = exercise();
  assert.equal(current.run(), census, 'full current census remains the returned observation');
  assert.deepEqual(current.calls, ['original cutoff']);
  assert.deepEqual(current.proof.queryExplanations, [{
    phase: 'TEST original phase', observer, driver, children: [child],
    observationOnly: true, signalAuthorized: false,
  }]);
  assert.deepEqual(current.lineage().map(({ pid, birth }) => ({ pid, birth })),
    [main, oldParent].map(({ pid, birth }) => ({ pid, birth })), 'query identities never enter App custody');
  const noChild = exercise({ snapshot: census.filter(row => row !== child) });
  noChild.run(); assert.deepEqual(noChild.proof.queryExplanations, []);
  const otherParent = { pid: 400, parent: 200, birth: oldParent.birth };
  const foreignChild = { pid: 401, parent: 400, birth: child.birth };
  const otherQuery = { pid: 500, parent: 100, birth: observer.birth };
  const refused = [
    { self: null }, { self: { ...observer, birth: oldParent.birth } },
    { self: { ...observer, extra: true } },
    { snapshot: census.filter(row => row !== observer) },
    { snapshot: [...census, { ...observer }] },
    { snapshot: census.map(row => row === driver ? { ...row, birth: 'reused' } : row) },
    { snapshot: census.map(row => row === driver ? { ...row, parent: 999 } : row) },
    { snapshot: census.map(row => row === observer ? { ...row, parent: 999 } : row),
      self: { ...observer, parent: 999 } },
    { snapshot: census.map(row => row === child ? { ...row, birth: observer.birth } : row) },
    { snapshot: census.map(row => row === child ? { ...row, birth: '2026-01-01T00:00:03.9999999Z' } : row) },
    { snapshot: census.map(row => row === child ? { ...row, birth: 'invalid' } : row) },
    { snapshot: census.map(row => row === child ? { ...row, birth: '2026-02-30T00:00:04.0000000Z' } : row) },
    { snapshot: [...census, foreignChild], history: [...originalHistory, otherParent] },
    { snapshot: [...census, otherQuery], self: otherQuery },
    { entries: Array(512).fill(null) }, { entries: Object.freeze([]) },
  ];
  for (const input of refused) {
    const result = exercise(input);
    assert.throws(result.run);
    assert.deepEqual(result.calls, [], 'no original admission follows unresolved provenance or overflow');
    assert.ok(!result.lineage().some(row => row.pid === child.pid), 'no query-child cleanup authority');
  }
  const previous = exercise({ snapshot: [...census.filter(row => row !== observer), otherQuery], self: otherQuery,
    entries: current.proof.queryExplanations });
  assert.throws(previous.run, 'an earlier explanation never authorizes a later query');
  assert.equal(packagedOrphanObservation(originalHistory, census).candidates[0].signalAuthorized, false);
});
function observerWorkerFixture() {
  const channel = new EventEmitter(), messages = [], inputs = [], launches = [];
  channel.postMessage = value => messages.push(value);
  channel.close = () => { channel.closed = true; };
  const child = new EventEmitter();
  child.pid = 71;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on('data', part => inputs.push(String(part)));
  let kills = 0;
  child.kill = () => { kills++; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  serveWindowsProcessObserver(channel, new Int32Array(new SharedArrayBuffer(4)),
    { executable: 'C:\\Windows\\PowerShell.exe', port: 43127 }, (...args) => { launches.push(args); return child; });
  child.emit('spawn');
  const reply = (sequence, processes, listeners = '') => JSON.stringify({ sequence,
    observation: JSON.stringify({ processes: JSON.stringify(processes), listeners }) }) + '\n';
  return { channel, child, messages, inputs, launches, reply, kills: () => kills,
    read: (sequence, timeoutMs = 1000) => channel.emit('message', { kind: 'read', sequence, timeoutMs }),
    close: () => channel.emit('message', { kind: 'close' }) };
}

test('persistent Windows query owner keeps one child and delivers fresh ordered snapshots without coalescing', async () => {
  const f = observerWorkerFixture();
  const first = [{ pid: 1, parent: 0, birth: '2026-09-10T01:02:03.0000000Z' }],
    second = [{ pid: 2, parent: 1, birth: '2026-09-10T01:02:04.0000000Z' }];
  f.read(1);
  const bytes = Buffer.from(f.reply(1, first, '11\r\n'));
  f.child.stdout.write(bytes.subarray(0, 17));
  assert.equal(f.messages.length, 1, 'incomplete output cannot become an observation');
  f.child.stdout.write(bytes.subarray(17));
  f.read(2); f.child.stdout.write(f.reply(2, second, '22\r\n'));
  assert.deepEqual(f.inputs, ['1\n', '2\n']); assert.equal(f.launches.length, 1);
  assert.deepEqual(f.messages, [{ kind: 'ready', pid: 71 },
    { kind: 'snapshot', sequence: 1, observation: { processes: first, listeners: [11] } },
    { kind: 'snapshot', sequence: 2, observation: { processes: second, listeners: [22] } }]);
  const script = Buffer.from(f.launches[0][1].at(-1), 'base64').toString('utf16le');
  const progress = script.indexOf("$ProgressPreference='SilentlyContinue'");
  assert.ok(progress >= 0 && progress < script.indexOf('while ('),
    'Windows module progress is disabled before any original query reaches stderr');
  assert.ok(script.indexOf('while (') < script.indexOf('Get-CimInstance Win32_Process'));
  assert.ok(script.indexOf('Get-CimInstance Win32_Process') < script.indexOf('MSFT_NetTCPConnection'));
  assert.ok(script.includes('LocalPort = 43127 AND State = 2'));
  f.close(); await Promise.resolve();
  assert.equal(f.kills(), 1); assert.equal(f.channel.closed, true);
  assert.deepEqual(f.messages.at(-1), { kind: 'closed', pid: 71, code: null, signal: 'SIGTERM', expected: true });
});

for (const kind of ['duplicate request', 'stale reply', 'malformed envelope', 'invalid birth', 'extra reply', 'stderr', 'partial close'])
test('persistent Windows query owner refuses ' + kind + ' and retires only its original child', async () => {
  const f = observerWorkerFixture(); f.read(1);
  if (kind === 'duplicate request') f.read(1);
  else if (kind === 'stale reply') f.child.stdout.write(f.reply(2, []));
  else if (kind === 'malformed envelope') f.child.stdout.write('{"sequence":1,"observation":null}\n');
  else if (kind === 'invalid birth') f.child.stdout.write(f.reply(1, [{ pid: 1, parent: 0, birth: 'not-a-birth' }]));
  else if (kind === 'extra reply') f.child.stdout.write(f.reply(1, []) + f.reply(1, []));
  else if (kind === 'stderr') f.child.stderr.write('TEST query failure');
  else { f.child.stdout.write(f.reply(1, []).slice(0, -1)); f.child.emit('close', 1, null); }
  await Promise.resolve();
  assert.equal(f.launches.length, 1); assert.deepEqual(f.inputs, ['1\n']);
  assert.equal(f.messages.some(row => row.kind === 'snapshot'), false);
  assert.equal(f.messages.filter(row => row.kind === 'failure').length, 1);
  assert.equal(f.messages.at(-1).kind, 'closed'); assert.equal(f.messages.at(-1).expected, false);
  assert.equal(f.kills(), kind === 'partial close' ? 0 : 1);
});

test('persistent Windows query timeout closes the original child and never accepts its late output', async () => {
  const f = observerWorkerFixture(); f.read(1, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  f.child.stdout.write(f.reply(1, []));
  assert.equal(f.kills(), 1); assert.equal(f.messages.some(row => row.kind === 'snapshot'), false);
  assert.equal(f.messages.at(-1).kind, 'closed'); assert.equal(f.messages.at(-1).expected, false);
});

function observerClientFixture(change = value => value) {
  const owner = { pid: 71, parent: 7, birth: '2026-11-17T00:00:00.0000000Z', executable: 'C:\\Windows\\PowerShell.exe' };
  const queue = [{ kind: 'ready', pid: 71 }], sent = [];
  let now = 0, closed = false;
  const channel = { postMessage(message) {
    sent.push(message);
    if (message.kind === 'read') queue.push(change({ kind: 'snapshot', sequence: message.sequence,
      observation: { processes: [{ ...owner }], listeners: [100 + message.sequence] } }));
    else queue.push({ kind: 'closed', pid: 71, code: null, signal: 'SIGTERM', expected: true });
  }, close() { closed = true; } };
  const client = createWindowsProcessObservationClient({ channel, wake: new Int32Array(new SharedArrayBuffer(4)),
    executable: owner.executable, driverPid: 7, exited: Promise.resolve({ code: 0 }),
    receive: () => queue.length ? { message: queue.shift() } : undefined,
    now: () => now, wait: (_wake, _index, _value, milliseconds) => { now += milliseconds; } });
  return { client, owner, queue, sent, closed: () => closed, setNow: value => { now = value; } };
}

test('synchronous Windows observer preserves every fresh invocation and binds the query child birth', async () => {
  const f = observerClientFixture();
  const first = f.client.snapshot(50), second = f.client.snapshot(50);
  assert.deepEqual(first.listeners, [101]); assert.deepEqual(second.listeners, [102]);
  assert.deepEqual(first.observer, { pid: f.owner.pid, parent: f.owner.parent, birth: f.owner.birth });
  assert.deepEqual(second.observer, first.observer, 'each query identity comes from that fresh validated census');
  assert.notEqual(first.observer, second.observer, 'observation-only metadata is not retained mutable authority');
  assert.deepEqual(f.sent.map(row => row.sequence), [1, 2]);
  assert.deepEqual(await f.client.close(50), { identity: f.owner, pid: 71, closed: true });
  assert.equal(f.closed(), true);
  assert.throws(() => f.client.snapshot(50), /closed or failed/);
});

for (const kind of ['missing', 'duplicate', 'parent', 'executable', 'birth', 'sequence'])
test('synchronous Windows observer refuses changed query child ' + kind + ' without another read', async () => {
  const f = observerClientFixture(value => {
    if (value.sequence === 1) return value;
    const rows = value.observation.processes;
    if (kind === 'missing') rows.length = 0;
    else if (kind === 'duplicate') rows.push({ ...rows[0] });
    else if (kind === 'sequence') value.sequence = 1;
    else rows[0][kind] = kind === 'parent' ? 8 : 'TEST changed';
    return value;
  });
  f.client.snapshot(50);
  assert.throws(() => f.client.snapshot(50));
  assert.throws(() => f.client.snapshot(50), /closed or failed/);
  assert.equal(f.sent.length, 2);
  await f.client.close(50);
});

test('synchronous Windows observation cannot outlive its original budget; expired close still requests retirement', async () => {
  const f = observerClientFixture(); f.queue.length = 0;
  assert.throws(() => f.client.snapshot(5), /Original Windows observation deadline/);
  assert.deepEqual(f.sent, [], 'no request before the original worker is ready');
  await assert.rejects(f.client.close(0));
  assert.deepEqual(f.sent, [{ kind: 'close' }]); assert.equal(f.closed(), true);
});

test('observer transport keeps real worker and TEST child ownership through synchronous reads and asynchronous close',
  { timeout: 15000 }, async () => {
    const childScript = `import { createInterface } from 'node:readline';
      const birth = new Date().toISOString(); let sequence = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        if (line !== String(++sequence)) throw new Error('TEST request order');
        const processes = JSON.stringify([{ pid: process.pid, parent: process.ppid, birth, executable: process.execPath }]);
        const observation = JSON.stringify({ processes, listeners: String(9000 + sequence) });
        process.stdout.write(JSON.stringify({ sequence, observation }) + '\\n');
      }`;
    const workerScript = `import { workerData } from 'node:worker_threads';
      import { spawn } from 'node:child_process';
      import { serveWindowsProcessObserver } from ${JSON.stringify(new URL('./platform.mjs', import.meta.url).href)};
      serveWindowsProcessObserver(workerData.channel, workerData.wake,
        { executable: process.execPath, port: 43127 }, () => spawn(process.execPath,
          ['--input-type=module', '--eval', ${JSON.stringify(childScript)}], { stdio: ['pipe', 'pipe', 'pipe'] }));`;
    const { port1, port2 } = new MessageChannel(), wake = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerScript)),
      { workerData: { channel: port2, wake }, transferList: [port2] });
    let error;
    worker.once('error', value => { error = value; });
    const exited = new Promise(resolve => worker.once('exit', code => resolve({ code, error })));
    const client = createWindowsProcessObservationClient({ channel: port1, wake,
      executable: process.execPath, driverPid: process.pid, exited });
    let first;
    try {
      first = client.snapshot(5000);
      const second = client.snapshot(5000);
      assert.deepEqual(first.listeners, [9001]); assert.deepEqual(second.listeners, [9002]);
      assert.deepEqual(second.processes, first.processes);
    } finally {
      const retired = await client.close(5000);
      assert.equal(retired.closed, true);
      if (first) assert.equal(retired.pid, first.processes[0].pid);
    }
  });

test('Windows persistent interpreter observes actual listener changes and confirms original child close',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const port = await allocateIsolatedCdpPort(), observer = createWindowsProcessObserver(port);
    const server = net.createServer();
    try {
      assert.deepEqual(observer.snapshot(15000).listeners, []);
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
      });
      assert.deepEqual(observer.snapshot(5000).listeners, [process.pid]);
      await new Promise(resolve => server.close(resolve));
      assert.deepEqual(observer.snapshot(5000).listeners, []);
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      const retired = await observer.close(5000);
      assert.equal(retired.closed, true); assert.equal(retired.identity.parent, process.pid);
    }
  });
