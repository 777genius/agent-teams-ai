import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { AcceptedOpenCodeV2FileKey, createOpenCodeV2FileMaterialization,
  openCodeV2SelectedSourceReference, selectedFilePaths } from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createRuntimeMemberProviderFactory } from '../dist/composition/createRuntimeMemberProviderFactory.js';
import { createRuntimeTeamLaunch } from '../dist/composition/createRuntimeTeamLaunch.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { assertMemberModelReadinessFileHandoffsAvailable, attachMemberModelReadiness,
  captureActionModelReadiness, captureNativeRestartReadiness, capturePreparedModelReference,
  installMemberModelReadinessFileKey, readMemberModelReadinessFileKey,
  settleMemberModelReadinessFileHandoff } from '../dist/composition/prepareTeamModelReadiness.js';
import type { PreparedModelReadinessReference } from '../dist/composition/prepareTeamModelReadiness.js';
import type { HostedTeam, MemberEntry } from '../dist/composition/MemberEntry.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { ProviderManagementProfile } from '../dist/management/profile.js';
import { ToolEvidenceWindows } from '../dist/evidence/ToolEvidenceWindows.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { runtimeDigest as digest } from '../dist/runtime/identity.js';
import { modelReadinessMechanismDigest } from '../dist/team-launch/launchReadiness.js';
import type { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { Driver } from './native-member-actions-fixture.ts';

/** Actual Launch/Runtime/journal owners; only the native Session is a controlled TEST driver. */
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-model-file-handoff-')));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-file-handoff' };
  const members = ['A', 'B'].map(memberId => ({ memberId, name: memberId === 'A' ? 'alice' : 'bob',
    role: memberId === 'A' ? 'lead' as const : 'member' as const,
    delivery: { ...binding, runId: 'TEST-run', memberId, generation: '1' } }));
  const grants = [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'admin'] as ('read' | 'admin')[] },
    ...members.map(member => ({ principalId: `TEST-${member.memberId}`, memberName: member.name,
      permissions: ['read', 'task.write', 'message.write'] as ('read' | 'task.write' | 'message.write')[] }))];
  const owner = createFilesystemTeamOwner({ root, binding, members, grants });
  const team: HostedTeam = { owner, connection: owner.connect('TEST-human'), definition: {
    binding, members, grants, scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace',
      teamId: binding.teamId, runId: 'TEST-run', memberId: 'TEST-host', generation: '1' } } };
  const home = join(root, 'home'), data = join(root, 'data');
  mkdirSync(home); mkdirSync(data);
  writeFileSync(join(root, 'TEST-selected.key'), 'TEST-original-file-key', { mode: 0o600 });
  writeFileSync(join(root, 'opencode.json'), JSON.stringify({ provider: { 'test-local': {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: '{file:TEST-selected.key}' },
    models: { 'TEST-model': { name: 'TEST-model' } } } } }), { mode: 0o600 });
  const entries = new Map<string, MemberEntry>();
  for (const member of members) {
    const profile = runtimeMemberProfileSchema.parse({ provider: 'opencode', nativeGeneration: 'v2',
      protocolRevision: '2.1.4', teamId: binding.teamId, memberId: member.memberId,
      principalId: `TEST-${member.memberId}`, sessionId: `TEST-session-${member.memberId}`, generation: 1,
      configRevision: 'TEST-config', accountBinding: 'TEST-account', model: 'TEST-model', cwd: root,
      executable: { path: join(root, 'TEST-never-executed-bun'), sha256: 'a'.repeat(64) }, endpoint: 'http://127.0.0.1:9',
      environment: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: data, XDG_CACHE_HOME: home },
      embedded: { directory: join(root, 'TEST-engine'), manifestSha256: 'b'.repeat(64), version: '2.1.4',
        platform: process.platform, arch: process.arch, externalDirectory: 'deny' },
      nativeOptions: { providerId: 'test-local', agent: 'build' },
      limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 8192, outputEvents: 128,
        pendingInteractions: 1, timeoutMs: 30000 } });
    assert.equal(profile.provider, 'opencode'); if (profile.provider !== 'opencode') assert.fail();
    profile.embedded!.configurationSource = captureOpenCodeConfigurationSource(profile).reference;
    const { teamName: _name, ...runtimeBinding } = member.delivery;
    entries.set(member.memberId, { team, profile, baseProfile: structuredClone(profile), binding: runtimeBinding,
      delivery: member.delivery, config: { tenantId: binding.backendId, projectId: 'TEST-project',
        sessionId: profile.sessionId, generation: 1, configRevision: profile.configRevision, requiredCapabilities: ['tools'] } });
  }
  const first = entries.get('A')!, firstProfile = teamModelProbeProfile(first.profile);
  assert.equal(firstProfile.provider, 'opencode'); if (firstProfile.provider !== 'opencode') assert.fail();
  const source = captureOpenCodeV2Configuration(firstProfile,
    { providerId: 'test-local', modelId: 'TEST-model' }, () => true).selectedFile;
  assert.ok(source);
  const policy = { kind: 'protected' as const, key: { version: 1 as const, salt: '1'.repeat(32) },
    files: { version: 1 as const, salt: '2'.repeat(32) } };
  const materialization = createOpenCodeV2FileMaterialization(source.descriptor, () => {}, policy);
  const key = selectedFilePaths(source.descriptor).map(path => materialization.readFileString(path).trim()).join('');
  const nonce = 'c'.repeat(64), integrationId = 'test-local';
  const issuer = { nonce, pid: process.pid, integrationId,
    reference: openCodeV2SelectedSourceReference(source.descriptor, nonce, integrationId, 'fresh') };
  const password = Buffer.alloc(32, 7).toString('base64url'), request = { method: 'POST' as const, deadline: Date.now() + 30000 };
  await materialization.prepareIssue(key, issuer, request, password);
  const nativeProof = AcceptedOpenCodeV2FileKey.accept(source, materialization.issue(key, issuer), issuer,
    () => true, { policy, password, request });
  const profiles = new Map([...entries.values()].map(entry => {
    const profile = teamModelProbeProfile(entry.profile); return [profile.profileId, profile];
  }));
  const target = (profile: ProviderManagementProfile) => ({ profileId: profile.profileId,
    configRevision: profile.configRevision, selectionDigest: digest(profile), resourceId: digest(profile.accountBinding) });
  const records = new FileManagementCommandStore(root);
  const probes = new ModelProbeOwner({ store: records, fence: new ManagementResourceFence(records.list()),
    assertWriter() {}, select(profileId, configRevision) {
      const profile = profiles.get(profileId); assert.ok(profile); assert.equal(configRevision, profile.configRevision);
      return target(profile);
    }, prepare: () => ({ timeoutMs: 30000, run: async () => true, close: async () => true,
      nativeFileKeyWitness: () => nativeProof }) });
  const management = { probes, readinessTarget: target, admitTeamProbeProfile() { assert.fail('TEST unexpected new probe'); } };
  const prepared = new Map<string, PreparedModelReadinessReference>();
  for (const entry of entries.values()) {
    const profile = teamModelProbeProfile(entry.profile), commandId = `TEST-probe-${entry.profile.memberId}`;
    const context = digest(commandId), cutoff = Date.now() + 30000;
    probes.startPrepared({ commandId, context, profileId: profile.profileId, configRevision: profile.configRevision,
      providerId: 'test-local', modelId: 'TEST-model' }, () => true, undefined,
    { schemaVersion: 1, kind: 'native', teamBindingDigest: digest(binding), actionDigest: digest(commandId),
      selectionDigest: digest({ providerId: 'test-local', modelId: 'TEST-model' }), sourceRevision: 'TEST-source',
      rosterRevision: 'TEST-roster', mechanismDigest: modelReadinessMechanismDigest(profile), workspace: root,
      cutoff, destinationKeys: [digest({ launchId: 'TEST-run', memberId: entry.profile.memberId })] });
    await probes.awaitPrepared(commandId, context);
    const pair = await capturePreparedModelReference({ management, profile: entry.profile,
      commandId, context, kind: 'native', isCurrent: () => true });
    assert.ok(pair.fileKey); prepared.set(entry.profile.memberId, pair);
  }
  let writer = true, sealed = false, progress = 0;
  const progressed = Promise.withResolvers<void>();
  const denied = new Set<string>(), contexts: MemberProviderContext[] = [], drivers: Driver[] = [];
  const events: string[] = [];
  let launch!: TeamLaunchOwner, runtime!: RuntimeOwner;
  const assertWriter = () => { if (!writer) throw new Error('TEST writer revoked'); };
  const assertCurrent = (entry: MemberEntry) => {
    assertWriter(); if (sealed || denied.has(entry.profile.memberId)) throw new Error('TEST original unavailable');
  };
  const factory = createRuntimeMemberProviderFactory({ entries, storageRoot: root, profileId: 'TEST-profile',
    principalId: 'TEST-human', hostIncarnation: 'TEST-host', windows: new ToolEvidenceWindows(), modelReadiness: management,
    readinessLaunch: () => launch, isSealed: () => sealed, assertWriter, assertCurrent,
    readRuntime: binding => runtime.readCapturedSession(binding), readCheckpoint: (reference, request) => runtime.readCheckpoint(reference, request),
    observe: (...args) => runtime.observeProviderActivity(...args), captureInteractions() {}, settleDeliveries: async () => {},
    onProgress() {}, createProvider(context) {
      contexts.push(context); events.push(`factory-${context.profile.memberId}`);
      const driver = new Driver(context.profile.memberId); drivers.push(driver);
      return { factory: { open: async () => ({ driver, capabilities: ['tools'] }) }, isReady: () => true,
        seal() {}, cleanup: async () => true };
    } });
  runtime = new RuntimeOwner({ store: new FileRuntimeStore(root), profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    authorize: (selected, action, intent) => intent ? owner.authorizeDeliveryIntent(intent, action) : owner.authorizeMemberBinding(selected, action),
    canDispatch: () => true, driverFactory: factory });
  launch = createRuntimeTeamLaunch({ root, team, entries: [...entries.values()], principalId: 'TEST-human',
    hostIncarnation: 'TEST-host', runtime, modelReadiness: management, isCurrent: entry => !denied.has(entry.profile.memberId),
    isSealed: () => sealed, assertWriter, trackOpening: pending => pending,
    onProgress: () => { progress++; progressed.resolve(); } });
  t.after(async () => {
    sealed = true; launch.seal();
    for (const entry of entries.values()) {
      await runtime.stopCapturedSession(entry.binding);
      entry.endpoint?.revoke(); await entry.endpoint?.close();
    }
    await probes.close(); rmSync(root, { recursive: true, force: true });
  });
  const selected = (entry: MemberEntry) => ({ binding: entry.binding,
    configRevision: entry.profile.configRevision, configurationDigest: digest(entry.profile) });
  const options = (entry: MemberEntry) => ({ launch, entry, hostIncarnation: 'TEST-host', assertCurrent: () => assertCurrent(entry) });
  const attach = (entry: MemberEntry) => {
    const pair = prepared.get(entry.profile.memberId)!;
    attachMemberModelReadiness({ launch, entry, reference: pair.reference, commandId: 'TEST-start',
      actorDigest: digest('TEST-human'), inputDigest: digest('TEST-start'), cutoff: pair.reference.expiresAt });
  };
  for (const entry of entries.values()) attach(entry);
  const install = (entry: MemberEntry, pair = prepared.get(entry.profile.memberId)!) => {
    const handoff = installMemberModelReadinessFileKey({ ...options(entry), prepared: pair,
      expectedAttemptId: launch.readModelReadiness(selected(entry)).attempt.attemptId });
    assert.ok(handoff); return handoff;
  };
  return { root, team, entries, management, records, nativeProof, prepared, runtime, launch, contexts, drivers, events,
    options, selected, install, attach, denied, progressed: progressed.promise, get progress() { return progress; },
    revokeWriter: () => { writer = false; }, seal: () => { sealed = true; launch.seal(); } };
}

test('queued opening retains its original proof when an equal competing continuation resumes first', async t => {
  const f = await fixture(t), entry = f.entries.get('A')!, pair = f.prepared.get('A')!;
  const fileKey = pair.fileKey;
  assert.ok(fileKey);
  const nativeSource = await captureNativeRestartReadiness({ management: f.management, launch: f.launch,
    entry, isCurrent: () => true, cutoff: Date.now() + 30000 });
  const before = f.launch.readModelReadiness(f.selected(entry)).consumer;
  const competitor = Promise.resolve().then(() => {
    f.events.push('competitor');
    assert.equal(f.launch.readModelReadiness(f.selected(entry)).attempt.claimed, true);
    assert.throws(() => f.install(entry), { code: 'held' });
    assert.throws(() => f.install(entry, { reference: structuredClone(pair.reference), fileKey }), { code: 'held' });
    assert.throws(() => captureActionModelReadiness({ management: f.management, launch: f.launch,
      targets: [{ entry, profile: entry.profile, binding: entry.binding }], commandId: 'TEST-competing-open',
      payload: { memberId: 'A' }, actorDigest: digest('TEST-native'), nativeSource, assertCurrent() {} }), { code: 'held' });
    assert.deepEqual(f.launch.readModelReadiness(f.selected(entry)).consumer, before,
      'the refused admission-only publication must not retire the queued original consumer');
  });
  const handoff = f.install(entry), opening = f.launch.startMember('A'); assert.ok(opening);
  assert.equal(entry.modelReadinessFileHandoff, handoff);
  await competitor; await opening;
  assert.deepEqual(f.events, ['competitor', 'factory-A']);
  assert.equal(f.contexts[0]?.readinessFileKey, fileKey.proof);
  assert.equal(entry.modelReadinessFileHandoff, undefined);
  assert.equal(f.runtime.readCapturedSession(entry.binding).record?.phase, 'allocated');
  assert.equal(f.progress, 1);
});

test('historical native Restart permits own retirement but never renews the original readiness', async t => {
  const f = await fixture(t), entry = f.entries.get('A')!;
  f.install(entry);
  const opening = f.launch.startMember('A'); assert.ok(opening); await opening;
  const selected = f.selected(entry), before = f.launch.readModelReadinessSource(selected);
  assert.equal(before?.consumer.disposition, 'consumed');
  const assertCurrent = f.options(entry).assertCurrent;
  const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
  const options = { management: f.management, launch: f.launch, entry, isCurrent, cutoff: Date.now() + 30000 };
  const nativeSource = await captureNativeRestartReadiness(options);
  const originalProbe = f.records.read(nativeSource.reference.commandId);
  assert.ok(originalProbe?.kind === 'model.probe');
  assert.equal(originalProbe.readinessRetired, undefined);
  captureActionModelReadiness({ management: f.management, launch: f.launch,
    targets: [{ entry, profile: entry.profile, binding: entry.binding }], commandId: 'TEST-original-restart',
    payload: { memberId: 'A' }, actorDigest: digest('TEST-native'), nativeSource, assertCurrent });
  assert.deepEqual(f.launch.readModelReadinessSource(selected), {
    ...before, consumer: { ...before!.consumer, disposition: 'retired' },
  });
  assert.doesNotThrow(nativeSource.assertCurrent, 'the original consumer may become historical');
  await f.management.probes.cancelRetained(nativeSource.reference.commandId, nativeSource.reference.context);
  const retiredProbe = f.records.read(nativeSource.reference.commandId);
  assert.ok(retiredProbe?.kind === 'model.probe');
  assert.deepEqual(retiredProbe, { ...originalProbe, readinessRetired: true });
  assert.doesNotThrow(nativeSource.assertCurrent, 'physical cleanup may retire the original probe');
  await assert.rejects(capturePreparedModelReference({ management: f.management, profile: entry.profile,
    commandId: nativeSource.reference.commandId, context: nativeSource.reference.context,
    kind: 'native', isCurrent }), { code: 'held' });
  const retiredSource = await captureNativeRestartReadiness(options);
  assert.doesNotThrow(retiredSource.assertCurrent);

  await t.test('other selected consumer metadata still holds after retirement', t => {
    const read = f.launch.readModelReadinessSource.bind(f.launch);
    const changed = t.mock.method(f.launch, 'readModelReadinessSource',
      (input: Parameters<TeamLaunchOwner['readModelReadinessSource']>[0]) => {
        const source = read(input); assert.ok(source);
        return { ...source, consumer: { ...source.consumer, actorDigest: digest('TEST-other-actor') } };
      });
    try { assert.throws(retiredSource.assertCurrent, { code: 'held' }); }
    finally { changed.mock.restore(); }
    assert.doesNotThrow(retiredSource.assertCurrent);
  });
  await t.test('an originally retired consumer cannot become active again', t => {
    const read = f.launch.readModelReadinessSource.bind(f.launch);
    const changed = t.mock.method(f.launch, 'readModelReadinessSource',
      (input: Parameters<TeamLaunchOwner['readModelReadinessSource']>[0]) => {
        const source = read(input); assert.ok(source);
        return { ...source, consumer: { ...source.consumer, disposition: 'consumed' as const } };
      });
    try { assert.throws(retiredSource.assertCurrent, { code: 'held' }); }
    finally { changed.mock.restore(); }
    assert.doesNotThrow(retiredSource.assertCurrent);
  });
  await t.test('an originally retired probe cannot lose its retirement flag', () => {
    const { readinessRetired: _retired, ...active } = retiredProbe;
    f.records.write(active);
    try { assert.throws(retiredSource.assertCurrent, { code: 'held' }); }
    finally { f.records.write(retiredProbe); }
    assert.doesNotThrow(retiredSource.assertCurrent);
  });
  assert.equal(f.contexts.length, 1, 'historical inspections never allocate another provider');
  assert.equal([...f.records.list()].length, 2, 'historical inspections never create another probe');
});

test('all-target reservation refuses before changing an earlier member and never overwrites equal proof', async t => {
  const f = await fixture(t), a = f.entries.get('A')!, b = f.entries.get('B')!;
  const original = f.install(a), beforeB = f.launch.readModelReadiness(f.selected(b));
  assert.throws(() => assertMemberModelReadinessFileHandoffsAvailable([b, a]), { code: 'held' });
  assert.throws(() => f.install(a), { code: 'held' });
  assert.equal(a.modelReadinessFileHandoff, original);
  assert.deepEqual(f.launch.readModelReadiness(f.selected(b)), beforeB);
  assert.equal(b.modelReadinessFileHandoff, undefined);
  settleMemberModelReadinessFileHandoff({ ...f.options(a), handoff: original });
  assert.equal(a.modelReadinessFileHandoff, undefined, 'an unclaimed original is cleared');
});

test('partial aggregate start keeps the claimed first proof and clears only the unclaimed second proof', async t => {
  const f = await fixture(t), a = f.entries.get('A')!, b = f.entries.get('B')!;
  const originalA = f.install(a), originalB = f.install(b);
  f.denied.add('B');
  assert.throws(() => f.launch.start('TEST-start'), { code: 'hold' });
  settleMemberModelReadinessFileHandoff({ ...f.options(a), handoff: originalA });
  settleMemberModelReadinessFileHandoff({ ...f.options(b), handoff: originalB });
  assert.equal(a.modelReadinessFileHandoff, originalA);
  assert.equal(b.modelReadinessFileHandoff, undefined);
  assert.equal(f.launch.readModelReadiness(f.selected(a)).attempt.claimed, true);
  assert.equal(f.launch.readModelReadiness(f.selected(b)).attempt.claimed, false);
  await f.progressed;
  assert.deepEqual(f.contexts.map(context => context.profile.memberId), ['A']);
  assert.equal(f.progress, 1);
});

test('queued authority, seal, cutoff and original-read failures clear the unused slot and forward progress once', async t => {
  for (const failure of ['authority', 'seal', 'cutoff', 'read'] as const) await t.test(failure, async t => {
    const f = await fixture(t), entry = f.entries.get('A')!;
    const original = f.install(entry);
    const guard = () => { readMemberModelReadinessFileKey(f.options(entry)); };
    const opening = f.launch.startMember('A', guard); assert.ok(opening);
    let restore: (() => void) | undefined;
    if (failure === 'authority') f.revokeWriter();
    else if (failure === 'seal') f.seal();
    else if (failure === 'cutoff') {
      const mocked = t.mock.method(Date, 'now', () => original.cutoff);
      restore = () => mocked.mock.restore();
    } else {
      const mocked = t.mock.method(f.launch, 'readModelReadiness', () => { throw new Error('TEST original read failed'); });
      restore = () => mocked.mock.restore();
    }
    try {
      await opening;
      assert.equal(entry.modelReadinessFileHandoff, undefined);
      assert.equal(f.runtime.readCapturedSession(entry.binding).record, undefined,
        'the failed queued guard never enters Runtime.open');
      assert.equal(f.contexts.length, 0);
      assert.equal(f.progress, 1, 'cleanup failure must still forward the original progress callback once');
    } finally { restore?.(); }
  });
});

test('production factory takes before its first worktree await and keeps the original proof in its invocation', async t => {
  const f = await fixture(t), entry = f.entries.get('A')!, first = f.prepared.get('A')!;
  const replacementPair = await capturePreparedModelReference({ management: f.management, profile: entry.profile,
    commandId: first.reference.commandId, context: first.reference.context, kind: 'native', isCurrent: () => true });
  assert.notEqual(first.fileKey?.proof, replacementPair.fileKey?.proof);
  const original = f.install(entry), opening = f.launch.startMember('A'); assert.ok(opening);
  await Promise.resolve();
  assert.equal(entry.modelReadinessFileHandoff, undefined, 'take is synchronous before the first worktree await');
  assert.equal(f.contexts.length, 0, 'provider has not yet been constructed');
  const replacement = f.install(entry, replacementPair);
  settleMemberModelReadinessFileHandoff({ ...f.options(entry), handoff: original });
  assert.equal(entry.modelReadinessFileHandoff, replacement, 'late cleanup cannot clear a different slot');
  await opening;
  assert.equal(f.contexts[0]?.readinessFileKey, first.fileKey?.proof);
  assert.notEqual(f.contexts[0]?.readinessFileKey, replacementPair.fileKey?.proof);
  assert.equal(f.runtime.readCapturedSession(entry.binding).record?.phase, 'allocated');
  assert.equal(f.progress, 1, 'the original terminal progress callback is forwarded once');
  assert.equal(entry.modelReadinessFileHandoff, undefined,
    'terminal progress clears the unused replacement slot after the original factory consumes its own proof');
});

test('a worktree read failure after the factory takes the proof cannot reach native construction', async t => {
  const f = await fixture(t), entry = f.entries.get('A')!;
  f.install(entry);
  let worktreeReads = 0;
  // Inject the original source-read failure at the real worktree boundary, after synchronous take.
  Object.defineProperty(entry, 'liveRosterCapture', { configurable: true, get() {
    if (entry.modelReadinessFileHandoff !== undefined) return undefined;
    worktreeReads++;
    throw new Error('TEST original worktree read failed');
  } });
  const opening = f.launch.startMember('A'); assert.ok(opening);
  await opening;
  delete entry.liveRosterCapture;
  assert.equal(worktreeReads, 1);
  assert.equal(entry.modelReadinessFileHandoff, undefined);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.runtime.readCapturedSession(entry.binding).record?.phase, 'held');
  assert.equal(f.progress, 1);
});
