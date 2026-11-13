import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { Duplex } from 'node:stream';

import { encodeFrame, encodeLaunch, FrameDecoder, Op } from '@agent-teams/legacy-agent-host/owned-process';
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
  pipe.on('error', events.guard(() => { throw new Error('TEST debug control failed'); }));
  pipe.on('data', events.guard((chunk: Buffer) => decoder.push(chunk, frame => {
    if (frame.opcode === Op.rootExit) return;
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
    const selected = Buffer.alloc(17);
    selected.writeUInt32LE(10000); selected[4] = 2;
    selected.writeUInt32LE(service.pid, 5); selected.writeBigUInt64LE(BigInt(`0x${service.birth}`), 9);
    const wrong = Buffer.from(selected);
    wrong.writeBigUInt64LE(BigInt(`0x${service.birth}`) ^ 1n, 9);
    phase('stop');
    await request(Op.stop, Op.failed, wrong); // Wrong original identity has no native effect.
    const stopId = lastId + 1n;
    const stopped = await request(Op.stop, Op.stopped, selected);
    assert.equal(stopped.payload.length, 26);
    assert.equal(stopped.payload[1], 1);
    assert.equal(stopped.payload.readUInt32LE(2), 0, 'Selected nested Job is genuinely empty');
    assert.equal(stopped.payload.readBigUInt64LE(10), BigInt(`0x${service.birth}`));
    assert.equal(stopped.payload.readUInt32LE(18), 0);
    assert.equal(stopped.payload.readUInt32LE(22), 0);
    phase('witness-exits');
    assert.deepEqual(await timeout(events.wait(Promise.all(serviceWitnesses.map(value => value.exit)))), [0, 0, 0]);
    const retire = Buffer.from(selected);
    retire.writeUInt32LE(0); retire[4] = 3;
    const retired = await request(Op.stop, Op.stopped, retire);
    assert.equal(retired.payload.length, 34);
    assert.equal(retired.payload[0], 3);
    assert.equal(retired.payload[1], 1);
    assert.equal(retired.payload.readUInt32LE(2), 0);
    assert.equal(retired.payload.readBigUInt64LE(10), BigInt(`0x${service.birth}`));
    assert.equal(retired.payload.readUInt32LE(18), 0);
    assert.equal(retired.payload.readUInt32LE(22), 0);
    assert.ok(retired.payload.readBigUInt64LE(26) > (mode === 'service-pair' ? 64n : 0n),
      'scope keys never restart or alias after cumulative native retirement');
    assert.deepEqual((await request(Op.stop, Op.stopped, selected, stopId)).payload, stopped.payload,
      'original ACK remains replayable after its native scope retired, without recapture');
    await request(Op.stop, Op.failed, selected); // New request cannot reacquire a retired PID/birth.
    assert.equal(adjacent.process.exitCode, null, 'Other service original HANDLE remains unsignaled');
    assert.equal(root.process.exitCode, null, 'Provider original HANDLE remains unsignaled');
    assert.equal(sentinel.exitCode, null);
    stdin.write('TEST provider remains functional\n');
    await waitFor(() => text.includes('{"providerAlive":true}'), 3000, events);
  }
  phase('stop');
  const stopped = await request(Op.stop, Op.stopped, whole);
  assert.equal(stopped.payload[1], 1);
  assert.equal(stopped.payload.readUInt32LE(2), 0);
  assert.equal(stopped.payload.readBigUInt64LE(10), BigInt(`0x${rootBirth}`));
  assert.equal(stopped.payload.readUInt32LE(18), 0);
  assert.equal(stopped.payload.readUInt32LE(22), 0);
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
