/** TEST actual Main -> Host -> D adapters with Node peers and original native Windows service Jobs. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { FileRuntimeStore } from '../../packages/legacy-agent-host/dist/adapters/runtime/FileRuntimeStore.js';
import { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { captureMainWindowsCustody } from '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';
import { fileHash, prepareEmulatedProfile } from './nativeEmulatedProfile';
import { nativeEmulatedOwnerLossScenario } from './nativeEmulatedOwnerLossScenario';
import { nativeEmulatedSourceScenario } from './nativeEmulatedSourceScenario';
import { nativeLauncherScenarios } from './nativeLauncherScenario';

import type { HostCustodyOwner, HostCustodyPort } from '@agent-teams/legacy-agent-host/owned-process';
import type { JsonValue } from '../../packages/legacy-agent-host/dist/contracts.js';
import type { WindowsServiceCapture } from '../../packages/legacy-agent-host/dist/owned-process/retainedServiceContracts.js';
import type { EmulatedSourceProvider } from './nativeEmulatedSourceProfile';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};

interface RootLifecycle {
  capability: string;
  providerGeneration: string;
  root?: { pid: number; birth: string };
  counts: { allocate: number; prepare: number; resume: number; stop: number; release: number };
  order: string[];
  nativeInputs: number;
}

async function providerScenario(sandbox: string, broker: string, actor: string,
  provider: 'codex' | 'opencode', sentinel: ChildProcess, evidence: Record<string, unknown>) {
  Object.assign(evidence, { provider, status: 'INCOMPLETE', stage: 'capture', cleanup: false });
  const selected = await prepareEmulatedProfile(sandbox, broker, actor, provider);
  const physical = captureMainWindowsCustody(selected.host); assert.ok(physical);
  const events = createNativeGateEvents(), witnesses: Awaited<ReturnType<typeof capturedQueryableWitness>>[] = [];
  const observedChildren: ChildProcess[] = [];
  const track = (child: ChildProcess) => observedChildren.push(child);
  const captures = new Map<number, WindowsServiceCapture>();
  const counts = { allocate: 0, prepare: 0, resume: 0, stop: 0, release: 0,
    serviceCapture: 0, serviceStop: 0, serviceSettle: 0 };
  const roots: RootLifecycle[] = [], operationOrder: { operation: string; capability: string }[] = [];
  const inputTails = new Map<string, Buffer>();
  const healthyRestart: Record<string, unknown> = { status: 'INCOMPLETE', stage: 'not-started' };
  const delivery = selected.profile.teams[0]!.members[0]!.delivery; assert.ok(delivery);
  const originalBinding = { backendId: delivery.backendId, teamId: delivery.teamId, runId: delivery.runId,
    memberId: delivery.memberId, generation: delivery.generation };
  const store = new FileRuntimeStore(selected.profile.owner.storageRoot);
  const read = (generation: string) => {
    const binding = { ...originalBinding, generation };
    const record = store.fenced(binding, transaction => transaction.get()); assert.ok(record);
    assert.deepEqual(record.binding, binding); assert.equal(record.profileId, selected.profile.owner.profileId);
    return record;
  };
  Object.assign(evidence, { pins: selected.pins, counts, roots, operationOrder,
    ...(provider === 'codex' ? { healthyRestart } : {}) });
  let custodyPort: HostCustodyPort | undefined;
  let hostExited: Promise<void> | undefined;
  let providerRoot: { pid: number; birth: string } | undefined;
  const observedOwner: HostCustodyOwner = { mainEpoch: physical.mainEpoch,
    attach(context) {
      assert.equal(custodyPort, undefined, 'One original Host attachment for a healthy restart');
      const original = physical.attach(context); custodyPort = original; hostExited = context.hostExited;
      return { ...original, async handle(call) {
        try {
          if (call.operation === 'allocate') {
            assert.ok(roots.length < (provider === 'codex' ? 2 : 1));
            assert.equal(roots.some(root => root.capability === call.capability), false);
            if (roots.length === 1) {
              const old = read(originalBinding.generation);
              assert.equal(old.phase, 'closed'); assert.equal(old.custody, 'released');
              assert.equal(roots[0]!.counts.release, 1);
              assert.ok(roots[0]!.counts.stop >= 1 && roots[0]!.counts.stop <= 4);
              assert.equal(healthyRestart.stage, 'executing');
              // The original transition awaits provider cleanup and endpoint close before startSelected.
              Object.assign(healthyRestart, { sourceClosedBeforeAllocate: true, oldReleaseBeforeAllocate: true,
                retirementSourceOrder: 'closeRuntimeMember→retireOriginal→installSelected→startSelected' });
            }
            roots.push({ capability: call.capability, providerGeneration: call.owner.processGeneration,
              counts: { allocate: 0, prepare: 0, resume: 0, stop: 0, release: 0 }, order: [], nativeInputs: 0 });
          }
          const allocation = roots.find(root => root.capability === call.capability); assert.ok(allocation);
          const value = await original.handle(call);
          if (value.operation === 'allocate') { counts.allocate++; allocation.counts.allocate++; }
          if (value.operation === 'prepare') {
            counts.prepare++; allocation.counts.prepare++; assert.equal(allocation.root, undefined);
            allocation.root = { ...value.root };
            if (allocation === roots[0]) { assert.equal(providerRoot, undefined); providerRoot = value.root; }
            else {
              assert.equal(witnesses.length, 3);
              witnesses.push(await capturedQueryableWitness(actor, value.root.pid, value.root.birth, track, events,
                'query-wait-gated'));
            }
          }
          if (value.operation === 'resume') { counts.resume++; allocation.counts.resume++; }
          if (value.operation === 'stop' && value.state === 'confirmed') { counts.stop++; allocation.counts.stop++; }
          if (value.operation === 'release' && value.state === 'released') { counts.release++; allocation.counts.release++; }
          if (['allocate', 'prepare', 'resume', 'stop', 'release'].includes(value.operation)) {
            allocation.order.push(value.operation); operationOrder.push({ operation: value.operation, capability: call.capability });
          }
          if (provider === 'codex' && call.operation === 'write' && value.operation === 'write') {
            const bytes = Buffer.from(call.bytes, 'base64'); assert.ok(bytes.length <= 16 * 1024);
            const joined = Buffer.concat([inputTails.get(call.capability) ?? Buffer.alloc(0), bytes]);
            let start = 0;
            for (;;) {
              const end = joined.indexOf(10, start); if (end < 0) break;
              const line = joined.subarray(start, end); assert.ok(line.length <= 1_000_000);
              const frame = object(JSON.parse(line.toString('utf8')));
              if (frame.method === 'turn/start') allocation.nativeInputs++;
              start = end + 1;
            }
            const tail = Buffer.from(joined.subarray(start)); assert.ok(tail.length <= 1_000_000);
            inputTails.set(call.capability, tail);
          }
          if (value.operation === 'service-capture') {
            assert.equal(value.outcome.state, 'captured');
            if (value.outcome.state !== 'captured') throw new Error('TEST original capture unavailable');
            assert.equal(captures.has(value.outcome.capture.target.pid), false);
            assert.equal(value.outcome.capture.mainEpoch, physical.mainEpoch);
            assert.deepEqual(value.outcome.capture.root, providerRoot);
            assert.equal(allocation, roots[0]);
            assert.equal(value.outcome.capture.providerCapability, allocation.capability);
            assert.equal(value.outcome.capture.providerGeneration, allocation.providerGeneration);
            captures.set(value.outcome.capture.target.pid, value.outcome.capture);
            counts.serviceCapture++;
          }
          if (value.operation === 'service-stop') {
            assert.equal(value.outcome.state, 'stopped');
            if (value.outcome.state === 'stopped') {
              assert.equal(value.outcome.observation, 'absent');
              assert.equal(value.outcome.evidence, 'native-scope');
              assert.deepEqual(value.outcome.capture, captures.get(value.outcome.capture.target.pid));
            }
            counts.serviceStop++;
          }
          if (value.operation === 'service-settle') { assert.equal(value.outcome.state, 'settled'); counts.serviceSettle++; }
          return value;
        } catch (error) { events.guard(() => { throw error; })(); throw error; }
      } };
    } };
  const client = new CapturedHostClient(selected.host, observedOwner);
  const envelope = (commandId: string, payload: JsonValue): JsonValue => ({ commandId,
    binding: { schemaVersion: 1, handleId: 'TEST-emulated-original', owner: selected.profile.owner,
      scope: selected.profile.teams[0]!.scope }, payload });
  const rpc = async (method: string, commandId: string, payload: JsonValue, cutoff?: number) => {
    if (cutoff !== undefined) assert.ok(performance.now() < cutoff, 'TEST original RPC phase deadline');
    const result = object(await events.wait(client.request(method, envelope(commandId, payload), {
      control: ['runtime.read', 'team.launch.read', 'team.member.actions.read', 'team.member.action.prepare'].includes(method)
        || method.startsWith('team.process.'),
      ...(cutoff === undefined ? {} : { remainingMs: () => cutoff - performance.now() }),
    })));
    if (cutoff !== undefined) assert.ok(performance.now() < cutoff, 'TEST original RPC phase deadline');
    assert.equal(result.ok, true, `TEST ${provider} ${method} refused: ${String(result.code)}`);
    return result.value;
  };
  let passed = false, cleanup = false;
  const cleanupProof: Record<string, unknown> = { hostExited: false, mainCloseConfirmed: false, handleWaits: [] };
  evidence.physical = cleanupProof;
  const errors: unknown[] = [];
  try {
    evidence.stage = 'original-input';
    await client.start();
    await rpc('runtime.open', 'TEST-open', { memberId: 'alice-id' });
    assert.equal(object(await rpc('runtime.read', 'TEST-ready', { memberId: 'alice-id' })).nativeReady, true);
    assert.deepEqual(counts, { allocate: 1, prepare: 1, resume: 1, stop: 0, release: 0,
      serviceCapture: 0, serviceStop: 0, serviceSettle: 0 });
    const sent = object(await rpc('team.execute', 'TEST-input', { operation: 'message.send',
      payload: { to: 'alice', text: 'TEST-register-services', messageId: 'TEST-input', actionMode: 'do' } }));
    const inputId = object(sent.effects).deliveryId; assert.equal(typeof inputId, 'string');
    const deadline = performance.now() + 15000;
    for (;;) {
      const state = object(await rpc('runtime.read', 'TEST-input-read', { memberId: 'alice-id' }, deadline));
      assert.ok(Array.isArray(state.inputs));
      const input = state.inputs.map(object).find(value => value.inputId === inputId);
      if (input?.phase === 'terminal') { assert.equal(input.terminal, 'succeeded'); break; }
      assert.ok(performance.now() < deadline, 'TEST original input deadline');
      await delay(25);
    }
    const effects = readFileSync(selected.effects, 'utf8').trim().split('\n').map(line => object(JSON.parse(line)));
    assert.equal(effects.filter(value => value.event === 'failure').length, 0);
    assert.equal(effects.filter(value => value.event === 'registered').length, 1);
    const registered = effects.find(value => value.event === 'registered')!.services;
    assert.ok(Array.isArray(registered) && registered.length === 2);
    const services = registered.map(object);
    assert.equal(captures.size, 2); assert.ok(providerRoot);
    for (const captured of [providerRoot, ...captures.values()].map(value => 'target' in value
      ? { pid: value.target.pid, birth: value.target.birth } : value))
      witnesses.push(await capturedQueryableWitness(actor, captured.pid, captured.birth, track, events,
        'query-wait-gated'));
    const list = async (id: string) => {
      const rows = await rpc('team.process.list', id, {}); assert.ok(Array.isArray(rows) && rows.length === 2);
      return rows.map(object);
    };
    let rows = await list('TEST-live');
    for (const service of services) {
      const row = rows.find(value => value.processRef === service.processRef);
      assert.ok(row); assert.equal(row.pid, service.pid); assert.equal(row.observation, 'same-live'); assert.equal(row.canTerminate, true);
    }
    for (const [index, service] of services.entries()) {
      const originalRow = rows.find(value => value.processRef === service.processRef);
      assert.ok(originalRow, 'Select the original live registration before its one Stop');
      const commandId = `TEST-stop-${index}`, stopDeadline = performance.now() + 10000;
      let receipt = object(await rpc('team.process.terminate', commandId, { processRef: String(service.processRef) }, stopDeadline));
      for (;;) {
        assert.equal(receipt.originalProcessRef, service.processRef);
        const state = object(receipt.state);
        if (receipt.phase === 'completed' && state.phase === 'completed' && state.native === 'observed-absent') break;
        assert.ok(performance.now() < stopDeadline, 'TEST original Stop deadline'); await delay(25);
        receipt = object(await rpc('team.process.lookup', `TEST-lookup-${index}`, { originalCommandId: commandId }, stopDeadline));
      }
      assert.equal(object(receipt.state).signalAccepted, 'unknown');
      assert.equal(await timeout(witnesses[index + 1]!.wait()), 0);
      rows = await list(`TEST-after-stop-${index}`);
      // Stop updates metadata and therefore its content-addressed processRef, not the registration ID.
      const stopped = rows.filter(value => value.id === originalRow.id);
      assert.equal(stopped.length, 1); assert.equal(stopped[0]!.pid, service.pid);
      assert.equal(stopped[0]!.observation, 'absent'); assert.equal(stopped[0]!.canTerminate, false);
      if (index === 0) {
        const neighbor = rows.find(value => value.processRef === services[1]!.processRef)!;
        assert.equal(neighbor.observation, 'same-live'); assert.equal(neighbor.canTerminate, true);
        assert.equal(await timeout(witnesses[2]!.observe()), 'alive', 'Independent original neighbor HANDLE remains alive');
      }
      assert.equal(await timeout(witnesses[0]!.observe()), 'alive', 'Scoped Stop preserves the provider root');
      assert.equal(sentinel.exitCode, null, 'Scoped Stop preserves an unrelated original child');
    }
    assert.equal(counts.serviceCapture, 2); assert.equal(counts.serviceStop, 2); assert.equal(counts.serviceSettle, 2);
    Object.assign(evidence, { nativeReady: true, inputCompleted: true, registeredServices: 2,
      scopedStops: 2, neighborSurvivedPrimary: true, providerSurvivedScopedStops: true });
    if (provider === 'codex') {
      evidence.stage = 'healthy-restart'; healthyRestart.stage = 'prepare';
      const old = read(originalBinding.generation); assert.ok(old.config);
      assert.equal(old.config.generation, selected.profile.runtime!.members[0]!.generation);
      assert.equal(old.inputs.length, 1); assert.equal(old.inputs[0]!.intent.inputId, inputId);
      assert.equal(old.inputs[0]!.phase, 'terminal'); assert.equal(old.inputs[0]!.terminal, 'succeeded');
      assert.equal(roots[0]!.nativeInputs, 1);
      const launch = object(await rpc('team.launch.read', 'TEST-restart-launch', {}));
      assert.ok(typeof launch.launchId === 'string'); assert.ok(Array.isArray(launch.members));
      const member = launch.members.map(object).find(value => value.memberId === originalBinding.memberId); assert.ok(member);
      assert.deepEqual(member.binding, originalBinding);
      const actionView = object(await rpc('team.member.actions.read', 'TEST-restart-actions', {
        launchId: launch.launchId, memberId: originalBinding.memberId }));
      assert.equal(actionView.launchId, launch.launchId); assert.equal(actionView.memberId, originalBinding.memberId);
      assert.ok(typeof actionView.rosterRevision === 'string'); assert.equal(actionView.rosterRevision, launch.rosterRevision);
      const commandId = 'TEST-clean-restart', payload = { launchId: launch.launchId,
        rosterRevision: actionView.rosterRevision, memberId: originalBinding.memberId,
        expectedGeneration: originalBinding.generation, action: 'restart' };
      const sourcePins = ['./nativeEmulatedProviderGate.ts',
        '../../packages/legacy-agent-host/src/composition/transitionRuntimeMember.ts',
        '../../packages/legacy-agent-host/src/composition/executeMemberAction.ts',
        '../../packages/legacy-agent-host/src/owned-process/RetainedWindowsServices.ts',
      ].map(path => realpathSync(fileURLToPath(new URL(path, import.meta.url))))
        .map(path => ({ path, sha256: fileHash(path) }));
      Object.assign(healthyRestart, { commandId, launchId: launch.launchId, memberId: originalBinding.memberId,
        rosterRevision: actionView.rosterRevision, sourcePins,
        before: { bindingGeneration: old.binding.generation, configGeneration: old.config.generation },
        profileGenerationSource: 'executeMemberAction assigns the selected profile generation to config.generation' });
      const prepared = object(await rpc('team.member.action.prepare', commandId, payload));
      assert.equal(prepared.commandId, commandId); assert.equal(prepared.stage, 'prepared');
      assert.equal(prepared.sourceGeneration, originalBinding.generation); assert.equal(prepared.selectedGeneration, null);
      assert.equal(prepared.current, true);
      healthyRestart.prepared = prepared; healthyRestart.stage = 'executing';
      const executed = object(await rpc('team.member.action.execute', commandId, payload));
      assert.equal(executed.commandId, commandId); assert.equal(executed.stage, 'selected'); assert.equal(executed.current, true);
      assert.equal(executed.sourceGeneration, originalBinding.generation);
      assert.ok(typeof executed.selectedGeneration === 'string'); assert.notEqual(executed.selectedGeneration, originalBinding.generation);
      assert.deepEqual(executed.source, { availability: 'observed', generation: originalBinding.generation,
        phase: 'closed', custody: 'released', attached: false });
      const generation = executed.selectedGeneration, next = read(generation); assert.ok(next.config);
      assert.deepEqual(executed.selected, { availability: 'observed', generation,
        phase: 'allocated', custody: 'owned', attached: true });
      assert.equal(next.config.generation, old.config.generation + 1); assert.equal(next.inputs.length, 0);
      const ready = object(await rpc('runtime.read', 'TEST-restart-ready', {
        memberId: originalBinding.memberId, expectedGeneration: generation }));
      assert.equal(ready.generation, generation); assert.equal(ready.nativeReady, true); assert.equal(ready.attached, true);
      assert.equal(ready.phase, 'allocated'); assert.equal(ready.custody, 'owned'); assert.deepEqual(ready.inputs, []);
      assert.equal(roots.length, 2); const previous = roots[0]!, successor = roots[1]!;
      assert.ok(previous.root && successor.root); assert.notDeepEqual(successor.root, previous.root);
      assert.notEqual(successor.capability, previous.capability); assert.notEqual(successor.providerGeneration, previous.providerGeneration);
      assert.equal(previous.nativeInputs, 1); assert.equal(successor.nativeInputs, 0);
      assert.equal(healthyRestart.sourceClosedBeforeAllocate, true); assert.equal(healthyRestart.oldReleaseBeforeAllocate, true);
      const oldRelease = operationOrder.findIndex(value => value.operation === 'release' && value.capability === previous.capability);
      const nextAllocate = operationOrder.findIndex(value => value.operation === 'allocate' && value.capability === successor.capability);
      assert.ok(oldRelease >= 0 && nextAllocate > oldRelease);
      assert.equal(await timeout(witnesses[0]!.wait()), 0);
      assert.equal(await timeout(witnesses[3]!.observe()), 'alive');
      const capture = captures.values().next().value; assert.ok(capture && custodyPort);
      const unchangedCapture = structuredClone(capture), beforeRefusal = structuredClone({ counts, roots });
      let rejection: string | undefined;
      try {
        await custodyPort.handle({ operation: 'service-query', capability: successor.capability, capture, budgetMs: 10000 });
      } catch (error) { assert.ok(error instanceof Error); rejection = error.message; }
      assert.equal(rejection, 'Original service custody unavailable');
      assert.deepEqual(capture, unchangedCapture); assert.deepEqual({ counts, roots }, beforeRefusal);
      assert.equal(await timeout(witnesses[3]!.observe()), 'alive'); assert.equal(sentinel.exitCode, null);
      const retainedRows = await list('TEST-restart-old-rows');
      for (const row of rows) {
        const retained = retainedRows.filter(value => value.id === row.id); assert.equal(retained.length, 1);
        assert.equal(retained[0]!.pid, row.pid); assert.equal(retained[0]!.observation, 'absent');
        assert.equal(retained[0]!.canTerminate, false);
      }
      const afterEffects = readFileSync(selected.effects, 'utf8').trim().split('\n').map(line => object(JSON.parse(line)));
      assert.equal(afterEffects.filter(value => value.event === 'failure').length, 0);
      assert.deepEqual(afterEffects.filter(value => value.event === 'registered'), effects.filter(value => value.event === 'registered'));
      assert.deepEqual(afterEffects.filter(value => value.event === 'connected').map(value => value.pid),
        [previous.root.pid, successor.root.pid]);
      assert.deepEqual(read(generation).inputs, []); assert.equal(successor.nativeInputs, 0);
      assert.equal(counts.serviceCapture, 2); assert.equal(counts.serviceStop, 2); assert.equal(counts.serviceSettle, 2);
      for (const pin of sourcePins) assert.equal(fileHash(pin.path), pin.sha256);
      Object.assign(healthyRestart, { stage: 'shutdown', executed,
        after: { bindingGeneration: generation, configGeneration: next.config.generation },
        staleCapture: { capture: unchangedCapture, capability: successor.capability, rejection,
          oldRootAbsent: true, newRootAlive: true, countsUnchanged: true },
        oldRows: retainedRows, oldRowsAbsent: true, successorInputs: 0 });
    }
    evidence.stage = 'shutdown';
    await client.shutdown();
    assert.equal(await physical.close(), true);
    assert.equal(await timeout(witnesses[0]!.wait()), 0);
    const expectedRoots = provider === 'codex' ? 2 : 1;
    assert.equal(roots.length, expectedRoots); assert.equal(counts.allocate, expectedRoots);
    assert.equal(counts.prepare, expectedRoots); assert.equal(counts.resume, expectedRoots); assert.equal(counts.release, expectedRoots);
    for (const root of roots) {
      assert.equal(root.counts.allocate, 1); assert.equal(root.counts.prepare, 1); assert.equal(root.counts.resume, 1);
      assert.equal(root.counts.release, 1); assert.ok(root.counts.stop >= 1 && root.counts.stop <= 4);
    }
    if (provider === 'opencode') assert.ok(counts.stop >= 1 && counts.stop <= 4);
    assert.equal(sentinel.exitCode, null);
    passed = true;
  } catch (error) { errors.push(error); }
  finally {
    try { await client.shutdown(); if (hostExited) await timeout(hostExited); cleanupProof.hostExited = !!hostExited; }
    catch (error) { errors.push(error); }
    try { assert.equal(await physical.close(), true); cleanupProof.mainCloseConfirmed = true; } catch (error) { errors.push(error); }
    try { const waits = await timeout(Promise.all(witnesses.map(value => value.wait())), 10000);
      cleanupProof.handleWaits = waits;
      if (provider === 'codex') healthyRestart.handleWaits = waits;
      assert.deepEqual(waits, Array(provider === 'codex' ? 4 : 3).fill(0)); }
    catch (error) { errors.push(error); }
    cleanup = errors.length === 0;
    // These are only witness processes launched by this gate. Original native cleanup remains mandatory.
    for (const child of observedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  Object.assign(evidence, { cleanup, status: passed && cleanup ? 'PASS' : 'INCOMPLETE',
    stage: passed && cleanup ? 'complete' : evidence.stage,
    errors: errors.map(error => error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }) });
  if (!passed || !cleanup) throw new AggregateError(errors, `TEST ${provider} Windows provider fixture incomplete`);
  if (provider === 'codex') Object.assign(healthyRestart, { status: 'PASS', stage: 'complete' });
  evidence.wrapper = provider === 'codex' ? 'npm-node' : 'opaque-cmd';
}

async function main() {
  const [wholeBroker, actor, _birthFault, _accountingFault, _releaseFault, scopedBroker, receiptPath, ...tail] = process.argv.slice(2);
  let sourceProvider: EmulatedSourceProvider | undefined;
  if (tail.length === 4) {
    assert.equal(tail[0], '--test-source-provider');
    const selected = tail[1]; assert.ok(selected === 'codex' || selected === 'claude' || selected === 'opencode');
    sourceProvider = selected;
  } else assert.equal(tail.length, 2, 'Exact original or one explicit source invocation');
  const [flag, sandbox] = tail.slice(sourceProvider === undefined ? 0 : 2);
  assert.equal(process.platform, 'win32'); assert.equal(process.version, 'v24.21.0');
  assert.match(process.env.HOST_PROCESS_SOURCE_HEAD ?? '', /^[a-f0-9]{40}$/);
  assert.ok(wholeBroker && actor && scopedBroker && receiptPath && sandbox); assert.equal(flag, '--controller-sandbox');
  assert.ok(resolve(sandbox).startsWith(resolve(tmpdir()) + sep) && /^opg[0-9a-f]+\.tmp$/i.test(basename(sandbox)));
  assert.equal(existsSync(receiptPath), false);
  const paths = [wholeBroker, actor, scopedBroker].map(path => realpathSync(path));
  const pins = paths.map(path => ({ path, sha256: fileHash(path) }));
  // Both native test lanes run inside the original controller's 120s Job.
  // Keep the unrelated sentinel alive until the original parent closes it;
  // its old 60s sleep could end before the later recovery scenario.
  const sentinel = spawn(paths[1]!, ['source-sentinel'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<number | null>((resolveExit, reject) => { sentinel.once('exit', resolveExit); sentinel.once('error', reject); });
  void exited.catch(() => undefined);
  const providers: Record<string, unknown>[] = [], wrappers: string[] = [], sourceScenarios: Record<string, unknown>[] = [];
  const ownerLoss: Record<string, unknown>[] = [
    { scenario: 'completed-install-before-physical-resume', status: 'INCOMPLETE', stage: 'not-started', cleanup: false },
    { scenario: 'completed-effects-before-runtime-completion', status: 'INCOMPLETE', stage: 'not-started', cleanup: false },
  ];
  let complete = false, cleanup = false, failure: unknown;
  try {
    await timeout(new Promise<void>((resolveReady, reject) => { sentinel.stdout!.once('data', () => resolveReady()); sentinel.once('error', reject); }));
    if (sourceProvider === undefined) {
      wrappers.push(...await nativeLauncherScenarios(realpathSync(sandbox), paths[0]!, paths[1]!));
      for (const provider of ['codex', 'opencode'] as const) {
        const evidence: Record<string, unknown> = { provider, status: 'INCOMPLETE', stage: 'not-started', cleanup: false };
        providers.push(evidence);
        await providerScenario(realpathSync(sandbox), paths[2]!, paths[1]!, provider, sentinel, evidence);
      }
      await nativeEmulatedOwnerLossScenario(realpathSync(sandbox), paths[2]!, paths[1]!, sentinel,
        'owner-loss-before-resume', ownerLoss[0]!);
      await nativeEmulatedOwnerLossScenario(realpathSync(sandbox), paths[2]!, paths[1]!, sentinel,
        'owner-loss-after-effect', ownerLoss[1]!);
      assert.deepEqual(ownerLoss.map(value => [value.status, value.stage, value.cleanup]),
        [['PASS', 'complete', true], ['PASS', 'complete', true]]);
    } else {
      const evidence: Record<string, unknown> = {};
      sourceScenarios.push(evidence);
      await nativeEmulatedSourceScenario(realpathSync(sandbox), paths[2]!, paths[1]!, sourceProvider, sentinel, evidence);
      assert.deepEqual(sourceScenarios.map(value => [value.provider, value.status, value.cleanup]),
        [[sourceProvider, 'PASS', true]]);
    }
    assert.equal(sentinel.exitCode, null);
    for (const pin of pins) assert.equal(fileHash(pin.path), pin.sha256);
    complete = true;
  } catch (error) { failure = error; }
  finally {
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill();
    try { await timeout(exited); cleanup = true; } catch (error) { failure ??= error; }
    writeFileSync(receiptPath, JSON.stringify({ kind: sourceProvider === undefined
      ? 'TEST_WINDOWS_EMULATED_PROVIDER_PARITY' : 'TEST_WINDOWS_EMULATED_SOURCE_PARITY',
      sourceHead: process.env.HOST_PROCESS_SOURCE_HEAD, platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version, status: complete && cleanup && !failure ? 'PASS' : 'INCOMPLETE',
      pins, ...(sourceProvider === undefined ? { wrappers, providers, ownerLoss } : { provider: sourceProvider, sourceScenarios }),
      cleanup, realProviderExecuted: false, desktopQualified: false,
      releaseQualified: false }, null, 2) + '\n', { flag: 'wx' });
  }
  if (failure) throw failure;
  assert.ok(complete && cleanup);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
