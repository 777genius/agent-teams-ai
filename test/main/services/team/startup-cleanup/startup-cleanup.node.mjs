import './source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

const { OpenCodeStartupCleanupBudget: Budget } = await import('../../../../../src/main/services/team/opencode/bridge/OpenCodeStartupCleanupBudget.ts');
const { cleanupManagedOpenCodeServeProcesses: sweep } = await import('../../../../../src/main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup.ts');
const { killProcessByPidAndWait: kill } = await import('../../../../../src/main/utils/processKill.ts');
const { executeOpenCodeStartupCleanup: bridgeCleanup, isStartupCleanupData } = await import('../../../../../src/main/services/team/opencode/bridge/OpenCodeStartupCleanupBridge.ts');
const { OpenCodeWindowsStartupCleanup: Owner } = await import('../../../../../src/main/services/team/opencode/bridge/OpenCodeWindowsStartupCleanup.ts');
const gate = await import('../../../../../src/main/services/team/opencode/bridge/OpenCodeStartupSweepGate.ts');
const command = 'C:\\runtimes\\opencode\\versions\\test\\opencode-windows-x64\\opencode.exe serve --port 1234';
const empty = { scanned: 0, killed: 0, candidates: [], diagnostics: [] };
const host = (pid, action) => ({ hostKey: `host-${pid}`, projectPath: '/sandbox/startup-cleanup', pid, port: 1234, action, reason: 'runtime fixture', leaseCount: 0 });
const drained = { ok: true, data: { cleaned: 0, remaining: 0, hosts: [], diagnostics: [], startupCleanup: { completion: 'drained', coverage: 'complete', survivingPids: [] } } };

test('deadline validation, monotonic clock and nonzero clamped timeouts', () => {
  for (const deadline of [NaN, Infinity, 100, 120_101]) assert.throws(() => new Budget(deadline, 100));
  let now = 0;
  const budget = new Budget(120_100, 100, () => now);
  assert.equal(budget.capMs(20_000), 20_000);
  now = 119_999;
  assert.equal(budget.capMs(6_000), 1);
  now++;
  assert.throws(() => budget.capMs(6_000), /exhausted/);
});

test('12s enumeration and repeated 4s native identities use startup caps; no dispose', async () => {
  let now = 0;
  let kills = 0;
  globalThis.startupTestEnumeration = async (timeout, options) => {
    assert.equal(timeout, 20_000); assert.equal(options.bypassCache, true);
    now += 12_000; return [{ pid: 1, ppid: 0, command }];
  };
  globalThis.startupTestIdentity = async (_pid, _platform, timeout) => {
    assert.equal(timeout, 6_000); now += 4_000; return 10;
  };
  const result = await sweep({ mode: 'orphaned', platform: 'win32', startupBudget: new Budget(120_000, 0, () => now),
    startedBeforeMs: 100, isProcessAlive: () => kills === 0,
    killProcess: () => { kills++; }, disposeServeHost: () => assert.fail('startup disposal'),
  });
  assert.equal(result.killed, 1); assert.equal(kills, 1); assert.equal(now, 24_000);
});

test('exhaustion after awaited identity prevents mutation and retains multiple candidates', async () => {
  let now = 0;
  const result = await sweep({ mode: 'orphaned', platform: 'win32', startupBudget: new Budget(22_000, 0, () => now),
    startedBeforeMs: 100,
    listProcessRows: async () => { now += 12_000; return [1, 2].map(pid => ({ pid, ppid: 0, command })); },
    readProcessStartTimeMs: async () => { now += 4_000; return 10; },
    isProcessAlive: () => true, killProcess: () => assert.fail('late mutation'), disposeServeHost: () => assert.fail('dispose'),
  });
  assert.deepEqual(result.candidates.map(c => c.action), ['failed', 'failed']);
});

test('legacy enumeration and identity defaults stay unchanged', async () => {
  globalThis.startupTestEnumeration = async timeout => { assert.equal(timeout, 4_000); return [{ pid: 1, ppid: 0, command }]; };
  globalThis.startupTestIdentity = async (_pid, _platform, timeout) => { assert.equal(timeout, undefined); return null; };
  await sweep({ mode: 'orphaned', platform: 'win32', isProcessAlive: () => true });
});

test('taskkill callback drainage is awaited; root gone does not erase tree error in startup', async () => {
  const originalExec = childProcess.execFile, originalKill = process.kill;
  let callback, alive = true, settled = false;
  try {
    childProcess.execFile = (_cmd, _args, _opts, cb) => { callback = cb; return {}; };
    syncBuiltinESMExports();
    process.kill = () => { if (alive) return true; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
    const operation = kill(123, { platform: 'win32', requireTreeSuccess: true }).then(() => { settled = true; }, error => { settled = true; return error; });
    alive = false;
    await Promise.resolve(); assert.equal(settled, false);
    callback(new Error('tree denied'));
    assert.match((await operation).message, /tree denied/);
  } finally { childProcess.execFile = originalExec; process.kill = originalKill; syncBuiltinESMExports(); }
});

test('PID reuse and budget exhaustion after fallback identity never directly signal', async () => {
  const originalExec = childProcess.execFile, originalKill = process.kill;
  try {
    childProcess.execFile = (_cmd, _args, _opts, cb) => { cb(new Error('denied')); return {}; };
    syncBuiltinESMExports();
    process.kill = (_pid, signal) => { assert.equal(signal, 0); return true; };
    await assert.rejects(kill(123, { platform: 'win32', confirmTargetIdentity: async () => false }), /identity changed/);
    let allowed = true;
    await assert.rejects(kill(123, { platform: 'win32', assertCanTerminate: () => { if (!allowed) throw new Error('budget exhausted'); },
      confirmTargetIdentity: async () => { allowed = false; return true; } }), /budget exhausted/);
  } finally { childProcess.execFile = originalExec; process.kill = originalKill; syncBuiltinESMExports(); }
});

test('new bridge dispatch preserves timeout uncertainty without legacy fallback', async () => {
  const failure = { ok: false, error: { kind: 'timeout', message: 'lost response' } };
  let calls = 0;
  const result = await bridgeCleanup({ execute: async (command, body, options) => {
    calls++; assert.equal(command, 'opencode.cleanupStartupHosts'); assert.equal(body.deadlineUnixMs, 120_000); assert.equal(options.timeoutMs, 120_000); return failure;
  } }, new Budget(120_000, 0, () => 0));
  assert.equal(result, failure); assert.equal(calls, 1);
});

test('gate precedes preflight; drained partial exclusions, bounded manual retry and no queued launch', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const scans = [];
    const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
      sweep: async options => { scans.push(options); return empty; }, waitMs: async () => {} });
    await assert.rejects(gate.whenOpenCodeStartupRuntimeSweepSettled(), /still running/);
    await owner.preflight();
    await owner.finish({ cleanupOpenCodeStartupHosts: async () => ({ ok: true, data: {
      ...drained.data, remaining: 3, hosts: [host(2, 'failed'), host(3, 'kept_active')],
      startupCleanup: { completion: 'drained', coverage: 'partial', survivingPids: [4, 2, 3] },
    } }) });
    assert.deepEqual([...scans[1].excludePids], [4, 2, 3]);
    assert.deepEqual([...scans[2].excludePids], [4, 2, 3]);
    assert.equal(scans[0].startupBudget, scans[2].startupBudget);
    await gate.whenOpenCodeStartupRuntimeSweepSettled();
    await owner.retry();
    assert.equal(scans[3].startedBeforeMs, 100);
    assert.notEqual(scans[3].startupBudget, scans[0].startupBudget);
  } finally { Object.defineProperty(process, 'platform', platform); gate.beginOpenCodeStartupRuntimeSweep()(); }
});

test('unsupported command releases; timeout and invalid acknowledgement retain gate', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    for (const kind of ['unsupported_command', 'timeout', 'invalid_result']) {
      const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {}, sweep: async () => empty });
      await owner.preflight();
      await owner.finish({ cleanupOpenCodeStartupHosts: async () => kind === 'invalid_result' ? { ok: true, data: {} } : { ok: false, error: { kind, message: kind } } });
      if (kind === 'unsupported_command') await gate.whenOpenCodeStartupRuntimeSweepSettled();
      else {
        await assert.rejects(gate.whenOpenCodeStartupRuntimeSweepSettled(), /unconfirmed/);
        await assert.rejects(owner.retry(), /unconfirmed existing operation/);
      }
      gate.beginOpenCodeStartupRuntimeSweep()();
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('deadline leaves a live helper gated while unrelated initialization can resume; retry does not queue work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let now = 0, finishScan, calls = 0;
  try {
    const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
      createBudget: () => new Budget(120_000, 0, () => now),
      sweep: () => { calls++; return new Promise(resolve => { finishScan = resolve; }); } });
    const preflight = owner.preflight();
    now = 120_000;
    t.mock.timers.tick(120_000);
    await preflight;
    const operation = owner.finish({ cleanupOpenCodeStartupHosts: () => assert.fail('new work after deadline') });
    await assert.rejects(gate.whenOpenCodeStartupRuntimeSweepSettled(), /exceeded its deadline/);
    await owner.retry();
    assert.equal(owner.getStatus().state, 'pending');
    assert.equal(calls, 1);
    finishScan(empty);
    await operation;
    await gate.whenOpenCodeStartupRuntimeSweepSettled();
  } finally { Object.defineProperty(process, 'platform', platform); gate.beginOpenCodeStartupRuntimeSweep()(); }
});

test('startup-only option leaves Unix and shutdown disposal behavior unchanged', async () => {
  for (const platform of ['linux', 'win32']) {
    let alive = true, disposed = 0;
    const result = await sweep({ mode: 'force', platform,
      ...(platform === 'linux' ? { startupBudget: new Budget(120_000, 0, () => 0) } : {}),
      listProcessRows: async () => [{ pid: 1, ppid: 0, command }],
      readProcessDetails: async () => 'CLAUDE_MULTIMODEL_DATA_HOME=test OPENCODE_CONFIG_CONTENT={} AGENT_TEAMS_MCP_CLAUDE_DIR=test',
      readProcessStartTimeMs: async () => 10,
      isProcessAlive: () => alive, killProcess: () => { alive = false; }, disposeServeHost: async () => { disposed++; },
    });
    assert.equal(disposed, 1); assert.equal(result.killed, 1);
  }
});

test('startup sweep retains terminal tree failure even when root died', async () => {
  let alive = true;
  const result = await sweep({ mode: 'orphaned', platform: 'win32', startupBudget: new Budget(120_000, 0, () => 0),
    listProcessRows: async () => [{ pid: 1, ppid: 0, command }], readProcessStartTimeMs: async () => 10,
    isProcessAlive: () => alive, killProcess: () => { alive = false; throw new Error('tree denied'); },
  });
  assert.equal(result.killed, 0); assert.equal(result.candidates[0].action, 'failed');
});

test('read-only initialization expiry releases gate without dispatching late cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let now = 0;
  try {
    const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
      createBudget: () => new Budget(120_000, 0, () => now), sweep: async () => empty });
    await owner.preflight();
    now = 120_000; t.mock.timers.tick(120_000);
    await gate.whenOpenCodeStartupRuntimeSweepSettled();
    await owner.finish({ cleanupOpenCodeStartupHosts: () => assert.fail('late dispatch') });
  } finally { Object.defineProperty(process, 'platform', platform); gate.beginOpenCodeStartupRuntimeSweep()(); }
});

for (const phase of ['registry', 'settle']) {
  test(`shutdown during ${phase} observes current work without later sweep or maintenance`, async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const pause = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    let scans = 0, maintenance = 0, dispatches = 0;
    const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
      sweep: async () => { scans++; return empty; },
      waitMs: phase === 'settle' ? pause : async () => {}, maintenance: async () => { maintenance++; } });
    await owner.preflight();
    let settled = false;
    const operation = owner.finish({ cleanupOpenCodeStartupHosts: async () => {
      dispatches++;
      if (phase === 'registry') await pause();
      return drained;
    } }).then(() => { settled = true; });
    await waiting;
    owner.stopAdmitting();
    await Promise.resolve();
    assert.equal(settled, false);
    await assert.rejects(owner.retry(), /shutdown/);
    release(); await operation;
    assert.equal(scans, phase === 'registry' ? 1 : 2);
    assert.equal(dispatches, 1); assert.equal(maintenance, 0);
  });
}

test('shutdown after awaited identity prevents startup mutation', async () => {
  let allowed = true, identities = 0;
  const result = await sweep({ mode: 'force', platform: 'win32', startupBudget: new Budget(),
    canAdmitStartupWork: () => allowed, startedBeforeMs: 100,
    listProcessRows: async () => [{ pid: 1, ppid: 0, command }],
    readProcessStartTimeMs: async () => { if (++identities === 3) allowed = false; return 10; },
    isProcessAlive: () => true, killProcess: () => assert.fail('shutdown mutation'),
    forceKillProcess: () => assert.fail('shutdown force mutation'), disposeServeHost: () => assert.fail('dispose'),
  });
  assert.equal(identities, 3); assert.equal(result.killed, 0);
});

test('unsupported/pre-mutation failure performs independent maintenance exactly once, no host fallback', async () => {
  for (const kind of ['unsupported_command', 'unsupported_schema', 'invalid_input']) {
    let maintenance = 0, scans = 0;
    const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
      sweep: async () => { scans++; return empty; }, maintenance: async () => { maintenance++; } });
    await owner.preflight();
    await owner.finish({ cleanupOpenCodeStartupHosts: async () => ({ ok: false, error: { kind, message: kind } }) });
    assert.equal(scans, 1); assert.equal(maintenance, 1);
    assert.equal(owner.getStatus().state, 'partial');
  }
});

test('registry response after deadline releases only on original terminal drainage; checks never resubmit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, release, scans = 0, dispatches = 0;
  const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
    createBudget: () => new Budget(120_000, 0, () => now),
    sweep: async () => { scans++; return empty; }, maintenance: () => assert.fail('late maintenance') });
  await owner.preflight();
  const operation = owner.finish({ cleanupOpenCodeStartupHosts: () => { dispatches++; return new Promise(resolve => { release = resolve; }); } });
  await Promise.resolve();
  now = 120_000; t.mock.timers.tick(120_000);
  await owner.retry();
  assert.equal(owner.getStatus().state, 'pending');
  assert.equal(dispatches, 1);
  release({ ...drained, data: { ...drained.data, startupCleanup: { completion: 'drained', coverage: 'partial', survivingPids: [77] } } });
  await operation;
  assert.equal(owner.getStatus().state, 'partial');
  assert.equal(dispatches, 1); assert.equal(scans, 1);
});

test('shutdown continues observing a started local helper and skips later force work', async () => {
  let allowed = true, release, entered, settled = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  const operation = sweep({ mode: 'force', platform: 'win32', startupBudget: new Budget(),
    canAdmitStartupWork: () => allowed, startedBeforeMs: 100,
    listProcessRows: async () => [{ pid: 1, ppid: 0, command }], readProcessStartTimeMs: async () => 10,
    isProcessAlive: () => true,
    killProcess: () => { entered(); return new Promise(resolve => { release = resolve; }); },
    sleepMs: () => assert.fail('new settle after shutdown'), forceKillProcess: () => assert.fail('force work after shutdown'),
  }).then(result => { settled = true; return result; });
  await waiting; allowed = false;
  await Promise.resolve(); assert.equal(settled, false);
  release(); await operation;
  assert.equal(settled, true);
});

const retained = (action, coverage = 'complete') => ({
  ...drained.data, remaining: 1, hosts: [host(77, action)],
  startupCleanup: { completion: 'drained', coverage, survivingPids: [77] },
});
const malformedPayloads = [
  { ...drained.data, hosts: [{ pid: 77, action: 'failed' }] },
  retained('failed'), retained('kept_active'), retained('invented'),
  ...['hostKey', 'projectPath', 'pid', 'port', 'action', 'reason', 'leaseCount'].map(field => {
    const data = retained('failed', 'partial'); delete data.hosts[0][field]; return data;
  }),
  ...['failed', 'kept_active', 'kept_leased', 'kept_recent', 'kept_filtered', 'kept_pending_oauth'].map(action => ({
    ...retained(action, 'partial'), remaining: 0,
    startupCleanup: { completion: 'drained', coverage: 'partial', survivingPids: [] },
  })),
  ...[-1, 0.5, NaN, Infinity].flatMap(count => [
    { ...drained.data, cleaned: count }, { ...drained.data, remaining: count },
    { ...retained('kept_recent'), hosts: [{ ...host(77, 'kept_recent'), leaseCount: count }] },
  ]),
  { ...drained.data, remaining: 1 },
  { ...drained.data, cleaned: 1 },
  { ...drained.data, startupCleanup: { completion: 'unknown', coverage: 'partial', survivingPids: [] } },
  ...[0, -1, 1.5, 65536].map(port => ({ ...retained('kept_recent'), hosts: [{ ...host(77, 'kept_recent'), port }] })),
];

test('strict actual runtime records accept complete/partial, retained OAuth and non-equal registry counts', () => {
  const valid = [drained.data, ...['disposed', 'removed_dead'].map(action => ({ ...drained.data, cleaned: 1, hosts: [host(77, action)] })),
    ...['kept_leased', 'kept_recent', 'kept_filtered', 'kept_pending_oauth'].map(action => retained(action)),
    retained('failed', 'partial'), retained('kept_active', 'partial'),
    // Filtered/inconsistent registry keys and duplicate PIDs do not imply count equality.
    { ...retained('kept_filtered'), remaining: 3 },
    { ...retained('failed', 'partial'), remaining: 0 },
    { ...drained.data, startupCleanup: { completion: 'unknown', coverage: 'partial', survivingPids: [88] } },
  ];
  for (const data of valid) assert.equal(isStartupCleanupData(data), true, JSON.stringify(data));
  for (const data of malformedPayloads) assert.equal(isStartupCleanupData(data), false, JSON.stringify(data));
});

for (const late of [false, true]) {
  test(`actual retained runtime hosts preserve exclusions and coverage (late=${late})`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      for (const action of ['kept_leased', 'kept_recent', 'kept_filtered', 'kept_pending_oauth', 'failed', 'kept_active']) {
        const coverage = ['failed', 'kept_active'].includes(action) ? 'partial' : 'complete';
        const data = retained(action, coverage);
        const scans = []; let dispatches = 0, requestId;
        const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
          sweep: async options => { scans.push(options); return empty; }, waitMs: async () => {} });
        await owner.preflight();
        await owner.finish({ cleanupOpenCodeStartupHosts: async (_budget, _start, _admit, id) => {
          dispatches++; requestId = id;
          return late ? { ok: false, requestId, error: { kind: 'timeout', message: 'lost response' } } : { ok: true, requestId, data };
        }, observeOpenCodeStartupCleanup: async () => ({ ok: true, requestId, data }) });
        if (late) await owner.retry();
        assert.equal(owner.getStatus().state, late ? 'partial' : coverage);
        await gate.whenOpenCodeStartupRuntimeSweepSettled();
        assert.equal(dispatches, 1); assert.equal(scans.length, late ? 1 : 3);
        for (const scan of scans.slice(1)) assert.deepEqual([...scan.excludePids], [77]);
      }
    } finally { Object.defineProperty(process, 'platform', platform); gate.beginOpenCodeStartupRuntimeSweep()(); }
  });
}

for (const late of [false, true]) {
  test(`malformed terminal evidence stays unknown/protected without resubmission (late=${late})`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      for (const data of malformedPayloads) {
        let dispatches = 0, scans = 0, requestId;
        const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
          sweep: async () => { scans++; return empty; }, maintenance: () => assert.fail('unproven maintenance') });
        await owner.preflight();
        await owner.finish({ cleanupOpenCodeStartupHosts: async (_budget, _start, _admit, id) => {
          dispatches++; requestId = id;
          return late ? { ok: false, requestId, error: { kind: 'timeout', message: 'lost response' } } : { ok: true, requestId, data };
        }, observeOpenCodeStartupCleanup: async id => {
          assert.equal(id, requestId); return { ok: true, requestId, data };
        } });
        for (let check = 0; check < 2; check++) {
          await assert.rejects(owner.retry(), /unconfirmed existing operation/);
          assert.equal(owner.getStatus().state, 'unknown');
          await assert.rejects(gate.whenOpenCodeStartupRuntimeSweepSettled(), /unconfirmed/);
        }
        assert.equal(dispatches, 1); assert.equal(scans, 1);
        gate.beginOpenCodeStartupRuntimeSweep()();
      }
    } finally { Object.defineProperty(process, 'platform', platform); gate.beginOpenCodeStartupRuntimeSweep()(); }
  });
}

test('shutdown hook closes current owner during identity and also fences later construction', async () => {
  const { stopAdmittingOpenCodeStartupCleanup } = await import('../../../../../src/main/services/team/opencode/bridge/OpenCodeWindowsStartupCleanup.ts');
  let identities = 0, registry = 0;
  const owner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
    sweep: options => sweep({ ...options, requiredProfileScope: undefined,
      listProcessRows: async () => [{ pid: 1, ppid: 0, command }],
      readProcessStartTimeMs: async () => { identities++; stopAdmittingOpenCodeStartupCleanup(); return 10; },
      isProcessAlive: () => true, killProcess: () => assert.fail('mutation after shutdown hook'),
    }), maintenance: () => assert.fail('maintenance after shutdown') });
  await owner.preflight();
  await owner.finish({ cleanupOpenCodeStartupHosts: async () => { registry++; return drained; } });
  assert.equal(identities, 1); assert.equal(registry, 0);
  const laterOwner = new Owner({ appStartedAtMs: 100, profileScope: 'test', logWarning: () => {},
    sweep: () => assert.fail('new startup work during shutdown') });
  await laterOwner.preflight(); await laterOwner.finish(null);
});
