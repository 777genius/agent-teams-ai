/** TEST original Host loss after owner installation, before the one physical Resume. */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileRuntimeStore } from '../../packages/legacy-agent-host/dist/adapters/runtime/FileRuntimeStore.js';
import { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { captureMainWindowsCustody } from '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';
import { HostClientError } from '../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import { fileHash, prepareEmulatedProfile } from './nativeEmulatedProfile';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';

import type { ChildProcess } from 'node:child_process';
import type { HostCustodyOwner, HostCustodyPort } from '@agent-teams/legacy-agent-host/owned-process';
import type { JsonValue } from '../../packages/legacy-agent-host/dist/contracts.js';
import type { RuntimeSessionRecord } from '../../packages/legacy-agent-host/dist/runtime/contracts.js';

type Row = Record<string, unknown>;
type AttachmentContext = Parameters<HostCustodyOwner['attach']>[0];
type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;
interface Attachment {
  context: AttachmentContext;
  original: HostCustodyPort;
  proof: Row;
}
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
function journal(path: string): Row[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096);
  const raw = readFileSync(path, 'utf8'); if (!raw) return [];
  assert.ok(raw.endsWith('\n'));
  return raw.trimEnd().split('\n').map(line => object(JSON.parse(line)));
}
function durable(record: RuntimeSessionRecord): Row {
  return { binding: { ...record.binding }, profileId: record.profileId,
    hostIncarnation: record.hostIncarnation, openFingerprint: record.openFingerprint,
    phase: record.phase, custody: record.custody, sealed: record.sealed, nativeReady: record.nativeReady,
    inputs: record.inputs.length, interactions: record.interactions.length };
}

/** Physical cleanup stays with the original Main; the replacement Host retains UNKNOWN history. */
export async function nativeEmulatedOwnerLossScenario(sandbox: string, broker: string, actor: string,
  sentinel: ChildProcess, evidence: Row): Promise<void> {
  assert.equal(process.platform, 'win32');
  assert.equal(evidence.status, 'INCOMPLETE'); assert.equal(evidence.stage, 'not-started');
  const stage = (value: string) => { evidence.stage = value; };
  const events = createNativeGateEvents(), observedChildren: ChildProcess[] = [];
  const clients: CapturedHostClient[] = [], attachments: Attachment[] = [];
  const counts = { allocated: 0, prepared: 0, resumeRequests: 0, resumeCompleted: 0, writeCompleted: 0 };
  const intents = { original: 0, identicalReplay: 0, reconcile: 0, numericPidProbe: 0 };
  const forwarded: string[] = [];
  const negatives: Row = {}, states: Row = {}, cleanup: Row = { mainCloseConfirmed: false, originalHandleAbsent: false };
  const barrier: Row = { reached: false, pendingBeforeCrash: false, originalAttachmentCurrent: false,
    crashMarkers: 0, originalHostExited: false, callbackSettled: false };
  Object.assign(evidence, { stage: 'capture', sourceHead: process.env.HOST_PROCESS_SOURCE_HEAD,
    counts, openIntents: intents, negatives, states, barrier, physical: cleanup, hosts: [] });
  let resolveBarrier!: () => void, releaseHold!: () => void, finishHold!: () => void;
  const reached = new Promise<void>(done => { resolveBarrier = done; });
  const hold = new Promise<void>(done => { releaseHold = done; });
  const holdFinished = new Promise<void>(done => { finishHold = done; });
  const lostBeforeResume = new Error('TEST original Host lost before physical Resume');
  const errors: unknown[] = [];
  let physical: ReturnType<typeof captureMainWindowsCustody> = undefined;
  let witness: Witness | undefined;
  let capability: string | undefined, root: { pid: number; birth: string } | undefined;
  let held = false, complete = false;
  let pins: { path: string; sha256: string }[] = [];
  let readFinal: (() => RuntimeSessionRecord) | undefined;
  let originalRecord: RuntimeSessionRecord | undefined;
  let effects: (() => Row[]) | undefined;
  let assertFinalCounts: (() => void) | undefined;
  try {
    const selectedSandbox = join(sandbox, 'TEST-owner-loss'); mkdirSync(selectedSandbox);
    const selected = await prepareEmulatedProfile(realpathSync(selectedSandbox), broker, actor,
      'codex', undefined, 'owner-loss-before-resume');
    assert.ok(selected.crash && selected.hostBirths);
    const crash = selected.crash, births = selected.hostBirths;
    const ownSources = [
      './nativeEmulatedOwnerLossScenario.ts', './nativeEmulatedProfile.ts', './nativeEmulatedProviderGate.ts',
      './nativeGateContext.ts', './nativeGateEvents.ts',
      '../../src/features/agent-backend/main/infrastructure/CapturedHostClient.ts',
      '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts',
      '../../src/features/agent-backend/main/infrastructure/selectedHostProfile.ts',
      '../../packages/legacy-agent-host/src/adapters/runtime/FileRuntimeStore.ts',
      '../../packages/legacy-agent-host/dist/adapters/runtime/FileRuntimeStore.js',
      '../../packages/legacy-agent-host/src/runtime/prepareSessionOpen.ts',
      '../../packages/legacy-agent-host/src/runtime/RuntimeOwner.ts',
      '../../packages/legacy-agent-host/src/adapters/providers/WindowsCapturedProcess.ts',
      '../../packages/legacy-agent-host/src/owned-process/HostWindowsLaunch.ts',
      '../../packages/legacy-agent-host/src/owned-process/RetainedWindowsCustody.ts',
      '../../packages/legacy-agent-host/src/owned-process/hostCustody.ts',
    ].map(path => realpathSync(fileURLToPath(new URL(path, import.meta.url))));
    pins = [...new Set([...selected.pathPins.map(pin => pin.path), broker, actor, ...ownSources])]
      .map(path => ({ path, sha256: fileHash(path) }));
    evidence.pins = pins; evidence.profilePins = selected.pins;
    evidence.budgets = { startupMs: selected.host.startupTimeoutMs, requestMs: selected.host.requestTimeoutMs,
      writeMs: selected.host.writeTimeoutMs, profileShutdownMs: selected.host.shutdownTimeoutMs };
    effects = () => journal(selected.effects);
    assert.equal(effects().length, 0); assert.equal(journal(births).length, 0);
    const team = selected.profile.teams[0]!, delivery = team.members[0]!.delivery;
    assert.ok(delivery);
    const binding = { backendId: delivery.backendId, teamId: delivery.teamId, runId: delivery.runId,
      memberId: delivery.memberId, generation: delivery.generation };
    const store = new FileRuntimeStore(selected.profile.owner.storageRoot);
    const read = () => {
      const record = store.fenced(binding, transaction => transaction.get()); assert.ok(record);
      assert.deepEqual(record.binding, binding); assert.equal(record.profileId, selected.profile.owner.profileId);
      assert.match(record.openFingerprint ?? '', /^[a-f0-9]{64}$/);
      assert.ok(record.hostIncarnation.length > 0);
      assert.equal(record.inputs.length, 0); assert.equal(record.interactions.length, 0);
      return record;
    };
    readFinal = read;
    const owner = captureMainWindowsCustody(selected.host); assert.ok(owner); physical = owner;
    evidence.mainEpoch = owner.mainEpoch;
    const observed: HostCustodyOwner = { mainEpoch: owner.mainEpoch, attach(context) {
      assert.ok(attachments.length < 2, 'Only the two captured Host epochs');
      const original = owner.attach(context);
      const attachment: Attachment = { context, original, proof: { ...context.binding, profileId: context.profileId } };
      attachments.push(attachment);
      return { ...original, async handle(call) {
        try {
          if (call.operation === 'resume') {
            counts.resumeRequests++;
            assert.equal(attachments[0], attachment); assert.equal(held, false);
            assert.equal(context.signal.aborted, false); assert.equal(counts.allocated, 1); assert.equal(counts.prepared, 1);
            assert.ok(root && witness && capability); assert.equal(call.capability, capability);
            held = true;
            Object.assign(barrier, { reached: true, capability, root: { ...root }, attachment: { ...context.binding } });
            resolveBarrier();
            try { await hold; } finally { barrier.callbackSettled = true; finishHold(); }
            throw lostBeforeResume;
          }
          forwarded.push(call.operation);
          const result = await original.handle(call);
          if (result.operation === 'allocate') {
            assert.equal(call.operation, 'allocate'); assert.equal(capability, undefined);
            capability = call.capability; counts.allocated++;
            evidence.capability = capability;
          }
          if (result.operation === 'prepare') {
            assert.equal(call.operation, 'prepare'); assert.equal(call.capability, capability);
            assert.equal(root, undefined); root = { ...result.root }; counts.prepared++;
            evidence.root = root;
            witness = await capturedQueryableWitness(actor, root.pid, root.birth,
              child => observedChildren.push(child), events, 'query-wait-gated');
            cleanup.witnessCaptured = true;
          }
          if (result.operation === 'resume') counts.resumeCompleted++;
          if (result.operation === 'write') counts.writeCompleted++;
          return result;
        } catch (error) {
          if (error !== lostBeforeResume) events.guard(() => { throw error; })();
          throw error;
        }
      } };
    } };
    const envelope = (commandId: string, payload: JsonValue): JsonValue => ({ commandId,
      binding: { schemaVersion: 1, handleId: 'TEST-emulated-owner-loss', owner: selected.profile.owner,
        scope: team.scope }, payload });
    const rpc = async (client: CapturedHostClient, method: string, commandId: string, payload: JsonValue) =>
      object(await client.request(method, envelope(commandId, payload), { control: method !== 'runtime.open' }));
    const value = (response: Row) => { assert.equal(response.ok, true); return object(response.value); };
    const rememberHost = (index: number, hello: Awaited<ReturnType<CapturedHostClient['start']>>) => {
      const attachment = attachments[index]; assert.ok(attachment); assert.equal(attachments.length, index + 1);
      assert.equal(attachment.context.binding.mainEpoch, owner.mainEpoch);
      assert.equal(attachment.context.binding.hostIncarnation, hello.hostIncarnation);
      assert.equal(attachment.context.profileId, selected.host.profileId);
      const rows = journal(births); assert.equal(rows.length, index + 1);
      const birth = rows[index]!; assert.deepEqual(Object.keys(birth).sort(), ['parentPid', 'pid']);
      assert.ok(Number.isSafeInteger(birth.pid) && Number(birth.pid) > 0); assert.equal(birth.parentPid, process.pid);
      Object.assign(attachment.proof, { epoch: index === 0 ? 'A' : 'B', helloHostIncarnation: hello.hostIncarnation,
        capturedChild: birth, exited: false });
      evidence.hosts = attachments.map(item => item.proof);
      return attachment;
    };
    const assertNoNativeInput = () => {
      assert.equal(counts.allocated, 1); assert.equal(counts.prepared, 1); assert.equal(counts.resumeRequests, 1);
      assert.equal(forwarded.includes('resume'), false); assert.equal(counts.resumeCompleted, 0);
      assert.equal(forwarded.includes('write'), false); assert.equal(counts.writeCompleted, 0);
      assert.equal(effects!().length, 0); assert.equal(sentinel.exitCode, null);
    };
    assertFinalCounts = assertNoNativeInput;
    const assertUnknown = (snapshot: Row) => {
      assert.equal(snapshot.memberId, binding.memberId); assert.equal(snapshot.generation, binding.generation);
      assert.equal(snapshot.custody, 'unknown'); assert.equal(snapshot.nativeReady, false); assert.equal(snapshot.attached, false);
      assert.ok(Array.isArray(snapshot.inputs) && snapshot.inputs.length === 0);
    };
    const assertProvenance = (record: RuntimeSessionRecord) => {
      assert.ok(originalRecord); assert.deepEqual(record.binding, originalRecord.binding);
      assert.equal(record.openFingerprint, originalRecord.openFingerprint);
      assert.equal(record.hostIncarnation, originalRecord.hostIncarnation);
      assert.equal(record.custody, 'unknown'); assert.equal(record.nativeReady, false);
    };
    stage('Host-A-open');
    const a = new CapturedHostClient(selected.host, observed); clients.push(a);
    const aHello = await a.start(), aAttachment = rememberHost(0, aHello);
    let openingPending = true;
    intents.original++;
    const opening = rpc(a, 'runtime.open', 'TEST-open', { memberId: binding.memberId }).then(
      response => { openingPending = false; return { state: 'fulfilled' as const, response }; },
      (error: unknown) => { openingPending = false; return { state: 'rejected' as const, error }; });
    await timeout(events.wait(reached));
    stage('completed-install-before-physical-Resume');
    assert.ok(witness && capability && root); assertNoNativeInput();
    originalRecord = read(); assert.equal(originalRecord.phase, 'opening'); assert.equal(originalRecord.custody, 'unknown');
    assert.equal(originalRecord.nativeReady, false); states.beforeLoss = durable(originalRecord);
    assert.equal(await witness.observe(), 'alive'); cleanup.originalHandleAliveBeforeLoss = true;
    assert.equal(openingPending, true); assert.equal(aAttachment.context.signal.aborted, false);
    barrier.pendingBeforeCrash = openingPending; barrier.originalAttachmentCurrent = !aAttachment.context.signal.aborted;
    writeFileSync(crash, 'TEST-original-host-loss\n', { flag: 'wx' }); barrier.crashMarkers = 1;
    await timeout(events.wait(aAttachment.context.hostExited));
    assert.equal(aAttachment.context.signal.aborted, true); aAttachment.proof.exited = true; barrier.originalHostExited = true;
    const outcome = await opening; assert.equal(outcome.state, 'rejected');
    if (outcome.state !== 'rejected') assert.fail('Original open unexpectedly completed');
    assert.ok(outcome.error instanceof HostClientError);
    assert.equal(outcome.error.code, 'transport-closed'); assert.equal(outcome.error.outcome, 'unknown');
    evidence.openFailure = { code: outcome.error.code, outcome: outcome.error.outcome };
    releaseHold(); await timeout(holdFinished);
    unlinkSync(crash);
    assert.equal(await witness.observe(), 'alive'); cleanup.originalHandleAliveAfterLoss = true;
    assertNoNativeInput();
    stage('Host-B-cold-read-and-reconcile');
    const b = new CapturedHostClient(selected.host, observed); clients.push(b);
    const bHello = await b.start(), bAttachment = rememberHost(1, bHello);
    assert.notEqual(bHello.hostIncarnation, aHello.hostIncarnation);
    assert.equal(bAttachment.context.binding.profileDigest, aAttachment.context.binding.profileDigest);
    const coldRead = value(await rpc(b, 'runtime.read', 'TEST-owner-loss-read', { memberId: binding.memberId }));
    assertUnknown(coldRead); states.coldRead = coldRead;
    intents.reconcile++;
    const reconciled = value(await rpc(b, 'runtime.reconcile', 'TEST-owner-loss-reconcile', { memberId: binding.memberId }));
    assertUnknown(reconciled); assert.equal(reconciled.phase, 'held'); states.reconciled = reconciled;
    const retained = read(); assertProvenance(retained); assert.equal(retained.phase, 'held'); states.retained = durable(retained);
    assertNoNativeInput();
    stage('identical-open-no-replay');
    intents.identicalReplay++;
    const replay = value(await rpc(b, 'runtime.open', 'TEST-open', { memberId: binding.memberId }));
    assertUnknown(replay); assert.equal(replay.phase, 'held'); states.replay = replay;
    assertProvenance(read()); assertNoNativeInput();
    stage('old-capability-and-pid-refusals');
    for (const [name, attachment] of [['stale', aAttachment], ['successor', bAttachment]] as const) {
      for (const operation of ['resume', 'write'] as const) {
        const call = operation === 'resume' ? { operation, capability } : {
          operation, capability, bytes: Buffer.from('TEST-no-replay').toString('base64') };
        await assert.rejects(Promise.resolve().then(() => attachment.original.handle(call)), /Original native custody unavailable/);
        negatives[`${name}-${operation}`] = 'refused';
      }
    }
    intents.numericPidProbe++;
    const pidRefusal = await rpc(b, 'runtime.open', 'TEST-owner-loss-pid', { memberId: binding.memberId, pid: root.pid });
    assert.deepEqual(pidRefusal, { ok: false, code: 'invalid', outcome: 'rejected' });
    negatives.numericPid = pidRefusal; assertNoNativeInput();
    assert.equal(await witness.observe(), 'alive'); cleanup.originalHandleAliveAfterRefusals = true;
    complete = true;
  } catch (error) { errors.push(error); }
  finally {
    releaseHold();
    if (held) try { await timeout(holdFinished); } catch (error) { errors.push(error); }
    for (const [index, client] of clients.entries()) try {
      const result = await client.shutdown();
      assert.equal(result.childExit, 'confirmed'); assert.equal(result.providerCustody, 'unresolved');
      if (attachments[index]) Object.assign(attachments[index]!.proof, { shutdown: result, exited: true });
    } catch (error) { errors.push(error); }
    if (physical) try { cleanup.mainCloseConfirmed = await physical.close(); assert.equal(cleanup.mainCloseConfirmed, true); }
    catch (error) { errors.push(error); }
    if (witness) try { assert.equal(await witness.wait(), 0); cleanup.originalHandleAbsent = true; }
    catch (error) { errors.push(error); }
    if (readFinal && originalRecord) try {
      const final = readFinal(); states.afterCleanup = durable(final);
      assert.deepEqual(final.binding, originalRecord.binding); assert.equal(final.openFingerprint, originalRecord.openFingerprint);
      assert.equal(final.hostIncarnation, originalRecord.hostIncarnation);
      assert.equal(final.custody, 'unknown'); assert.equal(final.nativeReady, false);
      if (complete) assert.equal(final.phase, 'held');
    } catch (error) { errors.push(error); }
    try {
      await events.wait(Promise.resolve());
      if (complete) { assert.ok(assertFinalCounts); assertFinalCounts(); }
      if (effects) { evidence.peerJournalRows = effects().length; assert.equal(evidence.peerJournalRows, 0); }
      for (const pin of pins) assert.equal(fileHash(pin.path), pin.sha256);
      evidence.pinsUnchanged = pins.length > 0; assert.equal(sentinel.exitCode, null); cleanup.sentinelSurvived = true;
    } catch (error) { errors.push(error); }
    Object.assign(counts, { resumeForwarded: forwarded.filter(operation => operation === 'resume').length,
      writeForwarded: forwarded.filter(operation => operation === 'write').length });
    evidence.hosts = attachments.map(item => item.proof);
    evidence.cleanup = errors.length === 0 && cleanup.mainCloseConfirmed === true && cleanup.originalHandleAbsent === true;
    // Only gate-owned witnesses use this fallback after mandatory native cleanup attempts.
    for (const child of observedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (!complete || !evidence.cleanup || errors.length)
    throw new AggregateError(errors, 'TEST completed-install owner loss incomplete');
  assert.equal(attachments.length, 2);
  evidence.status = 'PASS'; stage('complete');
}
