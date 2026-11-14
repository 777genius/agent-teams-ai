// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { Duplex, PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encodeServiceCaptureCurrent, nativeProcessProfileSchema, windowsBrokerReference } from '@agent-teams/legacy-agent-host/owned-process';

import {
  encodeFrame,
  encodeLaunch,
  FrameDecoder,
  Op,
} from '../../src/main/utils/ownedProcess/codec';
import {
  createWindowsOwnedLaunchPort,
  verifyStagedBroker,
  type BrokerTransport,
} from '../../src/main/utils/ownedProcess/windowsBroker';
import type { BrokerExit } from '../../src/main/utils/ownedProcess/contract';
import type { Frame } from '../../src/main/utils/ownedProcess/codec';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';
import { createFixtureOutputCollector } from './nativeGateOutput';
import { parseBinaryInventory, validateNativeWriteFacts } from './nativePendingWriteGate';

const generation = '00112233-4455-6677-8899-aabbccddeeff';
const owner = {
  teamIncarnation: 'sandbox-team',
  runId: 'sandbox-run',
  laneId: 'lead',
  processGeneration: generation,
};
const spec = {
  executable: 'C:\\sandbox\\fixture.exe',
  commandLine: 'fixture.exe',
  cwd: 'C:\\sandbox',
  environment: [],
};
/** Synthetic trusted wire peer tests only bridge policy; it is not native tree authority proof. */
function wirePeer(
  options: {
    holdLaunch?: boolean;
    holdWrite?: boolean;
    nativeFailed?: boolean;
    partialRelease?: boolean;
    holdReleaseExit?: boolean;
    releaseExit?: BrokerExit;
    exitBeforeReleaseAck?: boolean;
  } = {}
) {
  const requests: Frame[] = [];
  const decoder = new FrameDecoder(generation);
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    stdin = new PassThrough();
  let exited: (exit: BrokerExit) => void = (exit: BrokerExit) => {
    throw new Error(
      `Exit observer missing (code=${exit.code ?? 'unknown'}, signal=${exit.signal ?? 'none'})`
    );
  };
  let completeWrite: (() => void) | undefined;
  const send = (opcode: number, requestId: bigint, payload = Buffer.alloc(0)): void => {
    control.push(encodeFrame({ opcode, requestId, generation, payload }));
  };
  const control = new Duplex({
    read: () => undefined,
    write(chunk: Buffer, _encoding, done) {
      decoder.push(chunk, (frame) => {
        requests.push(frame);
        if (frame.opcode === Op.launch && !options.holdLaunch) {
          if (options.nativeFailed) {
            const p = Buffer.alloc(5);
            p[0] = 1;
            p.writeUInt32LE(5, 1);
            send(Op.failed, frame.requestId, p);
          } else {
            const p = Buffer.alloc(12);
            p.writeUInt32LE(421);
            p.writeBigUInt64LE(0x1234n, 4);
            send(Op.prepared, frame.requestId, p);
          }
        }
        if (frame.opcode === Op.release) {
          if (options.exitBeforeReleaseAck)
            exited(options.releaseExit ?? { code: 0, signal: null });
          if (options.partialRelease)
            control.push(
              encodeFrame({
                opcode: Op.released,
                requestId: frame.requestId,
                generation,
                payload: Buffer.alloc(0),
              }).subarray(0, 8)
            );
          else send(Op.released, frame.requestId);
          control.push(null);
          if (!options.holdReleaseExit && !options.exitBeforeReleaseAck)
            exited(options.releaseExit ?? { code: 0, signal: null });
        }
      });
      if (options.holdWrite) completeWrite = done;
      else done();
    },
  });
  const transport: BrokerTransport = {
    stdin,
    stdout,
    stderr,
    control,
    onFailure: () => undefined,
    onExit(callback) {
      exited = callback;
    },
  };
  let connections = 0;
  const factory = {
    available: () => true,
    connect: () => {
      connections++;
      return transport;
    },
  };
  return {
    factory,
    requests,
    connections: () => connections,
    stdout,
    stderr,
    exit: (fact: BrokerExit) => exited(fact),
    completeWrite: () => {
      const done = completeWrite;
      completeWrite = undefined;
      done?.();
    },
    eof: () => control.push(null),
    resumed() {
      const request = requests.findLast((frame) => frame.opcode === Op.resume);
      if (!request) throw new Error('No Resume request');
      send(Op.resumed, request.requestId);
    },
    resumeFailed() {
      const request = requests.findLast((frame) => frame.opcode === Op.resume);
      if (!request) throw new Error('No Resume request');
      const payload = Buffer.alloc(5);
      payload[0] = 1;
      payload.writeUInt32LE(5, 1);
      send(Op.failed, request.requestId, payload);
    },
    prepared() {
      const request = requests.find((frame) => frame.opcode === Op.launch);
      if (!request) throw new Error('No launch');
      const p = Buffer.alloc(12);
      p.writeUInt32LE(421);
      p.writeBigUInt64LE(0x1234n, 4);
      send(Op.prepared, request.requestId, p);
    },
    stopped(dispatchError = 0) {
      const request = requests.findLast((frame) => frame.opcode === Op.stop);
      if (!request) throw new Error('No Stop request');
      const p = Buffer.alloc(26);
      p[0] = 2;
      p[1] = 1;
      p.writeUInt32LE(7, 6);
      p.writeBigUInt64LE(0x1234n, 10);
      p.writeUInt32LE(dispatchError, 18);
      send(Op.stopped, request.requestId, p);
    },
    serviceIdentity(request: Frame, key = 1n, birth = 0x4567n) {
      if (request.opcode !== Op.serviceCaptureCurrent && request.opcode !== Op.serviceSettle)
        throw new Error('Expected original capture/settle');
      const payload = Buffer.alloc(16);
      payload.writeBigUInt64LE(key); payload.writeBigUInt64LE(birth, 8);
      send(request.opcode === Op.serviceSettle ? Op.serviceSettled : Op.serviceCaptured,
        request.requestId, payload);
    },
    serviceFacts(request: Frame, key = 1n, birth = 0x4567n, active = 0) {
      if (request.opcode !== Op.serviceStop && request.opcode !== Op.serviceQuery)
        throw new Error('Expected original Stop/query');
      const payload = Buffer.alloc(33);
      payload.writeBigUInt64LE(key); payload.writeBigUInt64LE(birth, 8);
      payload[16] = active === 0 ? 1 : 0;
      payload.writeUInt32LE(active, 17); payload.writeUInt32LE(active ? 0 : 7, 21);
      send(request.opcode === Op.serviceStop ? Op.serviceStopped : Op.serviceObserved,
        request.requestId, payload);
    },
    serviceRefused(request: Frame) {
      const payload = Buffer.alloc(5); payload[0] = 2; payload.writeUInt32LE(1168, 1);
      send(Op.serviceRefused, request.requestId, payload);
    },
    root() {
      const p = Buffer.alloc(12);
      p.writeUInt32LE(7);
      p.writeBigUInt64LE(0x1234n, 4);
      send(Op.rootExit, 0n, p);
    },
  };
}
describe('bounded owned process protocol', () => {
  it('preserves exact request IDs and a current-child selector across fragmented and coalesced frames', () => {
    const decoder = new FrameDecoder(generation);
    const received: Frame[] = [];
    const frame = encodeFrame({
      opcode: Op.stop,
      requestId: 9007199254740993n,
      generation,
      payload: Buffer.from([1]),
    });
    const current = encodeFrame({
      opcode: Op.serviceCaptureCurrent,
      requestId: 9007199254740994n,
      generation,
      payload: encodeServiceCaptureCurrent(421),
    });
    decoder.push(frame.subarray(0, 17), (value) => received.push(value));
    decoder.push(Buffer.concat([frame.subarray(17), frame, current]), (value) =>
      received.push(value)
    );
    decoder.end();
    expect(received.map(value => value.requestId)).toEqual([9007199254740993n, 9007199254740993n, 9007199254740994n]);
    expect(received[2]!.opcode).toBe(Op.serviceCaptureCurrent);
    expect(received[2]!.payload).toEqual(Buffer.from([165, 1, 0, 0]));
    for (const invalid of [0, -1, 1.5, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => encodeServiceCaptureCurrent(invalid)).toThrow('selector');
  });
  it.each(['version', 'generation', 'length', 'opcode'])(
    'seals on invalid %s before receiving the payload',
    (kind) => {
      const frame = encodeFrame({
        opcode: Op.stop,
        requestId: 1n,
        generation,
        payload: Buffer.alloc(0),
      });
      if (kind === 'version') frame.writeUInt16LE(2, 4);
      if (kind === 'generation') frame[16] = 255;
      if (kind === 'length') frame.writeUInt32LE(4097, 0);
      if (kind === 'opcode') frame.writeUInt16LE(999, 6);
      const decoder = new FrameDecoder(generation);
      expect(() =>
        decoder.push(frame, () => {
          throw new Error('Must not publish');
        })
      ).toThrow();
      expect(() => decoder.push(Buffer.alloc(1), () => undefined)).toThrow('sealed');
    }
  );
  it('rejects truncated headers on EOF', () => {
    const decoder = new FrameDecoder(generation);
    decoder.push(Buffer.from([0]), () => undefined);
    expect(() => decoder.end()).toThrow('Truncated');
  });
  it('rejects unsupported relative path, NUL and duplicate environment before admission', () => {
    const spec = {
      executable: 'C:\\sandbox\\fixture.exe',
      commandLine: 'fixture.exe',
      cwd: 'C:\\sandbox',
      environment: ['PATH=x'],
    };
    expect(() => encodeLaunch({ ...spec, executable: 'fixture.exe' })).toThrow();
    expect(() => encodeLaunch({ ...spec, commandLine: 'x\0secret' })).toThrow();
    expect(() => encodeLaunch({ ...spec, environment: ['PATH=x', 'Path=y'] })).toThrow();
    expect(encodeLaunch({ ...spec, environment: ['UNICODE=你好'] }).length).toBeGreaterThan(0);
  });
  it('cancel before prepare retains the same authority and dispatches no target', async () => {
    const port = createWindowsOwnedLaunchPort('must-never-spawn.exe');
    const pending = port.allocate(owner);
    const result = await pending.stop({
      expectedOwner: owner,
      attemptId: 'pre-dispatch',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    expect(result.kind).toBe('confirmed');
    const preparation = await port.prepare(pending, {
      executable: 'C:\\sandbox\\fixture.exe',
      commandLine: 'fixture',
      cwd: 'C:\\sandbox',
      environment: [],
    });
    expect(preparation).toMatchObject({
      kind: 'failed',
      creation: 'known-not-created',
      cleanup: pending,
    });
    if (result.kind !== 'confirmed') throw new Error('Expected receipt');
    await expect(pending.release({ ...result.receipt }, 'job-membership')).rejects.toThrow(
      'authority'
    );
    await expect(pending.release(result.receipt, 'no-local-dispatch')).rejects.toThrow('coverage');
    await pending.release(result.receipt, 'job-membership');
  });
  it('owner mismatch cannot seal or release a foreign pending generation', async () => {
    const port = createWindowsOwnedLaunchPort('must-never-spawn.exe');
    const pending = port.allocate(owner);
    await expect(
      pending.stop({
        expectedOwner: { ...owner, runId: 'replacement' },
        attemptId: 'stale',
        mode: 'force',
        deadlineMs: performance.now() + 1000,
      })
    ).rejects.toThrow('owner');
    const result = await pending.stop({
      expectedOwner: owner,
      attemptId: 'valid',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    expect(result.kind).toBe('confirmed');
  });
  it('abandonment is exact-owner fenced and cannot become a receipt or restart admission', async () => {
    const port = createWindowsOwnedLaunchPort('must-never-spawn.exe');
    const pending = port.allocate(owner);
    expect(() => pending.abandonControl({ ...owner, runId: 'stale' })).toThrow('owner');
    pending.abandonControl(owner);
    pending.abandonControl(owner);
    const result = await pending.stop({
      expectedOwner: owner,
      attemptId: 'abandoned',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    expect(result.kind).toBe('unknown');
    const preparation = await port.prepare(pending, {
      executable: 'C:\\sandbox\\fixture.exe',
      commandLine: 'fixture',
      cwd: 'C:\\sandbox',
      environment: [],
    });
    expect(preparation).toMatchObject({ kind: 'failed', cleanup: pending });
    await expect(
      pending.release(
        {
          owner,
          attemptId: 'forged',
          coverage: 'job-membership',
          rootExited: true,
          proofDigest: 'fake',
        },
        'job-membership'
      )
    ).rejects.toThrow('authority');
  });
  it('keeps an attempt immutable and rejects conflicting replay instead of rewriting it', async () => {
    const pending = createWindowsOwnedLaunchPort('must-never-spawn.exe').allocate(owner);
    const request = {
      expectedOwner: owner,
      attemptId: 'immutable',
      mode: 'force' as const,
      deadlineMs: performance.now() + 1000,
    };
    const original = await pending.stop(request);
    expect(await pending.stop(request)).toBe(original);
    await expect(pending.stop({ ...request, mode: 'graceful' })).rejects.toThrow('Conflicting');
  });
  it('rejects wrong-architecture PE while accepting its declared machine', () => {
    const bytes = Buffer.alloc(128);
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64);
    bytes.writeUInt16LE(0x8664, 68);
    verifyBrokerArchitecture(bytes, 'x64');
    expect(() => verifyBrokerArchitecture(bytes, 'arm64')).toThrow('architecture');
  });
  it('sealed pending sends zero launch writes while a nonsealed control reaches the same transport', async () => {
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const cancelled = port.allocate(owner);
    await cancelled.stop({
      expectedOwner: owner,
      attemptId: 'cancel',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    expect((await port.prepare(cancelled, spec)).kind).toBe('failed');
    expect(peer.connections()).toBe(0);
    expect(peer.requests).toEqual([]);
    const live = port.allocate(owner);
    expect((await port.prepare(live, spec)).kind).toBe('prepared');
    expect(peer.connections()).toBe(1);
    expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch]);
    live.abandonControl(owner);
  });
  it('retains Stop root witness exactly once before immediate release and treats its EOF as normal', async () => {
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    const preparation = await port.prepare(pending, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const target = preparation.process;
    const early: number[] = [],
      late: number[] = [],
      failures: string[] = [];
    target.observeRootExit((exit) => early.push(exit.code));
    target.observeTransportFailure((reason) => failures.push(reason));
    const stop = pending.stop({
      expectedOwner: owner,
      attemptId: 'stop',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    peer.stopped();
    const outcome = await stop;
    expect(early).toEqual([7]);
    peer.root();
    await Promise.resolve();
    expect(early).toEqual([7]);
    target.observeRootExit((exit) => late.push(exit.code));
    expect(late).toEqual([7]);
    target.stdout.resume();
    target.stderr.resume();
    peer.stdout.end();
    peer.stderr.end();
    expect((await target.drain(performance.now() + 1000)).kind).toBe('complete');
    if (outcome.kind !== 'confirmed') throw new Error('Expected synthetic bridge receipt');
    await pending.release(outcome.receipt, 'job-membership');
    await new Promise<void>((done) => setImmediate(done));
    expect(failures).toEqual([]);
  });
  it('latches earliest monotonic deadline when a valid reply arrives before a delayed timer callback', async () => {
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    await port.prepare(pending, spec);
    const long = pending.stop({
      expectedOwner: owner,
      attemptId: 'long',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    const earliest = performance.now() + 20;
    const short = pending.stop({
      expectedOwner: owner,
      attemptId: 'short',
      mode: 'force',
      deadlineMs: earliest,
    });
    while (performance.now() < earliest + 5) {
      /* bounded event-loop delay: timer cannot run yet */
    }
    peer.stopped();
    const results = await Promise.all([long, short]);
    expect(results.map((value) => value.kind)).toEqual(['unknown', 'unknown']);
    expect(results).toMatchObject([{ deadlineExpired: true }, { deadlineExpired: true }]);
    pending.abandonControl(owner);
  });
  it('retains bounded drain on the original pending authority when Stop wins held preparation', async () => {
    const peer = wirePeer({ holdLaunch: true });
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner), preparing = port.prepare(pending, spec);
    const stopping = pending.stop({ expectedOwner: owner, attemptId: 'prepare-race', mode: 'force',
      deadlineMs: performance.now() + 1000 });
    peer.prepared();
    const preparation = await preparing;
    expect(preparation).toMatchObject({ kind: 'failed', cleanup: pending });
    peer.stopped();
    const stopped = await stopping;
    if (stopped.kind !== 'confirmed' || preparation.kind !== 'failed') throw new Error('Expected original synthetic receipt');
    await expect(preparation.cleanup.release(stopped.receipt, 'job-membership')).rejects.toThrow('drain');
    peer.stdout.end('TEST tail never consumed by a prepared facade'); peer.stderr.end();
    expect((await preparation.cleanup.drain(performance.now() + 20)).kind).toBe('incomplete');
    await preparation.cleanup.release(stopped.receipt, 'job-membership');
    expect(peer.requests.filter(frame => frame.opcode === Op.release)).toHaveLength(1);
  });
  it('an expired Stop waits for its original wire reply before a fresh attempt needs its own ACK', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort('C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory);
    const pending = port.allocate(owner);
    try {
      await port.prepare(pending, spec);
      const first = { expectedOwner: owner, attemptId: 'expired', mode: 'force' as const, deadlineMs: 1010 };
      const firstPromise = pending.stop(first);
      clock = 1011; await vi.advanceTimersByTimeAsync(11);
      const original = await firstPromise;
      expect(original).toMatchObject({ kind: 'unknown', deadlineExpired: true });
      let secondSettled = false;
      const second = pending.stop({ ...first, attemptId: 'reconcile', deadlineMs: 2011 });
      void second.then(() => { secondSettled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(secondSettled).toBe(false);
      expect(peer.requests.filter(frame => frame.opcode === Op.stop)).toHaveLength(1);
      peer.stopped();
      await vi.advanceTimersByTimeAsync(0);
      const requests = peer.requests.filter(frame => frame.opcode === Op.stop);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
      expect(secondSettled, 'late original ACK only unblocks dispatch; it is not the second receipt').toBe(false);
      expect(await pending.stop(first)).toBe(original);
      peer.stopped();
      expect(await second).toMatchObject({ kind: 'confirmed', receipt: { attemptId: 'reconcile' } });
      expect(await pending.stop(first)).toBe(original);
      clock = 10_000;
      const lost = { ...first, attemptId: 'wire-deadline', deadlineMs: 10_010 };
      const lostResult = pending.stop(lost);
      clock = 10_011; await vi.advanceTimersByTimeAsync(11);
      const lostOutcome = await lostResult;
      expect(lostOutcome.kind).toBe('unknown');
      clock = 70_011; await vi.advanceTimersByTimeAsync(60_000);
      const refused = await pending.stop({ ...first, attemptId: 'without-wire-ack', deadlineMs: 71_011 });
      expect(refused.kind).toBe('unknown');
      expect(peer.requests.filter(frame => frame.opcode === Op.stop)).toHaveLength(3);
      peer.stopped(); // The retained wire waiter consumes the reply after its public60s timeout.
      await vi.advanceTimersByTimeAsync(0);
      const afterReply = pending.stop({ ...first, attemptId: 'after-real-late-ack', deadlineMs: 71_011 });
      expect(peer.requests.filter(frame => frame.opcode === Op.stop)).toHaveLength(4);
      peer.stopped();
      expect((await afterReply).kind).toBe('confirmed');
      expect(await pending.stop(lost)).toBe(lostOutcome);
    } finally { pending.abandonControl(owner); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it('retains late original service replies without rewriting timeout or whole-root evidence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory, 'service-scopes-v1');
    const pending = port.allocate(owner);
    try {
      const preparation = await port.prepare(pending, spec);
      if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
      const services = preparation.process.services;
      if (!services) throw new Error('Expected explicit scoped capability');
      const rootExits: number[] = [];
      preparation.process.observeRootExit(exit => rootExits.push(exit.code));
      const resuming = preparation.process.resume(owner, () => Promise.resolve());
      await Promise.resolve(); peer.resumed(); await resuming;
      const capture = services.allocate({ operation: 'capture', pid: 500 });
      expect(capture.snapshot()).toEqual({ phase: 'prepared' });
      expect(peer.requests.filter(frame => frame.opcode === Op.serviceCaptureCurrent)).toHaveLength(0);
      const initial = capture.run(1010), originalRequest = peer.requests.at(-1)!;
      expect(originalRequest.opcode).toBe(Op.serviceCaptureCurrent);
      expect(capture.snapshot()).toMatchObject({ phase: 'requested', wireId: originalRequest.requestId.toString() });
      clock = 1011; // Native reply arrives after the deadline, before the delayed JS timer executes.
      peer.serviceIdentity(originalRequest);
      const unknown = await initial;
      expect(unknown).toEqual({ state: 'unknown' });
      expect(capture.run(1010)).toBe(initial);
      expect(await capture.run(1010)).toBe(unknown);
      expect(() => capture.run(2010)).toThrow('Conflicting original service deadline');
      const captured = capture.snapshot().result;
      if (captured?.state !== 'captured') throw new Error('Expected original late capture evidence');
      expect(capture.snapshot()).toMatchObject({ phase: 'settled', wireId: originalRequest.requestId.toString() });
      const stopping = services.allocate({ operation: 'stop', identity: captured.identity });
      const firstStop = stopping.run(1021), stopRequest = peer.requests.at(-1)!;
      expect(stopRequest.opcode).toBe(Op.serviceStop);
      expect(stopRequest.payload.readUInt32LE(8)).toBe(10);
      clock = 1022; await vi.advanceTimersByTimeAsync(11);
      const stoppedUnknown = await firstStop;
      expect(stoppedUnknown).toEqual({ state: 'unknown' });
      expect(stopping.snapshot()).toMatchObject({ phase: 'requested', result: { state: 'unknown' } });
      clock = 61022; await vi.advanceTimersByTimeAsync(60000);
      peer.serviceFacts(stopRequest); // The exact native waiter still owns this late ACK after its public timeout.
      await vi.advanceTimersByTimeAsync(0);
      expect(stopping.snapshot()).toMatchObject({ phase: 'settled', result: {
        state: 'stopped', facts: { ...captured.identity, rootExited: true, activeProcesses: 0 } } });
      expect(await stopping.run(1021)).toBe(stoppedUnknown);
      expect(peer.requests.filter(frame => frame.opcode === Op.serviceStop)).toHaveLength(1);
      const settling = services.allocate({ operation: 'settle', identity: captured.identity });
      const settled = settling.run(62022), settleRequest = peer.requests.at(-1)!;
      peer.serviceIdentity(settleRequest);
      expect(await settled).toEqual({ state: 'settled', identity: captured.identity });
      expect(await capture.run(1010)).toBe(unknown);
      expect(capture.snapshot().result).toBe(captured);
      const refused = services.query(captured.identity, 62022), refusedRequest = peer.requests.at(-1)!;
      peer.serviceRefused(refusedRequest);
      expect(await refused).toEqual({ state: 'refused', reason: 2, nativeCode: 1168 });
      const mismatched = services.query(captured.identity, 62022), badRequest = peer.requests.at(-1)!;
      peer.serviceFacts(badRequest, 2n);
      expect(await mismatched).toEqual({ state: 'unknown' });
      expect(rootExits).toEqual([]);
      expect(peer.requests.some(frame => frame.opcode === Op.stop || frame.opcode === Op.release)).toBe(false);
      expect((await pending.stop({ expectedOwner: owner, attemptId: 'after-invalid-service',
        mode: 'force', deadlineMs: 62022 })).kind).toBe('unknown');
      expect(await stopping.run(1021)).toBe(stoppedUnknown);
    } finally { pending.abandonControl(owner); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it('bounds service admission while preserving the original whole-provider cleanup slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory, 'service-scopes-v1');
    const pending = port.allocate(owner);
    try {
      const preparation = await port.prepare(pending, spec);
      if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
      const services = preparation.process.services;
      if (!services) throw new Error('Expected explicit scoped capability');
      const resuming = preparation.process.resume(owner, () => Promise.resolve());
      await Promise.resolve(); peer.resumed(); await resuming;
      const held = [500, 501, 502].map(pid => services.allocate({ operation: 'capture', pid }));
      const results = held.map(operation => operation.run(2000));
      const queued = services.allocate({ operation: 'capture', pid: 503 });
      const expired = queued.run(1010);
      expect(peer.requests.filter(frame => frame.opcode === Op.serviceCaptureCurrent)).toHaveLength(3);
      expect(queued.snapshot()).toEqual({ phase: 'queued' });
      clock = 1011; await vi.advanceTimersByTimeAsync(11);
      expect(await expired).toEqual({ state: 'not-dispatched', reason: 'deadline' });
      expect(queued.snapshot()).not.toHaveProperty('wireId');
      const cleanup = pending.stop({ expectedOwner: owner, attemptId: 'original-whole-cleanup',
        mode: 'force', deadlineMs: 2011 });
      expect(peer.requests.filter(frame => frame.opcode === Op.stop)).toHaveLength(1);
      peer.stopped();
      const outcome = await cleanup;
      if (outcome.kind !== 'confirmed') throw new Error('Expected original synthetic whole-Job receipt');
      expect(await services.allocate({ operation: 'capture', pid: 504 }).run(2011))
        .toEqual({ state: 'not-dispatched', reason: 'admission' });
      expect(peer.requests.filter(frame => frame.opcode === Op.serviceCaptureCurrent)).toHaveLength(3);
      preparation.process.stdout.resume(); preparation.process.stderr.resume();
      peer.stdout.end(); peer.stderr.end();
      expect((await pending.drain(2011)).kind).toBe('complete');
      await pending.release(outcome.receipt, 'job-membership');
      expect(await Promise.all(results)).toEqual([{ state: 'unknown' }, { state: 'unknown' }, { state: 'unknown' }]);
      expect(peer.requests.filter(frame => frame.opcode === Op.release)).toHaveLength(1);
      for (const operation of held) expect(operation.snapshot().result).toEqual({ state: 'unknown' });
    } finally { pending.abandonControl(owner); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it('a Stop rejected before wire admission can retry after original request slots drain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe', 'job-membership', peer.factory, 'service-scopes-v1');
    const pending = port.allocate(owner);
    try {
      const preparation = await port.prepare(pending, spec);
      if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
      const services = preparation.process.services;
      if (!services) throw new Error('Expected explicit scoped capability');
      const resuming = preparation.process.resume(owner, () => Promise.resolve());
      await Promise.resolve(); // Resume retains the fourth wire slot until its original ACK.
      const identity = { key: '0000000000000001', birth: '0000000000004567' };
      const queries = [0, 1, 2].map(() => services.query(identity, 2000));
      const held = peer.requests.filter(frame => frame.opcode === Op.serviceQuery);
      expect(held).toHaveLength(3);
      const request = { expectedOwner: owner, attemptId: 'before-wire-admission',
        mode: 'force' as const, deadlineMs: 2000 };
      const denied = pending.stop(request);
      expect((await denied).kind).toBe('unknown');
      expect(peer.requests.filter(frame => frame.opcode === Op.stop)).toHaveLength(0);
      peer.resumed(); await resuming;
      for (const frame of held) peer.serviceFacts(frame);
      expect((await Promise.all(queries)).every(result => result.state === 'observed')).toBe(true);
      const retry = pending.stop({ ...request, attemptId: 'after-wire-capacity' });
      expect(peer.requests.filter(frame => frame.opcode === Op.stop)).toHaveLength(1);
      peer.stopped();
      const outcome = await retry;
      if (outcome.kind !== 'confirmed') throw new Error('Expected original synthetic whole-Job receipt');
      expect(pending.stop(request)).toBe(denied);
      expect((await denied).kind).toBe('unknown');
      preparation.process.stdout.resume(); preparation.process.stderr.resume();
      peer.stdout.end(); peer.stderr.end();
      expect((await pending.drain(2000)).kind).toBe('complete');
      await pending.release(outcome.receipt, 'job-membership');
    } finally { pending.abandonControl(owner); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it('a failed native dispatch stays unknown despite a valid root witness and zero membership', async () => {
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    await port.prepare(pending, spec);
    const stop = pending.stop({
      expectedOwner: owner,
      attemptId: 'failed-api',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    peer.stopped(5);
    expect((await stop).kind).toBe('unknown');
    pending.abandonControl(owner);
  });
  it('rejects cumulative oversize launch input before constructing any wire buffer', () => {
    const tail = 'x'.repeat(32700);
    const environment = Array.from({ length: 17 }, (_, i) => `KEY${i}=${tail}`);
    const allocations = vi.spyOn(Buffer, 'from');
    try {
      expect(() => encodeLaunch({ ...spec, environment })).toThrow('exceeds limit');
      expect(allocations).not.toHaveBeenCalled();
    } finally {
      allocations.mockRestore();
    }
  });
  it('retains original broker exit independently of its immutable preparation cause', async () => {
    const peer = wirePeer({ holdLaunch: true });
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    const preparing = port.prepare(pending, spec);
    peer.exit({ code: 198, signal: null });
    const failure = await preparing;
    expect(failure).toMatchObject({ kind: 'failed', creation: 'uncertain', cleanup: pending });
    expect(pending.diagnostics()).toMatchObject({
      cause: { name: 'broker-exit', phase: 'prepare' },
      brokerExit: { code: 198, signal: null },
      nativeExitCategory: 'owner-eof',
      nativeCancelUndrained: true,
    });
    const cause = pending.diagnostics().cause;
    pending.abandonControl(owner);
    expect(pending.diagnostics().cause).toBe(cause);
    expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch]);
  });
  it('preserves actual native Failed creation/code when a later original exit is observed', async () => {
    const peer = wirePeer({ nativeFailed: true });
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    const failure = await port.prepare(pending, spec);
    expect(failure).toMatchObject({
      kind: 'failed',
      creation: 'contained-suspended',
      cleanup: pending,
    });
    const cause = pending.diagnostics().cause;
    peer.exit({ code: 74, signal: null });
    expect(pending.diagnostics()).toMatchObject({
      cause: { name: 'native-failed', phase: 'prepare' },
      nativeFailure: { creation: 'contained-suspended', code: 5 },
      brokerExit: { code: 74 },
      nativeExitCategory: 'write-deadline',
    });
    expect(pending.diagnostics().cause).toBe(cause);
    pending.abandonControl(owner);
  });
  it('latches write failure before a late completed callback/reply and keeps Stop unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const peer = wirePeer({ holdLaunch: true, holdWrite: true });
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    try {
      const preparing = port.prepare(pending, spec);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await preparing).toMatchObject({
        kind: 'failed',
        creation: 'uncertain',
        cleanup: pending,
      });
      const cause = pending.diagnostics().cause;
      expect(cause).toEqual({
        name: 'control-write-deadline',
        phase: 'prepare',
        writeCompleted: false,
      });
      const request = {
        expectedOwner: owner,
        attemptId: 'failed-wire',
        mode: 'force' as const,
        deadlineMs: performance.now() + 1000,
      };
      const original = await pending.stop(request);
      expect(original.kind).toBe('unknown');
      peer.completeWrite();
      peer.prepared();
      peer.exit({ code: 74, signal: null });
      await Promise.resolve();
      expect(await pending.stop(request)).toBe(original);
      expect(pending.diagnostics().cause).toBe(cause);
      expect((await port.prepare(pending, spec)).kind).toBe('failed');
      await expect(
        pending.release(
          {
            owner,
            attemptId: 'fake',
            coverage: 'job-membership',
            rootExited: true,
            proofDigest: 'fake',
          },
          'job-membership'
        )
      ).rejects.toThrow('authority');
      expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch]);
    } finally {
      pending.abandonControl(owner);
      peer.completeWrite();
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    'attributes overlapping Prepare/Stop to its own write (Launch completed: %s)',
    async (completeLaunch) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const peer = wirePeer({ holdLaunch: true, holdWrite: true });
      const port = createWindowsOwnedLaunchPort(
        'C:\\sandbox\\owned-process-broker.exe',
        'job-membership',
        peer.factory
      );
      const pending = port.allocate(owner);
      try {
        const preparing = port.prepare(pending, spec);
        const request = {
          expectedOwner: owner,
          attemptId: 'overlapping-stop',
          mode: 'force' as const,
          deadlineMs: performance.now() + 20000,
        };
        const stopping = pending.stop(request); // legal while Prepare's earlier write is incomplete
        await vi.advanceTimersByTimeAsync(3000);
        if (completeLaunch) {
          peer.completeWrite();
          await Promise.resolve();
          expect(peer.requests.map((frame) => frame.opcode)).toEqual([Op.launch, Op.stop]);
          expect(
            pending.diagnostics().writeCompleted,
            'Earlier Launch callback cannot complete queued Stop'
          ).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(2001);
        expect(await preparing).toMatchObject({
          kind: 'failed',
          creation: 'uncertain',
          cleanup: pending,
        });
        const original = await stopping;
        expect(original.kind).toBe('unknown');
        const cause = pending.diagnostics().cause;
        expect(cause).toEqual({
          name: 'control-write-deadline',
          phase: completeLaunch ? 'stop' : 'prepare',
          writeCompleted: false,
        });
        peer.completeWrite();
        await Promise.resolve();
        expect(await pending.stop(request)).toBe(original);
        expect(pending.diagnostics().cause).toBe(cause);
        expect((await port.prepare(pending, spec)).kind).toBe('failed');
        await expect(
          pending.release(
            {
              owner,
              attemptId: 'forged',
              coverage: 'job-membership',
              rootExited: true,
              proofDigest: 'fake',
            },
            'job-membership'
          )
        ).rejects.toThrow('authority');
        expect(
          peer.requests.some((frame) => frame.opcode === Op.resume || frame.opcode === Op.release)
        ).toBe(false);
        expect(peer.connections()).toBe(1);
      } finally {
        pending.abandonControl(owner);
        peer.completeWrite();
        vi.useRealTimers();
      }
    }
  );
  it('partial Released bytes plus original exit0 never substitute for a complete acknowledgement', async () => {
    const peer = wirePeer({ partialRelease: true });
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const owned = port.allocate(owner);
    const preparation = await port.prepare(owned, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const stopping = owned.stop({
      expectedOwner: owner,
      attemptId: 'partial-ack',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    peer.stopped();
    const stopped = await stopping;
    preparation.process.stdout.resume();
    preparation.process.stderr.resume();
    peer.stdout.end();
    peer.stderr.end();
    expect((await preparation.process.drain(performance.now() + 1000)).kind).toBe('complete');
    if (stopped.kind !== 'confirmed') throw new Error('Synthetic bridge facts missing');
    await expect(owned.release(stopped.receipt, 'job-membership')).rejects.toThrow();
    expect(owned.diagnostics()).toMatchObject({
      cause: { name: 'protocol', phase: 'release' },
      brokerExit: { code: 0, signal: null },
    });
    owned.abandonControl(owner);
  });
  it.each(['lost-ack', 'native-failed', 'acknowledged'] as const)(
    'Resume dispatch reports only observed creation facts (%s)',
    async (result) => {
      const peer = wirePeer();
      const port = createWindowsOwnedLaunchPort(
        'C:\\sandbox\\owned-process-broker.exe',
        'job-membership',
        peer.factory
      );
      const pending = port.allocate(owner);
      const preparation = await port.prepare(pending, spec);
      if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
      const resume = preparation.process.resume(owner, () => Promise.resolve());
      const observed = resume.then(
        () => undefined,
        (error: unknown) => error
      );
      await Promise.resolve();
      expect(peer.requests.at(-1)?.opcode).toBe(Op.resume);
      if (result === 'lost-ack') peer.eof();
      else if (result === 'native-failed') peer.resumeFailed();
      else peer.resumed();
      const error = await observed;
      expect(error === undefined).toBe(result === 'acknowledged');
      const outcome = await pending.stop({
        expectedOwner: owner,
        attemptId: 'resume-fact',
        mode: 'graceful',
        deadlineMs: performance.now() + 1000,
      });
      const expectedCreation = {
        'lost-ack': 'uncertain',
        'native-failed': 'contained-suspended',
        acknowledged: 'running',
      };
      expect(outcome).toMatchObject({ kind: 'unknown', creation: expectedCreation[result] });
      pending.abandonControl(owner);
    }
  );
  it('preserves the caller generation spelling through resume and Stop authority checks', async () => {
    const uppercase = { ...owner, processGeneration: generation.toUpperCase() };
    const peer = wirePeer();
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(uppercase);
    expect(pending.owner).toEqual(uppercase);
    const preparation = await port.prepare(pending, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const resume = preparation.process.resume(uppercase, () => Promise.resolve());
    await Promise.resolve();
    peer.resumed();
    await resume;
    expect(
      await pending.stop({
        expectedOwner: uppercase,
        attemptId: 'case-preserved',
        mode: 'graceful',
        deadlineMs: performance.now() + 1000,
      })
    ).toMatchObject({ kind: 'unknown', owner: uppercase, creation: 'running' });
    pending.abandonControl(uppercase);
  });
  it.each([
    { holdReleaseExit: true },
    { releaseExit: { code: 74, signal: null } },
    { releaseExit: { code: null, signal: 'SIGTERM' as const } },
    { exitBeforeReleaseAck: true },
  ])('requires both complete Release acknowledgement and original exit0 (%j)', async (options) => {
    const peer = wirePeer(options);
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    const preparation = await port.prepare(pending, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const stopping = pending.stop({
      expectedOwner: owner,
      attemptId: 'release-completion',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    peer.stopped();
    const stopped = await stopping;
    if (stopped.kind !== 'confirmed') throw new Error('Expected bridge receipt');
    preparation.process.stdout.resume();
    preparation.process.stderr.resume();
    peer.stdout.end();
    peer.stderr.end();
    await preparation.process.drain(performance.now() + 1000);
    let completed = false;
    const release = pending.release(stopped.receipt, 'job-membership');
    const observed = release.then(
      () => {
        completed = true;
        return undefined;
      },
      (error: unknown) => error
    );
    await new Promise<void>((done) => setImmediate(done));
    if (options.holdReleaseExit) {
      expect(completed).toBe(false);
      const duplicate = pending.release(stopped.receipt, 'job-membership');
      peer.exit({ code: 0, signal: null });
      await duplicate;
      expect(peer.requests.filter((frame) => frame.opcode === Op.release)).toHaveLength(1);
    }
    const error = await observed;
    expect(error === undefined).toBe(!options.releaseExit);
    expect(completed).toBe(!options.releaseExit);
    if (options.releaseExit)
      expect(pending.diagnostics()).toMatchObject({
        cause: { name: 'broker-exit', phase: 'release' },
        brokerExit: options.releaseExit,
      });
    pending.abandonControl(owner);
  });
  it('a complete Release acknowledgement without original exit reaches a bounded failure', async () => {
    const peer = wirePeer({ holdReleaseExit: true });
    const port = createWindowsOwnedLaunchPort(
      'C:\\sandbox\\owned-process-broker.exe',
      'job-membership',
      peer.factory
    );
    const pending = port.allocate(owner);
    const preparation = await port.prepare(pending, spec);
    if (preparation.kind !== 'prepared') throw new Error(preparation.reason);
    const stopping = pending.stop({
      expectedOwner: owner,
      attemptId: 'missing-exit',
      mode: 'force',
      deadlineMs: performance.now() + 1000,
    });
    peer.stopped();
    const stopped = await stopping;
    if (stopped.kind !== 'confirmed') throw new Error('Expected bridge receipt');
    preparation.process.stdout.resume();
    preparation.process.stderr.resume();
    peer.stdout.end();
    peer.stderr.end();
    await preparation.process.drain(performance.now() + 1000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const release = pending.release(stopped.receipt, 'job-membership');
      const observed = release.then(
        () => undefined,
        (error: unknown) => error
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5001);
      expect(await observed).toBeInstanceOf(Error);
      expect(pending.diagnostics()).toMatchObject({
        cause: { name: 'release-unavailable', phase: 'release' },
      });
      peer.exit({ code: 0, signal: null });
      await expect(pending.release(stopped.receipt, 'job-membership')).rejects.toThrow(
        'completion deadline'
      );
    } finally {
      pending.abandonControl(owner);
      vi.useRealTimers();
    }
  });
  it('runtime staged admission rejects tampered bytes, schema/protocol and machine mismatch', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owned-admission-'));
    const path = join(sandbox, 'owned-process-broker.exe');
    const bytes = Buffer.alloc(128);
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64);
    bytes.writeUInt16LE(0x8664, 68);
    const manifest = {
      schema: 1,
      protocol: 1,
      platform: 'win32',
      arch: 'x64',
      file: 'owned-process-broker.exe',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const write = (value: Record<string, unknown> = manifest): void => {
      writeFileSync(path, bytes);
      writeFileSync(join(sandbox, 'manifest.json'), JSON.stringify(value));
    };
    try {
      write();
      verifyStagedBroker(path, 'x64');
      expect(() => verifyStagedBroker(path, 'arm64')).toThrow('manifest');
      write({ ...manifest, protocol: 2 });
      expect(() => verifyStagedBroker(path, 'x64')).toThrow('manifest');
      write({ ...manifest, schema: 2 });
      expect(() => verifyStagedBroker(path, 'x64')).toThrow('manifest');
      write();
      expect(() => verifyStagedBroker(path, 'x64', 'service-scopes-v1')).toThrow('manifest');
      const scoped = { ...manifest, schema: 2, capability: 'service-scopes-v1' };
      const selection = { path: 'C:\\TEST\\owned-process-broker.exe',
        sha256: manifest.sha256, arch: 'x64', protocol: 1 } as const;
      const brokerSchema = nativeProcessProfileSchema.shape.windowsBroker.unwrap();
      expect(brokerSchema.parse(selection)).toEqual(selection);
      const oldReference = createHash('sha256').update(JSON.stringify(selection)).digest('hex');
      expect(windowsBrokerReference(selection)).toBe(oldReference);
      const selectedScoped = brokerSchema.parse({ ...selection, capability: 'service-scopes-v1' });
      expect(windowsBrokerReference(selectedScoped)).not.toBe(oldReference);
      expect(windowsBrokerReference(selectedScoped)).toBe(
        createHash('sha256').update(JSON.stringify(selectedScoped)).digest('hex'));
      expect(() => brokerSchema.parse({ ...selection, capability: 'test-debug-service' })).toThrow();
      write(scoped);
      expect(() => verifyStagedBroker(path, 'x64')).toThrow('manifest'); // No implicit consumer activation.
      verifyStagedBroker(path, 'x64', 'service-scopes-v1');
      write({ ...scoped, capability: 'test-debug-service' });
      expect(() => verifyStagedBroker(path, 'x64', 'service-scopes-v1')).toThrow('manifest');
      write({ ...scoped, testMode: true });
      expect(() => verifyStagedBroker(path, 'x64', 'service-scopes-v1')).toThrow('manifest');
      write();
      bytes[100] = 1;
      writeFileSync(path, bytes);
      expect(() => verifyStagedBroker(path, 'x64')).toThrow('digest');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

// Real gate collector contract only; these stream bytes are not native containment proof.
describe('native fixture complete output records', () => {
  const descendants = [
    { pid: 101, birth: '0000000000000001' },
    { pid: 102, birth: '0000000000000002' },
    { pid: 103, birth: '0000000000000003' },
    { pid: 104, birth: '0000000000000004' },
  ];
  const childrenRecord = JSON.stringify({ children: descendants });
  it.each(['\n', '\r\n'])(
    'collects equivalent complete target records with %j delimiters',
    (delimiter) => {
      const output = createFixtureOutputCollector();
      output.push(
        Buffer.from(
          `${childrenRecord}${delimiter}${childrenRecord}${delimiter}{"final":true}${delimiter}`
        )
      );
      expect(output.children).toEqual(descendants);
      expect(output.hasFinal()).toBe(true);
    }
  );
  it('waits for LF across a split CR|LF and preserves a fragmented final record', () => {
    const output = createFixtureOutputCollector();
    output.push(Buffer.from(`${childrenRecord}\r`));
    expect(output.children).toEqual([]);
    expect(output.hasFinal()).toBe(false);
    output.push(Buffer.from('\n{"final":'));
    expect(output.children).toEqual(descendants);
    expect(output.hasFinal()).toBe(false);
    output.push(Buffer.from('true}\r'));
    expect(output.hasFinal()).toBe(false);
    output.push(Buffer.from('\n'));
    expect(output.hasFinal()).toBe(true);
  });
  it('does not accept complete-looking records at incomplete EOF or trim extra CR bytes', () => {
    const incomplete = createFixtureOutputCollector();
    incomplete.push(Buffer.from(childrenRecord));
    expect(incomplete.children).toEqual([]);
    incomplete.push(Buffer.from('\n{"final":true}'));
    expect(incomplete.children).toEqual(descendants);
    expect(incomplete.hasFinal()).toBe(false);
    const malformed = createFixtureOutputCollector();
    malformed.push(Buffer.from(`${childrenRecord}\r\r\n{"final":true}\r\r\n`));
    expect(malformed.children).toEqual([]);
    expect(malformed.hasFinal()).toBe(false);
  });
  it('retains the 65536 raw accumulated output boundary across chunks', () => {
    const output = createFixtureOutputCollector();
    output.push(Buffer.alloc(32768, 120));
    output.push(Buffer.alloc(32768, 120));
    expect(() => output.push(Buffer.from('\r\n'))).toThrow(
      'Fixture output exceeds bounded JSON-tail gate'
    );
    expect(output.children).toEqual([]);
    expect(output.hasFinal()).toBe(false);
  });
});

// Literal decoder contracts only; these numbers do not qualify any real Win32 operation.
describe('native pending write receipt validation', () => {
  const directory = 'C:\\sandbox\\Release';
  const path = `${directory}\\owned-process-pending-write-fixture.exe`;
  const digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const inventory = `Algorithm : SHA256\r\nHash      : ${digest}\r\nPath      : ${path}\r\n\r\n`;
  it.each(['', '\uFEFF'])('accepts a complete inventory with zero or one BOM (%j)', (bom) => {
    expect([...parseBinaryInventory(Buffer.from(bom + inventory), directory)]).toEqual([
      [path.toLowerCase(), digest],
    ]);
  });
  it('rejects two leading BOMs before binary admission', () => {
    expect(() =>
      parseBinaryInventory(Buffer.from('\uFEFF\uFEFF' + inventory), directory)
    ).toThrow();
  });
  it('rejects a timed-out pending wait even if later completion and event-close look successful', () => {
    const row = [1, 1048576, 0, 997, 1, 0, 996, 0, 0, 1, 0, 1048576].concat([
      0, 0, 0, 0, 0, 0, 1, 1, 15, 1, 0, 2,
    ]);
    const facts = {
      schema: 1,
      mode: 0,
      writerExit: 0,
      activeProcesses: 0,
      readBytes: 1048576,
      header: [1, 0, 1, 0, 1, 5000, 0, 0, 0, 0, 1, 1, 2, 0].concat(
        Array<number>(18).fill(0),
        [16, 0, 16, 16, 1048576, 1, 1, 1, 0, 0, 1, 0, 65536, 0],
        Array<number>(18).fill(0)
      ),
      operations: [row, ...Array.from({ length: 7 }, () => Array<number>(24).fill(0))],
    };
    expect(() => validateNativeWriteFacts(facts, 'complete')).not.toThrow();
    const timedOut = { ...facts, operations: facts.operations.map((operation) => [...operation]) };
    const pending = timedOut.operations[0];
    if (!pending) throw new Error('Literal pending operation missing');
    pending[8] = 258; // Only WAIT_OBJECT_0 becomes WAIT_TIMEOUT; all other facts stay identical.
    expect(() => validateNativeWriteFacts(timedOut, 'complete')).toThrow();
  });
});
