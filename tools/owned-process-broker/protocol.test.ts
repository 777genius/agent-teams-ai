// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { Duplex, PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { encodeFrame, encodeLaunch, FrameDecoder, Op } from '../../src/main/utils/ownedProcess/codec';
import { createWindowsOwnedLaunchPort, verifyStagedBroker, type BrokerTransport } from '../../src/main/utils/ownedProcess/windowsBroker';
import type { BrokerExit } from '../../src/main/utils/ownedProcess/contract';
import type { Frame } from '../../src/main/utils/ownedProcess/codec';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';

const generation = '00112233-4455-6677-8899-aabbccddeeff';
const owner = { teamIncarnation: 'sandbox-team', runId: 'sandbox-run', laneId: 'lead', processGeneration: generation };
const spec = { executable: 'C:\\sandbox\\fixture.exe', commandLine: 'fixture.exe', cwd: 'C:\\sandbox', environment: [] };
/** Synthetic trusted wire peer tests only bridge policy; it is not native tree authority proof. */
function wirePeer(options: { holdLaunch?: boolean; holdWrite?: boolean; nativeFailed?: boolean; partialRelease?: boolean } = {}) {
  const requests: Frame[] = []; const decoder = new FrameDecoder(generation);
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  let exited: (exit: BrokerExit) => void = (exit: BrokerExit) => {
    throw new Error(`Exit observer missing (code=${exit.code ?? 'unknown'}, signal=${exit.signal ?? 'none'})`);
  };
  let completeWrite: (() => void) | undefined;
  const send = (opcode: number, requestId: bigint, payload = Buffer.alloc(0)): void => {
    control.push(encodeFrame({ opcode, requestId, generation, payload }));
  };
  const control = new Duplex({ read: () => undefined, write(chunk: Buffer, _encoding, done) {
    decoder.push(chunk, (frame) => {
      requests.push(frame);
      if (frame.opcode === Op.launch && !options.holdLaunch) {
        if (options.nativeFailed) { const p = Buffer.alloc(5); p[0] = 1; p.writeUInt32LE(5, 1); send(Op.failed, frame.requestId, p); }
        else { const p = Buffer.alloc(12); p.writeUInt32LE(421); p.writeBigUInt64LE(0x1234n, 4); send(Op.prepared, frame.requestId, p); }
      }
      if (frame.opcode === Op.release) {
        if (options.partialRelease) control.push(encodeFrame({ opcode: Op.released, requestId: frame.requestId, generation, payload: Buffer.alloc(0) }).subarray(0, 8));
        else send(Op.released, frame.requestId);
        control.push(null); exited({ code: 0, signal: null });
      }
    }); if (options.holdWrite) completeWrite = done; else done();
  } });
  const transport: BrokerTransport = { stdin, stdout, stderr, control, onFailure: () => undefined, onExit(callback) { exited = callback; } };
  let connections = 0;
  const factory = { available: () => true, connect: () => { connections++; return transport; } };
  return { factory, requests, connections: () => connections, stdout, stderr,
    exit: (fact: BrokerExit) => exited(fact),
    completeWrite: () => { const done = completeWrite; completeWrite = undefined; done?.(); },
    prepared() { const request = requests.find((frame) => frame.opcode === Op.launch); if (!request) throw new Error('No launch');
      const p = Buffer.alloc(12); p.writeUInt32LE(421); p.writeBigUInt64LE(0x1234n, 4); send(Op.prepared, request.requestId, p); },
    stopped(dispatchError = 0) {
      const request = requests.findLast((frame) => frame.opcode === Op.stop); if (!request) throw new Error('No Stop request');
      const p = Buffer.alloc(26); p[0] = 2; p[1] = 1; p.writeUInt32LE(7, 6); p.writeBigUInt64LE(0x1234n, 10); p.writeUInt32LE(dispatchError, 18);
      send(Op.stopped, request.requestId, p);
    }, root() { const p = Buffer.alloc(12); p.writeUInt32LE(7); p.writeBigUInt64LE(0x1234n, 4); send(Op.rootExit, 0n, p); } };
}
describe('bounded owned process protocol', () => {
  it('preserves request IDs beyond Number precision across fragmented and coalesced frames', () => {
    const decoder = new FrameDecoder(generation); const received: bigint[] = [];
    const frame = encodeFrame({ opcode: Op.stop, requestId: 9007199254740993n, generation, payload: Buffer.from([1]) });
    decoder.push(frame.subarray(0, 17), (value) => received.push(value.requestId));
    decoder.push(Buffer.concat([frame.subarray(17), frame]), (value) => received.push(value.requestId));
    decoder.end(); expect(received).toEqual([9007199254740993n, 9007199254740993n]);
  });
  it.each(['version', 'generation', 'length', 'opcode'])('seals on invalid %s before receiving the payload', (kind) => {
    const frame = encodeFrame({ opcode: Op.stop, requestId: 1n, generation, payload: Buffer.alloc(0) });
    if (kind === 'version') frame.writeUInt16LE(2, 4);
    if (kind === 'generation') frame[16] = 255;
    if (kind === 'length') frame.writeUInt32LE(4097, 0);
    if (kind === 'opcode') frame.writeUInt16LE(999, 6);
    const decoder = new FrameDecoder(generation);
    expect(() => decoder.push(frame, () => { throw new Error('Must not publish'); })).toThrow();
    expect(() => decoder.push(Buffer.alloc(1), () => undefined)).toThrow('sealed');
  });
  it('rejects truncated headers on EOF', () => {
    const decoder = new FrameDecoder(generation); decoder.push(Buffer.from([0]), () => undefined);
    expect(() => decoder.end()).toThrow('Truncated');
  });
  it('rejects unsupported relative path, NUL and duplicate environment before admission', () => {
    const spec = { executable: 'C:\\sandbox\\fixture.exe', commandLine: 'fixture.exe', cwd: 'C:\\sandbox', environment: ['PATH=x'] };
    expect(() => encodeLaunch({ ...spec, executable: 'fixture.exe' })).toThrow();
    expect(() => encodeLaunch({ ...spec, commandLine: 'x\0secret' })).toThrow();
    expect(() => encodeLaunch({ ...spec, environment: ['PATH=x', 'Path=y'] })).toThrow();
    expect(encodeLaunch({ ...spec, environment: ['UNICODE=你好'] }).length).toBeGreaterThan(0);
  });
  it('cancel before prepare retains the same authority and dispatches no target', async () => {
    const port = createWindowsOwnedLaunchPort('must-never-spawn.exe'); const pending = port.allocate(owner);
    const result = await pending.stop({ expectedOwner: owner, attemptId: 'pre-dispatch', mode: 'force', deadlineMs: performance.now() + 1000 });
    expect(result.kind).toBe('confirmed');
    const preparation = await port.prepare(pending, { executable: 'C:\\sandbox\\fixture.exe', commandLine: 'fixture', cwd: 'C:\\sandbox', environment: [] });
    expect(preparation).toMatchObject({ kind: 'failed', creation: 'known-not-created', cleanup: pending });
    if (result.kind !== 'confirmed') throw new Error('Expected receipt');
    await expect(pending.release({ ...result.receipt }, 'job-membership')).rejects.toThrow('authority');
    await expect(pending.release(result.receipt, 'no-local-dispatch')).rejects.toThrow('coverage');
    await pending.release(result.receipt, 'job-membership');
  });
  it('owner mismatch cannot seal or release a foreign pending generation', async () => {
    const port = createWindowsOwnedLaunchPort('must-never-spawn.exe'); const pending = port.allocate(owner);
    await expect(pending.stop({ expectedOwner: { ...owner, runId: 'replacement' }, attemptId: 'stale', mode: 'force', deadlineMs: performance.now() + 1000 })).rejects.toThrow('owner');
    const result = await pending.stop({ expectedOwner: owner, attemptId: 'valid', mode: 'force', deadlineMs: performance.now() + 1000 });
    expect(result.kind).toBe('confirmed');
  });
  it('abandonment is exact-owner fenced and cannot become a receipt or restart admission', async () => {
    const port = createWindowsOwnedLaunchPort('must-never-spawn.exe'); const pending = port.allocate(owner);
    expect(() => pending.abandonControl({ ...owner, runId: 'stale' })).toThrow('owner');
    pending.abandonControl(owner); pending.abandonControl(owner);
    const result = await pending.stop({ expectedOwner: owner, attemptId: 'abandoned', mode: 'force', deadlineMs: performance.now() + 1000 });
    expect(result.kind).toBe('unknown');
    const preparation = await port.prepare(pending, { executable: 'C:\\sandbox\\fixture.exe', commandLine: 'fixture', cwd: 'C:\\sandbox', environment: [] });
    expect(preparation).toMatchObject({ kind: 'failed', cleanup: pending });
    await expect(pending.release({ owner, attemptId: 'forged', coverage: 'job-membership', rootExited: true, proofDigest: 'fake' }, 'job-membership')).rejects.toThrow('authority');
  });
  it('keeps an attempt immutable and rejects conflicting replay instead of rewriting it', async () => {
    const pending = createWindowsOwnedLaunchPort('must-never-spawn.exe').allocate(owner);
    const request = { expectedOwner: owner, attemptId: 'immutable', mode: 'force' as const, deadlineMs: performance.now() + 1000 };
    const original = await pending.stop(request);
    expect(await pending.stop(request)).toBe(original);
    await expect(pending.stop({ ...request, mode: 'graceful' })).rejects.toThrow('Conflicting');
  });
  it('rejects wrong-architecture PE while accepting its declared machine', () => {
    const bytes = Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
    verifyBrokerArchitecture(bytes, 'x64'); expect(() => verifyBrokerArchitecture(bytes, 'arm64')).toThrow('architecture');
  });
  it('sealed pending sends zero launch writes while a nonsealed control reaches the same transport', async () => {
    const peer = wirePeer(); const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const cancelled = port.allocate(owner);
    await cancelled.stop({ expectedOwner: owner, attemptId: 'cancel', mode: 'force', deadlineMs: performance.now() + 1000 });
    expect((await port.prepare(cancelled, spec)).kind).toBe('failed');
    expect(peer.connections()).toBe(0); expect(peer.requests).toEqual([]);
    const live = port.allocate(owner); expect((await port.prepare(live, spec)).kind).toBe('prepared');
    expect(peer.connections()).toBe(1); expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch]);
    live.abandonControl(owner);
  });
  it('retains Stop root witness exactly once before immediate release and treats its EOF as normal', async () => {
    const peer = wirePeer(); const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner); const preparation = await port.prepare(pending, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const target = preparation.process; const early: number[] = [], late: number[] = [], failures: string[] = [];
    target.observeRootExit((exit) => early.push(exit.code)); target.observeTransportFailure((reason) => failures.push(reason));
    const stop = pending.stop({ expectedOwner: owner, attemptId: 'stop', mode: 'force', deadlineMs: performance.now() + 1000 });
    peer.stopped(); const outcome = await stop;
    expect(early).toEqual([7]); peer.root(); await Promise.resolve(); expect(early).toEqual([7]);
    target.observeRootExit((exit) => late.push(exit.code)); expect(late).toEqual([7]);
    target.stdout.resume(); target.stderr.resume(); peer.stdout.end(); peer.stderr.end();
    expect((await target.drain(performance.now() + 1000)).kind).toBe('complete');
    if (outcome.kind !== 'confirmed') throw new Error('Expected synthetic bridge receipt');
    await pending.release(outcome.receipt, 'job-membership');
    await new Promise<void>((done) => setImmediate(done)); expect(failures).toEqual([]);
  });
  it('latches earliest monotonic deadline when a valid reply arrives before a delayed timer callback', async () => {
    const peer = wirePeer(); const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner); await port.prepare(pending, spec);
    const long = pending.stop({ expectedOwner: owner, attemptId: 'long', mode: 'force', deadlineMs: performance.now() + 1000 });
    const earliest = performance.now() + 20;
    const short = pending.stop({ expectedOwner: owner, attemptId: 'short', mode: 'force', deadlineMs: earliest });
    while (performance.now() < earliest + 5) { /* bounded event-loop delay: timer cannot run yet */ }
    peer.stopped();
    const results = await Promise.all([long, short]);
    expect(results.map((value) => value.kind)).toEqual(['unknown', 'unknown']);
    expect(results).toMatchObject([{ deadlineExpired: true }, { deadlineExpired: true }]);
    pending.abandonControl(owner);
  });
  it('a failed native dispatch stays unknown despite a valid root witness and zero membership', async () => {
    const peer = wirePeer(); const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner); await port.prepare(pending, spec);
    const stop = pending.stop({ expectedOwner: owner, attemptId: 'failed-api', mode: 'force', deadlineMs: performance.now() + 1000 });
    peer.stopped(5); expect((await stop).kind).toBe('unknown'); pending.abandonControl(owner);
  });
  it('rejects cumulative oversize launch input before constructing any wire buffer', () => {
    const tail = 'x'.repeat(32700);
    const environment = Array.from({ length: 17 }, (_, i) => `KEY${i}=${tail}`);
    const allocations = vi.spyOn(Buffer, 'from');
    try {
      expect(() => encodeLaunch({ ...spec, environment })).toThrow('exceeds limit');
      expect(allocations).not.toHaveBeenCalled();
    } finally { allocations.mockRestore(); }
  });
  it('retains original broker exit independently of its immutable preparation cause', async () => {
    const peer = wirePeer({ holdLaunch: true });
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner); const preparing = port.prepare(pending, spec);
    peer.exit({ code: 198, signal: null }); const failure = await preparing;
    expect(failure).toMatchObject({ kind: 'failed', creation: 'uncertain', cleanup: pending });
    expect(pending.diagnostics()).toMatchObject({ cause: { name: 'broker-exit', phase: 'prepare' },
      brokerExit: { code: 198, signal: null }, nativeExitCategory: 'owner-eof', nativeCancelUndrained: true });
    const cause = pending.diagnostics().cause; pending.abandonControl(owner);
    expect(pending.diagnostics().cause).toBe(cause);
    expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch]);
  });
  it('preserves actual native Failed creation/code when a later original exit is observed', async () => {
    const peer = wirePeer({ nativeFailed: true });
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner); const failure = await port.prepare(pending, spec);
    expect(failure).toMatchObject({ kind: 'failed', creation: 'contained-suspended', cleanup: pending });
    const cause = pending.diagnostics().cause; peer.exit({ code: 74, signal: null });
    expect(pending.diagnostics()).toMatchObject({ cause: { name: 'native-failed', phase: 'prepare' },
      nativeFailure: { creation: 'contained-suspended', code: 5 }, brokerExit: { code: 74 }, nativeExitCategory: 'write-deadline' });
    expect(pending.diagnostics().cause).toBe(cause);
    pending.abandonControl(owner);
  });
  it('latches write failure before a late completed callback/reply and keeps Stop unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const peer = wirePeer({ holdLaunch: true, holdWrite: true });
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner);
    try {
      const preparing = port.prepare(pending, spec); await vi.advanceTimersByTimeAsync(5001);
      expect(await preparing).toMatchObject({ kind: 'failed', creation: 'uncertain', cleanup: pending });
      const cause = pending.diagnostics().cause;
      expect(cause).toEqual({ name: 'control-write-deadline', phase: 'prepare', writeCompleted: false });
      const request = { expectedOwner: owner, attemptId: 'failed-wire', mode: 'force' as const, deadlineMs: performance.now() + 1000 };
      const original = await pending.stop(request); expect(original.kind).toBe('unknown');
      peer.completeWrite(); peer.prepared(); peer.exit({ code: 74, signal: null });
      await Promise.resolve(); expect(await pending.stop(request)).toBe(original);
      expect(pending.diagnostics().cause).toBe(cause);
      expect((await port.prepare(pending, spec)).kind).toBe('failed');
      await expect(pending.release({ owner, attemptId: 'fake', coverage: 'job-membership', rootExited: true, proofDigest: 'fake' }, 'job-membership')).rejects.toThrow('authority');
      expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch]);
    } finally { pending.abandonControl(owner); peer.completeWrite(); vi.useRealTimers(); }
  });
  it.each([false, true])('attributes overlapping Prepare/Stop to its own write (Launch completed: %s)', async (completeLaunch) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const peer = wirePeer({ holdLaunch: true, holdWrite: true });
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner);
    try {
      const preparing = port.prepare(pending, spec);
      const request = { expectedOwner: owner, attemptId: 'overlapping-stop', mode: 'force' as const, deadlineMs: performance.now() + 20000 };
      const stopping = pending.stop(request); // legal while Prepare's earlier write is incomplete
      await vi.advanceTimersByTimeAsync(3000);
      if (completeLaunch) {
        peer.completeWrite(); await Promise.resolve();
        expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch, Op.stop]);
        expect(pending.diagnostics().writeCompleted, 'Earlier Launch callback cannot complete queued Stop').toBe(false);
      }
      await vi.advanceTimersByTimeAsync(2001);
      expect(await preparing).toMatchObject({ kind: 'failed', creation: 'uncertain', cleanup: pending });
      const original = await stopping; expect(original.kind).toBe('unknown');
      const cause = pending.diagnostics().cause;
      expect(cause).toEqual({ name: 'control-write-deadline', phase: completeLaunch ? 'stop' : 'prepare', writeCompleted: false });
      peer.completeWrite(); await Promise.resolve();
      expect(await pending.stop(request)).toBe(original); expect(pending.diagnostics().cause).toBe(cause);
      expect((await port.prepare(pending, spec)).kind).toBe('failed');
      await expect(pending.release({ owner, attemptId: 'forged', coverage: 'job-membership', rootExited: true, proofDigest: 'fake' }, 'job-membership')).rejects.toThrow('authority');
      expect(peer.requests.some((frame) => frame.opcode === Op.resume || frame.opcode === Op.release)).toBe(false);
      expect(peer.connections()).toBe(1);
    } finally { pending.abandonControl(owner); peer.completeWrite(); vi.useRealTimers(); }
  });
  it('partial Released bytes plus original exit0 never substitute for a complete acknowledgement', async () => {
    const peer = wirePeer({ partialRelease: true });
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const owned = port.allocate(owner); const preparation = await port.prepare(owned, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const stopping = owned.stop({ expectedOwner: owner, attemptId: 'partial-ack', mode: 'force', deadlineMs: performance.now() + 1000 });
    peer.stopped(); const stopped = await stopping;
    preparation.process.stdout.resume(); preparation.process.stderr.resume(); peer.stdout.end(); peer.stderr.end();
    expect((await preparation.process.drain(performance.now() + 1000)).kind).toBe('complete');
    if (stopped.kind !== 'confirmed') throw new Error('Synthetic bridge facts missing');
    await expect(owned.release(stopped.receipt, 'job-membership')).rejects.toThrow();
    expect(owned.diagnostics()).toMatchObject({ cause: { name: 'protocol', phase: 'release' }, brokerExit: { code: 0, signal: null } });
    owned.abandonControl(owner);
  });
  it('runtime staged admission rejects tampered bytes, schema/protocol and machine mismatch', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owned-admission-')); const path = join(sandbox, 'owned-process-broker.exe');
    const bytes = Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
    const manifest = { schema: 1, protocol: 1, platform: 'win32', arch: 'x64', file: 'owned-process-broker.exe', sha256: createHash('sha256').update(bytes).digest('hex') };
    const write = (value = manifest): void => { writeFileSync(path, bytes); writeFileSync(join(sandbox, 'manifest.json'), JSON.stringify(value)); };
    try {
      write(); verifyStagedBroker(path, 'x64'); expect(() => verifyStagedBroker(path, 'arm64')).toThrow('manifest');
      write({ ...manifest, protocol: 2 }); expect(() => verifyStagedBroker(path, 'x64')).toThrow('manifest');
      write({ ...manifest, schema: 2 }); expect(() => verifyStagedBroker(path, 'x64')).toThrow('manifest');
      write(); bytes[100] = 1; writeFileSync(path, bytes); expect(() => verifyStagedBroker(path, 'x64')).toThrow('digest');
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });
});
