import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createHostTeamLifecycleComposition } from '../dist/composition/createHostTeamLifecycleComposition.js';
import { digest } from '../dist/team/identity.js';
import type { JsonValue } from '../dist/index.js';
import type { HostedTeam } from '../dist/composition/RuntimeTeamCoordinator.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';
import type { WindowsServiceCapture, WindowsServiceOutcome } from '../dist/owned-process/retainedServiceContracts.js';
import type { ProcessCommandReceipt, RegisteredProcessCapture, WindowsProcessNative } from '../dist/process/registeredProcessContracts.js';
import type { OwnerState } from '../dist/team/ownerState.js';

test('destructive lifecycle inspects original process receipt after metadata unregister, without signalling or trusting metadata stop', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-lifecycle-process-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, store, binding,
    members: [{ memberId: 'TEST-lead', name: 'captain', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'process.write'] }] });
  const registrar = { backendId: binding.backendId, teamId: binding.teamId, runId: 'TEST-run', memberId: 'TEST-lead', generation: '1' };
  const token = { auditToken: [501, 501, 20, 501, 20, 1000, 100, 2], sessionId: 1000,
    bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: '24G90' };
  const capture: RegisteredProcessCapture = { version: 1, registrar, root: token,
    target: { ...token, auditToken: [501, 501, 20, 501, 20, 1001, 100, 3] } };
  let absent = false, signals = 0, observations = 0;
  const native = { capture: () => capture, observe() { observations++; return absent ? 'absent' as const : 'same-live' as const; },
    signal() { signals++; return 'accepted' as const; } };
  const commands = owner.processCommands('human', { native, registrar: () => registrar });
  commands.register('TEST-register', { pid: 1001, label: 'TEST-service' });
  commands.metadata('TEST-metadata-stop', 'metadata-stop', { pid: 1001 });
  assert.throws(() => commands.assertReleased(), /hold/);
  commands.metadata('TEST-unregister', 'unregister', { pid: 1001 });
  assert.deepEqual(commands.list(), []);
  assert.throws(() => commands.assertReleased(), /hold/);
  absent = true;
  commands.assertReleased();
  assert.ok(observations > 0); assert.equal(signals, 0);
  store.fenced(() => { const state = store.read<OwnerState>('state.json')!; state.grants[0]!.revoked = true; store.write('state.json', state); });
  assert.throws(() => commands.assertReleased());
});

test('actual purge preflight persists natural Windows absence without a list or Stop; cold original purge uses the same durable proof', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-lifecycle-natural-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { principalId: 'human', owner: { ownerId: 'TEST-owner', revision: 'TEST-revision',
    storageRoot: root, profileId: 'TEST-profile', protocolVersion: 1 as const, buildId: 'TEST-build',
    nodeSha256: '0'.repeat(64), hostEntrySha256: '0'.repeat(64) } };
  const definition = {
    binding: { backendId: profile.owner.ownerId, teamId: 'TEST-team-id', teamName: 'TEST-team' },
    scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: 'TEST-team-id',
      runId: 'TEST-run', memberId: 'human', generation: '1' },
    members: [{ memberId: 'TEST-lead', name: 'lead', role: 'lead' }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'admin'] },
      { principalId: 'native-lead', memberName: 'lead', permissions: ['read', 'process.write'] },
    ],
  } satisfies HostedTeamDefinition;
  const capture: WindowsServiceCapture = {
    version: 5, platform: 'win32', admission: 'main-owned-job-scope-v1',
    mainEpoch: 'TEST-main', providerCapability: 'TEST-provider',
    providerGeneration: '11111111-1111-4111-8111-111111111111',
    root: { pid: 1000, birth: '0000000000000010' },
    target: { pid: 1001, key: '0000000000000001', birth: '0000000000000011' },
    registrar: { backendId: definition.binding.backendId, teamId: definition.binding.teamId,
      runId: 'TEST-run', memberId: 'TEST-lead', generation: '1' },
  };
  let sequence = 0, captures = 0, queries = 0, settlements = 0, stops = 0;
  const replies = new Map<string, WindowsServiceOutcome>();
  const source = () => ({ mainEpoch: capture.mainEpoch, providerCapability: capture.providerCapability,
    providerGeneration: capture.providerGeneration, root: structuredClone(capture.root) });
  // Declared synthetic native authority; this case proves filesystem/lifecycle composition, not the OS.
  const native: WindowsProcessNative = {
    prepareCapture(pid, registrar) {
      assert.equal(pid, capture.target.pid); assert.deepEqual(registrar, capture.registrar);
      return { ...source(), operationRef: 'TEST-natural-' + ++sequence,
        command: { operation: 'capture', pid, registrar: structuredClone(registrar) } };
    },
    prepareControl(selected, operation) {
      assert.deepEqual(selected, capture);
      const original = { ...source(), operationRef: 'TEST-natural-' + ++sequence };
      return operation === 'stop'
        ? { ...original, command: { operation: 'stop', capture: structuredClone(selected) } }
        : { ...original, command: { operation: 'settle', capture: structuredClone(selected) } };
    },
    async run(intent, deadline) {
      assert.ok(deadline > performance.now());
      assert.equal(replies.has(intent.operationRef), false);
      let outcome: WindowsServiceOutcome;
      if (intent.command.operation === 'capture') {
        captures++; outcome = { state: 'captured', capture: structuredClone(capture) };
      } else if (intent.command.operation === 'settle') {
        settlements++;
        const prepared = f.store.read<ProcessCommandReceipt>('commands/' + digest('TEST-native-register') + '.json')!;
        assert.equal(prepared.nativeAbsence?.settlement, 'requested');
        assert.deepEqual(prepared.nativeSettlement, intent, 'Same original register is durable before settlement');
        outcome = { state: 'settled', capture: structuredClone(capture) };
      } else {
        stops++; throw new Error('TEST no synthetic Stop');
      }
      replies.set(intent.operationRef, structuredClone(outcome));
      return outcome;
    },
    async lookup(intent) { return structuredClone(replies.get(intent.operationRef) ?? { state: 'unknown' }); },
    async query(selected, deadline) {
      assert.ok(deadline > performance.now()); assert.deepEqual(selected, capture); queries++;
      return { state: 'observed', capture: structuredClone(capture), observation: 'absent', evidence: 'native-scope' };
    },
  };
  function composed(windows?: WindowsProcessNative, storageRoot = root) {
    const selectedProfile = storageRoot === root ? profile : { ...profile, owner: { ...profile.owner, storageRoot } };
    const store = new TeamOwnerStore(storageRoot, definition.binding.teamName);
    const owner = createFilesystemTeamOwner({ root: storageRoot, store, binding: definition.binding,
      members: definition.members, grants: definition.grants });
    const team: HostedTeam = { definition, owner, connection: owner.connect('human'), operatorPrincipalId: 'human' };
    const teams = new Map([[definition.binding.teamId, team]]);
    const lifecycle = createHostTeamLifecycleComposition({
      profile: selectedProfile, teams, runtime: () => undefined, importer: () => undefined,
      assertCurrent() {}, assertWriter() {}, isShuttingDown: () => false,
      ...(windows ? { windows } : {}),
    });
    lifecycle.stores.set(definition.binding.teamId, store);
    async function call(method: string, commandId: string, payload: JsonValue): Promise<Record<string, unknown>> {
      const handler = lifecycle.methods[method]; assert.ok(handler);
      const result = await handler.handle({ commandId, binding: {
        schemaVersion: 1, handleId: 'TEST-handle', owner: selectedProfile.owner, scope: definition.scope,
      }, payload }, { requestId: commandId, signal: new AbortController().signal });
      assert.ok(result && typeof result === 'object' && !Array.isArray(result)); return result;
    }
    return { owner, store, lifecycle, call };
  }
  const f = composed(native);
  const member = f.owner.processCommands('native-lead', { windows: native, registrar: () => capture.registrar });
  const registered = await member.windows!.register('TEST-native-register', { pid: 1001, label: 'TEST natural' }, performance.now() + 10000);
  assert.equal(registered.result && !Array.isArray(registered.result) ? registered.result.observation : undefined, 'unknown');
  assert.equal(queries, 0, 'No prior Processes list or native absence poll');
  const trashed = await f.call('team.lifecycle.change', 'TEST-trash-natural', {
    expectedRevision: f.owner.lifecycleCommands('human').view().revision, action: 'trash',
  });
  assert.equal(trashed.ok, true);
  const revision = f.owner.lifecycleCommands('human').view().revision;
  // Existing failure seam leaves the original prepared purge intact after its actual preflight.
  f.lifecycle.storage.coordinator.commitPermanentDeletionBoundary = async () => { throw new Error('TEST-crash-after-prepare'); };
  const interrupted = await f.call('team.lifecycle.purge', 'TEST-natural-purge', { expectedRevision: revision });
  assert.deepEqual(interrupted, { ok: false, code: 'hold', outcome: 'unknown' });
  assert.equal(captures, 1); assert.equal(queries, 1); assert.equal(settlements, 1); assert.equal(stops, 0);
  const natural = f.store.read<ProcessCommandReceipt>('commands/' + digest('TEST-native-register') + '.json')!;
  assert.equal(natural.operation, 'register'); assert.equal(natural.principalId, 'native-lead');
  assert.deepEqual(natural.state, { phase: 'completed', native: 'not-requested' });
  assert.deepEqual(natural.capture, capture);
  assert.equal(natural.nativeAbsence?.settlement, 'settled');
  assert.equal(f.store.list<ProcessCommandReceipt>('commands').some(row => row.family === 'process' && row.operation === 'terminate'), false);
  const intentPath = join(root, 'backups', 'permanent-deletion-intents', encodeURIComponent(definition.binding.teamName) + '.json');
  const prepared = JSON.parse(readFileSync(intentPath, 'utf8')) as { phase: string; transactionId: string };
  assert.equal(prepared.phase, 'prepared');
  const cold = composed(); // No live Windows port; only the validated durable original observation survives.
  cold.owner.processCommands('human').assertReleased();
  assert.throws(() => cold.owner.processCommands('human').lookup('TEST-native-register'), /forbidden/);
  const completed = await cold.call('team.lifecycle.purge', 'TEST-natural-purge', { expectedRevision: revision });
  assert.equal(completed.ok, true);
  const result = completed.value as { transactionId: string; phase: string };
  assert.equal(result.transactionId, prepared.transactionId); assert.equal(result.phase, 'deleted');
  assert.equal(existsSync(join(root, 'teams', definition.binding.teamName)), false);
  assert.equal(captures, 1); assert.equal(queries, 1); assert.equal(settlements, 1); assert.equal(stops, 0);

  const stoppedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-lifecycle-stop-release-')));
  t.after(() => rmSync(stoppedRoot, { recursive: true, force: true }));
  let stopCaptures = 0, stopCalls = 0, stopSettlements = 0, stopLookups = 0, stopQueries = 0, deletionBoundaries = 0;
  const stopReplies = new Map<string, WindowsServiceOutcome>();
  const stoppedNative: WindowsProcessNative = {
    prepareCapture: native.prepareCapture!, prepareControl: native.prepareControl,
    async run(intent, deadline) {
      assert.ok(deadline > performance.now()); assert.equal(stopReplies.has(intent.operationRef), false);
      let outcome: WindowsServiceOutcome;
      if (intent.command.operation === 'capture') {
        stopCaptures++; outcome = { state: 'captured', capture: structuredClone(capture) };
      } else {
        const prepared = stopped.store.read<ProcessCommandReceipt>('commands/' + digest('TEST-genuine-stop') + '.json')!;
        if (intent.command.operation === 'stop') {
          assert.equal(prepared.state.phase, 'requested'); assert.deepEqual(prepared.nativeIntent, intent);
          stopCalls++; outcome = { state: 'stopped', capture: structuredClone(capture), observation: 'absent', evidence: 'native-scope' };
        } else {
          assert.equal(prepared.state.native, 'observed-absent'); assert.deepEqual(prepared.nativeSettlement, intent);
          assert.equal(prepared.nativeSettlementCompleted, undefined);
          stopSettlements++; outcome = { state: 'unknown' };
        }
      }
      stopReplies.set(intent.operationRef, structuredClone(outcome)); return outcome;
    },
    async lookup(intent, deadline) {
      assert.ok(deadline > performance.now()); stopLookups++;
      return structuredClone(stopReplies.get(intent.operationRef) ?? { state: 'unknown' });
    },
    async query() { stopQueries++; return { state: 'unknown' }; },
  };
  const stopped = composed(stoppedNative, stoppedRoot);
  const stoppedMember = stopped.owner.processCommands('native-lead', { windows: stoppedNative, registrar: () => capture.registrar });
  const stoppedRegistration = await stoppedMember.windows!.register('TEST-stopped-register',
    { pid: 1001, label: 'TEST genuine Stop' }, performance.now() + 10000);
  assert.ok(stoppedRegistration.result && !Array.isArray(stoppedRegistration.result));
  const stopAdmin = stopped.owner.processCommands('human', { windows: stoppedNative, registrar: () => capture.registrar });
  const originalStop = await stopAdmin.windows!.terminate('TEST-genuine-stop', stoppedRegistration.result.processRef, performance.now() + 10000);
  assert.equal(originalStop.state.native, 'observed-absent'); assert.equal(originalStop.nativeSettlementCompleted, undefined);
  assert.ok(originalStop.nativeSettlement);
  assert.throws(() => stopAdmin.assertReleased(), /hold/);
  const stoppedTrash = await stopped.call('team.lifecycle.change', 'TEST-trash-stopped', {
    expectedRevision: stopped.owner.lifecycleCommands('human').view().revision, action: 'trash',
  });
  assert.equal(stoppedTrash.ok, true);
  const stoppedRevision = stopped.owner.lifecycleCommands('human').view().revision;
  const originalBoundary = stopped.lifecycle.storage.coordinator.commitPermanentDeletionBoundary
    .bind(stopped.lifecycle.storage.coordinator);
  stopped.lifecycle.storage.coordinator.commitPermanentDeletionBoundary = async (...args) => {
    deletionBoundaries++;
    const confirmed = stopped.store.read<ProcessCommandReceipt>('commands/' + digest('TEST-genuine-stop') + '.json')!;
    assert.equal(confirmed.nativeSettlementCompleted, true);
    assert.deepEqual(confirmed.nativeSettlement, originalStop.nativeSettlement);
    assert.deepEqual(confirmed.nativeIntent, originalStop.nativeIntent);
    assert.equal(confirmed.principalId, originalStop.principalId);
    assert.equal(confirmed.commandId, originalStop.commandId);
    assert.deepEqual(confirmed.capture, originalStop.capture);
    return originalBoundary(...args);
  };
  const blocked = await stopped.call('team.lifecycle.purge', 'TEST-stopped-purge', { expectedRevision: stoppedRevision });
  assert.deepEqual(blocked, { ok: false, code: 'hold', outcome: 'unknown' });
  assert.equal(deletionBoundaries, 0, 'Completed absence without confirmed settlement cannot reach deletion');
  assert.equal(existsSync(join(stoppedRoot, 'teams', definition.binding.teamName)), true);
  assert.equal(stopped.store.read<ProcessCommandReceipt>('commands/' + digest('TEST-genuine-stop') + '.json')!.nativeSettlementCompleted, undefined);
  assert.equal(stopSettlements, 1); assert.equal(stopCalls, 1); assert.equal(stopCaptures, 1);
  stopReplies.set(originalStop.nativeSettlement.operationRef, { state: 'settled', capture: structuredClone(capture) });
  const deleted = await stopped.call('team.lifecycle.purge', 'TEST-stopped-purge', { expectedRevision: stoppedRevision });
  assert.equal(deleted.ok, true); assert.equal(deletionBoundaries, 1);
  assert.equal(existsSync(join(stoppedRoot, 'teams', definition.binding.teamName)), false);
  assert.equal(stopSettlements, 1); assert.equal(stopCalls, 1); assert.equal(stopCaptures, 1);
  assert.equal(stopLookups, 2); assert.equal(stopQueries, 0, 'Completed Stop maintenance uses its retained intent without a new query');
});
