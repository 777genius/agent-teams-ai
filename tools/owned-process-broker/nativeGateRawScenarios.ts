import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Duplex } from 'node:stream';

import {
  encodeFrame,
  encodeLaunch,
  FrameDecoder,
  Op,
  type Frame,
} from '../../src/main/utils/ownedProcess/codec';
import { capturedWitness, timeout, waitFor, type GateContext } from './nativeGateContext';

export async function nativeReleaseScenario(
  context: GateContext,
  releaseBroker: string,
  terminalRace = false,
  releaseContention = false
): Promise<void> {
  const { fixture, owner, marker, spec, track, phase } = context;
  const identity = owner();
  const raw = spawn(releaseBroker, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'overlapped'],
    windowsHide: true,
    env: {
      ...process.env,
      OWNED_PROCESS_TEST_TERMINAL_RACE: terminalRace ? '1' : '0',
      OWNED_PROCESS_TEST_RELEASE_CONTENTION: releaseContention ? '1' : '0',
    },
  });
  track(raw, 'raw-broker');
  raw.stdout.resume();
  raw.stderr.resume();
  const exited = new Promise<number | null>((done, reject) => {
    raw.once('exit', done);
    raw.once('error', reject);
  });
  void exited.catch(() => undefined); // original error also reaches the awaited exit/protocol path
  const pipe = raw.stdio[3];
  assert.ok(pipe instanceof Duplex);
  const decoder = new FrameDecoder(identity.processGeneration);
  const replies = new Map<number, (frame: Frame) => void>();
  pipe.on(
    'error',
    context.events.guard(() => {
      throw new Error('Native release control failed');
    })
  );
  pipe.on(
    'data',
    context.events.guard((data: Buffer) =>
      decoder.push(data, (frame) => {
        replies.get(frame.opcode)?.(frame);
      })
    )
  );
  let id = 0n;
  const request = (opcode: number, response: number, payload: Buffer): Promise<Frame> => {
    const reply = new Promise<Frame>((done) => {
      replies.set(response, done);
    });
    pipe.write(
      encodeFrame({ opcode, requestId: ++id, generation: identity.processGeneration, payload })
    );
    return timeout(context.events.wait(reply));
  };
  phase('prepare');
  const start = marker();
  const prepared = await context.events.wait(
    request(Op.launch, Op.prepared, encodeLaunch(spec('tree', start)))
  );
  phase('capture-root');
  const witness = await context.events.wait(
    capturedWitness(
      fixture,
      prepared.payload.readUInt32LE(0),
      prepared.payload.readBigUInt64LE(4).toString(16).padStart(16, '0'),
      track,
      context.events
    )
  );
  const budget = Buffer.alloc(5);
  budget.writeUInt32LE(10000);
  budget[4] = 1;
  phase('stop');
  const stopped = await context.events.wait(request(Op.stop, Op.stopped, budget));
  assert.equal(stopped.payload.length, 26);
  assert.equal(stopped.payload.readUInt32LE(2), 0);
  assert.equal(stopped.payload[1], 1);
  assert.equal(stopped.payload.readUInt32LE(18), 0);
  assert.equal(stopped.payload.readUInt32LE(22), 0);
  phase('witness-exits');
  assert.equal(await timeout(context.events.wait(witness.exit)), 0);
  assert.equal(existsSync(start.path), false);
  phase('target-drain');
  await context.events.wait(
    waitFor(() => raw.stdout.readableEnded && raw.stderr.readableEnded, 3000, context.events)
  );
  phase('release-ack');
  const released = await context.events.wait(request(Op.release, Op.released, Buffer.alloc(0)));
  if (releaseContention)
    assert.deepEqual(
      released.payload,
      Buffer.from([1, 1, 1]),
      'Actual watcher lock, failed lock probe and unlocked state before Release ACK'
    );
  else assert.equal(released.payload.length, 0);
  phase('broker-exit');
  pipe.end();
  const originalExit = await timeout(context.events.wait(exited));
  if (terminalRace) {
    assert.equal(
      originalExit,
      74,
      'Observed native failure winner cannot become exit0 after complete ACK'
    );
    console.log(
      JSON.stringify({
        nativeNegative: 'failure-winner-after-complete-ack',
        completeAck: true,
        brokerExit: originalExit,
      })
    );
  } else
    assert.equal(
      originalExit,
      0,
      'Genuine Released ACK followed by owner EOF exits normally, including scheduling window'
    );
}

export async function nativeLossScenario(
  context: GateContext,
  faultMode:
    | 'owner-eof'
    | 'broker-crash'
    | 'wrong-generation'
    | 'lost-prepared'
    | 'malformed'
    | 'truncated',
  sentinel: ChildProcess
): Promise<void> {
  const { broker, fixture, owner, marker, spec, track, phase } = context;
  const identity = owner();
  const raw = spawn(broker, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'overlapped'],
    windowsHide: true,
  });
  track(raw, 'raw-broker');
  raw.stdout.resume();
  raw.stderr.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done, reject) => {
      raw.once('exit', (code, signal) => done({ code, signal }));
      raw.once('error', reject);
    }
  );
  void exited.catch(() => undefined); // original error also reaches the awaited exit/protocol path
  const pipe = raw.stdio[3];
  assert.ok(pipe instanceof Duplex);
  pipe.on('error', () => undefined); // deliberate loss gate still requires original exit + independent root witness
  const decoder = new FrameDecoder(identity.processGeneration);
  let preparedReply!: (frame: Frame) => void;
  let stoppedReply!: (frame: Frame) => void;
  const nativePrepared = new Promise<Frame>((done) => {
    preparedReply = done;
  });
  const nativeStopped = new Promise<Frame>((done) => {
    stoppedReply = done;
  });
  const start = marker();
  pipe.on(
    'data',
    context.events.guard((data: Buffer) =>
      decoder.push(data, (frame) => {
        if (frame.opcode === Op.prepared) {
          preparedReply(frame);
        }
        if (frame.opcode === Op.stopped) {
          stoppedReply(frame);
        }
      })
    )
  );
  phase('prepare');
  pipe.write(
    encodeFrame({
      opcode: Op.launch,
      requestId: 1n,
      generation: identity.processGeneration,
      payload: encodeLaunch(spec('tree', start)),
    })
  );
  const frame = await timeout(context.events.wait(nativePrepared));
  phase('capture-root');
  const witness = await context.events.wait(
    capturedWitness(
      fixture,
      frame.payload.readUInt32LE(0),
      frame.payload.readBigUInt64LE(4).toString(16).padStart(16, '0'),
      track,
      context.events
    )
  );
  assert.equal(existsSync(start.path), false);
  phase('loss-dispatch');
  if (faultMode === 'broker-crash') raw.kill();
  else if (faultMode === 'lost-prepared') {
    // Gate inspector captures native identity; admission deliberately publishes no prepared port/resume.
    const budget = Buffer.alloc(5);
    budget.writeUInt32LE(3000);
    budget[4] = 1;
    pipe.write(
      encodeFrame({
        opcode: Op.stop,
        requestId: 2n,
        generation: identity.processGeneration,
        payload: budget,
      })
    );
    phase('stop');
    const stopped = await timeout(context.events.wait(nativeStopped));
    assert.equal(stopped.payload.readUInt32LE(2), 0);
    assert.equal(stopped.payload[1], 1);
    pipe.destroy();
  } else if (faultMode === 'malformed') {
    const invalid = encodeFrame({
      opcode: Op.resume,
      requestId: 2n,
      generation: identity.processGeneration,
      payload: Buffer.alloc(0),
    });
    invalid.writeUInt16LE(99, 4);
    pipe.write(invalid);
  } else if (faultMode === 'truncated') {
    pipe.write(Buffer.alloc(8));
    pipe.end();
  } else if (faultMode === 'wrong-generation')
    pipe.write(
      encodeFrame({
        opcode: Op.resume,
        requestId: 2n,
        generation: randomUUID(),
        payload: Buffer.alloc(0),
      })
    );
  else pipe.destroy();
  phase('witness-exits');
  assert.equal(
    await timeout(context.events.wait(witness.exit)),
    0,
    'Original suspended target exits on broker/control loss'
  );
  assert.equal(
    existsSync(start.path),
    false,
    'Unacknowledged/cancelled target never executes first nonce'
  );
  phase('broker-exit');
  const exit = await timeout(context.events.wait(exited));
  assert.ok(
    exit.code !== 0 || exit.signal !== null,
    'Loss/malformed control never exits as successful release'
  );
  console.log(JSON.stringify({ nativeNegative: faultMode, brokerExit: exit }));
  assert.equal(sentinel.exitCode, null);
}
