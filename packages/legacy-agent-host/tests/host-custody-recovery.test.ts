import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { DEFAULT_HOST_LIMITS } from '../dist/contracts.js';
import { HostCustodyClient, HOST_CUSTODY_MAX_ALLOCATIONS, HOST_CUSTODY_READY_METHOD, hostCustodyRequestSchema } from '../dist/owned-process/hostCustody.js';
import { HostWindowsLaunch } from '../dist/owned-process/HostWindowsLaunch.js';
import { RetainedWindowsCustody } from '../dist/owned-process/RetainedWindowsCustody.js';
import type { RpcRequest } from '../dist/contracts.js';
import type { OwnedLaunchPort, PreparedOwnedProcess, StopRequest, TreeReceipt } from '../dist/owned-process/contract.js';

const binding = { mainEpoch: 'TEST-main', hostIncarnation: 'TEST-host', profileDigest: 'a'.repeat(64) };
function client() {
  const sent: RpcRequest[] = [];
  const transport = new HostCustodyClient({ hostIncarnation: binding.hostIncarnation, timeoutMs: 1000,
    limits: { ...DEFAULT_HOST_LIMITS, maxPendingRequests: 4, reservedControlRequests: 1 },
    send(frame) { sent.push(frame); return true; } });
  assert.equal(transport.bind(binding), true);
  const receive = (frame: unknown) => transport.receive(frame, Buffer.byteLength(JSON.stringify(frame)));
  const hint = (capability: string, stream: 'stdout' | 'stderr' | 'state' = 'stdout') => receive({
    jsonrpc: '2.0', method: HOST_CUSTODY_READY_METHOD, params: { binding, hint: { capability, stream } },
  });
  return { transport, sent, receive, hint };
}

test('new readiness during an empty original read wakes the same stream after its reply', async () => {
  const f = client(), notifications: string[] = [];
  f.transport.onReadable(hint => notifications.push(hint.capability));
  try {
    f.hint('TEST-original');
    const read = f.transport.request({ operation: 'read', capability: 'TEST-original', stream: 'stdout' });
    assert.equal(f.sent.length, 1);
    f.hint('TEST-original');
    assert.equal(notifications.length, 1, 'An in-flight read coalesces newer readiness');
    const empty = { status: 'completed', value: { operation: 'read', state: 'empty', bytes: '', more: false } };
    f.receive({ jsonrpc: '2.0', id: f.sent[0]!.id, result: { binding, reply: empty } });
    assert.deepEqual(await read, empty);
    assert.equal(notifications.length, 2, 'The original empty ACK must not strand a newer hint');
    const later = f.transport.request({ operation: 'read', capability: 'TEST-original', stream: 'stdout' });
    f.receive({ jsonrpc: '2.0', id: f.sent[1]!.id, result: { binding, reply: empty } });
    await later;
    assert.equal(notifications.length, 2, 'An acknowledged hint is removed without a synthetic wake');
  } finally { f.transport.seal(); }
});

test('readiness capacity follows retained producers instead of simultaneous requests', () => {
  const f = client();
  let notifications = 0;
  f.transport.onReadable(() => { notifications++; });
  try {
    for (let i = 0; i < HOST_CUSTODY_MAX_ALLOCATIONS; i++)
      for (const stream of ['state', 'stdout', 'stderr'] as const) f.hint('TEST-owner-' + i, stream);
    assert.equal(notifications, HOST_CUSTODY_MAX_ALLOCATIONS * 3);
    f.hint('TEST-owner-0');
    assert.equal(notifications, HOST_CUSTODY_MAX_ALLOCATIONS * 3, 'Repeated readiness stays coalesced');
    assert.throws(() => f.hint('TEST-excess-owner'), /readiness capacity/);
    assert.equal(f.sent.length, 0, 'A readiness marker never consumes a request slot');
  } finally { f.transport.seal(); }
});

test('Main retries an unconfirmed original cleanup on the next close with a new attempt', async () => {
  const attempts: StopRequest[] = [], released: TreeReceipt[] = [];
  let finishFirst!: () => void;
  const gate = new Promise<void>(resolve => { finishFirst = resolve; });
  const primitive: OwnedLaunchPort = {
    allocate(owner) {
      return {
        owner, diagnostics: () => ({ writeCompleted: false }),
        async stop(request) {
          assert.deepEqual(request.expectedOwner, owner);
          attempts.push(request);
          if (attempts.length === 1) {
            await gate;
            return { kind: 'unknown', owner, attemptId: request.attemptId, reason: 'TEST no original ACK',
              creation: 'uncertain', deadlineExpired: false };
          }
          assert.notEqual(request.attemptId, attempts[0]!.attemptId);
          return { kind: 'confirmed', receipt: { owner, attemptId: request.attemptId,
            coverage: 'no-local-dispatch', rootExited: false, proofDigest: 'c'.repeat(64) } };
        },
        async drain() { return { kind: 'incomplete' }; },
        async release(receipt) { released.push(receipt); },
        abandonControl() { assert.fail('Cleanup must keep the original authority'); },
      };
    },
    async prepare() { assert.fail('This test never launches a native process'); },
  };
  const owner = new RetainedWindowsCustody({ profileId: 'TEST-profile', profileDigest: binding.profileDigest,
    selectBroker: () => ({ path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64), arch: 'x64', protocol: 1 }),
    async verifyLaunch() { assert.fail('No native prepare'); }, createPort: () => primitive });
  const signal = new AbortController();
  const port = owner.attach({ profileId: 'TEST-profile', binding: { ...binding, mainEpoch: owner.mainEpoch },
    signal: signal.signal, hostExited: new Promise<void>(() => {}) });
  await port.handle({ operation: 'allocate', capability: 'TEST-original',
    owner: { teamIncarnation: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-member',
      processGeneration: '00112233-4455-6677-8899-aabbccddeeff' },
    brokerRef: 'b'.repeat(64), executableSha256: 'c'.repeat(64), launchSha256: 'd'.repeat(64), launchBytes: 1, budgetMs: 1000 });
  const first = owner.close();
  assert.equal(owner.close(), first, 'Concurrent close shares one original cleanup attempt');
  finishFirst();
  assert.equal(await first, false);
  assert.equal(released.length, 0);
  assert.equal(await owner.close(), true);
  assert.equal(attempts.length, 2); assert.equal(released.length, 1);
  assert.equal(await owner.close(), true);
  assert.equal(attempts.length, 2, 'A released allocation is never stopped again');
});

test('incomplete native drain replies before the original queued Host deadline and permits only genuine release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const advance = async (ms: number) => { clock += ms; t.mock.timers.tick(ms); await flush(); };
  for (const scenario of [
    { callerBudget: 300, clientTimeout: 1000, admissionDelay: 50 },
    { callerBudget: 50, clientTimeout: 1000, admissionDelay: 0 },
    { callerBudget: 1000, clientTimeout: 200, admissionDelay: 25 },
  ]) {
    let drainDeadline = 0, drained = false, stops = 0, releases = 0, blocked = false;
    let receipt: TreeReceipt | undefined, nativePending: PreparedOwnedProcess | undefined;
    const streams = [new PassThrough(), new PassThrough(), new PassThrough()];
    const primitive: OwnedLaunchPort = {
      allocate(owner) {
        nativePending = {
          owner, root: { pid: 421, birth: '0000000000001234' },
          stdin: streams[0]!, stdout: streams[1]!, stderr: streams[2]!,
          diagnostics: () => ({ writeCompleted: true }),
          observeRootExit: () => () => {}, observeTransportFailure: () => () => {},
          async resume(_owner, installOwner) { await installOwner(); },
          async stop(request) {
            stops++; assert.deepEqual(request.expectedOwner, owner);
            receipt = { owner, attemptId: request.attemptId, coverage: 'job-membership',
              rootExited: true, proofDigest: 'e'.repeat(64) };
            return { kind: 'confirmed', receipt };
          },
          drain(deadline) {
            drainDeadline = deadline;
            return new Promise(resolve => setTimeout(() => {
              drained = true; resolve({ kind: 'incomplete', reason: 'TEST bounded unconsumed tail' });
            }, Math.max(0, deadline - performance.now())));
          },
          async release(value, coverage) {
            assert.equal(value, receipt, 'Main accepts only its original synthetic native receipt');
            assert.equal(coverage, 'job-membership'); assert.equal(drained, true); releases++;
          },
          abandonControl() { assert.fail('No cleanup authority may be abandoned'); },
        };
        return nativePending;
      },
      async prepare(pending) {
        assert.equal(pending, nativePending); return { kind: 'prepared', process: nativePending! };
      },
    };
    const broker = { path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64), arch: 'x64' as const, protocol: 1 as const };
    const owner = new RetainedWindowsCustody({ profileId: 'TEST-profile', profileDigest: binding.profileDigest,
      selectBroker: () => broker, async verifyLaunch() {}, createPort: () => primitive });
    const wireBinding = { ...binding, mainEpoch: owner.mainEpoch }, signal = new AbortController();
    const main = owner.attach({ profileId: 'TEST-profile', binding: wireBinding,
      signal: signal.signal, hostExited: new Promise<void>(() => {}) });
    const transport = new HostCustodyClient({ hostIncarnation: binding.hostIncarnation,
      timeoutMs: scenario.clientTimeout, limits: DEFAULT_HOST_LIMITS, canSend: () => !blocked,
      send(frame) {
        const request = hostCustodyRequestSchema.parse(frame);
        void Promise.resolve(main.handle(request.params.call)).then(value => {
          const reply = { jsonrpc: '2.0', id: frame.id, result: { binding: wireBinding,
            reply: { status: 'completed', value } } };
          const deliver = () => { transport.receive(reply, Buffer.byteLength(JSON.stringify(reply))); };
          if (request.params.call.operation === 'drain') setTimeout(deliver, 25);
          else deliver();
        });
        return true;
      },
    });
    assert.equal(transport.bind(wireBinding), true);
    try {
      const profile = { provider: 'codex', cwd: 'C:\\TEST', environment: {}, windowsBroker: broker,
        executable: { path: 'C:\\TEST\\finite.exe', sha256: 'c'.repeat(64) } };
      const port = new HostWindowsLaunch(() => transport).port(profile, () => true);
      const pending = port.allocate({ teamIncarnation: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-member',
        processGeneration: '00112233-4455-6677-8899-aabbccddeeff' });
      assert.equal((await port.prepare(pending, { executable: profile.executable.path,
        commandLine: 'finite.exe', cwd: profile.cwd, environment: [] })).kind, 'prepared');
      const stopped = await pending.stop({ expectedOwner: pending.owner, attemptId: 'TEST-drain-stop',
        mode: 'force', deadlineMs: clock + 1000 });
      assert.equal(stopped.kind, 'confirmed'); if (stopped.kind !== 'confirmed') assert.fail();
      const originalDeadline = clock + Math.min(scenario.callerBudget, scenario.clientTimeout);
      blocked = true;
      let outcome: unknown, error: unknown;
      const draining = pending.drain(clock + scenario.callerBudget).then(value => { outcome = value; }, value => { error = value; });
      await advance(scenario.admissionDelay);
      assert.equal(drainDeadline, 0, 'Queued drain has not invoked Main');
      blocked = false; transport.resumeAdmission(); await flush();
      await advance(Math.max(0, drainDeadline - clock));
      assert.equal(outcome, undefined, 'The original incomplete result still awaits its wire reply');
      await advance(25); await draining;
      assert.equal(error, undefined); assert.deepEqual(outcome, { kind: 'incomplete' });
      assert.ok(clock < originalDeadline, 'Neither queueing nor native drain extends the original Host deadline');
      await assert.rejects(pending.release({ ...stopped.receipt }, 'job-membership'), /Original Main custody unavailable/);
      assert.equal(releases, 0);
      await pending.release(stopped.receipt, 'job-membership');
      assert.equal(releases, 1); assert.equal(stops, 1); assert.equal(await owner.close(), true);
    } finally {
      signal.abort(); transport.seal(); for (const stream of streams) stream.destroy();
    }
  }
});
