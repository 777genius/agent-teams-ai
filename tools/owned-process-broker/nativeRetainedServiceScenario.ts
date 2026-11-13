/** TEST ordinary Team MCP registration/natural exit/cold purge through one retained Main owner. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { JsonValue } from '../../packages/legacy-agent-host/dist/contracts.js';
import type { ProcessCommandReceipt } from '../../packages/legacy-agent-host/dist/process/registeredProcessContracts.js';
import { validateProcessReceipt } from '../../packages/legacy-agent-host/dist/process/validateProcessRecords.js';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import type { HostCustodyCall, HostCustodyResult } from '@agent-teams/legacy-agent-host/owned-process';
import type { WindowsServiceCapture, WindowsServiceIntent } from '../../packages/legacy-agent-host/dist/owned-process/retainedServiceContracts.js';
import { PROCESS_BOOTSTRAP, PROCESS_REGISTER_ID, PROCESS_LABEL, startProcessModel,
  type Service } from '../../scripts/legacy-agent-host/desktop-native-process-model.ts';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import type { NativeGateEvents } from './nativeGateEvents';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const remaining = (deadline: number) => {
  const milliseconds = Math.floor(deadline - performance.now());
  assert.ok(milliseconds > 0, 'Original native scenario deadline');
  return milliseconds;
};
const json = (path: string) => {
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 0 && bytes.length <= 65536, 'Bounded original TEST record');
  return object(JSON.parse(bytes.toString('utf8')));
};
type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;

export async function prepareNativeRetainedServiceScenario(options: {
  sandbox: string; fixture: string; track(child: ChildProcess): void; events: NativeGateEvents;
}) {
  const root = join(realpathSync.native(options.sandbox), 'TEST-desktop-backend-natural-' + randomUUID());
  mkdirSync(root); mkdirSync(join(root, 'workspace'));
  const roles = { primary: { nonce: 'TEST-' + randomUUID() }, neighbor: { nonce: 'TEST-' + randomUUID() } };
  const seed = { schemaVersion: 1, node: realpathSync.native(process.execPath), roles,
    ttlMs: 300000, primaryCompletion: 'natural-request' };
  const seedPath = join(root, 'process-ui-seed.json');
  const seedBytes = Buffer.from(JSON.stringify(seed));
  writeFileSync(seedPath, seedBytes, { flag: 'wx' });
  const actorSource = new URL('../../scripts/legacy-agent-host/fixtures/process-foreground-service.ts', import.meta.url);
  const actorBytes = readFileSync(actorSource), actor = join(root, 'workspace/process-foreground-service.ts');
  writeFileSync(actor, actorBytes, { flag: 'wx' });
  const readServices = async (): Promise<{ primary: Service; neighbor: Service }> => {
    const read = (role: 'primary' | 'neighbor'): Service => {
      const value = json(join(root, 'workspace/process-' + role + '.json'));
      assert.deepEqual(Object.keys(value).sort(), ['nonce', 'pid', 'port', 'role', 'url']);
      assert.equal(value.role, role); assert.equal(value.nonce, roles[role].nonce);
      assert.ok(typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 1);
      assert.ok(typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535);
      assert.equal(value.url, 'http://127.0.0.1:' + value.port + '/' + roles[role].nonce);
      return { role, nonce: roles[role].nonce, pid: value.pid, port: value.port, url: String(value.url) };
    };
    const primary = read('primary'), neighbor = read('neighbor');
    assert.notEqual(primary.pid, neighbor.pid);
    return { primary, neighbor };
  };
  const lifecycle = async (role: 'primary' | 'neighbor') => {
    const bytes = readFileSync(join(root, 'workspace/process-' + role + '-lifecycle.ndjson'));
    assert.ok(bytes.length <= 16384);
    const lines = bytes.toString('utf8').trim().split('\n');
    assert.ok(lines.length <= 3);
    return lines.map(line => object(JSON.parse(line)));
  };
  let cleanupRequested = false, cleanupDeadline = 0, wholeConfirmed = false, released = false;
  let confirmWhole!: () => void;
  const whole = new Promise<void>(resolve => { confirmWhole = resolve; });
  const model = await startProcessModel({
    bashCommand: () => quote(seed.node) + ' ' + quote(actor) + ' ' + quote(root),
    services: readServices, serviceLifecycle: lifecycle,
    windowsNaturalServices: {
      async originalWholeCleanup() {
        assert.ok(cleanupRequested, 'Neighbor completion cannot precede original Human Trash');
        await timeout(whole, Math.min(10000, remaining(cleanupDeadline)));
        assert.equal(wholeConfirmed, true);
      },
    },
  });
  let allocation: Extract<HostCustodyCall, { operation: 'allocate' }> | undefined;
  let providerRoot: Extract<HostCustodyResult, { operation: 'prepare' }>['root'] | undefined;
  let capture: WindowsServiceCapture | undefined, captureIntent: WindowsServiceIntent | undefined;
  let primaryWitness: Witness | undefined, successor: CapturedHostClient | undefined;
  const serviceCounts = { capture: 0, stop: 0, query: 0, settle: 0, lookup: 0, coldQuery: 0, coldSettle: 0 };
  const proof = {
    registryQualified: false, initialRegisterConservative: false,
    liveListBeforeNatural: false, naturalPrimaryAbsent: false, primaryNativeCompletion: false,
    providerAliveBeforeTrash: false, neighborAliveBeforeTrash: false,
    sameMainHostRebind: false, coldPurgeCompleted: false, originalScopeSettled: false,
    secondHostNativeAllocations: 0, secondHostInputWrites: 0,
    neighborIndependentHandle: false, durableFieldsQualifiedByThisGate: false,
  };
  let phase = 'prepared';
  const observeCustody = async (call: HostCustodyCall, value: HostCustodyResult, epoch: number) => {
    if (epoch === 2) {
      if (call.operation === 'allocate') proof.secondHostNativeAllocations++;
      if (call.operation === 'write') proof.secondHostInputWrites++;
      assert.ok(!['allocate', 'launch-chunk', 'launch-commit', 'prepare', 'resume', 'write', 'end',
        'service-capture', 'service-stop'].includes(call.operation), 'Cold epoch has original cleanup/read authority only');
    }
    if (call.operation === 'allocate') {
      assert.equal(allocation, undefined); allocation = structuredClone(call);
    }
    if (value.operation === 'prepare') {
      assert.equal(providerRoot, undefined); providerRoot = structuredClone(value.root);
    }
    if (call.operation === 'service-capture') {
      serviceCounts.capture++;
      assert.equal(serviceCounts.capture, 1); assert.equal(epoch, 1);
      assert.equal(value.operation, 'service-capture');
      if (value.operation !== 'service-capture') throw new Error('Original service capture reply mismatch');
      assert.equal(value.outcome.state, 'captured');
      if (value.outcome.state !== 'captured') throw new Error('Original service capture unavailable');
      assert.ok(allocation && providerRoot);
      capture = structuredClone(value.outcome.capture); captureIntent = structuredClone(call.intent);
      assert.equal(capture.providerCapability, allocation.capability);
      assert.equal(capture.providerGeneration, allocation.owner.processGeneration);
      assert.deepEqual(capture.root, providerRoot);
      const services = await readServices();
      assert.equal(capture.target.pid, services.primary.pid);
      primaryWitness = await capturedQueryableWitness(options.fixture, capture.target.pid,
        capture.target.birth, options.track, options.events);
    }
    if (call.operation === 'service-stop') {
      serviceCounts.stop++; throw new Error('Natural service proof cannot synthesize Stop');
    }
    if (call.operation === 'service-query') {
      serviceCounts.query++; if (epoch === 2) serviceCounts.coldQuery++;
      assert.ok(capture); assert.deepEqual(call.capture, capture);
      assert.equal(value.operation, 'service-query');
      if (value.operation === 'service-query') {
        assert.equal(value.outcome.state, 'observed');
        if (value.outcome.state === 'observed') assert.deepEqual(value.outcome.capture, capture);
      }
    }
    if (call.operation === 'service-settle' || call.operation === 'service-lookup') {
      if (call.operation === 'service-settle') { serviceCounts.settle++; if (epoch === 2) serviceCounts.coldSettle++; }
      else serviceCounts.lookup++;
      assert.ok(capture && call.intent.command.operation === 'settle');
      assert.deepEqual(call.intent.command.capture, capture);
      assert.equal(epoch, 2, 'Settlement belongs to explicit cold purge');
      assert.ok('outcome' in value && value.outcome.state === 'settled');
      if ('outcome' in value && value.outcome.state === 'settled') {
        assert.deepEqual(value.outcome.capture, capture); proof.originalScopeSettled = true;
      }
    }
    if (cleanupRequested && call.operation === 'stop' && value.operation === 'stop' && value.state === 'confirmed') {
      assert.ok(cleanupRequested && allocation && capture);
      assert.equal(call.capability, allocation.capability);
      assert.equal(value.receipt?.coverage, 'job-membership');
      assert.equal(value.receipt?.rootExited, true);
      assert.deepEqual(value.receipt?.owner, allocation.owner);
      wholeConfirmed = true; confirmWhole();
    }
    if (cleanupRequested && call.operation === 'release' && value.operation === 'release' && value.state === 'released') {
      assert.ok(wholeConfirmed && allocation);
      assert.equal(call.capability, allocation.capability); released = true;
    }
    assert.ok(Object.values(serviceCounts).every(value => value <= 64), 'Bounded original service observations');
  };
  const probe = async (service: Service, deadline: number) => {
    const response = await fetch(service.url, {
      signal: AbortSignal.timeout(Math.min(2000, remaining(deadline))), redirect: 'error',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { role: service.role, nonce: service.nonce, pid: service.pid });
  };
  async function run(options: {
    client: CapturedHostClient; profile: TeamHostProfile; mainEpoch: string;
    providerWitness: Witness; originalHostExit(): Promise<void>;
    createSuccessor(): CapturedHostClient;
  }) {
    const team = options.profile.teams[0]!;
    const request = async (client: CapturedHostClient, method: string, commandId: string,
      payload: JsonValue, deadline = performance.now() + 45000): Promise<unknown> => {
      const result = object(await timeout(client.request(method, {
        commandId, binding: { schemaVersion: 1, handleId: 'TEST-natural-process',
          owner: options.profile.owner, scope: team.scope }, payload,
      }, { control: ['runtime.read', 'team.process.list', 'team.lifecycle.read'].includes(method) }),
      remaining(deadline)));
      assert.equal(result.ok, true, 'Original natural-service Host route succeeded');
      return result.value;
    };
    phase = 'native-bootstrap';
    const input = object(await request(options.client, 'team.execute', 'TEST-native-process-bootstrap', {
      operation: 'message.send', payload: { to: 'alice', text: PROCESS_BOOTSTRAP,
        messageId: 'TEST-native-process-bootstrap', actionMode: 'do' },
    }));
    const inputId = object(input.effects).deliveryId; assert.equal(typeof inputId, 'string');
    const turnDeadline = performance.now() + 35000;
    for (;;) {
      assert.deepEqual(model.failures, []);
      const state = object(await request(options.client, 'runtime.read', 'TEST-native-process-terminal',
        { memberId: 'alice-id' }, turnDeadline));
      assert.ok(Array.isArray(state.inputs));
      const original = state.inputs.map(object).find(value => value.inputId === inputId);
      if (original?.phase === 'terminal') { assert.equal(original.terminal, 'succeeded'); break; }
      await delay(Math.min(25, remaining(turnDeadline)));
    }
    assert.deepEqual(model.observations.map(value => [value.turn, value.step]),
      [[PROCESS_BOOTSTRAP, 0], [PROCESS_BOOTSTRAP, 1], [PROCESS_BOOTSTRAP, 2], [PROCESS_BOOTSTRAP, 3]]);
    assert.equal(model.probes.length, 0);
    assert.ok(capture && captureIntent && primaryWitness);
    assert.equal(capture.mainEpoch, options.mainEpoch);
    const originalReceipt = validateProcessReceipt(json(join(options.profile.owner.storageRoot,
      'teams', team.binding.teamName, '.host-owner', 'commands', digest(PROCESS_REGISTER_ID) + '.json')) as unknown as ProcessCommandReceipt, digest);
    assert.equal(originalReceipt.commandId, PROCESS_REGISTER_ID);
    assert.equal(originalReceipt.principalId, 'alice-session');
    assert.equal(originalReceipt.operation, 'register'); assert.equal(originalReceipt.phase, 'completed');
    assert.deepEqual(originalReceipt.capture, capture);
    assert.deepEqual(originalReceipt.nativeIntent, captureIntent);
    assert.equal(originalReceipt.nativeAbsence, undefined);
    const initial = object(originalReceipt.result);
    assert.equal(initial.observation, 'unknown'); assert.equal(initial.canTerminate, false);
    proof.initialRegisterConservative = true; proof.registryQualified = true;
    const processDeadline = performance.now() + 10000;
    const live = await request(options.client, 'team.process.list', 'TEST-original-process-live', {}, processDeadline);
    assert.ok(Array.isArray(live) && live.length === 1);
    const selected = object(live[0]);
    assert.equal(selected.label, PROCESS_LABEL); assert.equal(selected.pid, capture.target.pid);
    assert.equal(selected.processRef, initial.processRef);
    assert.equal(selected.observation, 'same-live'); assert.equal(selected.canTerminate, true);
    proof.liveListBeforeNatural = true;
    assert.equal(await timeout(primaryWitness.observe(), remaining(processDeadline)), 'alive');
    assert.equal(await timeout(options.providerWitness.observe(), remaining(processDeadline)), 'alive');
    const services = await readServices();
    phase = 'natural-primary';
    await probe(services.primary, processDeadline); // Its sole nonce response triggers normal close; no signal.
    for (;;) {
      assert.deepEqual(model.failures, []);
      if (model.notificationAcks.some(ack => ack.role === 'primary' && ack.responseFinished)) break;
      await delay(Math.min(25, remaining(processDeadline)));
    }
    assert.equal(model.notificationAcks.filter(ack => ack.role === 'primary').length, 1);
    const notification = model.notificationAcks.find(ack => ack.role === 'primary')!;
    assert.equal(notification.status, 'completed'); assert.equal(notification.exitReason, 'natural-request');
    proof.primaryNativeCompletion = true;
    assert.equal(await timeout(primaryWitness.observe(), remaining(processDeadline)), 'absent');
    assert.equal(await timeout(primaryWitness.wait(), remaining(processDeadline)), 0);
    const ended = await request(options.client, 'team.process.list', 'TEST-original-process-absent', {}, processDeadline);
    assert.ok(Array.isArray(ended) && ended.length === 1);
    assert.equal(object(ended[0]).processRef, initial.processRef);
    assert.equal(object(ended[0]).observation, 'absent'); assert.equal(object(ended[0]).canTerminate, false);
    proof.naturalPrimaryAbsent = true;
    assert.equal(await timeout(options.providerWitness.observe(), remaining(processDeadline)), 'alive');
    proof.providerAliveBeforeTrash = true;
    await probe(services.neighbor, processDeadline); proof.neighborAliveBeforeTrash = true;
    assert.equal(serviceCounts.stop, 0); assert.equal(serviceCounts.settle, 0);
    phase = 'legitimate-trash';
    const beforeTrash = object(await request(options.client, 'team.lifecycle.read', 'TEST-natural-before-trash', {}));
    cleanupDeadline = performance.now() + 45000; cleanupRequested = true;
    await request(options.client, 'team.lifecycle.change', 'TEST-natural-trash',
      { action: 'trash', expectedRevision: String(beforeTrash.revision) }, cleanupDeadline);
    const afterTrash = object(await request(options.client, 'team.lifecycle.read', 'TEST-natural-after-trash', {}, cleanupDeadline));
    assert.equal(afterTrash.cleanupPending, false); assert.equal(typeof afterTrash.deletedAt, 'string');
    assert.equal(wholeConfirmed, true); assert.equal(released, true);
    assert.equal((await options.client.shutdown()).childExit, 'confirmed');
    await timeout(options.originalHostExit(), 5000);
    assert.equal(await options.providerWitness.observe(), 'absent');
    phase = 'same-main-cold-purge';
    successor = options.createSuccessor();
    await successor.start(); proof.sameMainHostRebind = true;
    const cold = object(await request(successor, 'team.lifecycle.read', 'TEST-cold-natural-read', {}));
    assert.equal(cold.revision, afterTrash.revision); assert.equal(cold.cleanupPending, false);
    const purged = object(await request(successor, 'team.lifecycle.purge', 'TEST-cold-natural-purge',
      { expectedRevision: String(cold.revision) }));
    assert.equal(purged.phase, 'deleted'); assert.equal(typeof purged.transactionId, 'string');
    assert.equal(existsSync(join(options.profile.owner.storageRoot, 'teams', team.binding.teamName)), false);
    assert.equal(serviceCounts.capture, 1); assert.equal(serviceCounts.stop, 0);
    assert.ok(serviceCounts.coldQuery >= 1); assert.equal(serviceCounts.coldSettle, 1);
    assert.equal(proof.originalScopeSettled, true);
    assert.equal(proof.secondHostNativeAllocations, 0); assert.equal(proof.secondHostInputWrites, 0);
    assert.deepEqual(model.failures, []); assert.equal(model.observations.length, 4);
    assert.ok(model.notificationAcks.length >= 1 && model.notificationAcks.length <= 2);
    assert.ok(model.notificationAcks.every(ack => ack.responseFinished));
    assert.equal((await successor.shutdown()).childExit, 'confirmed');
    proof.coldPurgeCompleted = true;
    assert.equal(sha(readFileSync(seedPath)), sha(seedBytes));
    assert.equal(sha(readFileSync(actor)), sha(actorBytes));
    assert.equal(sha(readFileSync(actorSource)), sha(actorBytes));
    phase = 'completed';
  }
  return { model, observeCustody, run,
    phase: () => phase,
    evidence: () => ({ ...proof, serviceCounts: { ...serviceCounts }, wholeConfirmed, released,
      actorSha256: sha(actorBytes), nativeNotificationCount: model.notificationAcks.length }),
    closeHost: async () => { if (successor) await successor.shutdown(); },
    drain: async () => { if (primaryWitness) assert.equal(await primaryWitness.wait(), 0); },
  };
}
