/** TEST original Host loss at two closed boundaries; Main retains original HANDLE custody. */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
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
import type { WindowsServiceCapture } from '../../packages/legacy-agent-host/dist/owned-process/retainedServiceContracts.js';
import type { EmulatedOwnerLossMode } from './nativeEmulatedProfile';

type Row = Record<string, unknown>;
type Stage = 'capture' | 'Host-A-open' | 'one-original-business-input' |
  'completed-effects-before-runtime-completion' | 'completed-install-before-physical-resume' |
  'Host-B-cold-read-and-reconcile' | 'identical-command-no-replay' | 'old-capability-and-pid-refusals' | 'complete';
type AttachmentContext = Parameters<HostCustodyOwner['attach']>[0];
type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;
interface Attachment { context: AttachmentContext; original: HostCustodyPort; proof: Row }
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
    inputs: record.inputs.length, interactions: record.interactions.length,
    ...(record.inputs[0] ? { input: { intent: structuredClone(record.inputs[0].intent),
      fingerprint: record.inputs[0].fingerprint, operationRef: record.inputs[0].operationRef,
      phase: record.inputs[0].phase, ...(record.inputs[0].terminal ? { terminal: record.inputs[0].terminal } : {}) } } : {}) };
}
/** Only original complete NDJSON frames are observed; the one unfinished line stays bounded. */
function nativeFrames(limit: number) {
  let tail = Buffer.alloc(0);
  return (encoded: string): Row[] => {
    const bytes = Buffer.from(encoded, 'base64');
    assert.ok(bytes.length <= 16 * 1024 && bytes.toString('base64') === encoded);
    const joined = Buffer.concat([tail, bytes]), frames: Row[] = [];
    let start = 0;
    for (;;) {
      const end = joined.indexOf(10, start); if (end < 0) break;
      const line = joined.subarray(start, end); assert.ok(line.length > 0 && line.length <= limit);
      const text = line.toString('utf8'); assert.ok(Buffer.from(text).equals(line), 'Original UTF-8 frame');
      frames.push(object(JSON.parse(text))); start = end + 1;
    }
    tail = Buffer.from(joined.subarray(start)); assert.ok(tail.length <= limit);
    return frames;
  };
}

/** Both cold Hosts reuse the original storage/binding; neither case can restart out of UNKNOWN. */
export async function nativeEmulatedOwnerLossScenario(sandbox: string, broker: string, actor: string,
  sentinel: ChildProcess, mode: EmulatedOwnerLossMode, evidence: Row): Promise<void> {
  assert.equal(process.platform, 'win32');
  assert.ok(mode === 'owner-loss-before-resume' || mode === 'owner-loss-after-effect');
  const afterEffect = mode === 'owner-loss-after-effect';
  assert.equal(evidence.status, 'INCOMPLETE'); assert.equal(evidence.stage, 'not-started');
  assert.equal(evidence.scenario, afterEffect ? 'completed-effects-before-runtime-completion'
    : 'completed-install-before-physical-resume');
  const stage = (value: Stage) => { evidence.stage = value; };
  const events = createNativeGateEvents(), observedChildren: ChildProcess[] = [];
  const clients: CapturedHostClient[] = [], attachments: Attachment[] = [], witnesses: Witness[] = [];
  const captures: WindowsServiceCapture[] = [];
  const counts = { allocated: 0, prepared: 0, resumeRequests: 0, resumeCompleted: 0, writeCompleted: 0,
    serviceCapture: 0, serviceCaptureACKs: 0, businessInputs: 0, nativeTurnStarts: 0, completedEffects: 0, registeredRows: 0 };
  const intents = { original: 0, identicalReplay: 0, reconcile: 0, numericPidProbe: 0, commandLookup: 0, processList: 0 };
  const forwarded: string[] = [], negatives: Row = {}, states: Row = {};
  const cleanup: Row = { mainCloseConfirmed: false, originalHandleAbsent: false };
  const barrier: Row = { reached: false, pendingBeforeCrash: false, originalAttachmentCurrent: false,
    crashMarkers: 0, originalHostExited: false, callbackSettled: false, terminalForwarded: false };
  Object.assign(evidence, { stage: 'capture', sourceHead: process.env.HOST_PROCESS_SOURCE_HEAD,
    counts, openIntents: intents, negatives, states, barrier, physical: cleanup, hosts: [], captures,
    realProviderExecuted: false, desktopQualified: false, releaseQualified: false });
  let resolveBarrier!: () => void, releaseHold!: () => void, finishHold!: () => void, resolveTurnWrite!: () => void;
  const reached = new Promise<void>(done => { resolveBarrier = done; });
  const turnWriteFinished = new Promise<void>(done => { resolveTurnWrite = done; });
  const hold = new Promise<void>(done => { releaseHold = done; });
  const holdFinished = new Promise<void>(done => { finishHold = done; });
  const lost = new Error(afterEffect ? 'TEST original Host lost before Runtime terminal completion'
    : 'TEST original Host lost before physical Resume');
  const errors: unknown[] = [];
  let physical: ReturnType<typeof captureMainWindowsCustody> = undefined;
  let capability: string | undefined, providerGeneration: string | undefined;
  let root: { pid: number; birth: string } | undefined;
  let held = false, complete = false, inputCutoff: number | undefined, lossStarted = false;
  let crash: string | undefined, birthPath: string | undefined;
  let pins: { path: string; sha256: string }[] = [];
  let readFinal: (() => RuntimeSessionRecord) | undefined, originalRecord: RuntimeSessionRecord | undefined;
  let effects: (() => Row[]) | undefined, assertFinalCounts: (() => void) | undefined;
  let pendingOpen: Promise<{ state: 'fulfilled'; response: Row } | { state: 'rejected'; error: unknown }> | undefined;
  let nativeTurn: { requestId: string | number; threadId: string } | undefined;
  let nativeTurnReply: { requestId: string | number; turnId: string } | undefined;
  let completedCommand: Row | undefined, countsAtLoss: typeof counts | undefined;
  const deadline = () => {
    if (inputCutoff !== undefined && !lossStarted)
      assert.ok(performance.now() < inputCutoff, 'TEST original owner-loss input deadline');
  };
  const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
    deadline();
    const remaining = inputCutoff === undefined || lossStarted ? 10000 : Math.min(10000, inputCutoff - performance.now());
    assert.ok(remaining > 0, 'TEST original owner-loss observation deadline');
    const result = await timeout(events.wait(operation()), remaining); deadline(); return result;
  };
  const holdOriginal = async (attachment: Attachment, facts: Row): Promise<never> => {
    assert.equal(attachments[0], attachment); assert.equal(held, false);
    assert.equal(attachment.context.signal.aborted, false); assert.ok(root && capability && witnesses[0]);
    held = true;
    Object.assign(barrier, { reached: true, capability, root: { ...root },
      attachment: { ...attachment.context.binding }, ...facts });
    resolveBarrier();
    try {
      await hold; await attachment.context.hostExited;
      assert.equal(attachment.context.signal.aborted, true);
      throw lost;
    } finally { barrier.callbackSettled = true; finishHold(); }
  };
  try {
    const selectedSandbox = join(sandbox, afterEffect ? 'TEST-owner-loss-after-effect' : 'TEST-owner-loss');
    mkdirSync(selectedSandbox);
    const selected = await prepareEmulatedProfile(realpathSync(selectedSandbox), broker, actor, 'codex', undefined, mode);
    assert.ok(selected.crash && selected.hostBirths); crash = selected.crash; birthPath = selected.hostBirths;
    const ownSources = [
      './nativeEmulatedOwnerLossScenario.ts', './nativeEmulatedProfile.ts', './nativeEmulatedProviderGate.ts',
      './nativeGateContext.ts', './nativeGateEvents.ts',
      '../../src/features/agent-backend/main/infrastructure/CapturedHostClient.ts',
      '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts',
      '../../src/features/agent-backend/main/infrastructure/selectedHostProfile.ts',
      '../../packages/legacy-agent-host/src/adapters/runtime/FileRuntimeStore.ts',
      '../../packages/legacy-agent-host/dist/adapters/runtime/FileRuntimeStore.js',
      '../../packages/legacy-agent-host/src/runtime/contracts.ts',
      '../../packages/legacy-agent-host/src/runtime/prepareSessionOpen.ts',
      '../../packages/legacy-agent-host/src/runtime/RuntimeOwner.ts',
      '../../packages/legacy-agent-host/src/runtime/sessionState.ts',
      '../../packages/legacy-agent-host/src/composition/TeamHost.ts',
      '../../packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts',
      '../../packages/legacy-agent-host/src/index.ts',
      '../../packages/legacy-agent-host/src/composition/executeCapturedRuntimeControl.ts',
      '../../packages/legacy-agent-host/src/composition/projectRuntimeMember.ts',
      '../../packages/legacy-agent-host/src/team/executeTeamCommand.ts',
      '../../packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts',
      '../../packages/legacy-agent-host/src/adapters/providers/codexByteTransport.ts',
      '../../packages/legacy-agent-host/src/adapters/providers/WindowsCapturedProcess.ts',
      '../../packages/legacy-agent-host/src/owned-process/HostWindowsLaunch.ts',
      '../../packages/legacy-agent-host/src/owned-process/RetainedWindowsCustody.ts',
      '../../packages/legacy-agent-host/src/owned-process/RetainedWindowsServices.ts',
      '../../packages/legacy-agent-host/src/owned-process/retainedServiceContracts.ts',
      '../../packages/legacy-agent-host/src/owned-process/hostCustody.ts',
    ].map(path => realpathSync(fileURLToPath(new URL(path, import.meta.url))));
    pins = [...new Set([...selected.pathPins.map(pin => pin.path), broker, actor, ...ownSources])]
      .map(path => ({ path, sha256: fileHash(path) }));
    evidence.pins = pins; evidence.profilePins = selected.pins;
    evidence.budgets = { startupMs: selected.host.startupTimeoutMs, requestMs: selected.host.requestTimeoutMs,
      writeMs: selected.host.writeTimeoutMs, profileShutdownMs: selected.host.shutdownTimeoutMs, inputMs: 15000 };
    effects = () => journal(selected.effects);
    assert.equal(effects().length, 0); assert.equal(journal(birthPath).length, 0);
    const team = selected.profile.teams[0]!, delivery = team.members[0]!.delivery; assert.ok(delivery);
    const binding = { backendId: delivery.backendId, teamId: delivery.teamId, runId: delivery.runId,
      memberId: delivery.memberId, generation: delivery.generation };
    const store = new FileRuntimeStore(selected.profile.owner.storageRoot);
    const read = () => {
      deadline();
      const record = store.fenced(binding, transaction => transaction.get()); assert.ok(record);
      assert.deepEqual(record.binding, binding); assert.equal(record.profileId, selected.profile.owner.profileId);
      assert.match(record.openFingerprint ?? '', /^[a-f0-9]{64}$/); assert.ok(record.hostIncarnation.length > 0);
      assert.equal(record.interactions.length, 0); assert.equal(record.inputs.length, counts.businessInputs);
      deadline(); return record;
    };
    readFinal = read;
    const owner = captureMainWindowsCustody(selected.host); assert.ok(owner); physical = owner;
    evidence.mainEpoch = owner.mainEpoch;
    const output = nativeFrames(selected.profile.runtime!.members[0]!.limits.outputBytes);
    const input = nativeFrames(selected.profile.runtime!.members[0]!.limits.outputBytes);
    const observed: HostCustodyOwner = { mainEpoch: owner.mainEpoch, attach(context) {
      assert.ok(attachments.length < 2, 'Only the two captured Host epochs');
      const original = owner.attach(context);
      const attachment: Attachment = { context, original, proof: { ...context.binding, profileId: context.profileId } };
      attachments.push(attachment);
      return { ...original, async handle(call) {
        try {
          if (call.operation === 'resume') {
            counts.resumeRequests++;
            assert.equal(attachments[0], attachment); assert.equal(counts.allocated, 1); assert.equal(counts.prepared, 1);
            assert.equal(call.capability, capability);
            if (!afterEffect) return await holdOriginal(attachment, { operation: 'resume' });
          }
          // Observe the actual request identity before IO can reply, but count it only after the original write ACK.
          let completesTurn = false;
          if (afterEffect && call.operation === 'write') for (const frame of input(call.bytes)) {
            if (frame.method !== 'turn/start') continue;
            assert.equal(nativeTurn, undefined); assert.equal(counts.businessInputs, 1);
            const requestId = frame.id;
            assert.ok(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 256 ||
              typeof requestId === 'number' && Number.isSafeInteger(requestId));
            assert.equal(object(frame.params).threadId, 'TEST-thread');
            nativeTurn = { requestId, threadId: 'TEST-thread' }; completesTurn = true;
          }
          forwarded.push(call.operation);
          const result = await original.handle(call);
          if (result.operation === 'allocate') {
            assert.ok(call.operation === 'allocate'); assert.equal(capability, undefined);
            capability = call.capability; providerGeneration = call.owner.processGeneration;
            counts.allocated++; evidence.capability = capability; evidence.providerGeneration = providerGeneration;
            evidence.nativeOwner = { ...call.owner };
          }
          if (result.operation === 'prepare') {
            assert.equal(call.operation, 'prepare'); assert.equal(call.capability, capability);
            assert.equal(root, undefined); root = { ...result.root }; counts.prepared++; evidence.root = root;
            witnesses.push(await observe(() => capturedQueryableWitness(actor, result.root.pid, result.root.birth,
              child => observedChildren.push(child), events, 'query-wait-gated')));
            cleanup.witnessCaptured = true;
          }
          if (result.operation === 'resume') counts.resumeCompleted++;
          if (result.operation === 'service-capture') {
            assert.ok(afterEffect); assert.equal(result.outcome.state, 'captured');
            if (result.outcome.state !== 'captured') throw new Error('TEST original service capture unavailable');
            const capture = result.outcome.capture;
            assert.equal(captures.length < 2, true); assert.equal(capture.mainEpoch, owner.mainEpoch);
            assert.equal(capture.providerCapability, capability); assert.equal(capture.providerGeneration, providerGeneration);
            assert.deepEqual(capture.root, root);
            assert.deepEqual(capture.registrar, binding);
            assert.equal(captures.some(value => value.target.pid === capture.target.pid), false);
            captures.push(structuredClone(capture)); counts.serviceCapture++;
            witnesses.push(await observe(() => capturedQueryableWitness(actor, capture.target.pid, capture.target.birth,
              child => observedChildren.push(child), events, 'query-wait-gated')));
            counts.serviceCaptureACKs++;
          }
          if (result.operation === 'write') {
            assert.equal(call.operation, 'write'); counts.writeCompleted++;
            if (completesTurn) {
              assert.ok(nativeTurn); counts.nativeTurnStarts++; evidence.nativeTurn = { ...nativeTurn };
              resolveTurnWrite();
            }
          }
          if (afterEffect && call.operation === 'read' && call.stream === 'stdout' && result.operation === 'read') {
            const frames = output(result.bytes), completedMethods = new Set<string>(); let terminal: Row | undefined;
            for (const frame of frames) {
              if (nativeTurn && frame.id === nativeTurn.requestId) {
                assert.equal(nativeTurnReply, undefined); assert.equal(object(object(frame.result).turn).id, 'TEST-turn');
                nativeTurnReply = { requestId: nativeTurn.requestId, turnId: 'TEST-turn' };
                evidence.nativeTurnReply = nativeTurnReply;
              }
              if (frame.method !== 'item/completed' && frame.method !== 'turn/completed') continue;
              assert.equal(completedMethods.has(frame.method), false, 'No duplicate original completion');
              completedMethods.add(frame.method);
              const params = object(frame.params); assert.equal(params.threadId, 'TEST-thread');
              if (frame.method === 'item/completed') {
                assert.equal(params.turnId, 'TEST-turn'); assert.equal(object(params.item).id, 'TEST-message');
                assert.equal(object(params.item).type, 'agentMessage');
                assert.equal(object(params.item).text, 'TEST registered both services');
              } else {
                assert.equal(object(params.turn).id, 'TEST-turn'); assert.equal(object(params.turn).status, 'completed');
              }
              terminal ??= { method: frame.method, threadId: 'TEST-thread', turnId: 'TEST-turn' };
            }
            if (terminal) {
              assert.ok(nativeTurn && nativeTurnReply);
              assert.equal(result.state, 'data'); deadline();
              return await holdOriginal(attachment, { operation: 'read', stream: 'stdout', terminal,
                heldBytes: Buffer.from(result.bytes, 'base64').length, originalMore: result.more });
            }
          }
          return result;
        } catch (error) {
          if (error !== lost) events.guard(() => { throw error; })();
          throw error;
        }
      } };
    } };
    const envelope = (commandId: string, payload: JsonValue): JsonValue => ({ commandId,
      binding: { schemaVersion: 1, handleId: 'TEST-emulated-owner-loss', owner: selected.profile.owner,
        scope: team.scope }, payload });
    const rpc = async (client: CapturedHostClient, method: string, commandId: string, payload: JsonValue) => {
      deadline();
      const response = object(await client.request(method, envelope(commandId, payload), {
        control: method !== 'runtime.open' && method !== 'team.execute',
        ...(inputCutoff === undefined || lossStarted ? {} : { remainingMs: () => inputCutoff! - performance.now() }),
      }));
      deadline(); return response;
    };
    const value = (response: Row) => { assert.equal(response.ok, true); return object(response.value); };
    const rememberHost = (index: number, hello: Awaited<ReturnType<CapturedHostClient['start']>>) => {
      const attachment = attachments[index]; assert.ok(attachment); assert.equal(attachments.length, index + 1);
      assert.equal(attachment.context.binding.mainEpoch, owner.mainEpoch);
      assert.equal(attachment.context.binding.hostIncarnation, hello.hostIncarnation);
      assert.equal(attachment.context.profileId, selected.host.profileId);
      const rows = journal(selected.hostBirths!); assert.equal(rows.length, index + 1);
      const birth = rows[index]!; assert.deepEqual(Object.keys(birth).sort(), ['parentPid', 'pid']);
      assert.ok(Number.isSafeInteger(birth.pid) && Number(birth.pid) > 0); assert.equal(birth.parentPid, process.pid);
      Object.assign(attachment.proof, { epoch: index === 0 ? 'A' : 'B', helloHostIncarnation: hello.hostIncarnation,
        capturedChild: birth, exited: false });
      evidence.hosts = attachments.map(item => item.proof); return attachment;
    };
    const assertCounts = () => {
      assert.equal(counts.allocated, 1); assert.equal(counts.prepared, 1); assert.equal(counts.resumeRequests, 1);
      assert.equal(counts.resumeCompleted, afterEffect ? 1 : 0);
      assert.equal(forwarded.filter(operation => operation === 'resume').length, afterEffect ? 1 : 0);
      assert.equal(counts.businessInputs, afterEffect ? 1 : 0); assert.equal(counts.nativeTurnStarts, afterEffect ? 1 : 0);
      assert.equal(counts.serviceCapture, afterEffect ? 2 : 0); assert.equal(counts.serviceCaptureACKs, afterEffect ? 2 : 0);
      assert.equal(captures.length, afterEffect ? 2 : 0);
      const rows = effects!(); assert.equal(rows.filter(row => row.event === 'failure').length, 0);
      const registered = rows.filter(row => row.event === 'registered'); assert.equal(registered.length, afterEffect ? 1 : 0);
      counts.registeredRows = registered.length;
      if (afterEffect) {
        assert.ok(Array.isArray(registered[0]!.services)); assert.equal(registered[0]!.services.length, 2);
        counts.completedEffects = registered[0]!.services.length;
        assert.equal(counts.completedEffects, 2); assert.ok(counts.writeCompleted > 0);
      } else {
        assert.equal(forwarded.includes('write'), false); assert.equal(counts.writeCompleted, 0);
        assert.equal(rows.length, 0); assert.equal(counts.completedEffects, 0);
      }
      if (countsAtLoss) assert.deepEqual(counts, countsAtLoss);
      assert.equal(sentinel.exitCode, null);
    };
    assertFinalCounts = assertCounts;
    const assertUnknown = (snapshot: Row) => {
      assert.equal(snapshot.memberId, binding.memberId); assert.equal(snapshot.generation, binding.generation);
      assert.equal(snapshot.custody, 'unknown'); assert.equal(snapshot.nativeReady, false); assert.equal(snapshot.attached, false);
      assert.ok(Array.isArray(snapshot.inputs)); assert.equal(snapshot.inputs.length, afterEffect ? 1 : 0);
      if (afterEffect) { assert.equal(object(snapshot.inputs[0]).phase, 'unknown');
        assert.equal(object(snapshot.inputs[0]).inputId, originalRecord!.inputs[0]!.intent.inputId); }
    };
    const assertProvenance = (record: RuntimeSessionRecord) => {
      assert.ok(originalRecord); assert.deepEqual(record.binding, originalRecord.binding);
      assert.deepEqual(record.config, originalRecord.config); assert.equal(record.profileId, originalRecord.profileId);
      assert.equal(record.openFingerprint, originalRecord.openFingerprint); assert.equal(record.hostIncarnation, originalRecord.hostIncarnation);
      assert.equal(record.custody, 'unknown'); assert.equal(record.nativeReady, false);
      if (afterEffect) {
        const input = record.inputs[0]!, before = originalRecord.inputs[0]!;
        assert.deepEqual(input.intent, before.intent); assert.equal(input.fingerprint, before.fingerprint);
        assert.equal(input.operationRef, before.operationRef); assert.equal(input.phase, 'unknown');
        assert.equal(input.terminal, undefined);
      }
    };
    stage('Host-A-open');
    const a = new CapturedHostClient(selected.host, observed); clients.push(a);
    const aHello = await a.start(), aAttachment = rememberHost(0, aHello);
    let openingPending = true; intents.original++;
    pendingOpen = rpc(a, 'runtime.open', 'TEST-open', { memberId: binding.memberId }).then(
      response => { openingPending = false; return { state: 'fulfilled' as const, response }; },
      (error: unknown) => { openingPending = false; return { state: 'rejected' as const, error }; });
    const command: JsonValue = { operation: 'message.send', payload: {
      to: 'alice', text: 'TEST-register-services', messageId: 'TEST-input', actionMode: 'do' } };
    if (afterEffect) {
      const opened = await observe(() => pendingOpen!); assert.equal(opened.state, 'fulfilled');
      assert.equal(value(opened.response).nativeReady, true);
      stage('one-original-business-input');
      const entered = performance.now(); inputCutoff = entered + 15000;
      Object.assign(barrier, { inputEntered: entered, inputCutoff });
      counts.businessInputs++;
      completedCommand = value(await rpc(a, 'team.execute', 'TEST-input', command));
      assert.equal(completedCommand.phase, 'completed');
      const deliveryId = object(completedCommand.effects).deliveryId; assert.equal(typeof deliveryId, 'string');
      evidence.commandReceipt = completedCommand;
    }
    await observe(() => reached);
    if (afterEffect) { await observe(() => turnWriteFinished); barrier.nativeWriteAcknowledged = true; }
    stage(afterEffect ? 'completed-effects-before-runtime-completion' : 'completed-install-before-physical-resume');
    assert.ok(witnesses[0] && capability && root); assertCounts();
    // Runtime ownership and transport HELLO use separate incarnation domains.
    originalRecord = read();
    if (afterEffect) {
      assert.equal(originalRecord.phase, 'allocated'); assert.equal(originalRecord.custody, 'owned');
      assert.equal(originalRecord.nativeReady, true);
      const input = originalRecord.inputs[0]!;
      assert.ok(input.phase === 'claimed' || input.phase === 'consumed'); assert.equal(input.terminal, undefined);
      assert.equal(input.intent.inputId, object(completedCommand!.effects).deliveryId);
      assert.equal(input.intent.deliveryId, object(completedCommand!.effects).deliveryId);
      assert.match(input.fingerprint, /^[a-f0-9]{64}$/); assert.ok(input.operationRef.length > 0);
      const registered = effects().find(row => row.event === 'registered')!;
      assert.ok(Array.isArray(registered.services));
      intents.processList++;
      const response = await rpc(a, 'team.process.list', 'TEST-owner-loss-live', {});
      assert.equal(response.ok, true); assert.ok(Array.isArray(response.value)); assert.equal(response.value.length, 2);
      const rows = response.value.map(object);
      for (const service of registered.services.map(object)) {
        const row = rows.find(item => item.processRef === service.processRef); assert.ok(row);
        assert.equal(row.pid, service.pid); assert.equal(row.observation, 'same-live'); assert.equal(row.canTerminate, true);
        const capture = captures.find(item => item.target.pid === service.pid); assert.ok(capture);
        assert.deepEqual(capture.root, root); assert.equal(capture.providerCapability, capability);
      }
      evidence.registeredServices = structuredClone(registered.services); evidence.originalProcessRows = rows;
    } else {
      assert.equal(originalRecord.phase, 'opening'); assert.equal(originalRecord.custody, 'unknown');
      assert.equal(originalRecord.nativeReady, false); assert.equal(openingPending, true);
    }
    states.beforeLoss = durable(originalRecord);
    for (const witness of witnesses) assert.equal(await observe(() => witness.observe()), 'alive');
    cleanup.originalHandleAliveBeforeLoss = true; cleanup.handlesAliveBeforeLoss = witnesses.length;
    assert.equal(aAttachment.context.signal.aborted, false);
    barrier.pendingBeforeCrash = afterEffect ? held && barrier.callbackSettled === false : openingPending;
    barrier.originalAttachmentCurrent = !aAttachment.context.signal.aborted;
    deadline(); assertCounts(); deadline(); countsAtLoss = { ...counts };
    evidence.forwardedAtLoss = { allocate: forwarded.filter(op => op === 'allocate').length,
      write: forwarded.filter(op => op === 'write').length };
    barrier.beforeLossObserved = performance.now(); deadline(); lossStarted = true;
    writeFileSync(crash, 'TEST-original-host-loss\n', { flag: 'wx' }); barrier.crashMarkers = 1;
    await observe(() => aAttachment.context.hostExited);
    assert.equal(aAttachment.context.signal.aborted, true); aAttachment.proof.exited = true; barrier.originalHostExited = true;
    if (!afterEffect) {
      const outcome = await pendingOpen; assert.equal(outcome.state, 'rejected');
      if (outcome.state !== 'rejected') assert.fail('Original open unexpectedly completed');
      assert.ok(outcome.error instanceof HostClientError);
      assert.equal(outcome.error.code, 'transport-closed'); assert.equal(outcome.error.outcome, 'unknown');
      evidence.openFailure = { code: outcome.error.code, outcome: outcome.error.outcome };
    }
    releaseHold(); await timeout(holdFinished); unlinkSync(crash);
    for (const witness of witnesses) assert.equal(await observe(() => witness.observe()), 'alive');
    cleanup.originalHandleAliveAfterLoss = true; cleanup.handlesAliveAfterLoss = witnesses.length; assertCounts();
    stage('Host-B-cold-read-and-reconcile');
    const b = new CapturedHostClient(selected.host, observed); clients.push(b);
    const bHello = await b.start(), bAttachment = rememberHost(1, bHello);
    assert.notEqual(bHello.hostIncarnation, aHello.hostIncarnation);
    assert.equal(bAttachment.context.binding.profileDigest, aAttachment.context.binding.profileDigest);
    const coldRead = value(await rpc(b, 'runtime.read', 'TEST-owner-loss-read', { memberId: binding.memberId }));
    if (afterEffect) {
      assert.equal(coldRead.memberId, binding.memberId); assert.equal(coldRead.generation, binding.generation);
      assert.equal(coldRead.attached, false); assert.equal(coldRead.nativeReady, false);
      assert.ok(Array.isArray(coldRead.inputs)); assert.equal(coldRead.inputs.length, 1);
      assert.equal(object(coldRead.inputs[0]).inputId, originalRecord.inputs[0]!.intent.inputId);
      const beforeReconcile = read(); assert.deepEqual(beforeReconcile.inputs[0]!.intent, originalRecord.inputs[0]!.intent);
      assert.deepEqual(beforeReconcile.config, originalRecord.config);
      assert.equal(beforeReconcile.openFingerprint, originalRecord.openFingerprint);
      assert.equal(beforeReconcile.hostIncarnation, originalRecord.hostIncarnation);
      assert.equal(beforeReconcile.inputs[0]!.fingerprint, originalRecord.inputs[0]!.fingerprint);
      assert.equal(beforeReconcile.inputs[0]!.operationRef, originalRecord.inputs[0]!.operationRef);
      assert.equal(coldRead.phase, beforeReconcile.phase); assert.equal(coldRead.custody, beforeReconcile.custody);
      assert.equal(object(coldRead.inputs[0]).phase, beforeReconcile.inputs[0]!.phase);
      assert.equal(beforeReconcile.inputs[0]!.terminal, undefined); states.beforeReconcile = durable(beforeReconcile);
    } else assertUnknown(coldRead);
    states.coldRead = coldRead; intents.reconcile++;
    const reconciled = value(await rpc(b, 'runtime.reconcile', 'TEST-owner-loss-reconcile', { memberId: binding.memberId }));
    assertUnknown(reconciled); assert.equal(reconciled.phase, 'held'); states.reconciled = reconciled;
    const retained = read(); assertProvenance(retained); assert.equal(retained.phase, 'held'); states.retained = durable(retained);
    assertCounts(); stage('identical-command-no-replay');
    if (afterEffect) {
      intents.commandLookup++;
      const lookup = value(await rpc(b, 'team.execute', 'TEST-input', command));
      assert.deepEqual(lookup, completedCommand); evidence.commandLookup = lookup;
      assertProvenance(read()); assertCounts();
    } else {
      intents.identicalReplay++;
      const replay = value(await rpc(b, 'runtime.open', 'TEST-open', { memberId: binding.memberId }));
      assertUnknown(replay); assert.equal(replay.phase, 'held'); states.replay = replay;
      assertProvenance(read()); assertCounts();
    }
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
    assert.deepEqual(pidRefusal, { ok: false, code: 'invalid', outcome: 'rejected' }); negatives.numericPid = pidRefusal;
    assertCounts(); assertProvenance(read());
    for (const witness of witnesses) assert.equal(await observe(() => witness.observe()), 'alive');
    cleanup.originalHandleAliveAfterRefusals = true; cleanup.handlesAliveAfterRefusals = witnesses.length;
    complete = true;
  } catch (error) { errors.push(error); }
  finally {
    // If an assertion failed while a native callback was held, close that captured Host before rejecting it.
    if (held && barrier.originalHostExited !== true && clients[0]) try {
      const result = await clients[0].shutdown(); assert.equal(result.childExit, 'confirmed');
      if (attachments[0]) { await timeout(attachments[0].context.hostExited);
        assert.equal(attachments[0].context.signal.aborted, true); barrier.originalHostExited = true; }
    } catch (error) { errors.push(error); }
    releaseHold();
    if (held) try { await timeout(holdFinished); } catch (error) { errors.push(error); }
    for (const [index, client] of clients.entries()) try {
      const result = await client.shutdown();
      assert.equal(result.childExit, 'confirmed'); assert.equal(result.providerCustody, 'unresolved');
      if (attachments[index]) Object.assign(attachments[index]!.proof, { shutdown: result, exited: true });
    } catch (error) { errors.push(error); }
    if (pendingOpen) try { await timeout(pendingOpen); } catch (error) { errors.push(error); }
    if (physical) try { cleanup.mainCloseConfirmed = await physical.close(); assert.equal(cleanup.mainCloseConfirmed, true); }
    catch (error) { errors.push(error); }
    const absent: boolean[] = [];
    for (const witness of witnesses) try { assert.equal(await witness.wait(), 0); absent.push(true); }
    catch (error) { absent.push(false); errors.push(error); }
    cleanup.handleWaits = absent; cleanup.originalHandleAbsent = absent.length === (afterEffect ? 3 : 1) && absent.every(Boolean);
    if (crash && existsSync(crash)) try { unlinkSync(crash); } catch (error) { errors.push(error); }
    if (readFinal && originalRecord) try {
      lossStarted = true;
      const final = readFinal(); states.afterCleanup = durable(final);
      assert.deepEqual(final.binding, originalRecord.binding); assert.deepEqual(final.config, originalRecord.config);
      assert.equal(final.profileId, originalRecord.profileId); assert.equal(final.openFingerprint, originalRecord.openFingerprint);
      assert.equal(final.hostIncarnation, originalRecord.hostIncarnation);
      assert.equal(final.custody, 'unknown'); assert.equal(final.nativeReady, false);
      if (complete) assert.equal(final.phase, 'held');
      if (afterEffect) {
        assert.deepEqual(final.inputs[0]!.intent, originalRecord.inputs[0]!.intent);
        assert.equal(final.inputs[0]!.fingerprint, originalRecord.inputs[0]!.fingerprint);
        assert.equal(final.inputs[0]!.operationRef, originalRecord.inputs[0]!.operationRef);
        assert.equal(final.inputs[0]!.terminal, undefined); if (complete) assert.equal(final.inputs[0]!.phase, 'unknown');
      }
    } catch (error) { errors.push(error); }
    try {
      await events.wait(Promise.resolve());
      if (complete) { assert.ok(assertFinalCounts); assertFinalCounts(); }
      if (effects) evidence.peerJournalRows = effects().length;
      for (const pin of pins) assert.equal(fileHash(pin.path), pin.sha256);
      evidence.pinsUnchanged = pins.length > 0; assert.equal(sentinel.exitCode, null); cleanup.sentinelSurvived = true;
      if (countsAtLoss) {
        assert.equal(forwarded.filter(op => op === 'allocate').length, object(evidence.forwardedAtLoss).allocate);
        assert.equal(forwarded.filter(op => op === 'write').length, object(evidence.forwardedAtLoss).write);
        evidence.allocationsAfterLoss = 0; evidence.nativeWritesAfterLoss = 0;
      }
    } catch (error) { errors.push(error); }
    Object.assign(counts, { resumeForwarded: forwarded.filter(operation => operation === 'resume').length,
      writeForwarded: forwarded.filter(operation => operation === 'write').length });
    evidence.hosts = attachments.map(item => item.proof);
    evidence.errors = errors.map(error => error instanceof Error ? { name: error.name, message: error.message.slice(0, 1024) }
      : { name: 'Unknown', message: 'TEST fixture failed' });
    evidence.cleanup = errors.length === 0 && cleanup.mainCloseConfirmed === true && cleanup.originalHandleAbsent === true;
    // Only gate-owned witnesses use this fallback after mandatory native cleanup attempts.
    for (const child of observedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (!complete || !evidence.cleanup || errors.length)
    throw new AggregateError(errors, `TEST ${mode} incomplete`);
  assert.equal(attachments.length, 2); evidence.status = 'PASS'; stage('complete');
}
