import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createWindowsOwnedLaunchPort, OwnedProcessFacade } from '@agent-teams/legacy-agent-host/owned-process';
import { brokerReleased, capturedWitness, timeout } from './nativeGateContext';

import type { ChildProcess } from 'node:child_process';
import type { PreparedOwnedProcess, TreeOutcome } from '@agent-teams/legacy-agent-host/owned-process';
import type { GateContext } from './nativeGateContext';

/** Real native process + original HANDLE witnesses, under the existing independent outer Job. */
export async function nativeFacadeScenario(
  context: GateContext,
  cancel: boolean,
  sentinel: ChildProcess
): Promise<void> {
  const { owner, broker, fixture, marker, spec, retain, phase, events, track } = context;
  const identity = owner(), start = marker(), port = createWindowsOwnedLaunchPort(broker);
  const pending = port.allocate(identity);
  retain(pending); // Preparation must never outrun its cleanup owner.
  let grant!: () => void, captured!: (process: PreparedOwnedProcess) => void;
  const permission = new Promise<void>((resolve) => { grant = resolve; });
  const entered = new Promise<PreparedOwnedProcess>((resolve) => { captured = resolve; });
  let stopping: Promise<TreeOutcome> | undefined, stopRequests = 0;
  const stop = () => {
    stopping ??= pending.stop({ expectedOwner: identity,
      attemptId: 'facade-native-cleanup', mode: 'force', deadlineMs: performance.now() + 10000 });
    void stopping.catch(() => undefined);
    return stopping;
  };
  phase('prepare');
  const child = new OwnedProcessFacade({ owner: identity, current: () => true,
    prepare: () => port.prepare(pending, spec('stdio', start)),
    installOwner: async (process) => { captured(process); await permission; },
    requestStop: () => { stopRequests++; void stop(); return true; } });
  assert.equal(child.pid, undefined, 'A synchronous SDK facade exposes no broker PID');
  const input = Buffer.alloc(256 * 1024);
  for (let index = 0; index < input.length; index++) input[index] = index % 256;
  const output: Buffer[] = [], errors: Buffer[] = [];
  let outputSize = 0;
  child.stdout.on('data', events.guard((chunk: Buffer) => {
    outputSize += chunk.length;
    assert.ok(outputSize <= input.length + 128, 'Bounded native fixture output');
    output.push(chunk);
  }));
  child.stderr.on('data', events.guard((chunk: Buffer) => {
    assert.ok(errors.reduce((size, value) => size + value.length, chunk.length) <= 128);
    errors.push(chunk);
  }));
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const inputResult = new Promise<Error | null | undefined>((resolve) => {
    assert.equal(child.stdin.write(input, resolve), false, 'SDK observes backpressure while suspended');
  });
  child.stdin.end(); // EOF is also gated; the native fixture cannot consume it early.
  const prepared = await timeout(events.wait(entered));
  phase('capture-root');
  assert.equal(child.pid, prepared.root.pid);
  const witness = await capturedWitness(fixture, prepared.root.pid, prepared.root.birth, track, events);
  assert.equal(existsSync(start.path), false, 'No target instruction before native authority installation');
  assert.equal(outputSize, 0);
  if (cancel) {
    phase('stop');
    assert.equal(child.kill('SIGTERM'), true);
    assert.equal(child.kill('SIGKILL'), true);
    grant();
    await assert.rejects(child.ready, /unavailable/);
    assert.ok(await timeout(events.wait(inputResult)), 'Queued private input is rejected');
    assert.equal(stopRequests, 1, 'Repeated SDK kill shares the original cleanup request');
  } else {
    phase('resume');
    const finished = once(child.stdin, 'finish');
    grant();
    await timeout(events.wait(child.ready));
    assert.ok((await timeout(events.wait(inputResult))) == null);
    await timeout(events.wait(finished));
    phase('root-exit');
    assert.equal(await timeout(events.wait(closed)), 7, 'Actual target code reaches the SDK');
    assert.deepEqual(Buffer.concat(output), Buffer.concat([input, Buffer.from('TEST native stdout tail\n')]));
    assert.equal(Buffer.concat(errors).toString(), 'TEST native stderr tail\n');
    assert.equal(readFileSync(start.path, 'utf8'), start.nonce);
    assert.equal(child.killed, false, 'Natural exit is independent from cleanup');
  }
  phase('stop');
  const outcome = await timeout(events.wait(stop()));
  assert.equal(outcome.kind, 'confirmed');
  phase('witness-exits');
  assert.equal(await timeout(events.wait(witness.exit)), 0, 'Original native root HANDLE is signaled');
  if (cancel) assert.equal(existsSync(start.path), false, 'Cancelled native target never executes');
  phase('target-drain');
  assert.equal((await events.wait(prepared.drain(performance.now() + 3000))).kind, 'complete');
  if (outcome.kind !== 'confirmed') throw new Error('Facade native cleanup lacks proof');
  phase('release-ack');
  await events.wait(pending.release(outcome.receipt, 'job-membership'));
  phase('broker-exit');
  await brokerReleased(pending, events);
  assert.equal(sentinel.exitCode, null, 'Unrelated live process survives facade cleanup');
}
