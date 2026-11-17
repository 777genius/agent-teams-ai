import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { RuntimeSourceIndex } from '../dist/composition/RuntimeSourceIndex.js';
import { runtimeSourceNativeExecutableDigest, runtimeSourceSummarySchema } from '../dist/composition/runtimeSourceContracts.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { providerManagementProfileSchema } from '../dist/management/profile.js';
import {
  captureRuntimeSource,
  compileRuntimeCapture,
} from '../dist/composition/runtimeCaptureSource.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  RuntimeSourceCandidate,
  RuntimeSourceGrant,
  RuntimeSourcePublication,
  RuntimeSourceSummary,
} from '../dist/composition/runtimeSourceContracts.js';
import type { TeamRosterConfiguration } from '../dist/team/rosterContracts.js';
import type { TestContext } from 'node:test';

function fixture(provider: 'claude' | 'codex' = 'claude') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-runtime-source-')));
  mkdirSync(join(root, '.claude'), { mode: 0o700 });
  const bytes = '#!/bin/sh\nprintf TEST-source-fixture\n';
  const executable = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const original = executable('TEST-original'),
    replacement = executable('TEST-replacement');
  const environment = {
    HOME: root,
    PATH: '/usr/bin',
    TEST_AUTH_VALUE: 'TEST-do-not-persist-secret',
    ...(provider === 'codex' ? { CODEX_HOME: root } : {}),
  };
  const scope = {
    projectId: 'TEST-host-project',
    workspaceId: 'TEST-host-workspace',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-human',
    generation: '0',
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-owner-v1',
      storageRoot: root,
      profileId: 'TEST-bootstrap',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    management: [
      providerManagementProfileSchema.parse({
        provider,
        ...(provider === 'claude' ? { sdkRevision: '0.3.305' as const } : {}),
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        ...(provider === 'claude' ? { configNamespace: 'native-default' as const } : {}),
        accountBinding: 'TEST-account',
        cwd: root,
        environment,
        executable: original,
        timeoutMs: 1000,
        ...(provider === 'codex' ? { protocolRevision: '0.162.0' as const } : {}),
      }),
    ],
    runtime: {
      members: [
        runtimeMemberProfileSchema.parse({
          provider,
          teamId: 'TEST-team',
          memberId: 'lead',
          principalId: 'TEST-agent',
          sessionId: 'TEST-session',
          generation: 0,
          configRevision: 'TEST-runtime-config',
          model: 'TEST-model',
          accountBinding: 'TEST-account',
          cwd: root,
          environment,
          executable: original,
          ...(provider === 'claude' ? { nativeTools: ['Read'], autoAllowedTools: ['Read'] } : {
            protocolRevision: '0.162.0' as const,
            nativeOptions: { approvalPolicy: 'never' as const, sandbox: 'read-only' as const },
          }),
          limits: {
            queuedInputs: 8,
            inputBytes: 4096,
            outputBytes: 8192,
            outputEvents: 128,
            pendingInteractions: 8,
            timeoutMs: 1000,
          },
        }),
      ],
    },
    teams: [
      {
        binding: { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-source-team' },
        scope,
        members: [{ memberId: 'lead', name: 'captain', role: 'lead' }],
        grants: [],
      },
    ],
  };
  const grant: RuntimeSourceGrant = {
    targetId: 'c'.repeat(64),
    ownerId: profile.owner.ownerId,
    ownerRevision: profile.owner.revision,
    contextId: 'TEST-desktop-context',
    projectPath: root,
    runtimeId: provider,
    profileId: 'TEST-management',
    configRevision: 'TEST-config',
    teamScopes: [
      { teamId: scope.teamId, projectId: scope.projectId, workspaceId: scope.workspaceId },
    ],
  };
  const roster: TeamRosterConfiguration = {
    revision: 'd'.repeat(64),
    savedSettings: { cwd: root },
    removedMembers: [],
    members: [{ memberId: 'lead', name: 'captain', role: 'lead', settings: {} }],
  };
  const candidate: RuntimeSourceCandidate = { sourceKind: 'app-managed', executable: replacement };
  return {
    root,
    profile,
    grant,
    candidate,
    original,
    replacement,
    roster,
    team: { definition: profile.teams[0]! },
  };
}

function leased(t: TestContext, provider: 'claude' | 'codex' = 'claude') {
  const f = fixture(provider);
  let lease = acquireProfileWriterLease(f.root);
  let nativeChecks = 0;
  t.after(() => {
    lease.release();
    rmSync(f.root, { recursive: true, force: true });
  });
  const open = () => {
    const captured = lease;
    return new RuntimeSourceIndex(f.profile, () => captured.assertCurrent(), provider === 'codex' ? {
      createNativeCheck: (_seed, candidate, current) => {
        const version = candidate.nativeCli?.version;
        assert.ok(version);
        return {
          run: async () => { assert.ok(current()); nativeChecks++; return { nativeVersion: version }; },
          close: async () => true,
        };
      },
    } : {});
  };
  let index = open();
  return {
    ...f,
    get index() {
      return index;
    },
    get nativeChecks() { return nativeChecks; },
    restart() {
      lease.release();
      lease = acquireProfileWriterLease(f.root);
      index = open();
    },
  };
}

test('publication pins new captures while seed and retained captures replay unchanged after a cold restart', async (t) => {
  const f = leased(t), firstScope = f.grant.teamScopes[0]!;
  const otherScope = { ...firstScope, teamId: 'TEST-second-team' };
  f.profile.teams.push({ ...f.profile.teams[0]!,
    binding: { ...f.profile.teams[0]!.binding, teamId: otherScope.teamId, teamName: 'second-source-team' },
    scope: { ...f.profile.teams[0]!.scope, teamId: otherScope.teamId } });
  f.grant.teamScopes = [firstScope, otherScope, firstScope];
  const equivalent = { ...f.grant, teamScopes: [otherScope, firstScope] };
  const initial = f.index.current({ grant: f.grant });
  assert.equal(initial.nativeExecutableDigest, undefined, 'the identity projection is Codex-only');
  const seed = captureRuntimeSource(f.profile, f.team, 'TEST-seed', 'TEST-roster', f.roster, {
    deferMcp: true,
  });
  const seedJson = JSON.stringify(seed);
  assert.equal(seed.recipeSources, undefined);
  const input = {
    grant: f.grant,
    commandId: 'TEST-publish-1',
    expectedRevision: initial.revision,
    candidate: f.candidate,
  };
  const first = await f.index.publish(input, () => {});
  assert.equal(first.phase, 'published');
  const originalBytes = readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8');
  const originalReceipt = JSON.stringify(new FileManagementCommandStore(f.root).read(input.commandId));
  assert.deepEqual(f.index.current({ grant: equivalent }), first.selection);
  assert.deepEqual(f.index.lookup({ grant: equivalent, commandId: input.commandId }), first);
  assert.throws(() => f.index.current({ grant: { ...equivalent, teamScopes: [firstScope] } }),
    { code: 'conflict' }, 'removing a real scope is not alias deduplication');
  assert.deepEqual(
    await f.index.publish({ ...input, grant: equivalent }, () => assert.fail('replay must not re-admit')),
    first
  );
  assert.equal(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8'), originalBytes);
  assert.equal(JSON.stringify(new FileManagementCommandStore(f.root).read(input.commandId)), originalReceipt);
  const selected = captureRuntimeSource(f.profile, f.team, 'TEST-new', 'TEST-roster', f.roster, {
    deferMcp: true,
    sources: f.index,
  });
  assert.equal(selected.recipeSources?.[0]?.revision, first.selection?.revision);
  assert.throws(() => f.index.resolveRecipe(selected.recipeSources![0]!,
    { ...f.team.definition.scope, teamId: 'TEST-foreign-team' }, f.root, f.profile.runtime!.members[0]!), { code: 'held' });
  const next = await f.index.publish(
    {
      grant: equivalent,
      commandId: 'TEST-publish-2',
      expectedRevision: first.selection!.revision,
      candidate: { ...f.candidate, executable: f.original, sourceKind: 'override' },
    },
    () => {}
  );
  await assert.rejects(
    f.index.publish({ ...input, commandId: 'TEST-stale' }, () => {}),
    { code: 'conflict' }
  );
  assert.deepEqual(f.index.lookup({ grant: f.grant, commandId: input.commandId }), first);
  f.restart();
  assert.equal(f.index.current({ grant: equivalent }).revision, next.selection!.revision);
  const retainedIndex = JSON.parse(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8'));
  assert.deepEqual(retainedIndex.records.map((row: { grant: RuntimeSourceGrant }) => row.grant), [f.grant, f.grant]);
  assert.deepEqual(
    compileRuntimeCapture(f.profile, f.team, selected, 'model-preflight', f.index).profiles[0]!
      .executable,
    f.replacement
  );
  assert.deepEqual(
    compileRuntimeCapture(f.profile, f.team, seed, 'model-preflight', f.index).profiles[0]!
      .executable,
    f.original
  );
  assert.equal(JSON.stringify(seed), seedJson);
  assert.equal(f.index.retained({ grant: equivalent }).length, 3);
  assert.equal(
    f.index.retainedManagementProfiles()[0]!.environment.TEST_AUTH_VALUE,
    'TEST-do-not-persist-secret'
  );
  assert.equal(
    readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8').includes(
      'TEST-do-not-persist-secret'
    ),
    false
  );
  rmSync(join(f.root, 'runtime-sources', 'index.json'));
  assert.throws(() => f.index.current({ grant: f.grant }), { code: 'held' });
  assert.throws(() => f.restart(), { code: 'held' }, 'missing published index cannot fall back to the seed after restart');

  const codex = leased(t, 'codex'), profileBytes = JSON.stringify(codex.profile);
  const captured = codex.index.current({ grant: codex.grant });
  assert.equal(captured.cliVersion, undefined, 'an initial protocol label is not a measured CLI version');
  assert.equal(captured.nativeExecutableDigest, runtimeSourceNativeExecutableDigest(codex.original));
  assert.equal(runtimeSourceNativeExecutableDigest({ sha256: codex.original.sha256, path: codex.original.path }),
    captured.nativeExecutableDigest, 'the executable digest has one canonical property order');
  assert.notEqual(runtimeSourceNativeExecutableDigest({ ...codex.original, sha256: 'f'.repeat(64) }),
    captured.nativeExecutableDigest, 'the same pathname with different bytes is a different executable');
  assert.throws(() => runtimeSourceNativeExecutableDigest({ path: 'relative', sha256: codex.original.sha256 }));
  assert.equal(runtimeSourceSummarySchema.safeParse({ ...captured, nativeExecutableDigest: 'invalid' }).success, false);
  const seedCapture = captureRuntimeSource(codex.profile, codex.team, 'TEST-codex-seed', 'TEST-roster', codex.roster,
    { deferMcp: true });
  const seedCaptureBytes = JSON.stringify(seedCapture);
  const original = await codex.index.publish({ grant: codex.grant, commandId: 'TEST-codex-A',
    expectedRevision: captured.revision, candidate: { sourceKind: 'captured', executable: codex.original,
      nativeCli: { executable: codex.original, version: '0.162.0' } } }, () => {});
  assert.equal(original.phase, 'published');
  const oldCapture = captureRuntimeSource(codex.profile, codex.team, 'TEST-codex-retained', 'TEST-roster', codex.roster,
    { deferMcp: true, sources: codex.index });
  const oldCaptureBytes = JSON.stringify(oldCapture);
  const store = new FileManagementCommandStore(codex.root);
  const receiptBytes = JSON.stringify(store.read(original.commandId));
  const recordBytes = JSON.stringify(JSON.parse(readFileSync(join(codex.root, 'runtime-sources', 'index.json'), 'utf8')).records[0]);
  const version = process.platform === 'darwin' && process.arch === 'arm64' ? '0.169.0' : '0.162.0';
  const replacementInput = { grant: codex.grant, commandId: 'TEST-codex-B', expectedRevision: original.selection!.revision,
    nativeSelection: { sourceKind: 'app-managed', nativeCli: { executable: codex.replacement, version } } };
  const replacement = await codex.index.publish(replacementInput, selected => {
    assert.ok(selected.provider === 'codex');
    assert.equal(selected.protocolRevision, version, 'metadata follows the exact verified native version');
  });
  assert.equal(replacement.phase, 'published');
  assert.equal(replacement.selection?.cliVersion, version);
  assert.equal(replacement.selection?.nativeExecutableDigest, runtimeSourceNativeExecutableDigest(codex.replacement));
  const newCapture = captureRuntimeSource(codex.profile, codex.team, 'TEST-codex-new', 'TEST-roster', codex.roster,
    { deferMcp: true, sources: codex.index });
  const indexBytes = readFileSync(join(codex.root, 'runtime-sources', 'index.json'), 'utf8');
  codex.restart();
  const oldProfile = compileRuntimeCapture(codex.profile, codex.team, oldCapture, 'model-preflight', codex.index).profiles[0]!;
  const newProfile = compileRuntimeCapture(codex.profile, codex.team, newCapture, 'model-preflight', codex.index).profiles[0]!;
  assert.ok(oldProfile.provider === 'codex' && newProfile.provider === 'codex');
  assert.equal(oldProfile.protocolRevision, '0.162.0');
  assert.equal(newProfile.protocolRevision, version, 'fresh members follow B without relabelling retained A');
  assert.deepEqual(oldProfile.executable, codex.original);
  assert.deepEqual(newProfile.executable, codex.replacement);
  const retained = codex.index.retainedManagementProfiles();
  const oldManagement = retained.find(row => row.profileId === original.selection!.profileId);
  const newManagement = retained.find(row => row.profileId === replacement.selection!.profileId);
  assert.ok(oldManagement?.provider === 'codex' && newManagement?.provider === 'codex');
  assert.equal(oldManagement.protocolRevision, '0.162.0');
  assert.equal(newManagement.protocolRevision, version);
  assert.deepEqual(await codex.index.publish(replacementInput, () => assert.fail('same original publication cannot re-admit')), replacement);
  assert.equal(codex.nativeChecks, 2, 'cold/current/replay never allocate another native verifier');
  assert.equal(readFileSync(join(codex.root, 'runtime-sources', 'index.json'), 'utf8'), indexBytes);
  assert.equal(JSON.stringify(JSON.parse(indexBytes).records[0]), recordBytes);
  assert.equal(JSON.stringify(store.read(original.commandId)), receiptBytes);
  assert.equal(JSON.stringify(codex.profile), profileBytes);
  assert.equal(JSON.stringify(seedCapture), seedCaptureBytes);
  assert.equal(JSON.stringify(oldCapture), oldCaptureBytes);
  for (const bytes of [indexBytes, receiptBytes, JSON.stringify(store.read(replacement.commandId)),
    profileBytes, seedCaptureBytes, oldCaptureBytes, JSON.stringify(newCapture)])
    assert.equal(bytes.includes('nativeExecutableDigest'), false, 'the private projection never rewrites stored or captured identity');
  await codex.index.close();
});

test('cold source history isolates an unavailable seed without falling through its selected project scope', async (t) => {
  const f = leased(t);
  const originalSeed = structuredClone(f.profile.management![0]!);
  const original = await f.index.publish({
    grant: f.grant, commandId: 'TEST-retained-A',
    expectedRevision: f.index.current({ grant: f.grant }).revision, candidate: f.candidate,
  }, () => {});
  assert.equal(original.phase, 'published');
  const originalReceipt = JSON.stringify(new FileManagementCommandStore(f.root).read(original.commandId));
  const originalRecord = JSON.parse(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8')).records[0];
  const other = structuredClone(f.profile.teams[0]!);
  other.binding = { ...other.binding, teamId: 'TEST-valid-B', teamName: 'test-valid-source-b' };
  other.scope = { ...other.scope, teamId: other.binding.teamId };
  f.profile.teams.push(other);
  const otherSeed = { ...originalSeed, profileId: 'TEST-management-B', configRevision: 'TEST-config-B' };
  f.profile.management!.push(otherSeed);
  const globalGrant = { ...f.grant, targetId: 'e'.repeat(64), projectPath: null,
    profileId: otherSeed.profileId, configRevision: otherSeed.configRevision };
  const global = await f.index.publish({
    grant: globalGrant, commandId: 'TEST-valid-global',
    expectedRevision: f.index.current({ grant: globalGrant }).revision, candidate: f.candidate,
  }, () => {});
  assert.equal(global.phase, 'published');
  f.profile.management = [otherSeed];
  const retainedBytes = readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8');
  f.restart();
  assert.deepEqual(f.index.current({ grant: globalGrant }), global.selection);
  const state = f.index.retainedManagementState();
  assert.deepEqual(state.unavailable, [{
    profileId: original.selection!.profileId, configRevision: original.selection!.configRevision,
  }]);
  assert.equal(state.profiles.length, 1);
  assert.throws(() => f.index.lookup({ grant: f.grant, commandId: original.commandId }), { code: 'conflict' });
  assert.throws(() => f.index.currentForRecipe(f.team.definition.scope, f.root,
    f.profile.runtime!.members[0]!), { code: 'held' }, 'selected project A cannot fall through to valid global B');
  assert.throws(() => captureRuntimeSource(f.profile, f.team, 'TEST-no-fallback', 'TEST-roster', f.roster,
    { deferMcp: true, sources: f.index }), { code: 'held' });
  assert.equal(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8'), retainedBytes);

  const grantB = { ...f.grant, targetId: 'f'.repeat(64), profileId: otherSeed.profileId,
    configRevision: otherSeed.configRevision, teamScopes: [{
      teamId: other.scope.teamId, projectId: other.scope.projectId, workspaceId: other.scope.workspaceId,
    }] };
  const valid = await f.index.publish({
    grant: grantB, commandId: 'TEST-valid-B-publication',
    expectedRevision: f.index.current({ grant: grantB }).revision, candidate: f.candidate,
  }, () => {});
  assert.equal(valid.phase, 'published');
  assert.deepEqual(f.index.lookup({ grant: grantB, commandId: valid.commandId }), valid);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8')).records[0],
    originalRecord);
  assert.equal(JSON.stringify(new FileManagementCommandStore(f.root).read(original.commandId)), originalReceipt);
  f.profile.management!.unshift(originalSeed);
  f.restart();
  assert.deepEqual(f.index.lookup({ grant: f.grant, commandId: original.commandId }), original);
  assert.deepEqual(f.index.resolveRecipe({ sourceId: f.grant.targetId, revision: original.selection!.revision },
    f.team.definition.scope, f.root, f.profile.runtime!.members[0]!).executable, f.replacement);

  f.profile.management = [otherSeed];
  const corrupt = JSON.parse(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8'));
  corrupt.records[0].previousRevision = '0'.repeat(64);
  writeFileSync(join(f.root, 'runtime-sources', 'index.json'), JSON.stringify(corrupt));
  assert.throws(() => f.restart(), { code: 'held' }, 'unavailable seed never hides corrupt original history');
});

test('member project source is captured before preparation and retained through cold compile', async (t) => {
  const f = leased(t), workerCwd = join(f.root, 'TEST-worker-project');
  mkdirSync(workerCwd);
  f.profile.management!.push({ ...f.profile.management![0]!, cwd: workerCwd,
    profileId: 'TEST-worker-management', configRevision: 'TEST-worker-config' });
  f.profile.runtime!.members.push({ ...f.profile.runtime!.members[0]!, memberId: 'worker',
    principalId: 'TEST-worker-agent', sessionId: 'TEST-worker-session', cwd: workerCwd });
  f.profile.teams[0]!.members.push({ memberId: 'worker', name: 'worker', role: 'member' });
  f.roster.members.push({ memberId: 'worker', name: 'worker', role: 'member', settings: { cwd: workerCwd } });
  const workerGrant = { ...f.grant, targetId: 'e'.repeat(64), projectPath: workerCwd,
    profileId: 'TEST-worker-management', configRevision: 'TEST-worker-config' };
  const lead = await f.index.publish({ grant: f.grant, commandId: 'TEST-lead-project',
    expectedRevision: f.index.current({ grant: f.grant }).revision, candidate: f.candidate }, () => {});
  const worker = await f.index.publish({ grant: workerGrant, commandId: 'TEST-worker-project',
    expectedRevision: f.index.current({ grant: workerGrant }).revision,
    candidate: { sourceKind: 'override', executable: f.original } }, () => {});
  const captured = captureRuntimeSource(f.profile, f.team, 'TEST-project-capture', 'TEST-roster', f.roster,
    { deferMcp: true, sources: f.index });
  assert.deepEqual(captured.recipeSources, [
    { memberId: 'lead', sourceId: f.grant.targetId, revision: lead.selection!.revision },
    { memberId: 'worker', sourceId: workerGrant.targetId, revision: worker.selection!.revision },
  ]);
  await f.index.publish({ grant: workerGrant, commandId: 'TEST-worker-new-default',
    expectedRevision: worker.selection!.revision, candidate: f.candidate }, () => {});
  f.restart();
  const profiles = compileRuntimeCapture(f.profile, f.team, captured, 'model-preflight', f.index).profiles;
  assert.deepEqual(profiles.map(row => ({ cwd: row.cwd, executable: row.executable })), [
    { cwd: f.root, executable: f.replacement }, { cwd: workerCwd, executable: f.original },
  ]);
});

test('source admission refuses scope widening, changed bytes and arbitrary configuration without changing current', async (t) => {
  const f = leased(t),
    initial = f.index.current({ grant: f.grant });
  const input = {
    grant: f.grant,
    commandId: 'TEST-refuse',
    expectedRevision: initial.revision,
    candidate: f.candidate,
  };
  for (const grant of [
    { ...f.grant, runtimeId: 'codex' },
    { ...f.grant, projectPath: tmpdir() },
    {
      ...f.grant,
      teamScopes: [{ teamId: 'foreign', projectId: 'foreign', workspaceId: 'foreign' }],
    },
  ])
    await assert.rejects(
      f.index.publish({ ...input, grant }, () => {}),
      { code: 'conflict' }
    );
  await assert.rejects(
    f.index.publish(
      { ...input, candidate: { ...f.candidate, environment: { HOME: '/foreign' } } },
      () => {}
    )
  );
  writeFileSync(f.replacement.path, '#!/bin/sh\nexit 2\n');
  await assert.rejects(
    f.index.publish(input, () => assert.fail('unverified bytes cannot be admitted'))
  );
  assert.deepEqual(f.index.current({ grant: f.grant }), initial);
  assert.deepEqual(f.index.lookup({ grant: f.grant, commandId: input.commandId }),
    { commandId: input.commandId, phase: 'held', reason: 'source-changed' });
  assert.equal(new FileManagementCommandStore(f.root).read(input.commandId)?.resourceHeld, false);
  assert.equal(
    f.index.currentForRecipe(
      { ...f.profile.teams[0]!.scope, teamId: 'foreign' },
      f.root,
      f.profile.runtime!.members[0]!
    ),
    undefined
  );
});

test('cold recovery keeps the original grant through prepared intent and lost pointer acknowledgement', async (t) => {
  const f = leased(t), equivalent = structuredClone(f.grant);
  f.grant.teamScopes.push({ ...f.grant.teamScopes[0]! });
  const current = f.index.current({ grant: f.grant });
  let interrupt: 'prepared' | 'published' = 'prepared';
  const write = FileManagementCommandStore.prototype.write;
  const fault = t.mock.method(
    FileManagementCommandStore.prototype,
    'write',
    function (this: FileManagementCommandStore, record: Parameters<typeof write>[0]) {
      if (record.kind === 'runtime.source' && record.phase === 'published' && interrupt === 'published')
        throw new Error('TEST crash before receipt completion');
      write.call(this, record);
      if (record.kind === 'runtime.source' && record.phase === 'prepared' && interrupt === 'prepared')
        throw new Error('TEST crash after prepared intent');
    }
  );
  const input = {
    grant: f.grant,
    commandId: 'TEST-interrupted-publication',
    expectedRevision: current.revision,
    candidate: f.candidate,
  };
  await assert.rejects(
    f.index.publish(input, () => {}),
    /TEST crash after prepared intent/
  );
  const original = new FileManagementCommandStore(f.root).read(input.commandId)!;
  assert.equal(original.kind, 'runtime.source');
  assert(original.kind === 'runtime.source');
  f.restart();
  interrupt = 'published';
  let admits = 0;
  await assert.rejects(f.index.recover({ grant: equivalent }, () => { admits++; }), /TEST crash before receipt completion/);
  assert.equal(admits, 1);
  fault.mock.restore();
  f.restart();
  const recovered = f.index.lookup({ grant: equivalent, commandId: input.commandId });
  assert.equal(recovered?.phase, 'published');
  assert.equal(f.index.current({ grant: f.grant }).revision, recovered?.selection?.revision);
  assert.deepEqual(
    await f.index.publish({ ...input, grant: equivalent }, () => assert.fail('recovery cannot re-admit')),
    recovered
  );
  assert.equal(new FileManagementCommandStore(f.root).read(input.commandId)?.phase, 'published');
  const saved = new FileManagementCommandStore(f.root).read(input.commandId)!;
  assert(saved.kind === 'runtime.source');
  for (const field of ['fingerprint', 'selectionDigest', 'revision', 'publicationJson'] as const)
    assert.equal(saved[field], original[field], 'the original request identity is not rewritten');
});

test('private Host RPC publishes and restores sources and admits existing Skills and extension targets', async (t) => {
  const f = fixture(),
    profile = { ...f.profile, teams: [] };
  delete profile.runtime;
  const grant = { ...f.grant, teamScopes: [] };
  let input: PassThrough,
    output: PassThrough,
    sequence = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let host!: ReturnType<typeof createTeamHost>;
  function start() {
    input = new PassThrough();
    output = new PassThrough();
    let pending = '';
    output.on('data', (chunk) => {
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const frame = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        const target = waiting.get(frame.id);
        if (target) {
          waiting.delete(frame.id);
          if (frame.error) target.reject(new Error(frame.error.message));
          else target.resolve(frame.result);
        }
      }
    });
    host = createTeamHost(profile, { input, output });
  }
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TEST RPC timeout: ${method}`)), 5000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  start();
  t.after(async () => {
    await host.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });
  const handshake = await rpc<{ capabilities: string[] }>('host.handshake', { protocolVersion: 1 });
  assert.ok(handshake.capabilities.includes('runtime.sources'));
  const current = await rpc<{ ok: true; value: RuntimeSourceSummary }>('runtime.source.current', {
    grant,
  });
  const published = await rpc<{ ok: true; value: RuntimeSourcePublication }>(
    'runtime.source.publish',
    {
      grant,
      commandId: 'TEST-private-publish',
      expectedRevision: current.value.revision,
      candidate: f.candidate,
    }
  );
  assert.equal(published.ok, true);
  const selected = published.value.selection!;
  for (const identity of [current.value, selected]) {
    const skills = await rpc<{ ok: boolean }>('management.skills.capture', {
      profileId: identity.profileId,
      configRevision: identity.configRevision,
      scope: 'project',
      rootKind: 'claude',
    });
    assert.equal(skills.ok, true, 'both old and new profile IDs serve existing Skills');
    const extensions = await rpc<{ ok: boolean }>('management.extension.capture', {
      profileId: identity.profileId,
      configRevision: identity.configRevision,
      panel: 'mcp',
      scope: 'project',
    });
    assert.equal(extensions.ok, true, 'both old and new profile IDs serve existing extensions');
  }
  await host.dispose();
  start();
  await rpc('host.handshake', { protocolVersion: 1 });
  const restored = await rpc<{ ok: true; value: RuntimeSourceSummary }>('runtime.source.current', {
    grant,
  });
  assert.deepEqual(restored.value, selected);
  assert.deepEqual(
    await rpc('runtime.source.lookup', { grant, commandId: 'TEST-private-publish' }),
    published
  );
  const originalIndex = readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8');
  assert.equal((await host.dispose()).cleanup, 'completed');
  delete profile.management;
  start();
  const retainedHandshake = await rpc<{ capabilities: string[] }>('host.handshake', { protocolVersion: 1 });
  assert.ok(retainedHandshake.capabilities.includes('runtime.sources'), 'original history remains addressable without a seed');
  assert.deepEqual(await rpc('management.skills.capture', {
    profileId: selected.profileId, configRevision: selected.configRevision, scope: 'project', rootKind: 'claude',
  }), { ok: false, code: 'held' }, 'unavailable original target cannot look like a fresh missing profile');
  assert.equal((await host.dispose()).cleanup, 'completed', 'settled original source owes no native cleanup');
  assert.equal(readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8'), originalIndex);
});
