/** TEST actual Main -> Host -> D adapters with Node peers and original native Windows service Jobs. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { captureMainWindowsCustody } from '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';
import { capturedWitness, timeout } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';
import { fileHash, prepareEmulatedProfile } from './nativeEmulatedProfile';
import { nativeEmulatedSourceScenario } from './nativeEmulatedSourceScenario';
import { nativeLauncherScenarios } from './nativeLauncherScenario';

import type { HostCustodyOwner } from '@agent-teams/legacy-agent-host/owned-process';
import type { JsonValue } from '../../packages/legacy-agent-host/dist/contracts.js';
import type { WindowsServiceCapture } from '../../packages/legacy-agent-host/dist/owned-process/retainedServiceContracts.js';
import type { EmulatedSourceProvider } from './nativeEmulatedSourceProfile';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};

async function providerScenario(sandbox: string, broker: string, actor: string,
  provider: 'codex' | 'opencode', sentinel: ChildProcess) {
  const selected = await prepareEmulatedProfile(sandbox, broker, actor, provider);
  const physical = captureMainWindowsCustody(selected.host); assert.ok(physical);
  const events = createNativeGateEvents(), witnesses: Awaited<ReturnType<typeof capturedWitness>>[] = [];
  const observedChildren: ChildProcess[] = [];
  const track = (child: ChildProcess) => observedChildren.push(child);
  const captures = new Map<number, WindowsServiceCapture>();
  const counts = { allocate: 0, prepare: 0, resume: 0, stop: 0, release: 0,
    serviceCapture: 0, serviceStop: 0, serviceSettle: 0 };
  let providerRoot: { pid: number; birth: string } | undefined;
  const observedOwner: HostCustodyOwner = { mainEpoch: physical.mainEpoch,
    attach(context) {
      const original = physical.attach(context);
      return { ...original, async handle(call) {
        const value = await original.handle(call);
        if (call.operation === 'allocate') counts.allocate++;
        if (value.operation === 'prepare') { counts.prepare++; assert.equal(providerRoot, undefined); providerRoot = value.root; }
        if (value.operation === 'resume') counts.resume++;
        if (value.operation === 'stop' && value.state === 'confirmed') counts.stop++;
        if (value.operation === 'release' && value.state === 'released') counts.release++;
        if (value.operation === 'service-capture') {
          assert.equal(value.outcome.state, 'captured');
          if (value.outcome.state !== 'captured') throw new Error('TEST original capture unavailable');
          assert.equal(captures.has(value.outcome.capture.target.pid), false);
          assert.equal(value.outcome.capture.mainEpoch, physical.mainEpoch);
          assert.deepEqual(value.outcome.capture.root, providerRoot);
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
      } };
    } };
  const client = new CapturedHostClient(selected.host, observedOwner);
  const envelope = (commandId: string, payload: JsonValue): JsonValue => ({ commandId,
    binding: { schemaVersion: 1, handleId: 'TEST-emulated-original', owner: selected.profile.owner,
      scope: selected.profile.teams[0]!.scope }, payload });
  const rpc = async (method: string, commandId: string, payload: JsonValue) => {
    const result = object(await client.request(method, envelope(commandId, payload), {
      control: method === 'runtime.read' || method.startsWith('team.process.'),
    }));
    assert.equal(result.ok, true, `TEST ${provider} ${method} refused: ${String(result.code)}`);
    return result.value;
  };
  let passed = false, cleanup = false;
  const errors: unknown[] = [];
  try {
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
      const state = object(await rpc('runtime.read', 'TEST-input-read', { memberId: 'alice-id' }));
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
      witnesses.push(await capturedWitness(actor, captured.pid, captured.birth, track, events));
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
      const commandId = `TEST-stop-${index}`, stopDeadline = performance.now() + 10000;
      let receipt = object(await rpc('team.process.terminate', commandId, { processRef: String(service.processRef) }));
      for (;;) {
        assert.equal(receipt.originalProcessRef, service.processRef);
        const state = object(receipt.state);
        if (receipt.phase === 'completed' && state.phase === 'completed' && state.native === 'observed-absent') break;
        assert.ok(performance.now() < stopDeadline, 'TEST original Stop deadline'); await delay(25);
        receipt = object(await rpc('team.process.lookup', `TEST-lookup-${index}`, { originalCommandId: commandId }));
      }
      assert.equal(object(receipt.state).signalAccepted, 'unknown');
      assert.equal(await timeout(witnesses[index + 1]!.exit), 0);
      rows = await list(`TEST-after-stop-${index}`);
      assert.equal(rows.find(value => value.processRef === service.processRef)!.observation, 'absent');
      if (index === 0) {
        const neighbor = rows.find(value => value.processRef === services[1]!.processRef)!;
        assert.equal(neighbor.observation, 'same-live'); assert.equal(neighbor.canTerminate, true);
        assert.equal(witnesses[2]!.process.exitCode, null, 'Independent original neighbor HANDLE remains alive');
      }
      assert.equal(witnesses[0]!.process.exitCode, null, 'Scoped Stop preserves the provider root');
      assert.equal(sentinel.exitCode, null, 'Scoped Stop preserves an unrelated original child');
    }
    assert.equal(counts.serviceCapture, 2); assert.equal(counts.serviceStop, 2); assert.equal(counts.serviceSettle, 2);
    await client.shutdown();
    assert.equal(await physical.close(), true);
    assert.equal(await timeout(witnesses[0]!.exit), 0);
    assert.equal(counts.release, 1); assert.ok(counts.stop >= 1 && counts.stop <= 4);
    assert.equal(sentinel.exitCode, null);
    passed = true;
  } catch (error) { errors.push(error); }
  finally {
    try { await client.shutdown(); } catch (error) { errors.push(error); }
    try { assert.equal(await physical.close(), true); } catch (error) { errors.push(error); }
    try { await timeout(Promise.all(witnesses.map(value => value.exit)), 10000); }
    catch (error) { errors.push(error); }
    cleanup = errors.length === 0;
    // These are only witness processes launched by this gate. Original native cleanup remains mandatory.
    for (const child of observedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (!passed || !cleanup) throw new AggregateError(errors, `TEST ${provider} Windows provider fixture incomplete`);
  return { provider, wrapper: provider === 'codex' ? 'npm-node' : 'opaque-cmd', pins: selected.pins,
    counts, nativeReady: true, inputCompleted: true, registeredServices: 2,
    scopedStops: 2, neighborSurvivedPrimary: true, providerSurvivedScopedStops: true, cleanup };
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
  const sentinel = spawn(paths[1]!, ['sentinel'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<number | null>((resolveExit, reject) => { sentinel.once('exit', resolveExit); sentinel.once('error', reject); });
  void exited.catch(() => undefined);
  const providers: unknown[] = [], wrappers: string[] = [], sourceScenarios: Record<string, unknown>[] = [];
  let complete = false, cleanup = false, failure: unknown;
  try {
    await timeout(new Promise<void>((resolveReady, reject) => { sentinel.stdout!.once('data', () => resolveReady()); sentinel.once('error', reject); }));
    if (sourceProvider === undefined) {
      wrappers.push(...await nativeLauncherScenarios(realpathSync(sandbox), paths[0]!, paths[1]!));
      for (const provider of ['codex', 'opencode'] as const)
        providers.push(await providerScenario(realpathSync(sandbox), paths[2]!, paths[1]!, provider, sentinel));
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
      pins, ...(sourceProvider === undefined ? { wrappers, providers } : { provider: sourceProvider, sourceScenarios }),
      cleanup, realProviderExecuted: false, desktopQualified: false,
      releaseQualified: false }, null, 2) + '\n', { flag: 'wx' });
  }
  if (failure) throw failure;
  assert.ok(complete && cleanup);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
