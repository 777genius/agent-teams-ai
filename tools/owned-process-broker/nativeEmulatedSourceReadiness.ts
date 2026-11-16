/** TEST readback of an original aggregate action; never writes or synthesizes readiness. */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';

import { FileManagementCommandStore } from '../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { TeamOwnerStore } from '../../packages/legacy-agent-host/dist/adapters/team/TeamOwnerStore.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { validateLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/validateLaunchRecord.js';
import { readinessOriginDigest } from '../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';

import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { TeamLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/contracts.js';

export function readEmulatedSourceActionProbe(options: {
  profile: TeamHostProfile; team: number; handleId: string; contextId: string; commandId: string;
  payload: { launchId: string; rosterRevision: string }; fingerprint: string; captureDigest: string;
}) {
  const definition = options.profile.teams[options.team];
  assert.ok(definition);
  const store = new TeamOwnerStore(options.profile.owner.storageRoot, definition.binding.teamName);
  const record = store.read<TeamLaunchRecord>('launches/' + runtimeDigest(options.payload.launchId) + '.json');
  assert.ok(record);
  validateLaunchRecord(record, options.fingerprint, 1);
  assert.equal(record.startCommandId, options.commandId);
  assert.equal(record.definition.launchId, options.payload.launchId);
  assert.equal(record.definition.rosterRevision, options.payload.rosterRevision);
  assert.equal(runtimeDigest(record.definition.capture), options.captureDigest);
  assert.ok(record.readiness);
  assert.equal(record.readiness.capture, undefined, 'The original aggregate action owns this proof');
  const consumers = record.readiness.consumers.filter(row => row.actionId === options.commandId && row.memberId === 'alice-id');
  assert.equal(consumers.length, 1);
  const consumer = consumers[0]!, member = record.definition.members[0]!;
  assert.equal(consumer.memberId, member.memberId);
  assert.deepEqual(consumer.binding, member.binding);
  assert.equal(consumer.configRevision, member.configRevision);
  assert.equal(consumer.configurationDigest, member.configurationDigest);
  assert.equal(consumer.baseConfigurationDigest, member.baseConfigurationDigest);
  assert.equal(consumer.inputDigest, runtimeDigest(options.payload));
  assert.equal(consumer.disposition, 'consumed');
  assert.equal(consumer.admissionOnly, undefined);
  assert.equal(consumer.initialProfile, undefined);
  assert.equal(consumer.continuation, undefined);
  assert.equal(consumer.policyCommandId, undefined);
  assert.equal(consumer.sourceAttemptId, record.members[0]!.currentAttemptId);
  assert.ok(consumer.groupCommandId);
  const groups = record.readiness.groups.filter(row => row.commandId === consumer.groupCommandId);
  assert.equal(groups.length, 1);
  const group = groups[0]!;
  const receipt = new FileManagementCommandStore(options.profile.owner.storageRoot, true).read(group.commandId);
  assert.ok(receipt && receipt.kind === 'model.probe');
  assert.match(receipt.commandId, /^action-probe-[a-f0-9]{64}$/);
  for (const key of ['commandId', 'profileId', 'configRevision', 'context', 'fingerprint', 'selectionDigest', 'resourceId', 'expiresAt'] as const)
    assert.equal(receipt[key], group[key]);
  assert.equal(receipt.phase, 'completed'); assert.equal(receipt.ok, true); assert.equal(receipt.resourceHeld, false);
  assert.equal(receipt.purpose, 'native-local-readiness-v1'); assert.equal(group.purpose, receipt.purpose);
  assert.match(receipt.profileId, /^team-probe-[a-f0-9]{64}$/); assert.equal(receipt.configRevision, receipt.profileId);
  assert.equal(receipt.providerId, 'test-provider'); assert.equal(receipt.modelId, 'TEST-model');
  assert.equal(receipt.effort, undefined); assert.equal(receipt.modelContext, undefined);
  assert.ok(receipt.readinessScope && receipt.localModelReadinessOrigin && receipt.localModelReadinessPreparation && receipt.readiness);
  assert.equal(receipt.readinessScope.kind, 'team');
  assert.equal(receipt.readinessScope.teamBindingDigest, runtimeDigest(definition.binding));
  assert.equal(receipt.readinessScope.sourceRevision, options.captureDigest);
  assert.equal(receipt.readinessScope.rosterRevision, options.payload.rosterRevision);
  assert.equal(receipt.readinessScope.actionDigest,
    runtimeDigest({ commandId: options.commandId, actor: consumer.actorDigest, inputDigest: consumer.inputDigest }));
  assert.equal(receipt.readinessScope.selectionDigest, runtimeDigest({
    payload: options.payload, targets: [{ binding: consumer.binding, profile: consumer.configurationDigest }],
  }));
  assert.deepEqual(receipt.readinessScope.destinationKeys,
    [runtimeDigest({ launchId: consumer.binding.runId, memberId: consumer.memberId })]);
  assert.equal(group.preparationDigest, managementDigest({ scope: receipt.readinessScope,
    anchor: receipt.localModelReadinessPreparation ?? null, origin: receipt.localModelReadinessOrigin ?? null,
    ...(receipt.nativeFileKeyWitness === undefined ? {} : { nativeFileKeyWitness: managementDigest(receipt.nativeFileKeyWitness) }) }));
  assert.equal(receipt.readinessScope.mechanismDigest, group.mechanismDigest);
  assert.equal(receipt.readinessScope.workspace, definition.savedSettings!.cwd);
  assert.equal(receipt.localModelReadinessPreparation.anchorCommandId, receipt.commandId);
  assert.equal(receipt.localModelReadinessOrigin.ownerDigest, readinessOriginDigest(options.profile.owner));
  assert.equal(receipt.localModelReadinessOrigin.contextId, options.contextId);
  assert.equal(receipt.localModelReadinessOrigin.commandId, options.commandId);
  assert.equal(receipt.localModelReadinessOrigin.selectionDigest,
    readinessOriginDigest({ handleId: options.handleId, scope: definition.scope, payload: options.payload }));
  assert.deepEqual(receipt.localModelReadinessOrigin.workspaces.map(row => row.path), [definition.savedSettings!.cwd]);
  assert.equal(receipt.readiness.evidence.ordinary, 'confirmed');
  assert.equal(receipt.readiness.evidence.decision, 'allow');
  return receipt;
}

/** TEST-only completed-exit observation; never substitutes for Runtime readiness or custody. */
export function readEmulatedCodexReadinessObservation(options: Record<string, unknown>) {
  const unavailable = { status: 'unknown', reason: 'missing-invalid-overflow-conflicting-or-unjoined' };
  try {
    const object = (value: unknown) => {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      assert.ok(Object.values(descriptors).every(row => 'value' in row));
      return Object.fromEntries(Object.entries(descriptors).map(([key, row]) => [key, row.value]));
    };
    const input = object(options), projection = object(input.runtimeProjection), launch = object(input.lastLaunchReadiness);
    assert.equal(input.provider, 'codex'); assert.equal(typeof input.ledgerPath, 'string'); assert.ok(input.ledgerPath.length > 0);
    assert.ok(Array.isArray(input.epochs) && input.epochs.length === 1);
    const epoch = object(input.epochs[0]), source = object(launch.source), last = object(launch.lastRuntimeRead);
    assert.equal(epoch.projectionHostExit, 'confirmed');
    for (const id of [epoch.mainEpoch, launch.launchId]) assert.ok(typeof id === 'string' && id.length >= 1 && id.length <= 256 && !id.includes('\0'));
    for (const digest of [source.sourceId, source.revision, input.lastRuntimeViewDigest])
      assert.ok(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
    assert.equal(Object.keys(source).sort().join(' '), 'revision sourceId');
    assert.equal(Object.keys(projection).sort().join(' '), 'atomicWithFailure bindingMatches nativeReady ownerCurrent providerReady recordReady status viewDigest');
    assert.equal(projection.status, 'observed'); assert.equal(projection.atomicWithFailure, false);
    assert.equal(projection.viewDigest, input.lastRuntimeViewDigest); assert.equal(last.viewDigest, input.lastRuntimeViewDigest);
    const readiness = [projection.bindingMatches, projection.recordReady, projection.providerReady, projection.ownerCurrent, projection.nativeReady];
    assert.equal(typeof readiness[0], 'boolean'); assert.equal(typeof readiness[4], 'boolean');
    for (let index = 1; index <= 3; index++)
      assert.ok(readiness.slice(0, index).every(value => value === true) ? typeof readiness[index] === 'boolean' : readiness[index] === null);
    assert.equal(readiness[4], readiness.slice(0, 4).every(value => value === true)); assert.equal(readiness[0], true);
    assert.ok(Array.isArray(input.diagnosticLaunches));
    const launches = input.diagnosticLaunches.map(object).filter(row => row.launchId === launch.launchId); assert.equal(launches.length, 1);
    const selected = launches[0]; assert.ok(selected);
    const selectedSource = object(selected.source); assert.deepEqual(selectedSource, source);
    assert.ok(Array.isArray(selected.bindingDigests) && selected.bindingDigests.length > 0);
    assert.ok(selected.bindingDigests.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)));
    assert.equal(new Set(selected.bindingDigests).size, selected.bindingDigests.length);
    const stat = lstatSync(input.ledgerPath); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size >= 0 && stat.size <= 8192);
    const raw = readFileSync(input.ledgerPath, 'utf8'); assert.ok(Buffer.byteLength(raw) <= 8192);
    const ledger = object(JSON.parse(raw));
    assert.equal(Object.keys(ledger).sort().join(' '), 'contexts events schemaVersion status views');
    assert.equal(ledger.schemaVersion, 1); assert.equal(ledger.status, 'observed');
    assert.ok(Array.isArray(ledger.contexts) && ledger.contexts.length <= 4);
    assert.ok(Array.isArray(ledger.events) && ledger.events.length <= 64);
    assert.ok(Array.isArray(ledger.views) && ledger.views.length <= 4);
    const identities = new Set();
    const contexts = ledger.contexts.map(tuple => {
      assert.ok(Array.isArray(tuple) && tuple.length === 3);
      assert.ok(tuple.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)));
      const key = tuple.join(':'); assert.equal(identities.has(key), false); identities.add(key);
      return [tuple[0], tuple[1], tuple[2]];
    });
    const states = contexts.map(() => ({ sequence: 0, invocations: new Map() }));
    const events = ledger.events.map(tuple => {
      assert.ok(Array.isArray(tuple) && tuple.length === 6);
      const [contextIndex, sequence, invocation, operation, phase, result] = tuple;
      assert.ok(Number.isInteger(contextIndex) && contextIndex >= 0 && contextIndex < contexts.length);
      assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 64 && Number.isInteger(invocation) && invocation >= 1 && invocation <= 16);
      assert.ok(['open', 'catalog', 'readiness'].includes(operation) && ['before-await', 'after-await', 'returned', 'threw'].includes(phase));
      assert.ok(phase === 'returned' ? operation !== 'open' && typeof result === 'boolean' : result === null);
      const state = states[contextIndex]; assert.ok(state); assert.equal(sequence, state.sequence + 1);
      const prior = state.invocations.get(invocation);
      if (phase === 'before-await') {
        assert.equal(prior, undefined); assert.equal(invocation, state.invocations.size + 1);
      } else {
        assert.ok(prior && prior[0] === operation);
        assert.ok(phase === 'after-await' ? prior[1] === 'before-await'
          : phase === 'returned' ? prior[1] === 'after-await'
          : prior[1] === 'before-await' || prior[1] === 'after-await');
      }
      state.sequence = sequence; state.invocations.set(invocation, [operation, phase]);
      return [contextIndex, sequence, invocation, operation, phase, result];
    });
    assert.ok(states.every(state => state.sequence > 0));
    const digests = new Set();
    const views = ledger.views.map(tuple => {
      assert.ok(Array.isArray(tuple) && tuple.length === 2);
      assert.ok(typeof tuple[0] === 'string' && /^[a-f0-9]{64}$/.test(tuple[0]));
      assert.ok(Number.isInteger(tuple[1]) && tuple[1] >= 0 && tuple[1] <= events.length);
      assert.equal(digests.has(tuple[0]), false); digests.add(tuple[0]); return [tuple[0], tuple[1]];
    });
    const matches = contexts.map((tuple, index) => ({ tuple, index })).filter(({ tuple }) =>
      selected.bindingDigests.includes(tuple[0]) && tuple[1] === source.sourceId && tuple[2] === source.revision);
    assert.equal(matches.length, 1); const context = matches[0]; assert.ok(context);
    const matchingViews = views.filter(tuple => tuple[0] === input.lastRuntimeViewDigest);
    assert.equal(matchingViews.length, 1); const view = matchingViews[0]; assert.ok(view);
    const observedEventCount = view[1];
    const result = { schemaVersion: 1, status: 'observed', atomicWithFailure: false,
      samplePoint: 'last-original-projection-with-matching-view-digest',
      source: { sourceId: source.sourceId, revision: source.revision }, bindingDigest: context.tuple[0], viewDigest: view[0],
      mainEpoch: epoch.mainEpoch, launchId: launch.launchId, observedEventCount,
      events: events.slice(0, observedEventCount).filter(tuple => tuple[0] === context.index).map(tuple => tuple.slice(1)) };
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192); return result;
  } catch { return unavailable; }
}
