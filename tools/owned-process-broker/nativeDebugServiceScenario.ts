import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { Duplex } from 'node:stream';

import { decodeServiceFacts, decodeServiceIdentity, decodeServiceRefusal, encodeFrame, encodeLaunch,
  encodeServiceCapture, encodeServiceCaptureCurrent, encodeServiceScope, encodeServiceStop, FrameDecoder, Op, ServiceRefusal,
} from '@agent-teams/legacy-agent-host/owned-process';
import { capturedWitness, timeout, waitFor } from './nativeGateContext';
import { createFixtureOutputCollector } from './nativeGateOutput';

import type { Frame } from '@agent-teams/legacy-agent-host/owned-process';
import type { GateContext } from './nativeGateContext';

/** Unstaged TEST binary only. A valid provider receipt is never minted from these scoped facts. */
export async function nativeDebugServiceScenario(context: GateContext, debugBroker: string,
  mode: 'pre-resume-cancel' | 'service-pair' | 'service-first', sentinel: ChildProcess): Promise<void> {
  const { events, owner, marker, spec, fixture, track, phase } = context;
  const identity = owner(), start = marker();
  const diagnosticPath = `${start.path}.debug-failure`;
  const diagnosticFd = openSync(diagnosticPath, 'wx');
  const raw = (() => {
    try {
      return spawn(debugBroker, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'overlapped', diagnosticFd], windowsHide: true,
      });
    } finally { closeSync(diagnosticFd); }
  })();
  track(raw, 'raw-broker');
  raw.once('exit', events.guard((code: number | null) => {
    const bytes = readFileSync(diagnosticPath);
    assert.ok(bytes.length === 0 || bytes.length === 16, 'One bounded native failure record');
    if (bytes.length) {
      const stages = ['none', 'retain-root', 'retain-job', 'wait', 'root-identity', 'retain-child',
        'child-identity', 'outer-membership', 'create-job', 'assign-job', 'verify-job', 'image-close',
        'dll-close', 'rip', 'continue', 'job-close', 'root-close'];
      console.error(JSON.stringify({ debugServiceFailure: {
        stage: stages[bytes.readUInt32LE(0)] ?? bytes.readUInt32LE(0), win32Error: bytes.readUInt32LE(4),
        event: bytes.readUInt32LE(8), pid: bytes.readUInt32LE(12),
      } }));
    }
    assert.equal(code, 0, 'TEST debug broker must not die before completing its native gate');
    assert.equal(bytes.length, 0, 'Success cannot mask a native debug failure');
  }));
  const exited = new Promise<number | null>((resolve, reject) => {
    raw.once('exit', resolve); raw.once('error', reject);
  });
  void exited.catch(() => undefined);
  const pipe = raw.stdio[3];
  assert.ok(pipe instanceof Duplex);
  const { stdin, stdout, stderr } = raw;
  assert.ok(stdin && stdout && stderr, 'TEST target stdio pipes are present');
  const decoder = new FrameDecoder(identity.processGeneration);
  const replies = new Map<bigint, { opcode: number; resolve(frame: Frame): void }>();
  let lastId = 0n;
  let rootExit: Frame | undefined;
  const readRootExit = (): Frame | undefined => rootExit;
  pipe.on('error', events.guard(() => { throw new Error('TEST debug control failed'); }));
  pipe.on('data', events.guard((chunk: Buffer) => decoder.push(chunk, frame => {
    if (frame.opcode === Op.rootExit) {
      assert.equal(rootExit, undefined, 'One original provider exit event');
      assert.equal(frame.requestId, 0n); assert.equal(frame.payload.length, 12);
      rootExit = frame; return;
    }
    const pending = replies.get(frame.requestId);
    assert.ok(pending, 'Reply belongs to an admitted exact request');
    assert.equal(frame.opcode, pending.opcode, 'TEST debug native response opcode');
    replies.delete(frame.requestId); pending.resolve(frame);
  })));
  const request = (opcode: number, response: number, payload: Buffer, id = ++lastId) => {
    const result = new Promise<Frame>(resolve => replies.set(id, { opcode: response, resolve }));
    pipe.write(encodeFrame({ opcode, requestId: id, generation: identity.processGeneration, payload }));
    return timeout(events.wait(result));
  };
  const output = createFixtureOutputCollector();
  let text = '';
  stdout.on('data', events.guard((chunk: Buffer) => {
    output.push(chunk); text += chunk.toString();
  }));
  stderr.resume();
  phase('prepare');
  const prepared = await request(Op.launch, Op.prepared,
    encodeLaunch(spec(mode === 'pre-resume-cancel' ? 'tree' : mode, start)));
  assert.equal(prepared.payload.length, 12);
  const rootPid = prepared.payload.readUInt32LE(0);
  const rootBirth = prepared.payload.readBigUInt64LE(4).toString(16).padStart(16, '0');
  phase('capture-root');
  const root = await capturedWitness(fixture, rootPid, rootBirth, track, events);
  assert.equal(existsSync(start.path), false, 'DEBUG+CREATE_SUSPENDED target has no pre-resume effect');
  const whole = Buffer.alloc(5);
  whole.writeUInt32LE(10000); whole[4] = 1;
  let neighborExit: Promise<number | null> | undefined;
  if (mode !== 'pre-resume-cancel') {
    phase('resume');
    await request(Op.resume, Op.resumed, Buffer.alloc(0));
    phase('child-lines');
    await waitFor(() => output.children.length === 4 && output.childrenOf(rootPid).length === 2, 10000, events);
    if (mode === 'service-pair') assert.ok(text.includes('{"retiredChildren":80}'),
      'actual cumulative child churn exceeded64 without exhausting live scope custody');
    const [service, neighbor] = output.childrenOf(rootPid);
    assert.ok(service && neighbor);
    assert.equal(output.childrenOf(service.pid).length, 2, 'Selected service already has descendants before registration');
    phase('capture-descendants');
    const serviceWitnesses = await events.wait(Promise.all([service, ...output.childrenOf(service.pid)].map(value =>
      capturedWitness(fixture, value.pid, value.birth, track, events))));
    const adjacent = await capturedWitness(fixture, neighbor.pid, neighbor.birth, track, events);
    neighborExit = adjacent.exit;
    if (mode === 'service-first') {
      phase('root-exit');
      writeFileSync(`${start.path}.branch-release`, start.nonce, { flag: 'wx' });
      assert.equal(await timeout(events.wait(serviceWitnesses[0]!.exit)), 0);
    }
    const currentCapture = encodeServiceCaptureCurrent(service.pid);
    const captureOpcode = mode === 'service-pair' ? Op.serviceCaptureCurrent : Op.serviceCapture;
    const capture = mode === 'service-pair' ? currentCapture : encodeServiceCapture(service.pid, service.birth);
    const wrong = encodeServiceCapture(service.pid,
      (BigInt('0x' + service.birth) ^ 1n).toString(16).padStart(16, '0'));
    phase('service-capture');
    assert.equal(decodeServiceRefusal(await request(Op.serviceCapture, Op.serviceRefused, wrong)).reason,
      ServiceRefusal.missing, 'Wrong original identity has no native effect');
    const sentinelPid = sentinel.pid; assert.ok(sentinelPid);
    for (const pid of [rootPid, sentinelPid]) {
      assert.equal(decodeServiceRefusal(await request(Op.serviceCaptureCurrent, Op.serviceRefused,
        encodeServiceCaptureCurrent(pid))).reason, ServiceRefusal.missing,
        'Provider and foreign PIDs cannot enter this broker service registry');
    }
    if (mode === 'service-first') {
      assert.equal(decodeServiceRefusal(await request(Op.serviceCaptureCurrent, Op.serviceRefused,
        currentCapture)).reason, ServiceRefusal.missing,
        'A current-child selector cannot register an exited original root with live descendants');
    }
    const captureId = lastId + 1n;
    const selected = decodeServiceIdentity(await request(captureOpcode, Op.serviceCaptured, capture));
    assert.equal(selected.birth, service.birth);
    assert.ok(BigInt('0x' + selected.key) > (mode === 'service-pair' ? 64n : 0n),
      'scope keys never restart or alias after cumulative native retirement');
    const key = encodeServiceScope(selected.key);
    const observe = async () => {
      const facts = decodeServiceFacts(await request(Op.serviceQuery, Op.serviceObserved, key));
      assert.equal(facts.key, selected.key); assert.equal(facts.birth, service.birth);
      assert.equal(facts.queryError, 0); assert.equal(facts.dispatchError, 0);
      assert.ok(facts.activeProcesses > 0, 'Read-only query leaves the original subtree running');
      return facts;
    };
    assert.equal((await observe()).rootExited, mode === 'service-first');
    if (mode === 'service-pair') {
      phase('service-query-lifetime');
      const queryDeadline = Date.now() + 5000;
      for (let index = 0; index < 1025; index++) {
        assert.ok(Date.now() < queryDeadline, 'Bounded native query sequence');
        await observe();
      }
      phase('service-effect-retirement');
      for (let index = 0; index < 64; index++)
        assert.deepEqual(decodeServiceIdentity(await request(captureOpcode, Op.serviceCaptured, capture)), selected);
      assert.equal(decodeServiceRefusal(await request(captureOpcode, Op.serviceRefused, capture, captureId)).reason,
        ServiceRefusal.retiredRequest, 'Evicted command ID is refused, never dispatched as a new registration');
      await observe(); // Refusing an old request cannot abandon a healthy provider or its original scope.
    }
    phase('expired-service-stop');
    const expired = decodeServiceFacts(await request(Op.serviceStop, Op.serviceStopped,
      encodeServiceStop(selected.key, 0)));
    assert.equal(expired.key, selected.key); assert.equal(expired.birth, service.birth);
    assert.equal(expired.queryError, 258); // WAIT_TIMEOUT, no destructive dispatch after the admitted deadline.
    assert.equal(expired.dispatchError, 0);
    assert.ok(serviceWitnesses.slice(1).every(witness => witness.process.exitCode === null));
    await observe();
    const retainedCaptureId = lastId + 1n;
    assert.deepEqual(decodeServiceIdentity(await request(captureOpcode, Op.serviceCaptured, capture)), selected);
    phase('stop');
    const stopId = lastId + 1n;
    const stop = encodeServiceStop(selected.key, 10000);
    const stopped = await request(Op.serviceStop, Op.serviceStopped, stop);
    const terminal = decodeServiceFacts(stopped);
    assert.equal(terminal.key, selected.key); assert.equal(terminal.birth, service.birth);
    assert.equal(terminal.rootExited, true);
    assert.equal(terminal.activeProcesses, 0, 'Selected nested Job is genuinely empty');
    assert.equal(terminal.queryError, 0); assert.equal(terminal.dispatchError, 0);
    phase('witness-exits');
    assert.deepEqual(await timeout(events.wait(Promise.all(serviceWitnesses.map(value => value.exit)))), [0, 0, 0]);
    assert.deepEqual(decodeServiceIdentity(await request(Op.serviceSettle, Op.serviceSettled, key)), selected);
    assert.deepEqual(decodeServiceIdentity(await request(captureOpcode, Op.serviceCaptured, capture, retainedCaptureId)), selected,
      'An original capture ACK replays after retirement without a current-PID lookup');
    assert.equal(decodeServiceRefusal(await request(Op.serviceCaptureCurrent, Op.serviceRefused,
      currentCapture)).reason, ServiceRefusal.missing, 'Fresh admission cannot reacquire a retired original');
    assert.deepEqual((await request(Op.serviceStop, Op.serviceStopped, stop, stopId)).payload, stopped.payload,
      'original ACK remains replayable after its native scope retired, without recapture');
    assert.equal(decodeServiceRefusal(await request(Op.serviceStop, Op.serviceRefused, stop)).reason,
      ServiceRefusal.missing, 'A new Stop cannot reacquire a retired scope');
    assert.equal(decodeServiceRefusal(await request(Op.serviceQuery, Op.serviceRefused, key)).reason,
      ServiceRefusal.missing, 'Closed scope is unknown, not a new absence receipt');
    assert.equal(adjacent.process.exitCode, null, 'Other service original HANDLE remains unsignaled');
    assert.equal(root.process.exitCode, null, 'Provider original HANDLE remains unsignaled');
    assert.equal(sentinel.exitCode, null);
    stdin.write('TEST provider remains functional\n');
    await waitFor(() => text.includes('{"providerAlive":true}'), 3000, events);
  }
  assert.equal(readRootExit(), undefined, 'Service replies cannot publish an exit for the surviving provider');
  phase('stop');
  const stopped = await request(Op.stop, Op.stopped, whole);
  assert.equal(stopped.payload[1], 1);
  assert.equal(stopped.payload.readUInt32LE(2), 0);
  assert.equal(stopped.payload.readBigUInt64LE(10), BigInt(`0x${rootBirth}`));
  assert.equal(stopped.payload.readUInt32LE(18), 0);
  assert.equal(stopped.payload.readUInt32LE(22), 0);
  await waitFor(() => readRootExit() !== undefined, 3000, events);
  const originalExit = readRootExit(); assert.ok(originalExit);
  assert.equal(originalExit.payload.readBigUInt64LE(4), BigInt('0x' + rootBirth));
  assert.equal(originalExit.payload.readUInt32LE(0), stopped.payload.readUInt32LE(6));
  phase('witness-exits');
  assert.equal(await timeout(events.wait(root.exit)), 0);
  if (neighborExit) assert.equal(await timeout(events.wait(neighborExit)), 0);
  if (mode === 'pre-resume-cancel') assert.equal(existsSync(start.path), false);
  phase('target-drain');
  await waitFor(() => stdout.readableEnded && stderr.readableEnded, 3000, events);
  phase('release-ack');
  await request(Op.release, Op.released, Buffer.alloc(0));
  phase('broker-exit');
  pipe.end();
  assert.equal(await timeout(events.wait(exited)), 0);
  assert.equal(sentinel.exitCode, null);
}
