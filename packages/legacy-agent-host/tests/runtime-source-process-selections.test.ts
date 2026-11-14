import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileRuntimeSourceIndex } from '../dist/adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { RuntimeSourceIndex } from '../dist/composition/RuntimeSourceIndex.js';
import { captureMemberProcessOrigin, captureRuntimeSourceProcessOrigin } from '../dist/composition/captureRuntimeProcessOrigin.js';
import { captureRuntimeSource, compileRuntimeCapture } from '../dist/composition/runtimeCaptureSource.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { runtimeSourceProcessOriginSchema, runtimeSourceRecipeIdentity } from '../dist/composition/runtimeSourceProcessOrigin.js';
import { teamHostProfileSchema } from '../dist/composition/TeamHost.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { WindowsCapturedProcess } from '../dist/adapters/providers/WindowsCapturedProcess.js';
import { publishRuntimeSourceSchema } from '../dist/composition/runtimeSourceContracts.js';
import { providerManagementProfileSchema } from '../dist/management/profile.js';
import { readPreparedRuntimeSourcePublication, readRetainedRuntimeSourceSelections,
  readRuntimeSourceConfigurationVersion, runtimeSourceProcessContextSchema } from '../dist/owned-process/runtimeSourceSelections.js';
import { runtimeDigest } from '../dist/runtime/identity.js';

import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { PublishRuntimeSource, RuntimeSourceCandidate, RuntimeSourceGrant } from '../dist/composition/runtimeSourceContracts.js';
import type { StoredRuntimeSourceCommand } from '../dist/management/commandRecords.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, provider: 'codex' | 'opencode' = 'codex') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-source-process-history-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = (name: string) => {
    const bytes = `TEST immutable source ${name}; never executed\n`, path = join(root, name);
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const executable = binary('TEST-seed'), environment = { HOME: root, CODEX_HOME: root, PATH: root };
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'TEST-human', teams: [],
    creation: { contextIds: ['TEST-context'] },
    owner: { ownerId: 'TEST-owner', revision: 'TEST-owner-v1', profileId: 'TEST-bootstrap',
      storageRoot: root, protocolVersion: 1, buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    management: [{ profileId: 'TEST-management', configRevision: 'TEST-config',
      accountBinding: 'TEST-account', cwd: root, executable, environment, timeoutMs: 1000,
      ...(provider === 'codex' ? { provider, protocolRevision: '0.162.0' } :
        { provider, nativeGeneration: 'v1', endpoint: 'http://127.0.0.1:19182' }) }] };
  profile.management = profile.management!.map(seed => providerManagementProfileSchema.parse(seed));
  const grant: RuntimeSourceGrant = { targetId: 'c'.repeat(64), ownerId: profile.owner.ownerId,
    ownerRevision: profile.owner.revision, contextId: 'TEST-context', projectPath: root, runtimeId: provider,
    profileId: 'TEST-management', configRevision: 'TEST-config', teamScopes: [] };
  const context = () => runtimeSourceProcessContextSchema.parse(profile);
  let nativeReads = 0;
  const open = () => new RuntimeSourceIndex(profile, () => {}, { createNativeCheck: (_seed, candidate) => ({
    run: async () => { nativeReads++; return { nativeVersion: candidate.nativeCli!.version }; },
    close: async () => true,
  }) });
  const candidate = (name: string): RuntimeSourceCandidate => {
    const selected = binary(name);
    return { sourceKind: 'app-managed', executable: selected, nativeCli: { executable: selected,
      version: provider === 'codex' ? '0.162.0' : '1.19.4',
      ...(provider === 'opencode' ? { generation: 'v1' } : {}) } };
  };
  const pending = (input: PublishRuntimeSource, phase: StoredRuntimeSourceCommand['phase'] = 'prepared') => {
    input = publishRuntimeSourceSchema.parse(input);
    const selection = { previousRevision: input.expectedRevision, commandId: input.commandId,
      grant: input.grant, candidate: input.candidate, ...(input.intent ? { intent: input.intent } : {}) };
    const receipt: StoredRuntimeSourceCommand = { schemaVersion: 1, kind: 'runtime.source',
      commandId: input.commandId, profileId: input.grant.profileId, configRevision: input.grant.configRevision,
      providerId: input.grant.runtimeId, fingerprint: runtimeDigest(input), selectionDigest: runtimeDigest({ grant, seed: profile.management![0]! }),
      resourceId: input.grant.targetId, sourceId: input.grant.targetId,
      revision: runtimeDigest(selection), expectedRevision: input.expectedRevision,
      publicationJson: JSON.stringify(input), phase, resourceHeld: phase === 'verifying' || phase === 'held',
      ...(phase === 'verified' || phase === 'published' ? { nativeVersion: input.candidate.nativeCli!.version } : {}) };
    new FileManagementCommandStore(root).write(receipt);
    return receipt;
  };
  return { root, profile, grant, context, open, candidate, pending, reads: () => nativeReads };
}

test('Main read-only source observation creates no index, journal or native work', t => {
  const f = fixture(t), before = readdirSync(f.root);
  assert.deepEqual(readRetainedRuntimeSourceSelections(f.context(), [f.grant], () => {}), []);
  assert.equal(readPreparedRuntimeSourcePublication(f.context(), f.grant, () => {}), undefined);
  assert.deepEqual(readdirSync(f.root), before);
  assert.throws(() => new FileRuntimeSourceIndex(f.root, () => {}, true));
  assert.throws(() => new FileManagementCommandStore(f.root, true));
  assert.deepEqual(readdirSync(f.root), before);
  assert.equal(f.reads(), 0);
});

test('original released A and B remain eligible after publication and cold read; no latest substitution', async t => {
  const f = fixture(t), owner = f.open();
  for (const name of ['TEST-A', 'TEST-B']) await owner.publish({ grant: f.grant, commandId: name,
    expectedRevision: owner.current({ grant: f.grant }).revision, candidate: f.candidate(name) }, () => {});
  const history = readRetainedRuntimeSourceSelections(f.context(), [f.grant], () => {});
  assert.deepEqual(history.map(row => row.record.commandId), ['TEST-A', 'TEST-B']);
  assert.notEqual(history[0]!.record.revision, history[1]!.record.revision);
  assert.deepEqual(readRetainedRuntimeSourceSelections(f.context(), [{ ...f.grant, contextId: 'TEST-foreign' }], () => {}), []);
  assert.equal(f.reads(), 2);
  const source = new FileRuntimeSourceIndex(f.root, () => {}, true), commands = new FileManagementCommandStore(f.root, true);
  assert.throws(() => source.publish(history[0]!.record, '0'.repeat(64)));
  assert.throws(() => commands.write(commands.read('TEST-A')!));
  assert.equal(f.reads(), 2);
});

test('changed original seed becomes unavailable and corrupt or dangling successful history is held', async t => {
  const f = fixture(t), owner = f.open(), candidate = f.candidate('TEST-A');
  await owner.publish({ grant: f.grant, commandId: 'TEST-A', expectedRevision: owner.current({ grant: f.grant }).revision,
    candidate }, () => {});
  const changed = f.context(); changed.management![0]!.accountBinding = 'TEST-other-account';
  assert.deepEqual(readRetainedRuntimeSourceSelections(changed, [f.grant], () => {}), []);
  const store = new FileManagementCommandStore(f.root), saved = store.read('TEST-A')!;
  store.write({ ...saved, fingerprint: 'e'.repeat(64) });
  assert.throws(() => readRetainedRuntimeSourceSelections(f.context(), [f.grant], () => {}));
  store.write(saved);
  const input = { grant: f.grant, commandId: 'TEST-dangling', expectedRevision: owner.current({ grant: f.grant }).revision, candidate };
  f.pending(input, 'published');
  assert.throws(() => readRetainedRuntimeSourceSelections(f.context(), [f.grant], () => {}));
});

test('only explicit recovery reads an original prepared never-allocated snapshot', t => {
  const f = fixture(t), owner = f.open();
  const input: PublishRuntimeSource = { grant: f.grant, commandId: 'TEST-prepared',
    expectedRevision: owner.current({ grant: f.grant }).revision, candidate: f.candidate('TEST-next') };
  f.pending(input);
  assert.deepEqual(readPreparedRuntimeSourcePublication(f.context(), f.grant, () => {}), input);
  for (const phase of ['verifying', 'held', 'verified'] as const) {
    f.pending(input, phase);
    assert.equal(readPreparedRuntimeSourcePublication(f.context(), f.grant, () => {}), undefined);
  }
  f.pending(input);
  assert.throws(() => readPreparedRuntimeSourcePublication(f.context(), { ...f.grant, contextId: 'TEST-foreign' }, () => {}));
  const store = new FileManagementCommandStore(f.root), saved = store.read(input.commandId)!;
  store.write({ ...saved, fingerprint: 'd'.repeat(64) });
  assert.throws(() => readPreparedRuntimeSourcePublication(f.context(), f.grant, () => {}));
  assert.equal(f.reads(), 0);
});

test('configuration version check uses its exact published predecessor or original prepared snapshot', async t => {
  const f = fixture(t, 'opencode'), owner = f.open();
  const seedRevision = owner.current({ grant: f.grant }).revision;
  assert.equal(readRuntimeSourceConfigurationVersion(f.context(), f.grant,
    { commandId: 'TEST-first-config', expectedRevision: seedRevision }, () => {}), undefined);
  const candidate = f.candidate('TEST-A');
  const published = await owner.publish({ grant: f.grant, commandId: 'TEST-A', expectedRevision: seedRevision, candidate }, () => {});
  const request = { commandId: 'TEST-config', expectedRevision: published.selection!.revision };
  assert.deepEqual(readRuntimeSourceConfigurationVersion(f.context(), f.grant, request, () => {})?.candidate, candidate);
  const input: PublishRuntimeSource = { ...request, grant: f.grant, candidate: { ...candidate,
    openCodePreferences: { defaultModelId: null, modelLimitOverrides: {} } }, intent: 'configuration' };
  f.pending(input);
  assert.deepEqual(readRuntimeSourceConfigurationVersion(f.context(), f.grant, request, () => {}), input);
  f.pending(input, 'verifying');
  assert.equal(readRuntimeSourceConfigurationVersion(f.context(), f.grant, request, () => {}), undefined);
  assert.throws(() => readRuntimeSourceConfigurationVersion(f.context(), f.grant,
    { ...request, expectedRevision: seedRevision }, () => {}));
  assert.equal(f.reads(), 1);
});

function runtimeFixture(t: TestContext, custody: 'main' | 'whole-job' | 'scoped-without-main') {
  const f = fixture(t);
  const scope = { teamId: 'TEST-team', projectId: 'TEST-project', workspaceId: 'TEST-workspace',
    runId: 'TEST-run', memberId: 'TEST-human', generation: '1' };
  const broker = { path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64), arch: 'x64' as const,
    protocol: 1 as const,
    ...(custody === 'scoped-without-main' ? { capability: 'service-scopes-v1' as const } : {}) };
  f.profile.management![0]!.windowsBroker = broker;
  const seed = runtimeMemberProfileSchema.parse({ provider: 'codex', protocolRevision: '0.162.0',
    teamId: scope.teamId, memberId: 'TEST-lead', principalId: 'TEST-agent',
    sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-runtime-config',
    model: 'TEST-model', accountBinding: 'TEST-account', cwd: f.root,
    executable: f.profile.management![0]!.executable, environment: f.profile.management![0]!.environment,
    windowsBroker: broker, nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' },
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 4096, outputEvents: 128,
      pendingInteractions: 1, timeoutMs: 1000 } });
  f.profile.runtime = { members: [seed] };
  if (custody === 'main') f.profile.processCustody = { kind: 'main-windows-v1' };
  f.profile.teams = [{ binding: { backendId: f.profile.owner.ownerId, teamId: scope.teamId,
    teamName: 'test-source-origin' }, scope,
    members: [{ memberId: seed.memberId, name: 'team-lead', role: 'lead' }],
    grants: [{ principalId: f.profile.principalId, memberName: 'user', permissions: ['read', 'admin'] }] }];
  f.grant.teamScopes = [{ teamId: scope.teamId, projectId: scope.projectId, workspaceId: scope.workspaceId }];
  // Use the complete original private profile and its full Team scope, not a hand-trimmed Main surrogate.
  assert.deepEqual(teamHostProfileSchema.parse(f.profile), f.profile);
  const owner = f.open(), team = { definition: f.profile.teams[0]! };
  const capture = () => captureRuntimeSource(f.profile, team, 'TEST-model-preflight', 'TEST-roster', {
    revision: 'f'.repeat(64), savedSettings: { cwd: f.root }, removedMembers: [],
    members: [{ memberId: seed.memberId, name: 'team-lead', role: 'lead', settings: {} }],
  }, { deferMcp: true, sources: owner });
  return { ...f, scope, seed, owner, team, capture };
}

test('complete original Team scopes and member references produce private exact origins without changing retained bytes', async t => {
  const f = runtimeFixture(t, 'main'), seedCapture = f.capture();
  assert.equal(captureRuntimeSourceProcessOrigin(f.profile, f.scope, f.scope.teamId,
    seedCapture, f.seed, f.owner), undefined, 'a seed capture does not inherit a later source');
  assert.deepEqual(runtimeSourceProcessContextSchema.parse(f.profile).teams[0]!.scope, f.grant.teamScopes[0]);
  const candidate = f.candidate('TEST-published.exe');
  const first = await f.owner.publish({ grant: f.grant, commandId: 'TEST-origin-A',
    expectedRevision: f.owner.current({ grant: f.grant }).revision, candidate }, () => {});
  const captureA = f.capture(), bytesA = JSON.stringify(captureA);
  const profileA = compileRuntimeCapture(f.profile, f.team, captureA, 'model-preflight', f.owner).profiles[0]!;
  const profileBytes = JSON.stringify(profileA), probeA = teamModelProbeProfile(profileA);
  const recipeA = f.owner.resolveRecipe(captureA.recipeSources![0]!, f.scope, f.root, f.seed);
  const originA = captureRuntimeSourceProcessOrigin(f.profile, f.scope, f.scope.teamId, captureA, profileA, f.owner)!;
  assert.deepEqual(originA, { sourceId: f.grant.targetId, revision: first.selection!.revision,
    origin: { kind: 'runtime', scope: f.grant.teamScopes[0], projectPath: f.root,
      teamId: f.scope.teamId, memberId: f.seed.memberId, recipeIdentity: runtimeSourceRecipeIdentity(f.seed) } });
  assert.deepEqual(runtimeSourceProcessOriginSchema.parse(originA), originA);
  assert.throws(() => runtimeSourceProcessOriginSchema.parse({ ...originA, memberId: f.seed.memberId }));
  assert.throws(() => runtimeSourceProcessOriginSchema.parse({ ...originA,
    origin: { ...originA.origin, scope: f.scope } }), 'wire origin remains strict');
  const receiptA = new FileManagementCommandStore(f.root).read('TEST-origin-A');
  const second = await f.owner.publish({ grant: f.grant, commandId: 'TEST-origin-B',
    expectedRevision: first.selection!.revision, candidate }, () => {});
  const captureB = f.capture();
  const profileB = compileRuntimeCapture(f.profile, f.team, captureB, 'model-preflight', f.owner).profiles[0]!;
  const recipeB = f.owner.resolveRecipe(captureB.recipeSources![0]!, f.scope, f.root, f.seed);
  assert.deepEqual(recipeB, recipeA, 'two immutable source revisions can have identical private recipe bytes');
  assert.deepEqual(teamModelProbeProfile(recipeB), teamModelProbeProfile(recipeA),
    'equal private recipes retain their original equal model-probe IDs');
  assert.notEqual(profileB.configRevision, profileA.configRevision, 'full captures retain their original distinct source lineage');
  assert.deepEqual(compileRuntimeCapture(f.profile, f.team, captureA, 'model-preflight', f.owner).profiles[0], profileA);
  const originB = captureRuntimeSourceProcessOrigin(f.profile, f.scope, f.scope.teamId, captureB, profileB, f.owner)!;
  assert.equal(originB.revision, second.selection!.revision);
  assert.notEqual(originA.revision, originB.revision);
  assert.deepEqual(captureRuntimeSourceProcessOrigin(f.profile, f.scope, f.scope.teamId,
    captureA, profileA, f.owner), originA, 'A does not adopt the current B origin');
  assert.equal(JSON.stringify(captureA), bytesA);
  assert.equal(JSON.stringify(profileA), profileBytes);
  assert.deepEqual(new FileManagementCommandStore(f.root).read('TEST-origin-A'), receiptA);
  assert.equal('processOrigin' in captureA, false); assert.equal('processOrigin' in profileA, false);
  assert.equal(probeA.profileId, 'team-probe-' + runtimeDigest(profileA));
});

test('live member retains its own original source and rejects a capture from another configuration', async t => {
  const f = runtimeFixture(t, 'main'), candidate = f.candidate('TEST-live-source.exe');
  const first = await f.owner.publish({ grant: f.grant, commandId: 'TEST-live-origin-A',
    expectedRevision: f.owner.current({ grant: f.grant }).revision, candidate }, () => {});
  const initialCapture = f.capture();
  const seed = runtimeMemberProfileSchema.parse({ ...f.seed, memberId: 'TEST-live-member',
    principalId: 'TEST-live-agent', sessionId: 'TEST-live-session', configRevision: 'TEST-live-config' });
  f.profile.runtime!.members.push(seed);
  const sourceReference = { sourceId: f.grant.targetId, revision: first.selection!.revision };
  const baseProfile = { ...f.owner.resolveRecipe(sourceReference, f.scope, f.root, seed),
    cwd: join(f.root, 'TEST-selected-worktree') };
  const capture = { schemaVersion: 1, commandId: 'TEST-live-capture', requestDigest: '1'.repeat(64),
    sourceCaptureDigest: runtimeDigest(initialCapture), expectedRevision: '2'.repeat(64),
    launchId: f.scope.runId, sourceCwd: f.root, savedSettings: { cwd: f.root }, leadProvider: 'codex',
    member: { memberId: seed.memberId, name: 'live-member', role: 'member', settings: { providerId: 'codex' } },
    sourceReference, templateDigest: runtimeDigest(seed), previous: null,
    workspace: baseProfile.cwd, mcpRecipeReference: { memberId: seed.memberId, digest: '3'.repeat(64) },
    recipeDigest: runtimeDigest(seed), configurationDigest: runtimeDigest(baseProfile), runtimeGeneration: 1 };
  // Only private origin selection is exercised; this metadata cannot admit a Runtime allocation.
  const entry = { profile: baseProfile, baseProfile,
    team: { ...f.team, capture: initialCapture, launchId: f.scope.runId }, liveRosterCapture: capture,
  } as Parameters<typeof captureMemberProcessOrigin>[1];
  assert.equal(initialCapture.recipeSources!.some(row => row.memberId === seed.memberId), false);
  const original = captureMemberProcessOrigin(f.profile, entry, f.owner)!;
  assert.equal(original.revision, first.selection!.revision);
  assert.equal(original.origin.kind, 'runtime');
  if (original.origin.kind === 'runtime') {
    assert.equal(original.origin.memberId, seed.memberId);
    assert.equal(original.origin.projectPath, f.root, 'the original source cwd survives the worktree overlay');
  }
  await f.owner.publish({ grant: f.grant, commandId: 'TEST-live-origin-B',
    expectedRevision: first.selection!.revision, candidate }, () => {});
  assert.deepEqual(captureMemberProcessOrigin(f.profile, entry, f.owner), original);
  entry.liveRosterCapture = { ...entry.liveRosterCapture!, configurationDigest: '4'.repeat(64) };
  assert.throws(() => captureMemberProcessOrigin(f.profile, entry, f.owner), { code: 'held' });
  assert.equal(f.reads(), 2, 'origin reads and rejection perform no new native version checks');
});

for (const custody of ['whole-job', 'main', 'scoped-without-main'] as const)
  test(`source origin preserves original ${custody} admission without manufacturing Main ownership`, async t => {
    const f = runtimeFixture(t, custody), candidate = f.candidate('TEST-published.exe');
    await f.owner.publish({ grant: f.grant, commandId: 'TEST-publish',
      expectedRevision: f.owner.current({ grant: f.grant }).revision, candidate }, () => {});
    const captured = f.capture();
    const origin = captureRuntimeSourceProcessOrigin(f.profile, f.scope, f.scope.teamId, captured, f.seed, f.owner);
    assert.equal(origin !== undefined, custody === 'main');
    const reference = captured.recipeSources![0]!;
    assert.throws(() => f.owner.processOrigin(reference, { ...f.scope, teamId: 'TEST-foreign' }, f.root, f.seed));
    assert.throws(() => f.owner.processOrigin({ ...reference, revision: '0'.repeat(64) }, f.scope, f.root, f.seed));
    if (custody === 'scoped-without-main') assert.throws(() => new WindowsCapturedProcess({
      ...f.seed, executable: candidate.executable,
    }, () => true, () => {}), /Scoped Windows custody requires the original Main owner/);
  });
