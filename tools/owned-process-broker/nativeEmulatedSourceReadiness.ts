/** TEST readback of an original aggregate action; never writes or synthesizes readiness. */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

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

/** Passive projection of the existing TEST peer journal, after original cleanup attempts. */
export function observeEmulatedSourcePeerReadiness(
  evidence: Record<string, unknown>, values: readonly Record<string, unknown>[], provider: string
): void {
  if (provider !== 'codex') return;
  try {
    const data = (row: object, key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(row, key);
      if (property && !('value' in property)) throw new Error('TEST non-data peer observation');
      return property?.value;
    };
    const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const events: Record<string, unknown>[] = [];
    let truncated = false;
    for (const [index, value] of values.entries()) {
      if (data(value, 'provider') !== 'codex') continue;
      const event = data(value, 'event');
      if (typeof event !== 'string' ||
          !['launch', 'mcp-catalog', 'managed-configuration-read', 'connected', 'exit'].includes(event)) continue;
      if (events.length === 64) { truncated = true; break; }
      const pid = data(value, 'pid'), role = data(value, 'role');
      assert.ok(integer(pid) && pid > 0 && (role === 'runtime' || role === 'management'));
      const row: Record<string, unknown> = { ordinal: index + 1, event, pid, role };
      if (event === 'launch') {
        const parentPid = data(value, 'parentPid'), argc = data(value, 'argc');
        assert.ok(integer(parentPid) && parentPid > 0 && integer(argc, 1024));
        row.parentPid = parentPid; row.argc = argc;
      } else if (event === 'mcp-catalog') {
        const configuredServers = data(value, 'configuredServers');
        assert.ok(integer(configuredServers, 256)); row.configuredServers = configuredServers;
      } else if (event === 'managed-configuration-read') {
        const selected = data(value, 'selectedServers');
        assert.ok(Array.isArray(selected) && selected.length <= 1 && selected.every(name => name === 'team'));
        row.selectedServerCount = selected.length; row.teamSelected = selected.includes('team');
      } else if (event === 'connected') {
        const tools = data(value, 'tools');
        assert.ok(Array.isArray(tools) && tools.length <= 256 && tools.every(name => typeof name === 'string'));
        row.toolCount = tools.length;
      } else {
        const code = data(value, 'code');
        assert.ok(code === 0 || code === 1); row.code = code;
      }
      events.push(row);
    }
    evidence.sourcePeerReadiness = {
      status: 'observed', provider, capturePoint: 'existing-post-cleanup-effects-read',
      atomicWithReadinessFailure: false, events, truncated,
    };
  } catch {
    try { evidence.sourcePeerReadiness = { status: 'unknown', provider }; }
    catch { /* Passive evidence cannot replace the original failure or pin check. */ }
  }
}

/** Bounded TEST source evidence decoding; none of these helpers allocate or change readiness. */
const sourceRecord = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw)); return raw as Record<string, unknown>;
};
export const unwrapEmulatedSourceResult = (raw: unknown): Record<string, unknown> => {
  const reply = sourceRecord(raw); assert.equal(reply.ok, true, `TEST original Host refused: ${String(reply.code)}`);
  return sourceRecord(reply.value);
};

export function readEmulatedSourceJournal(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
  const value = readFileSync(path, 'utf8'); if (!value) return [];
  assert.ok(value.endsWith('\n'));
  return value.trimEnd().split('\n').map(line => sourceRecord(JSON.parse(line)));
}

export interface EmulatedSourceCustodyTiming {
  calls: number;
  settled: number;
  returned: number;
  totalMs: number;
  firstStartMs: number | null;
  lastEndMs: number | null;
}

export function validateEmulatedSourceRefusal(value: Record<string, unknown>, persisted: boolean) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  assert.ok(Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => 'value' in row));
  const hash = (raw: unknown) => typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw), clock = (raw: unknown) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0;
  const fields: Record<string, string> = { native: 'capability phase reason dispatched staged rootCaptured deadlineExpired checkSite',
    consumer: 'actionDigest groupDigest bindingDigest consumerId phase reason cutoff observedAt currentCalls',
    'opencode-open': 'bindingDigest phase reason',
    reference: 'commandDigest contextDigest phase reason probeCutoff probeNow scopeCutoff scopeNow preparationCutoff preparationNow', limit: '' };
  assert.ok(typeof value.kind === 'string' && Object.hasOwn(fields, value.kind));
  const keys = fields[value.kind]; assert.ok(typeof keys === 'string'); assert.deepEqual(Object.keys(value).sort(), ['kind', ...keys.split(' ').filter(Boolean), ...(persisted ? ['ordinal'] : [])].sort());
  if (persisted) assert.ok(typeof value.ordinal === 'number' && Number.isInteger(value.ordinal) && value.ordinal >= 1 && value.ordinal <= 65); if (value.kind === 'limit') { assert.equal(persisted, true); return; }
  assert.ok(typeof value.phase === 'string' && typeof value.reason === 'string');
  if (value.kind === 'native') {
    assert.ok(typeof value.capability === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.capability));
    assert.ok('capture staging allocate launch-chunk launch-commit post-commit prepare post-prepare resume'.split(' ').includes(value.phase));
    assert.ok('sealed current-false current-threw launch-deadline refused unknown result-mismatch preparation-failed'.split(' ').includes(value.reason));
    assert.ok(['dispatched', 'staged', 'rootCaptured'].every(key => typeof value[key] === 'boolean'));
    assert.equal(value.deadlineExpired, value.reason === 'launch-deadline' ? true : null);
    assert.ok(value.checkSite === null || typeof value.checkSite === 'string' && ['before-owner', 'after-owner', 'request-builder', 'after-reply'].includes(value.checkSite));
    if (value.checkSite !== null) assert.ok(value.phase === 'resume' && ['sealed', 'current-false', 'current-threw', 'launch-deadline'].includes(value.reason));
  } else if (value.kind === 'opencode-open') {
    assert.ok(hash(value.bindingDigest)); assert.equal(value.reason, 'threw');
    assert.ok('configuration server-launch native-ready startup-authority startup-configuration startup-delay session-authority session-create driver-readiness'.split(' ').includes(value.phase));
  } else {
    assert.ok(value.reason === 'held' || value.reason === 'threw'); const consumer = value.kind === 'consumer';
    if (consumer) {
      const timing = sourceRecord(value.currentCalls);
      assert.ok(timing && typeof timing === 'object' && !Array.isArray(timing) && [Object.prototype, null].includes(Object.getPrototypeOf(timing)));
      assert.ok(Object.getOwnPropertySymbols(timing).length === 0 && Object.values(Object.getOwnPropertyDescriptors(timing)).every(row => 'value' in row));
      assert.deepEqual(Object.keys(timing).sort(), ['count', 'lastMs', 'maxMs', 'totalMs', 'truncated', ...(Object.hasOwn(timing, 'regions') ? ['regions'] : [])].sort());
      assert.ok(clock(timing.count) && (timing.count as number) <= 4096 && clock(timing.totalMs) && clock(timing.maxMs) && (timing.maxMs as number) <= (timing.totalMs as number));
      assert.equal(typeof timing.truncated, 'boolean');
      assert.ok(timing.lastMs === null || clock(timing.lastMs) && (timing.lastMs as number) <= (timing.maxMs as number));
      if (timing.count === 0) assert.ok(timing.totalMs === 0 && timing.maxMs === 0 && timing.lastMs === null);
      else if (!timing.truncated) assert.notEqual(timing.lastMs, null);
      if (Object.hasOwn(timing, 'regions')) {
        const regions = sourceRecord(timing.regions);
        assert.ok(regions && typeof regions === 'object' && !Array.isArray(regions) && [Object.prototype, null].includes(Object.getPrototypeOf(regions)));
        assert.ok(Object.getOwnPropertySymbols(regions).length === 0 && Object.values(Object.getOwnPropertyDescriptors(regions)).every(row => 'value' in row));
        const names = ['initialAuthority', 'readConsumer', 'reference', 'finalAuthority', ...(Object.hasOwn(regions, 'referenceAccountCount') ? ['referenceAccount', 'referenceAccountAuthority'] : [])];
        assert.deepEqual(Object.keys(regions).sort(), names.flatMap(name => [name + 'Count', name + 'Ms']).sort());
        for (const name of names) {
          const count = regions[name + 'Count'], milliseconds = regions[name + 'Ms'];
          assert.ok(clock(count) && (count as number) <= (timing.count as number) && clock(milliseconds) && (count !== 0 || milliseconds === 0));
        }
      }
    }
    assert.ok((consumer ? ['actionDigest', 'groupDigest', 'bindingDigest', 'consumerId'] : ['commandDigest', 'contextDigest']).every(key => hash(value[key])));
    assert.ok((consumer ? 'initial-authority read-consumer identity continuation requirements cutoff reference equality final-authority' :
      'read inspect admission target scope retired completion probe-expiry scope-cutoff preparation-expiry origin purpose readiness account projection').split(' ').includes(value.phase));
    for (const [cutoff, now] of (consumer ? [['cutoff', 'observedAt']] : [['probeCutoff', 'probeNow'], ['scopeCutoff', 'scopeNow'], ['preparationCutoff', 'preparationNow']]) as [string, string][])
      assert.ok(value[cutoff] === null ? value[now] === null : clock(value[cutoff]) && clock(value[now]));
  }
}

/** Join only the already-read original refusal records to their retained source and owner. */
export function joinEmulatedSourceRefusalObservations(
  records: readonly Record<string, unknown>[],
  diagnosticLaunches: readonly {
    actionDigest: string;
    bindingDigests: readonly string[];
    launchId: string;
    source: { sourceId: string; revision: string };
  }[],
  epochs: readonly {
    physical: { mainEpoch: string };
    jobs: readonly {
      capability: string;
      origin?: { sourceId: string; revision: string };
    }[];
  }[]
) {
  const text = (raw: unknown): string => { assert.equal(typeof raw, 'string'); return raw as string; };
  const sourceRef = (value: { sourceId: string; revision: string }) => ({ sourceId: value.sourceId, revision: value.revision });
  const consumers = records.filter(row => row.kind === 'consumer').map(row => {
    const matches = diagnosticLaunches.filter(value => value.actionDigest === row.actionDigest && value.bindingDigests.includes(text(row.bindingDigest)));
    assert.equal(matches.length, 1); return { row, launch: matches[0]! };
  });
  const observations = records.map(row => {
    if (row.kind === 'opencode-open') {
      const matches = diagnosticLaunches.filter(value => value.bindingDigests.includes(text(row.bindingDigest)));
      assert.equal(matches.length, 1); return { ...row, launchId: matches[0]!.launchId, source: matches[0]!.source };
    }
    if (row.kind === 'native') { const matches = epochs.flatMap(epoch => epoch.jobs.map((job, jobSlot) => ({ epoch, job, jobSlot })))
      .filter(value => value.job.capability === row.capability);
      assert.equal(matches.length, 1); const match = matches[0]!; assert.ok(match.job.origin);
      const mainEpoch = match.epoch.physical.mainEpoch; assert.ok(typeof mainEpoch === 'string' && mainEpoch.length > 0 && mainEpoch.length <= 256 && !mainEpoch.includes('\0'));
      return { ...row, mainEpoch, jobSlot: match.jobSlot, source: sourceRef(match.job.origin) };
    }
    const matches = row.kind === 'consumer' ? consumers.filter(value => value.row === row) :
      consumers.filter(value => value.row.groupDigest === runtimeDigest({ commandDigest: row.commandDigest, contextDigest: row.contextDigest }));
    assert.ok(matches.length > 0); assert.equal(new Set(matches.map(value => JSON.stringify(value.launch))).size, 1);
    return { ...row, launchId: matches[0]!.launch.launchId, source: matches[0]!.launch.source };
  });
  return observations;
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
    assert.ok(ledger.schemaVersion === 1 || ledger.schemaVersion === 2); assert.equal(ledger.status, 'observed');
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
    const states = contexts.map(() => ({ sequence: 0, invocations: new Map(), timed: false, timing: Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0) }));
    const events = ledger.events.map(tuple => {
      assert.ok(Array.isArray(tuple) && (tuple.length === 6 || ledger.schemaVersion === 2 && tuple.length === 7));
      const [contextIndex, sequence, invocation, operation, phase, result, timing] = tuple;
      assert.ok(Number.isInteger(contextIndex) && contextIndex >= 0 && contextIndex < contexts.length);
      assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 64 && Number.isInteger(invocation) && invocation >= 1 && invocation <= 16);
      assert.ok(['open', 'catalog', 'readiness'].includes(operation) && ['before-await', 'after-await', 'returned', 'threw'].includes(phase));
      assert.ok(phase === 'returned' ? operation !== 'open' && typeof result === 'boolean' : result === null);
      const state = states[contextIndex]; assert.ok(state); assert.equal(sequence, state.sequence + 1);
      const timed = tuple.length === 7;
      if (state.sequence) assert.equal(timed, state.timed);
      if (timed) {
        assert.ok(Array.isArray(timing) && timing.length === 10);
        assert.ok(timing.every(number => Number.isSafeInteger(number) && number >= 0 && number <= 999999));
        for (const index of [1, 4, 7]) {
          assert.ok(timing[index] <= 4096 && timing[index + 2] <= timing[index + 1]);
          if (timing[index] === 0) assert.ok(timing[index + 1] === 0 && timing[index + 2] === 0);
          if (state.sequence && timing[index] === state.timing[index])
            assert.ok(timing[index + 1] === state.timing[index + 1] && timing[index + 2] === state.timing[index + 2]);
        }
        assert.ok(timing.every((number, index) => number >= Number(state.timing[index])));
        state.timing = timing;
      }
      state.timed = timed;
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
      return [contextIndex, sequence, invocation, operation, phase, result, ...(timed ? [timing] : [])];
    });
    assert.equal(ledger.schemaVersion === 2, states.some(state => state.timed));
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
    const selectedEvents = events.slice(0, observedEventCount).filter(tuple => tuple[0] === context.index);
    const lastEvent = selectedEvents.at(-1), timing = lastEvent?.[6];
    const result = { schemaVersion: ledger.schemaVersion, status: 'observed', atomicWithFailure: false,
      samplePoint: 'last-original-projection-with-matching-view-digest',
      source: { sourceId: source.sourceId, revision: source.revision }, bindingDigest: context.tuple[0], viewDigest: view[0],
      mainEpoch: epoch.mainEpoch, launchId: launch.launchId, observedEventCount,
      events: selectedEvents.map(tuple => tuple.slice(1, 6)),
      // Guard tuples are [count, totalDeciMs, maxDeciMs]. Preserve legacy phase rows.
      // Only the last original phase supplies cumulative guard costs;
      // this is not an atomic deadline sample, including when a later catalogue is still pending.
      ...(lastEvent && timing ? { timing: { samplePoint: 'last-original-codex-phase-event', sequence: lastEvent[1],
        elapsedDeciMs: selectedEvents.map(tuple => tuple[6][0]),
        isCurrent: timing.slice(1, 4), canAllocate: timing.slice(4, 7), mcpSourceCurrent: timing.slice(7, 10) } } : {}) };
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192); return result;
  } catch { return unavailable; }
}
