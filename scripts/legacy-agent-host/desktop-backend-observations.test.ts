import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createDesktopProcessRootOracle } from './desktop-process-root-oracle.ts';
import {
  assertOwnedCdpListener,
  groupMembers,
  isCapturedOriginalNodeZombie,
  processTable,
  safeGroupSnapshot,
  observeExitedAppGroup,
  observeOriginalAppReap,
  readRendererBackendConnections,
  readOwnedCdpListenerFailure,
  settledGroupMembers,
} from './desktop-backend-observations.ts';

test('Linux CDP diagnostics retain the original bounded descriptor read without accepting a second holder', { skip: process.platform !== 'linux' }, (t) => {
  const fields = (fd: number) => `f${fd}\ntIPv4\nD0xabcd\ni12345\nPTCP\nTST=LISTEN\nnPRIVATE_PATH_MUST_NOT_LEAK\n`;
  let output = 'p4100\n' + Array.from({ length: 17 }, (_, index) => fields(index + 1)).join('') + 'p4101\n' + fields(40);
  let reads = 0;
  let change: 'none' | 'replaced' | 'vanished' = 'none';
  const statReads = new Map<number, number>(), opened = new Map<number, string>();
  const procReads: string[] = [];
  let nextFd = 9000;
  t.mock.method(fs, 'openSync', (path: string) => {
    assert.match(path, /^\/proc\/(4100|4101)\/(stat|cmdline)$/u);
    const fd = nextFd++; opened.set(fd, path); return fd;
  });
  t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const path = opened.get(fd)!; procReads.push(path);
    assert.equal(position, 0); assert.equal(length, 4097, '4KiB plus one oversize sentinel byte');
    const pid = Number(path.split('/')[2]);
    let value: string;
    if (path.endsWith('/stat')) {
      const count = (statReads.get(pid) ?? 0) + 1; statReads.set(pid, count);
      if (pid === 4101 && count === 3 && change === 'vanished') throw new Error('PRIVATE_VANISHED');
      const stat = Array<string>(20).fill('0');
      stat[0] = 'S'; stat[1] = String(pid === 4100 ? 4000 : 4100); stat[2] = '4100';
      stat[19] = pid === 4101 && count === 3 && change === 'replaced' ? '200' : '100';
      value = `${pid} (PRIVATE_COMM_MUST_NOT_LEAK) ${stat.join(' ')}\n`;
    } else value = '/PRIVATE_EXECUTABLE/electron\0' +
      (pid === 4101 ? '--type=zygote\0' : '') + '--PRIVATE_ARGUMENT_MUST_NOT_LEAK\0';
    return Buffer.from(value).copy(buffer, offset, 0, length);
  });
  t.mock.method(fs, 'closeSync', (fd: number) => { assert.ok(opened.delete(fd)); });
  t.mock.method(fs, 'readlinkSync', (path: string) => {
    assert.match(path, /^\/proc\/(4100|4101)\/fd\/61$/u);
    procReads.push(path); return 'socket:[45678]';
  });
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    if (file === '/bin/ps') return '4100 4000 4100\n4101 4100 4100\n';
    assert.equal(file, '/usr/bin/lsof');
    assert.ok(args.includes('-FpfDtinPT') && args.includes('-Ts') && args.includes('-a'));
    reads++;
    return output;
  });
  t.mock.method(process, 'kill', () => assert.fail('a descriptor census never signals'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let original: unknown;
  try { assertOwnedCdpListener(4100); } catch (error) { original = error; }
  assert.ok(original instanceof assert.AssertionError);
  assert.match(original.message, /one CDP listener/u);
  assert.equal(reads, 1, 'failure projection does not perform a second racy census');
  const facts = readOwnedCdpListenerFailure(original);
  assert.ok(facts);
  assert.equal(facts.holderCount, 2, 'a second PID past the retained16rows still refuses, even with the same inode');
  assert.equal(facts.fileCount, 18); assert.equal(facts.files.length, 16); assert.equal(facts.truncated, true);
  assert.equal(JSON.stringify(facts).includes('PRIVATE_PATH_MUST_NOT_LEAK'), false);
  assert.equal(readOwnedCdpListenerFailure(new Error('unrelated')), undefined);
  output = 'p4100\n' + fields(1) + fields(2);
  assert.equal(assertOwnedCdpListener(4100), 4100, 'two descriptors of one original holder preserve the prior PID rule');
  assert.equal(readOwnedCdpListenerFailure(original), facts, 'a later successful read does not replace the original failure');
  output = 'p4100\n';
  assert.throws(() => assertOwnedCdpListener(4100), /Positive original lsof descriptor census/u);

  const unknownInode = 'f61\ntIPv4\nPTCP\nTST=LISTEN\nn127.0.0.1:9222\n';
  output = 'p4100\n' + unknownInode + 'p4101\n' + unknownInode;
  for (const variant of ['none', 'replaced', 'vanished'] as const) {
    change = variant; statReads.clear(); procReads.length = 0;
    let failure: unknown;
    try { assertOwnedCdpListener(4100); } catch (error) { failure = error; }
    assert.ok(failure instanceof assert.AssertionError);
    assert.match(failure.message, /one CDP listener/u);
    const retained = readOwnedCdpListenerFailure(failure)!;
    assert.equal(retained.holderCount, 2, 'even equal supplemental socket inodes never admit two holders');
    assert.equal(retained.files[0]!.inode, null, 'original lsof facts are never rewritten');
    assert.deepEqual(retained.files[0]!.afterCensus, {
      scope: 'after-original-census', atomic: false, birth: 'same', startTicks: '100',
      ppid: 4000, pgid: 4100, role: 'electron-main', socketInode: '45678',
    });
    assert.deepEqual(retained.files[1]!.afterCensus, variant === 'none' ? {
      scope: 'after-original-census', atomic: false, birth: 'same', startTicks: '100',
      ppid: 4100, pgid: 4100, role: 'electron-zygote', socketInode: '45678',
    } : {
      scope: 'after-original-census', atomic: false, birth: 'unknown', startTicks: null,
      ppid: null, pgid: null, role: 'unknown', socketInode: null,
    });
    assert.equal(JSON.stringify(retained).includes('PRIVATE_'), false, 'raw argv, comm, paths and errors stay private');
    assert.deepEqual(procReads.slice(0, 2), ['/proc/4100/stat', '/proc/4101/stat']);
    assert.equal(opened.size, 0, 'all diagnostic file descriptors close, including vanished birth');
  }
});

test('Linux zero-group rows remain observable without becoming owned app groups; malformed census stays an error', (t) => {
  let output = '1 0 1\n2 0 0\n4100 4000 4100\n';
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-ax', '-o', 'pid=,ppid=,pgid=']);
    return output;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', () => assert.fail('a census never signals'));
  assert.deepEqual(processTable(), [
    { pid: 1, ppid: 0, pgid: 1 }, { pid: 2, ppid: 0, pgid: 0 },
    { pid: 4100, ppid: 4000, pgid: 4100 },
  ]);
  assert.deepEqual(groupMembers(4100), [{ pid: 4100, ppid: 4000, pgid: 4100 }]);
  assert.throws(() => groupMembers(0), /Captured app group must be positive/);
  assert.throws(() => safeGroupSnapshot(0), /Captured app group must be positive/);
  for (const malformed of ['0 0 0', '2 0', '2 0 0 9', '2 nope 0', '2 -1 0', '9007199254740992 0 0']) {
    output = malformed + '\n';
    assert.throws(() => processTable(), /Malformed process table row|Invalid process table identity/);
  }
});

test('the same original-root oracle uses each existing caller deadline after a long provider phase, without renewing reads', t => {
  const capture = { version: 3 as const, platform: 'linux' as const,
    registrar: { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' },
    root: { pid: 4100, sessionId: 4100, pidfdId: '100', pidNamespaceId: '4026531836', bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    target: { pid: 4101, sessionId: 4100, pidfdId: '101', pidNamespaceId: '4026531836', bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
  const selection = { directory: '/TEST-original-artifact', manifestSha256: 'a'.repeat(64) };
  let clock = 1000, calls = 0, late = false;
  const budgets: number[] = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: { timeout: number }) => {
    assert.equal(file, '/TEST-original-node'); assert.equal(args.length, 4);
    assert.equal(args[1], '--observe-linux-root');
    assert.deepEqual(JSON.parse(args[2]!), selection); assert.deepEqual(JSON.parse(args[3]!), capture);
    assert.ok(options.timeout > 0 && options.timeout <= 5000); budgets.push(options.timeout);
    calls++; if (late) clock += options.timeout + 1;
    return calls === 1 ? 'same-live\n' : 'absent\n';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const oracle = createDesktopProcessRootOracle({ node: '/TEST-original-node', capture, selection,
    observe: () => assert.fail('Linux root observation uses only the bounded read-only actor') });
  assert.equal(oracle.observe(clock + 5000), 'same-live');
  clock += 180_001;
  const cleanupDeadline = clock + 30_000;
  assert.equal(oracle.observe(cleanupDeadline), 'absent', 'unrelated provider phases do not spend the cleanup read budget');
  assert.throws(() => oracle.observe(clock), /original-root oracle/u);
  assert.equal(calls, 2, 'an expired caller never starts another native read');
  for (let i = 0; i < 8; i++) { clock++; assert.equal(oracle.observe(cleanupDeadline), 'absent'); }
  clock = cleanupDeadline - 250; late = true;
  assert.throws(() => oracle.observe(cleanupDeadline), /original-root oracle/u);
  assert.equal(budgets.at(-1), 250, 'the final read receives only the original caller remainder');
  assert.equal(calls, 11);
  late = false;
  assert.throws(() => oracle.observe(clock + 5000), /original-root oracle/u);
  assert.equal(calls, 11, 'the13th call cannot reset the shared read cap with another deadline');
});

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
