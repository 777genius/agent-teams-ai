import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';

import { decodeServiceFacts, decodeServiceIdentity, decodeServiceRefusal, encodeFrame, encodeLaunch,
  encodeServiceCapture, encodeServiceCaptureCurrent, encodeServiceScope, encodeServiceStop, FrameDecoder, Op, ServiceRefusal,
} from '@agent-teams/legacy-agent-host/owned-process';
import { capturedQueryableWitness, capturedWitness, timeout, waitFor } from './nativeGateContext';
import { createFixtureOutputCollector } from './nativeGateOutput';

import type { Frame } from '@agent-teams/legacy-agent-host/owned-process';
import type { GateContext } from './nativeGateContext';

/** Unstaged TEST binary only. A valid provider receipt is never minted from these scoped facts. */
export async function nativeDebugServiceScenario(context: GateContext, debugBroker: string,
  mode: 'pre-resume-cancel' | 'service-pair' | 'service-first' | 'service-race' | 'wow64-root', sentinel: ChildProcess): Promise<void> {
  const { events, owner, marker, spec, fixture, track, phase } = context;
  const identity = owner(), start = marker();
  const admissionBarrier = `${start.path}.admission`;
  const wow64Path = join(dirname(start.path), 'TEST-wow64-command.utf16');
  if (mode === 'service-pair') assert.equal(existsSync(wow64Path), false,
    'The original child scenario publishes a fresh native path in this controller sandbox');
  const diagnosticPath = `${start.path}.debug-failure`;
  const diagnosticFd = openSync(diagnosticPath, 'wx');
  const raw = (() => {
    try {
      return spawn(debugBroker, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'overlapped', diagnosticFd], windowsHide: true,
        ...(mode === 'service-race' ? { env: { ...process.env,
          OWNED_PROCESS_TEST_ADMISSION_BARRIER: admissionBarrier,
          OWNED_PROCESS_TEST_ADMISSION_NONCE: start.nonce,
        } } : mode === 'wow64-root' ? { env: { ...process.env, OWNED_PROCESS_TEST_I386_ROOT: '1' } } : {}),
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
        'dll-close', 'rip', 'continue', 'job-close', 'root-close', 'registry', 'retire'];
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
  const publishBarrier = (path: string) => {
    writeFileSync(`${path}.pending`, start.nonce, { flag: 'wx' });
    renameSync(`${path}.pending`, path);
  };
  const waitBarrier = (path: string) => waitFor(() => existsSync(path) &&
    readFileSync(path, 'ascii') === start.nonce, 5000, events);
  const output = createFixtureOutputCollector();
  let text = '';
  stdout.on('data', events.guard((chunk: Buffer) => {
    output.push(chunk); text += chunk.toString();
  }));
  stderr.resume();
  let launch = spec(mode === 'pre-resume-cancel' ? 'tree' : mode, start);
  if (mode === 'wow64-root') {
    assert.ok(existsSync(wow64Path), 'The preceding completed child scenario must publish its verified I386 path');
    const bytes = readFileSync(wow64Path);
    assert.ok(bytes.length > 0 && bytes.length <= 1024 && bytes.length % 2 === 0);
    const executable = bytes.toString('utf16le');
    assert.ok(!executable.includes('"') && !/\p{Cc}/u.test(executable));
    launch = { ...launch, executable, commandLine: `"${executable}" /d /c exit 0` };
  }
  phase('prepare');
  const prepared = await request(Op.launch, Op.prepared, encodeLaunch(launch));
  assert.equal(prepared.payload.length, 12);
  const rootPid = prepared.payload.readUInt32LE(0);
  const rootBirth = prepared.payload.readBigUInt64LE(4).toString(16).padStart(16, '0');
  phase('capture-root');
  const root = await capturedQueryableWitness(fixture, rootPid, rootBirth, track, events, 'query-wait-gated');
  assert.equal(existsSync(start.path), false, 'DEBUG+CREATE_SUSPENDED target has no pre-resume effect');
  const whole = Buffer.alloc(5);
  whole.writeUInt32LE(10000); whole[4] = 1;
  let neighborWitness: Awaited<ReturnType<typeof capturedQueryableWitness>> | undefined;
  if (mode === 'wow64-root') {
    phase('resume');
    await request(Op.resume, Op.resumed, Buffer.alloc(0));
    phase('root-exit');
    await waitFor(() => readRootExit() !== undefined, 5000, events);
    assert.equal(readRootExit()!.payload.readUInt32LE(0), 0, 'Verified I386 original root survives both loader startup events');
    assert.equal(await root.observe(), 'absent', 'The exact original x86 root HANDLE signals natural exit');
  } else if (mode !== 'pre-resume-cancel') {
    phase('resume');
    await request(Op.resume, Op.resumed, Buffer.alloc(0));
    phase('child-lines');
    try {
      await waitFor(() => output.children.length === 4 && output.childrenOf(rootPid).length === 2, 10000, events);
    } catch (error) {
      // Read only the original bounded stdout; incomplete/ambiguous records carry no diagnosis.
      try {
        const lines = text.split('\n'), tail = lines.pop()!;
        const key = '"TEST_SERVICE_PAIR_PREREQUISITE"';
        const records = lines.filter(line => line.includes(key));
        const match = records.length === 1 && tail.length === 0
          ? /^\{"TEST_SERVICE_PAIR_PREREQUISITE":\{"stage":([1-9]|1[0-9])(?:,"result":(0|[1-9][0-9]{0,9}))?\}\}\r?$/.exec(records[0]!)
          : null;
        const result = match?.[2] === undefined ? undefined : Number(match[2]);
        const prerequisite = match && (result === undefined || result <= 0xffffffff)
          ? { stage: Number(match[1]), ...(result === undefined ? {} : { result }) } : 'unknown';
        console.error(JSON.stringify({ nativeServiceReadinessFailure: {
          rootExitCode: readRootExit()?.payload.readUInt32LE(0) ?? null,
          rootCount: output.root ? 1 : 0, childCount: output.children.length,
          rootChildCount: output.childrenOf(rootPid).length,
          wow64Completed: text.includes('{"wow64StartupAndApplicationBreakpoints":true}'),
          churnCompleted: text.includes('{"retiredChildren":80}'), prerequisite,
        } }));
      } catch { /* Diagnostic failure cannot replace the original readiness refusal. */ }
      throw error;
    }
    if (mode === 'service-pair') {
      assert.ok(text.includes('{"retiredChildren":80}'),
        'actual cumulative child churn exceeded64 without exhausting live scope custody');
      assert.ok(text.includes('{"wow64StartupAndApplicationBreakpoints":true}'),
        'A verified x86 child survives native startup; later root/child application exceptions reach their handlers');
    }
    const [service, neighbor] = output.childrenOf(rootPid);
    assert.ok(service && neighbor);
    assert.equal(output.childrenOf(service.pid).length, 2, 'Selected service already has descendants before registration');
    phase('capture-descendants');
    const serviceWitnesses = await events.wait(Promise.all([service, ...output.childrenOf(service.pid)].map(value =>
      capturedWitness(fixture, value.pid, value.birth, track, events))));
    const adjacent = await capturedQueryableWitness(fixture, neighbor.pid, neighbor.birth, track, events, 'query-wait-gated');
    neighborWitness = adjacent;
    if (mode === 'service-first') {
      phase('root-exit');
      writeFileSync(`${start.path}.branch-release`, start.nonce, { flag: 'wx' });
      assert.equal(await timeout(events.wait(serviceWitnesses[0]!.exit)), 0);
    }
    const currentCapture = encodeServiceCaptureCurrent(service.pid);
    const captureOpcode = mode !== 'service-first' ? Op.serviceCaptureCurrent : Op.serviceCapture;
    const capture = mode !== 'service-first' ? currentCapture : encodeServiceCapture(service.pid, service.birth);
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
    const observe = async (requireActive = true) => {
      const facts = decodeServiceFacts(await request(Op.serviceQuery, Op.serviceObserved, key));
      assert.equal(facts.key, selected.key); assert.equal(facts.birth, service.birth);
      assert.equal(facts.queryError, 0); assert.equal(facts.dispatchError, 0);
      if (requireActive)
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
    if (mode === 'service-race') {
      publishBarrier(`${start.path}.race-release`);
      await waitBarrier(`${admissionBarrier}.captured`);
    }
    const stopId = lastId + 1n;
    const stop = encodeServiceStop(selected.key, 10000);
    const pendingStop = request(Op.serviceStop, Op.serviceStopped, stop);
    let stopReplied = false;
    void pendingStop.then(() => { stopReplied = true; }, () => undefined);
    if (mode === 'service-race') {
      await waitBarrier(`${admissionBarrier}.dispatched`);
      // Termination may empty Job accounting before the original root HANDLE signals.
      const pending = await observe(false);
      console.error(JSON.stringify({ nativeServicePendingCreate: {
        rootExited: pending.rootExited, activeProcesses: pending.activeProcesses,
        queryError: pending.queryError, dispatchError: pending.dispatchError, stopReplied,
      } }));
      assert.ok(!pending.rootExited || pending.activeProcesses > 0,
        'Pending CREATE cannot complete the original scope');
      assert.equal(stopReplied, false, 'The one original Stop still waits for pending CREATE cleanup');
      assert.equal(decodeServiceRefusal(await request(Op.serviceSettle, Op.serviceRefused, key)).reason,
        ServiceRefusal.invalid, 'Pending CREATE cannot settle or retire the original terminating scope');
      publishBarrier(`${admissionBarrier}.dispatch-continue`);
      let admissionText = '';
      await waitFor(() => {
        if (!existsSync(`${admissionBarrier}.admitted`)) return false;
        admissionText = readFileSync(`${admissionBarrier}.admitted`, 'ascii');
        return admissionText.endsWith('}');
      }, 5000, events);
      const admitted: unknown = JSON.parse(admissionText);
      assert.ok(admitted && typeof admitted === 'object' && 'nonce' in admitted &&
        'pid' in admitted && 'birth' in admitted);
      assert.equal(admitted.nonce, start.nonce);
      assert.ok(typeof admitted.pid === 'number' && Number.isSafeInteger(admitted.pid) && admitted.pid > 0);
      assert.ok(typeof admitted.birth === 'string' && /^[0-9a-f]{16}$/.test(admitted.birth));
      assert.equal(decodeServiceRefusal(await request(Op.serviceCaptureCurrent, Op.serviceRefused,
        encodeServiceCaptureCurrent(admitted.pid))).reason, ServiceRefusal.missing,
        'A debug-only inherited Job grants no current-child service authority');
      assert.equal(decodeServiceRefusal(await request(Op.serviceCapture, Op.serviceRefused,
        encodeServiceCapture(admitted.pid, admitted.birth))).reason, ServiceRefusal.missing,
        'An exact original identity cannot register the inherited parent Job either');
      assert.equal(stopReplied, false, 'Stop cannot acknowledge absence before CREATE continuation');
      publishBarrier(`${admissionBarrier}.admission-continue`);
    }
    const stopped = await pendingStop;
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
    assert.equal(await adjacent.observe(), 'alive', 'Other service original HANDLE remains unsignaled');
    assert.equal(await root.observe(), 'alive', 'Provider original HANDLE remains unsignaled');
    if (mode === 'service-race') assert.equal(existsSync(`${start.path}.race-effect`), false,
      'The terminated child never reaches its first user-code effect');
    assert.equal(sentinel.exitCode, null);
    stdin.write('TEST provider remains functional\n');
    await waitFor(() => text.includes('{"providerAlive":true}'), 3000, events);
  }
  if (mode !== 'wow64-root')
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
  assert.equal(await root.wait(), 0);
  if (neighborWitness) assert.equal(await neighborWitness.wait(), 0);
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
