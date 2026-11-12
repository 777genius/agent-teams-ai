import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import {
  isCapturedOriginalNodeZombie,
  observeExitedAppGroup,
  observeOriginalAppReap,
  readRendererBackendConnections,
  settledGroupMembers,
} from './desktop-backend-observations.ts';

test('read-only discovery survives navigation during the actual IPC read, then reads the new context', async () => {
  let reads = 0;
  const cdp = {
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      reads++;
      if (reads === 1) throw new Error('Execution context was destroyed.');
      return { state: 'ready', bindings: [{ handle: 'original-owner' }] };
    },
  };
  assert.deepEqual(await readRendererBackendConnections(cdp), {
    kind: 'pending',
    reason: 'context-replaced',
  });
  assert.deepEqual(await readRendererBackendConnections(cdp), {
    kind: 'read',
    value: { state: 'ready', bindings: [{ handle: 'original-owner' }] },
  });
  assert.equal(reads, 2);
});

test('unregistered initial discovery waits, but owner failures are never hidden as navigation', async () => {
  const cdp = (failure: string) => ({
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      throw new Error(failure);
    },
  });
  assert.deepEqual(
    await readRendererBackendConnections(
      cdp("No handler registered for 'agentBackend:connections'")
    ),
    { kind: 'pending', reason: 'handler-not-ready' }
  );
  await assert.rejects(
    readRendererBackendConnections(cdp('Owner read forbidden')),
    /Owner read forbidden/
  );
});

test('initial discovery passes only its remaining captured budget to the IPC await', async (t) => {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const budgets: Array<number | undefined> = [];
  const cdp = {
    async evaluate(expression: string, timeoutMs?: number) {
      budgets.push(timeoutMs);
      if (expression.startsWith('Boolean(')) {
        clock += 10_000;
        return true;
      }
      assert.equal(timeoutMs, 50_000, 'bridge lookup time is charged to the original60s deadline');
      clock += 40_000;
      return { state: 'ready', bindings: [] };
    },
  };
  assert.deepEqual(await readRendererBackendConnections(cdp, 60_000), {
    kind: 'read',
    value: { state: 'ready', bindings: [] },
  });
  assert.deepEqual(budgets, [60_000, 50_000]);
});

test('exhausted initial observation never dispatches the backend IPC', async (t) => {
  let clock = 0,
    calls = 0;
  t.mock.method(performance, 'now', () => clock);
  const cdp = {
    async evaluate(_expression: string, timeoutMs?: number) {
      calls++;
      assert.equal(timeoutMs, 100);
      clock = 100;
      return true;
    },
  };
  await assert.rejects(
    readRendererBackendConnections(cdp, 100),
    /initial backend discovery observation deadline/
  );
  assert.equal(calls, 1);
});

test('other discovery callers retain the default CDP budget', async () => {
  const budgets: Array<number | undefined> = [];
  await readRendererBackendConnections({
    async evaluate(expression, timeoutMs) {
      budgets.push(timeoutMs);
      return expression.startsWith('Boolean(') ? true : { state: 'hold' };
    },
  });
  assert.deepEqual(budgets, [undefined, undefined]);
});

class CdpFixtureSocket extends EventEmitter {
  readonly sent: Array<{ id: number; method: string }> = [];
  send(value: string): void {
    this.sent.push(JSON.parse(value) as { id: number; method: string });
  }
  answer(id: number, value: unknown): void {
    this.emit('message', JSON.stringify({ id, result: { result: { value } } }));
  }
}
const { CdpClient } = createRequire(import.meta.url)('../e2e/comment-notification/cdp.mjs') as {
  CdpClient: new (socket: CdpFixtureSocket) => {
    evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
  };
};

test('an explicit IPC observation budget lets the same read settle after30s within60s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new CdpFixtureSocket(),
    client = new CdpClient(socket);
  const pending = client.evaluate('readOnlyConnections()', 60_000);
  // Observe rejection immediately as well, so old-code RED has no unhandled rejection.
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const })
  );
  t.mock.timers.tick(30_001);
  assert.equal(socket.sent.length, 1, 'one original read; no resend or replacement');
  socket.answer(socket.sent[0]!.id, { state: 'ready' });
  assert.deepEqual(await outcome, { ok: true, value: { state: 'ready' } });
});

test('default CDP evaluations still reject at30s without a resend', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new CdpFixtureSocket(),
    client = new CdpClient(socket);
  let settled = false;
  const pending = client.evaluate('ordinaryObservation()');
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const rejection = assert.rejects(pending, /CDP command timed out: Runtime.evaluate/);
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(socket.sent.length, 1);
});

test('macOS original Node zombie is the same unreaped harness child, never a changed live command', () => {
  const good = {
    expectedIdentity:
      'Sun Nov  8 01:17:47 2026     /captured/node /captured/pnpm.js dev:mcp --remoteDebuggingPort 9222',
    observedIdentity: 'Sun Nov  8 01:17:47 2026     (node)',
    state: 'Z',
    childPid: 4096,
    group: 4096,
    leader: { pid: 4096, ppid: 3990, pgid: 4096 },
    parentPid: 3990,
    platform: 'darwin' as const,
  };
  assert.equal(isCapturedOriginalNodeZombie(good), true);
  assert.equal(
    isCapturedOriginalNodeZombie({
      ...good,
      observedIdentity: 'Sun Nov  8 01:17:47 2026     <defunct>',
    }),
    true,
    'the original macOS defunct wrapper requires the same Z/parent/birth/custody proof'
  );
  const packed = {
    ...good,
    expectedIdentity:
      'Sun Nov  8 02:12:49 2026     /private/tmp/TEST-stage1-p7/app/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9222',
    observedIdentity: 'Sun Nov  8 02:12:49 2026     (Agent Teams AI)',
  };
  assert.equal(isCapturedOriginalNodeZombie(packed), true, 'original packed app zombie must retain its exact capture');
  for (const variant of [
    { state: 'S' },
    { state: 'R+' },
    { parentPid: 1 },
    { group: 5000 },
    { leader: { pid: 4096, ppid: 1, pgid: 4096 } },
    { platform: 'linux' as const },
    { observedIdentity: 'Sun Nov  8 02:12:50 2026     (Agent Teams AI)' },
    { observedIdentity: 'Sun Nov  8 02:12:49 2026     (foreign)' },
    { expectedIdentity: 'Sun Nov  8 02:12:49 2026     /unrelated/Agent Teams AI --remote-debugging-port=9222' },
    { expectedIdentity: 'Sun Nov  8 02:12:49 2026     /app/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9223' },
    { expectedIdentity: 'Sun Nov  8 02:12:49 2026     /app/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9222 --other' },
  ]) {
    assert.equal(isCapturedOriginalNodeZombie({ ...packed, ...variant }), false, JSON.stringify(variant));
  }
  const invalid = [
    { state: 'S' }, // A live renamed process is never enough.
    { state: 'R+' },
    { observedIdentity: 'Sun Nov  8 01:17:48 2026     (node)' },
    { observedIdentity: 'Sun Nov  8 01:17:47 2026     /different/node' },
    { observedIdentity: 'Sun Nov  8 01:17:47 2026     (foreign)' },
    { childPid: 5000 },
    { group: 5000 },
    { leader: { pid: 4096, ppid: 1, pgid: 4096 } },
    { leader: { pid: 4096, ppid: 3990, pgid: 5000 } },
    { leader: undefined },
    { parentPid: 1 },
    { platform: 'linux' as const },
    { expectedIdentity: 'Sun Nov  8 01:17:47 2026     /unrelated/program' },
  ];
  for (const variant of invalid) {
    assert.equal(
      isCapturedOriginalNodeZombie({ ...good, ...variant }),
      false,
      JSON.stringify(variant)
    );
  }
});

const appReapInput = () => ({
  child: { pid: 4096, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null },
  group: 4096,
  hostPid: 4196,
  initialMembers: [{ pid: 4096, ppid: 3990, pgid: 4096 }],
  expectedIdentity: 'Tue Oct 27 22:59:52 2026     /captured/node /captured/pnpm.js dev:mcp',
  observedIdentity: 'Tue Oct 27 22:59:52 2026     <defunct>',
  deadline: 3000,
});

test('live stat can become original defunct before the guard; only original child reap and whole-group absence settle it', async (t) => {
  let now = 0,
    reaped = false;
  const input = appReapInput();
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queries: string[] = [];
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    assert.equal(file, '/bin/ps');
    const query = args.join(' ');
    queries.push(query);
    if (query === '-p 4096 -o stat=') return 'S';
    if (query === '-p 4096 -o lstart=,command=') return input.observedIdentity;
    assert.equal(query, '-ax -o pid=,ppid=,pgid=');
    return reaped ? '9999 1 9999\n' : '4096 3990 4096\n';
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', () => {
    assert.fail('reaping observation never signals');
  });
  const deadline = Date.now() + 3000;
  const members = await settledGroupMembers(input.group, deadline);
  const observedIdentity = childProcess
    .execFileSync('/bin/ps', ['-p', '4096', '-o', 'lstart=,command='], { encoding: 'utf8' })
    .trim();
  const pending = observeOriginalAppReap({
    ...input,
    initialMembers: members,
    observedIdentity,
    deadline,
  });
  assert.equal(input.child.exitCode, null);
  now = 100;
  reaped = true;
  input.child.exitCode = 0;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'original-natural-exit-and-fresh-absence');
  assert.deepEqual(result.remaining, []);
  assert.equal(result.capturedHostAbsent, true);
  assert.equal(result.initial.appExitCode, null);
  assert.equal(result.initial.observedIdentity, input.observedIdentity);
  assert.deepEqual(queries.slice(0, 3), [
    '-ax -o pid=,ppid=,pgid=',
    '-p 4096 -o stat=',
    '-p 4096 -o lstart=,command=',
  ]);
});

test('changed command/start, wrong child/group and initial descendants never authorize a recovery observation', async () => {
  const variants = [
    { observedIdentity: 'Tue Oct 27 22:59:52 2026     /unrelated/command' },
    { observedIdentity: 'Tue Oct 27 23:00:52 2026     <defunct>' },
    { observedIdentity: '' },
    { child: { pid: 5000, exitCode: 0, signalCode: null } },
    { initialMembers: [{ pid: 5000, ppid: 3990, pgid: 4096 }] },
    {
      initialMembers: [
        { pid: 4096, ppid: 3990, pgid: 4096 },
        { pid: 5000, ppid: 4096, pgid: 4096 },
      ],
    },
  ];
  for (const variant of variants) {
    const result = await observeOriginalAppReap(
      { ...appReapInput(), deadline: Date.now() + 3000, ...variant },
      () => assert.fail('ineligible identity must not dispatch another observation')
    );
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'ineligible-original-defunct-observation');
  }
});

test('an already observed original natural exit still requires fresh group and captured Host absence', async () => {
  for (const table of [
    [],
    [{ pid: 5000, ppid: 1, pgid: 4096 }],
    [{ pid: 4196, ppid: 1, pgid: 7777 }],
    [{ pid: 4096, ppid: 1, pgid: 4096 }],
  ]) {
    const input = appReapInput();
    input.deadline = Date.now() + 3000;
    input.child.exitCode = 0;
    let reads = 0;
    const result = await observeOriginalAppReap(input, () => {
      reads++;
      return table;
    });
    assert.equal(result.settled, table.length === 0);
    assert.equal(reads, 1);
  }
});

test('original crash/signal and process-table failures remain debt', async () => {
  for (const outcome of [
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const },
  ]) {
    const input = appReapInput();
    input.deadline = Date.now() + 3000;
    Object.assign(input.child, outcome);
    const result = await observeOriginalAppReap(input, () =>
      assert.fail('non-natural exit cannot qualify')
    );
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'original-child-exit-not-natural-zero');
  }
  const input = appReapInput();
  input.deadline = Date.now() + 3000;
  const result = await observeOriginalAppReap(input, () => {
    throw new Error('ps unavailable');
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'process-table-unavailable');
});

test('the original deadline is not renewed after initial settlement consumed it', async (t) => {
  t.mock.method(Date, 'now', () => 3000);
  const input = appReapInput();
  input.child.exitCode = 0;
  const result = await observeOriginalAppReap(input, () =>
    assert.fail('expired original deadline cannot re-read or qualify absence')
  );
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'original-observation-deadline');
});

test('numeric group absence without this original child exit observation expires within the remaining original budget', async (t) => {
  let now = 2900;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = observeOriginalAppReap(appReapInput(), () => []);
  now = 3000;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'original-observation-deadline');
  assert.equal(result.appExitCode, null);
  assert.deepEqual(result.remaining, []);
});

test('a process-table read that crosses the original deadline cannot qualify natural exit', async (t) => {
  let now = 2999;
  t.mock.method(Date, 'now', () => now);
  const input = appReapInput();
  input.child.exitCode = 0;
  const result = await observeOriginalAppReap(input, () => {
    now = 3000;
    return [];
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'original-observation-deadline');
});

const exitedGroupInput = () => ({
  child: { pid: 4096, exitCode: 0 as number | null, signalCode: null as NodeJS.Signals | null },
  group: 4096,
  hostPid: 4196,
  initialMembers: [{ pid: 5000, ppid: 1, pgid: 4096 }],
  deadline: 3000,
});

test('an already reaped original child waits for actual descendant and original Host absence', async (t) => {
  let now = 2700;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(process, 'kill', () => assert.fail('absence observation never signals'));
  let table = [{ pid: 5000, ppid: 1, pgid: 4096 }];
  const pending = observeExitedAppGroup(exitedGroupInput(), () => table);
  table = [{ pid: 4196, ppid: 1, pgid: 7777 }];
  now = 2800;
  t.mock.timers.tick(100);
  await Promise.resolve();
  table = [];
  now = 2900;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'original-natural-exit-and-fresh-absence');
  assert.deepEqual(result.remaining, []);
  assert.equal(result.capturedHostAbsent, true);
  assert.deepEqual(result.initialMembers, exitedGroupInput().initialMembers);
  assert.equal(result.capturedDescendantsAbsent, true);
});

test('an orphan descendant, moved captured descendant or original Host cannot be cleared by an expired budget', async (t) => {
  let now = 2900;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const orphan = observeExitedAppGroup(exitedGroupInput(), () => exitedGroupInput().initialMembers);
  const moved = observeExitedAppGroup(exitedGroupInput(), () => [{ pid: 5000, ppid: 1, pgid: 5000 }]);
  const host = observeExitedAppGroup(exitedGroupInput(), () => [{ pid: 4196, ppid: 1, pgid: 7777 }]);
  now = 3000;
  t.mock.timers.tick(100);
  for (const result of await Promise.all([orphan, moved, host])) {
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'original-observation-deadline');
  }
  assert.equal((await moved).capturedDescendantsAbsent, false);
});

test('absent leader observation rejects wrong child, live/crashed/signaled child and invalid captured identities', async () => {
  for (const variant of [
    { child: { pid: 5000, exitCode: 0, signalCode: null } },
    { child: { pid: 4096, exitCode: null, signalCode: null } },
    { child: { pid: 4096, exitCode: 1, signalCode: null } },
    { child: { pid: 4096, exitCode: null, signalCode: 'SIGTERM' as const } },
    { hostPid: 0 }, { hostPid: 4096 }, { group: -1 }, { deadline: NaN },
    { initialMembers: [{ pid: 4096, ppid: 3990, pgid: 4096 }] },
    { initialMembers: [{ pid: 5000, ppid: 1, pgid: 7777 }] },
  ]) {
    const result = await observeExitedAppGroup({ ...exitedGroupInput(), ...variant }, () =>
      assert.fail('ineligible captured child cannot observe again'));
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'ineligible-original-natural-exit-observation');
  }
});

test('a reused leader PID and unavailable full process census retain debt without signaling', async (t) => {
  t.mock.method(Date, 'now', () => 2900);
  t.mock.method(process, 'kill', () => assert.fail('absence observation never signals'));
  const reused = await observeExitedAppGroup(exitedGroupInput(), () => [{ pid: 4096, ppid: 1, pgid: 7777 }]);
  assert.equal(reused.settled, false);
  assert.equal(reused.reason, 'captured-leader-pid-reappeared');
  const unavailable = await observeExitedAppGroup(exitedGroupInput(), () => { throw new Error('ps unavailable'); });
  assert.equal(unavailable.settled, false);
  assert.equal(unavailable.reason, 'process-table-unavailable');
});

test('absent leader observation never renews the original deadline or accepts a late census', async (t) => {
  let now = 3000;
  t.mock.method(Date, 'now', () => now);
  const expired = await observeExitedAppGroup(exitedGroupInput(), () => assert.fail('expired budget'));
  assert.equal(expired.settled, false);
  now = 2999;
  const late = await observeExitedAppGroup(exitedGroupInput(), () => { now = 3000; return []; });
  assert.equal(late.settled, false);
  assert.equal(late.reason, 'original-observation-deadline');
});
