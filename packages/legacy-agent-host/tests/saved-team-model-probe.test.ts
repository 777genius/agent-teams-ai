import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  lstatSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse as parsePath, sep } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ClaudeManagementCoordinator } from '../dist/composition/ClaudeManagementCoordinator.js';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { executeTeamModelProbe, teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { captureRuntimeSource, compileRuntimeCapture } from '../dist/composition/runtimeCaptureSource.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { storedModelProbeSchema } from '../dist/management/commandRecords.js';
import { managementDigest } from '../dist/management/identity.js';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { captureOpenCodeReadinessOrigin, captureReadinessPreparation } from '../dist/adapters/providers/OpenCodeReadinessOrigin.js';
import { AcceptedOpenCodeV2FileKey, DeferredOpenCodeV2FileKey, createOpenCodeV2FileMaterialization,
  openCodeV2SelectedSourceReference, selectedFilePaths } from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';
import { captureOpenCodeProbeAccount, capturePreparedModelReference, captureNativeRestartReadiness,
  attachMemberModelReadiness, consumeMemberModelReadiness, captureLaunchModelReadiness } from '../dist/composition/prepareTeamModelReadiness.js';
import type { LocalModelReadinessTransfer } from '../dist/composition/prepareTeamModelReadiness.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { modelReadinessMechanismDigest } from '../dist/team-launch/launchReadiness.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { attachInitialRuntimeModelAdmission, captureInitialRuntimeModelAdmission,
  captureInitialRuntimeMemberAdmission, initialRuntimeModelProbeScope } from '../dist/composition/initialRuntimeModelAdmission.js';
import { resolveTeamModelProbeRecipe, applyTeamModelProbeSelection } from '../dist/composition/teamModelProbeRecipe.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { teamHostProfileSchema } from '../dist/composition/TeamHost.js';
import { runtimeSourceSelectionFixture } from './fixtures/runtime-source-selection.ts';
import type { HostedTeam, MemberEntry } from '../dist/composition/MemberEntry.js';
import type { LocalModelReadinessOrigin, ReadinessSourceReference, NativeLocalReadinessEvidence, StoredModelProbe } from '../dist/management/commandRecords.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ProviderManagementProfile } from '../dist/management/profile.js';
import type { TeamModelProbeSelection } from '../dist/composition/teamLaunchModelProbe.js';
import type { RuntimeSourceProcessOrigin } from '../dist/composition/runtimeSourceProcessOrigin.js';
import type { ModelProbePreparation } from '../dist/management/ModelProbeOwner.js';
import type { TestContext } from 'node:test';

function files(root: string, prefix = ''): unknown[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry): unknown[] => {
    const path = join(prefix, entry.name);
    return entry.isDirectory()
      ? files(root, path)
      : [
          [
            path,
            createHash('sha256')
              .update(readFileSync(join(root, path)))
              .digest('hex'),
          ],
        ];
  });
}
function fixture(t: TestContext, withSources = false, configure?: (profile: TeamHostProfile) => void,
  onAllocation?: () => void, windowsMain = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-saved-model-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-imported-team',
    teamName: 'test-imported',
  };
  const definition: TeamHostProfile['teams'][number] = {
    binding,
    scope: {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: binding.teamId,
      runId: 'TEST-import',
      memberId: 'human',
      generation: '1',
    },
    savedSettings: {
      cwd: root,
      providerId: 'anthropic',
      model: 'TEST-lead-model',
      effort: 'low',
      syncModelsWithLead: false,
      limitContext: true,
    },
    members: [
      { memberId: 'team-lead', name: 'team-lead', role: 'lead', settings: {} },
      {
        memberId: 'alice',
        name: 'alice',
        role: 'member',
        settings: {
          providerId: 'anthropic',
          providerBackendId: 'cli-sdk',
          model: 'TEST-alice-model',
          effort: 'high',
        },
      },
    ],
    grants: [
      {
        principalId: 'TEST-human',
        memberName: 'user',
        permissions: ['read', 'admin'],
      },
    ],
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: [definition],
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-revision',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    runtime: {
      members: [],
      providerTemplates: [
        {
          provider: 'claude',
          teamId: 'TEST-template-team',
          memberId: 'TEST-template-member',
          principalId: 'TEST-template-agent',
          sessionId: 'TEST-template-session',
          generation: 1,
          configRevision: 'TEST-private-recipe',
          cwd: root,
          model: 'TEST-default-model',
          accountBinding: 'TEST-private-account',
          executable: { path: join(root, 'TEST-never-launched-claude'), sha256: 'c'.repeat(64) },
          environment: {
            HOME: root,
            CLAUDE_CONFIG_DIR: root,
            TEST_PRIVATE: 'TEST-secret',
          },
          nativeTools: [],
          autoAllowedTools: [],
          limits: {
            queuedInputs: 1,
            inputBytes: 4096,
            outputBytes: 8192,
            outputEvents: 100,
            pendingInteractions: 1,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
  if (windowsMain) {
    profile.processCustody = { kind: 'main-windows-v1' };
    profile.runtime!.providerTemplates![0]!.windowsBroker = {
      path: 'C:\\TEST\\broker.exe', sha256: 'e'.repeat(64), arch: 'x64', protocol: 1,
      capability: 'service-scopes-v1',
    };
    assert.deepEqual(teamHostProfileSchema.parse(profile), profile);
  }
  configure?.(profile);
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    savedSettings: definition.savedSettings!,
    members: definition.members.map(({ memberId, name, role, settings }) => ({
      memberId,
      name,
      role,
      ...(settings === undefined ? {} : { settings }),
    })),
    grants: definition.grants.map(({ principalId, memberName, permissions }) => ({
      principalId,
      memberName,
      permissions,
    })),
  });
  const team: HostedTeam = {
    definition,
    owner,
    connection: owner.connect(profile.principalId),
  };
  let current = true;
  const sources = withSources ? runtimeSourceSelectionFixture(profile, () => {
    if (!current) throw new Error('TEST-stale-owner');
  }) : undefined;
  const runtime = new RuntimeTeamCoordinator({
    profile,
    ...(sources ? { sources: sources.index } : {}),
    teams: new Map([[binding.teamId, team]]),
    assertWriter: () => {
      if (!current) throw new Error('TEST-stale-owner');
    },
    createProvider: () => {
      onAllocation?.();
      throw new Error('TEST-no-native-team-allocation');
    },
  });
  const view = () =>
    runtime.executeLaunch(
      binding.teamId,
      'model.configuration.read',
      'TEST-read',
      {}
    ) as unknown as {
      source: { sourceId: string; rosterRevision: string };
      members: {
        memberId: string;
        selected: {
          model: string;
          workspaceInherited?: boolean;
          effort?: 'low' | 'high';
          context: 'model-default';
        };
      }[];
    };
  const selection = (memberId = 'team-lead'): TeamModelProbeSelection => {
    const observed = view(),
      member = observed.members.find((row) => row.memberId === memberId)!;
    return {
      launchId: observed.source.sourceId,
      rosterRevision: observed.source.rosterRevision,
      memberId,
      model: member.selected.model,
      effort: member.selected.effort!,
      context: member.selected.context,
    };
  };
  return {
    root,
    profile,
    sources,
    owner,
    team,
    runtime,
    view,
    selection,
    stale: () => {
      current = false;
    },
  };
}

test('saved model evidence follows the published source and cannot authorize a later source revision', async (t) => {
  const f = fixture(t, true);
  const seed = f.view();
  const selected = await f.sources!.publish('TEST-saved-source-B');
  const current = f.view();
  assert.notEqual(current.source.sourceId, seed.source.sourceId);
  const input = f.selection();
  const captured = f.runtime.captureLaunchModelProbe('TEST-imported-team', input, 'start');
  assert.equal(captured.profile?.executable.path, selected.executable.path);
  assert.equal(captured.isCurrent(), true);
  const { effort: _effort, ...withoutEffort } = input;
  const defaults = f.runtime.captureLaunchModelProbe('TEST-imported-team', {
    ...withoutEffort, model: '__provider_default__',
    draft: { providerId: 'anthropic', target: { kind: 'lead' }, workspace: f.root },
  }, 'start');
  assert.equal(defaults.profile?.executable.path, selected.executable.path);
  assert.equal(defaults.model, 'TEST-default-model');
  await f.sources!.publish('TEST-saved-source-C');
  assert.equal(captured.isCurrent(), false);
  assert.equal(defaults.isCurrent(), false);
  assert.throws(() => f.runtime.captureLaunchModelProbe('TEST-imported-team', input, 'start'), { reason: 'saved-model-source' });
  const cleanup = f.runtime.captureLaunchModelProbe('TEST-imported-team', input, 'cancel');
  assert.equal(cleanup.profile, null);
  assert.equal(cleanup.context, captured.context);
  assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
});

test('saved no-draft and same-provider draft probes retain their source origin outside original profile and journal bytes', async t => {
  const f = fixture(t, true, undefined, undefined, true), published = await f.sources!.publish('TEST-saved-source-A');
  const input = f.selection(), captured = f.runtime.captureLaunchModelProbe('TEST-imported-team', input, 'start');
  assert.ok(captured.profile && captured.processOrigin);
  const origin = structuredClone(captured.processOrigin), profile = structuredClone(captured.profile);
  assert.equal(origin.revision, published.selection.revision);
  assert.equal(origin.sourceId, published.selection.sourceId);
  assert.equal(origin.origin.kind, 'runtime');
  assert.equal('processOrigin' in profile, false);
  assert.equal('runtimeSourceOrigin' in profile, false);
  const workspace = join(f.root, 'TEST-probe-workspace'); mkdirSync(workspace);
  const { effort: _effort, ...withoutEffort } = input;
  const draft = f.runtime.captureLaunchModelProbe('TEST-imported-team', {
    ...withoutEffort, model: '__provider_default__',
    draft: { providerId: 'anthropic', target: { kind: 'lead' }, workspace },
  }, 'start');
  assert.ok(draft.profile);
  assert.deepEqual(draft.processOrigin, origin, 'default selection cannot replace the original saved source witness');
  assert.equal(draft.profile?.cwd, workspace);
  assert.equal(draft.model, 'TEST-default-model');
  assert.equal(draft.isCurrent(), true);
  const store = new FileManagementCommandStore(f.root), profiles = new Map<string, ProviderManagementProfile>();
  let factories = 0, runs = 0, closes = 0, finish!: (value: boolean) => void;
  const probes = new ModelProbeOwner({ store, fence: new ManagementResourceFence(store.list()),
    assertWriter() {}, select(profileId, configRevision) {
      return { profileId, configRevision, selectionDigest: runtimeDigest(profiles.get(profileId)),
        resourceId: runtimeDigest('TEST-original-account') };
    }, prepare: () => assert.fail('A source-derived probe must use its original private preparation') });
  t.after(() => probes.close());
  const management = { probes,
    admitTeamProbeProfile(value: ProviderManagementProfile) { profiles.set(value.profileId, structuredClone(value)); },
    prepareTeamProbe(value: ProviderManagementProfile, selected?: RuntimeSourceProcessOrigin): ModelProbePreparation {
      assert.deepEqual(value, profile); assert.deepEqual(selected, origin);
      return () => {
        factories++;
        return { timeoutMs: 10000, run: () => { runs++; return new Promise<boolean>(resolve => { finish = resolve; }); },
          close: async () => { closes++; finish(false); return true; } };
      };
    },
  };
  const request = { runtime: f.runtime, management, teamId: 'TEST-imported-team',
    commandId: 'TEST-original-source-probe', payload: input };
  assert.equal(await executeTeamModelProbe({ ...request, action: 'read' }), null);
  assert.equal(factories, 0);
  assert.equal((await executeTeamModelProbe({ ...request, action: 'start' }))?.phase, 'running');
  const journal = store.read(request.commandId)!;
  assert.equal(factories, 1); assert.equal(runs, 1);
  await executeTeamModelProbe({ ...request, action: 'start' });
  assert.equal(factories, 1); assert.equal(runs, 1); assert.deepEqual(store.read(request.commandId), journal);
  assert.equal(JSON.stringify(journal).includes('processOrigin'), false);
  assert.equal(JSON.stringify(journal).includes('runtimeSourceOrigin'), false);
  assert.equal((await executeTeamModelProbe({ ...request, action: 'cancel' }))?.phase, 'cancelled');
  assert.equal(closes, 1);
  await probes.close();
  await f.sources!.publish('TEST-saved-source-B');
  assert.equal(captured.isCurrent(), false); assert.equal(draft.isCurrent(), false);
  assert.deepEqual(captured.processOrigin, origin);
  assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
});

test('never-captured saved/imported lead and Alice resolve explicit private recipes without any product/runtime writes', (t) => {
  const f = fixture(t),
    before = files(f.root),
    state = readFileSync(join(f.root, 'teams/test-imported/.host-owner/state.json'));
  const first = f.view();
  assert.equal(first.source.sourceId.startsWith('saved-model-'), true);
  assert.deepEqual(f.view(), first);
  assert.deepEqual(
    first.members.map((row) => row.selected.model),
    ['TEST-lead-model', 'TEST-alice-model']
  );
  assert.deepEqual(
    first.members.map((row) => row.selected.effort),
    ['low', 'high']
  );
  assert.equal('launch' in first, false);
  for (const member of first.members) {
    const captured = f.runtime.captureLaunchModelProbe(
      'TEST-imported-team',
      f.selection(member.memberId),
      'read'
    );
    assert.equal(captured.profile?.accountBinding, 'TEST-private-account');
    assert.equal(captured.profile?.environment.TEST_PRIVATE, 'TEST-secret');
    assert.equal(captured.isCurrent(), true);
  }
  assert.deepEqual(files(f.root), before);
  assert.deepEqual(readFileSync(join(f.root, 'teams/test-imported/.host-owner/state.json')), state);
  assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
});

test('missing/ambiguous templates, changed source and stale owner refuse without authorizing a new launch', (t) => {
  const f = fixture(t),
    selection = f.selection(),
    captured = f.runtime.captureLaunchModelProbe('TEST-imported-team', selection, 'start');
  f.profile.runtime!.providerTemplates![0]!.accountBinding = 'TEST-replaced-account';
  assert.equal(captured.isCurrent(), false);
  assert.throws(() => f.runtime.captureLaunchModelProbe('TEST-imported-team', selection, 'start'), {
    reason: 'saved-model-source',
  });
  f.profile.runtime!.providerTemplates!.push(
    structuredClone(f.profile.runtime!.providerTemplates![0]!)
  );
  assert.throws(f.view, { reason: 'runtime-template-ambiguous' });
  f.profile.runtime!.providerTemplates = [];
  assert.throws(f.view, { reason: 'runtime-recipe-unconfigured' });
  f.stale();
  assert.throws(f.view);
  assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
});

function selectProvider(f: ReturnType<typeof fixture>, provider: 'claude' | 'codex' | 'opencode') {
  if (provider === 'claude') return;
  const {
    nativeTools: _tools,
    autoAllowedTools: _allowed,
    ...base
  } = f.profile.runtime!.providerTemplates![0]! as Extract<
    NonNullable<TeamHostProfile['runtime']>['members'][number],
    { provider: 'claude' }
  >;
  f.profile.runtime!.providerTemplates = [
    runtimeMemberProfileSchema.parse({
      ...base,
      provider,
      accountBinding: `TEST-${provider}-account`,
      ...(provider === 'codex'
        ? {
            protocolRevision: '0.162.0',
            environment: { HOME: f.root, CODEX_HOME: f.root },
            nativeOptions: {
              approvalPolicy: 'never',
              sandbox: 'read-only',
              modelProvider: 'TEST-local',
            },
          }
        : {
            protocolRevision: '1.19.4',
            mcpPolicyPlugin: testPolicyPlugin(f.root),
            endpoint: 'http://127.0.0.1:19181',
            environment: {
              HOME: f.root,
              XDG_CONFIG_HOME: f.root,
              XDG_DATA_HOME: f.root,
              XDG_CACHE_HOME: f.root,
            },
            nativeOptions: { providerId: 'TEST-local', agent: 'build' },
          }),
    }),
  ];
  const roster = f.team.connection.readRoster();
  f.team.connection.replaceRoster({
    commandId: `TEST-${provider}-settings`,
    expectedRevision: roster.revision,
    savedSettings: {
      cwd: f.root,
      providerId: provider,
      model: 'TEST-model',
      syncModelsWithLead: false,
      limitContext: true,
    },
    members: [{ name: 'alice', providerId: provider, model: 'TEST-alice-model' }],
  });
}

for (const provider of ['claude', 'codex', 'opencode'] as const)
  for (const change of ['roster', 'revoke', 'recipe'] as const)
    test(`existing probe journal retains original intents and exact ${provider} cleanup after ${change} without native Team allocation`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const f = fixture(t);
      selectProvider(f, provider);
      const payload = f.selection('alice'),
        profiles = new Map<string, ProviderManagementProfile>();
      if (provider === 'opencode') payload.model = `TEST-local/${payload.model}`;
      const store = new FileManagementCommandStore(f.root);
      let runs = 0,
        closes = 0,
        finish!: (ok: boolean) => void;
      const make = () =>
        new ModelProbeOwner({
          store,
          fence: new ManagementResourceFence(store.list()),
          assertWriter: () => {},
          select: (profileId, configRevision) => ({
            profileId,
            configRevision,
            selectionDigest: runtimeDigest(profiles.get(profileId)),
            resourceId: runtimeDigest('TEST-private-account'),
          }),
          prepare: () => ({
            timeoutMs: 1000,
            run: () => {
              runs++;
              return new Promise<boolean>((resolve) => {
                finish = resolve;
              });
            },
            close: async () => {
              closes++;
              return true;
            },
          }),
        });
      const probes = make(),
        management = {
          admitTeamProbeProfile: (profile: ProviderManagementProfile) => {
            profiles.set(profile.profileId, profile);
          },
          probes,
        };
      const request = {
        runtime: f.runtime,
        management,
        teamId: 'TEST-imported-team',
        commandId: 'TEST-original-probe',
        payload,
      };
      assert.equal(await executeTeamModelProbe({ ...request, action: 'read' }), null);
      assert.equal(runs, 0);
      assert.equal(
        (await executeTeamModelProbe({ ...request, action: 'start' }))?.phase,
        'running'
      );
      assert.equal(runs, 1);
      const first = store.read(request.commandId);
      await executeTeamModelProbe({ ...request, action: 'start' });
      assert.equal(runs, 1);
      if (provider === 'opencode') {
        const original = store.read(request.commandId);
        assert.equal(original?.kind, 'model.probe');
        if (original?.kind !== 'model.probe') assert.fail('expected original TEST probe');
        assert.equal(original.readinessScope?.teamBindingDigest, runtimeDigest(f.team.definition.binding));
        assert.equal(original.readinessScope?.selectionDigest, runtimeDigest(payload));
        assert.deepEqual(original.readinessScope?.destinationKeys,
          [runtimeDigest({ launchId: payload.launchId, memberId: payload.memberId })]);
        assert.equal(first?.kind, 'model.probe');
        if (first?.kind !== 'model.probe') assert.fail('expected first TEST probe');
        assert.equal(original.readinessScope?.cutoff, first.readinessScope?.cutoff,
          'same-ID replay retains the first cutoff');
        assert.ok(original.expiresAt <= original.readinessScope!.cutoff);
        await probes.cancelTeamPreparations(runtimeDigest({ ...f.team.definition.binding, teamId: 'TEST-other-team' }));
        assert.equal(closes, 0, 'cleanup cannot select another Team by member name');
      }
      if (change === 'roster') {
        const roster = f.team.connection.readRoster();
        f.team.connection.replaceRoster({
          commandId: 'TEST-edited-roster',
          expectedRevision: roster.revision,
          members: [{ name: 'bob' }],
        });
      } else if (change === 'revoke') f.team.connection.revoke('TEST-human');
      else f.profile.runtime!.providerTemplates![0]!.accountBinding = 'TEST-replaced-account';
      const denied = change === 'revoke' ? { code: 'forbidden' } : { reason: 'saved-model-source' };
      await assert.rejects(() => executeTeamModelProbe({ ...request, action: 'read' }), denied);
      await assert.rejects(
        () =>
          executeTeamModelProbe({
            ...request,
            commandId: 'TEST-new-attempt',
            action: 'start',
          }),
        denied
      );
      await assert.rejects(
        () =>
          executeTeamModelProbe({
            ...request,
            commandId: 'TEST-not-original',
            action: 'cancel',
          }),
        { code: 'conflict' }
      );
      const wrong = { ...payload, memberId: 'team-lead' };
      await assert.rejects(
        () =>
          executeTeamModelProbe({
            ...request,
            payload: wrong,
            action: 'cancel',
          }),
        { code: 'conflict' }
      );
      assert.equal(closes, 0);
      assert.equal(
        (await executeTeamModelProbe({ ...request, action: 'cancel' }))?.phase,
        'cancelled'
      );
      finish(true);
      assert.equal(
        (await executeTeamModelProbe({ ...request, action: 'cancel' }))?.phase,
        'cancelled'
      );
      assert.equal(closes, 1);
      assert.equal(runs, 1);
      if (provider === 'opencode') {
        probes.seal();
        await probes.cancelTeamPreparations(runtimeDigest(f.team.definition.binding));
        const retired = store.read(request.commandId);
        assert.equal(retired?.kind, 'model.probe');
        if (retired?.kind !== 'model.probe') assert.fail('expected retained TEST probe');
        assert.equal(retired.readinessRetired, true, 'original cleanup survives seal and grant/source changes');
        assert.equal(retired.resourceHeld, false);
        assert.equal(retired.ok, false, 'late positive completion cannot revive retired evidence');
        assert.equal(closes, 1);
      }
      if (change === 'revoke') assert.throws(f.view, { code: 'forbidden' });
      else assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
      const cold = make();
      const original = Array.from(store.list())[0]!;
      assert.equal(
        cold.read({
          commandId: original.commandId,
          profileId: original.profileId,
          configRevision: original.configRevision,
        })?.phase,
        'cancelled'
      );
      if (provider === 'opencode' && change === 'roster') await assertRetainedProductRosterTransfer(t);
    });

test('operator grant revocation invalidates saved source evidence even when the roster and template remain identical', (t) => {
  const f = fixture(t),
    captured = f.runtime.captureLaunchModelProbe('TEST-imported-team', f.selection(), 'start');
  assert.equal(captured.isCurrent(), true);
  f.team.connection.revoke('TEST-human');
  assert.equal(captured.isCurrent(), false);
  assert.throws(f.view, { code: 'forbidden' });
});

test('Team probe read rejects completed evidence after physical config-directory replacement while exact contextual cleanup remains addressable', async (t) => {
  // These synthetic readers validate provenance, not filesystem throughput within the unchanged 1s lease.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t),
    captured = f.runtime.captureLaunchModelProbe('TEST-imported-team', f.selection(), 'read');
  assert.ok(captured.profile);
  assert.equal(captured.profile.provider, 'claude');
  if (captured.profile.provider !== 'claude') assert.fail('TEST-Claude-profile');
  const home = join(f.root, 'TEST-home'),
    config = join(f.root, 'TEST-config');
  mkdirSync(home);
  mkdirSync(config);
  const profile = {
    ...captured.profile,
    environment: {
      ...captured.profile.environment,
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
    },
  };
  const claude = new ClaudeManagementCoordinator([profile], () => {});
  const store = new FileManagementCommandStore(f.root);
  let runs = 0;
  const probes = new ModelProbeOwner({
    store,
    fence: new ManagementResourceFence(store.list()),
    assertWriter: () => {},
    select: (id, revision) => claude.target(id, revision),
    prepare: () => ({
      timeoutMs: 1000,
      run: async () => {
        runs++;
        return true;
      },
      close: async () => true,
    }),
  });
  const identity = {
    commandId: 'TEST-physical-target-probe',
    profileId: profile.profileId,
    configRevision: profile.configRevision,
  };
  probes.start({
    ...identity,
    providerId: 'anthropic',
    modelId: 'TEST-model',
    context: captured.context,
  });
  for (let attempts = 0; attempts < 20 && probes.read(identity)?.phase === 'running'; attempts++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probes.readCurrent(identity)?.ok, true);
  renameSync(config, `${config}-original`);
  mkdirSync(config);
  assert.throws(() => probes.readCurrent(identity), { code: 'conflict' });
  assert.equal(
    (await probes.cancelContextual(identity.commandId, captured.context)).phase,
    'completed'
  );
  assert.equal(runs, 1);

  // Real source/record/launch readers with an explicitly synthetic native issuer, not native qualification.
  for (const mode of ['native', 'local', 'initial', 'settings', 'missing', 'copied', 'foreign', 'unclean', 'late'] as const) {
    const own = fixture(t), providerId = 'test-local', modelId = 'TEST-model';
    const home = join(own.root, 'file-home'), data = join(own.root, 'file-data');
    mkdirSync(home); mkdirSync(data);
    const file = join(own.root, 'TEST-selected.key'), config = join(own.root, 'opencode.json');
    writeFileSync(file, 'TEST-original-private-key', { mode: 0o600 });
    writeFileSync(config, JSON.stringify({ provider: { [providerId]: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: '{file:TEST-selected.key}' },
      models: { [modelId]: { name: 'TEST-model' } } } } }), { mode: 0o600 });
    const member = runtimeMemberProfileSchema.parse({ provider: 'opencode', nativeGeneration: 'v2',
      protocolRevision: '2.1.4', teamId: own.team.definition.binding.teamId, memberId: 'team-lead',
      principalId: 'TEST-agent', sessionId: 'TEST-file-session', generation: 1,
      configRevision: 'TEST-file-config', accountBinding: 'TEST-file-account', model: modelId, cwd: own.root,
      executable: { path: join(own.root, 'TEST-bun'), sha256: 'a'.repeat(64) }, endpoint: 'http://127.0.0.1:9',
      environment: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: data, XDG_CACHE_HOME: home },
      embedded: { directory: join(own.root, 'engine'), manifestSha256: 'b'.repeat(64), version: '2.1.4',
        platform: process.platform, arch: process.arch, externalDirectory: 'deny' },
      nativeOptions: { providerId, agent: 'build' },
      limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 128,
        pendingInteractions: 1, timeoutMs: 1000 },
    });
    assert.equal(member.provider, 'opencode'); if (member.provider !== 'opencode') assert.fail();
    member.embedded!.configurationSource = captureOpenCodeConfigurationSource(member).reference;
    const management = teamModelProbeProfile(member);
    assert.equal(management.provider, 'opencode'); if (management.provider !== 'opencode') assert.fail();
    const configuration = captureOpenCodeV2Configuration(management, { providerId, modelId }, () => true);
    const deferred = configuration.selectedFile; assert.ok(deferred);
    const request = { commandId: 'TEST-file-' + mode, profileId: management.profileId,
      configRevision: management.configRevision, providerId,
      modelId: mode === 'initial' ? providerId + '/' + modelId : modelId, context: runtimeDigest({ mode }) };
    const initialProfile = mode === 'initial' ? structuredClone(own.profile) : undefined;
    if (initialProfile) {
      const team = initialProfile.teams[0]!;
      team.scope.runId = 'TEST-file-run';
      team.members.find(row => row.memberId === member.memberId)!.delivery = {
        ...team.binding, runId: team.scope.runId, memberId: member.memberId, generation: '1' };
      team.grants.push({ principalId: member.principalId, memberName: 'team-lead', permissions: ['read'] });
      initialProfile.management = [management]; initialProfile.runtime!.members = [member];
      initialProfile.runtime!.initialModelAdmissions = [captureInitialRuntimeModelAdmission(initialProfile, {
        method: 'runtime.open', teamId: member.teamId, commandId: 'TEST-initial-file-open', payload: { memberId: member.memberId },
        prepared: [{ memberId: member.memberId, commandId: request.commandId, profileId: request.profileId,
          configRevision: request.configRevision, context: request.context }],
      })];
    }
    const target = { profileId: management.profileId, configRevision: management.configRevision,
      selectionDigest: runtimeDigest(management), resourceId: runtimeDigest({ account: management.accountBinding, mode }) };
    const recordStore = new FileManagementCommandStore(own.root);
    let closed = false, nativeCalls = 0, witnessReads = 0;
    let complete!: (ok: boolean) => void;
    let accepted: AcceptedOpenCodeV2FileKey | undefined;
    const evidence = (): NativeLocalReadinessEvidence => ({ schemaVersion: 1, ordinary: 'confirmed',
      coordination: 'not-applicable', decision: 'allow', reasons: ['not-applicable'],
      routeDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64),
      accountDigest: managementDigest({ binding: management.accountBinding, key: accepted?.scopeDigest ?? null,
        configuredKey: '{file:TEST-selected.key}' }),
      metadata: { provider: 'custom', tools: null, modelListed: null, contextTokens: null,
        parameterCount: null, configuredContextTokens: null, trainedContextTokens: null, contextSource: 'unknown' } });
    const ownerOptions = { store: recordStore, fence: new ManagementResourceFence(recordStore.list()),
      assertWriter() {}, select: () => target,
      readinessOriginCurrent: (origin: LocalModelReadinessOrigin) =>
        captureOpenCodeReadinessOrigin(origin, management, providerId, () => true).isCurrent(),
      prepare: () => ({ timeoutMs: 1000,
        run: () => {
          nativeCalls++;
          if (mode !== 'missing') {
            const descriptor = deferred.descriptor, selected = mode === 'foreign'
              ? DeferredOpenCodeV2FileKey.capture({ ...descriptor, origin: {
                ...descriptor.origin, value: descriptor.rawKey }, providerId: 'test-foreign',
                environment: management.environment, isCurrent: () => true }) : deferred;
            const materializer = createOpenCodeV2FileMaterialization(selected.descriptor, () => {});
            const actual = selectedFilePaths(selected.descriptor).map(path => materializer.readFileString(path).trim()).join('');
            const nonce = 'c'.repeat(64), integrationId = selected.descriptor.providerId;
            const issuer = { nonce, pid: process.pid, integrationId,
              reference: openCodeV2SelectedSourceReference(selected.descriptor, nonce, integrationId, 'fresh') };
            accepted = AcceptedOpenCodeV2FileKey.accept(selected, materializer.issue(actual, issuer), issuer, () => true);
          }
          return new Promise<boolean>(resolve => { complete = resolve; });
        },
        readiness: evidence,
        nativeFileKeyWitness: () => {
          assert.equal(closed, true, 'the original owner must close before reading proof'); witnessReads++;
          return mode === 'copied' ? { ...accepted } : accepted;
        },
        close: async () => { closed = true; return mode !== 'unclean'; },
      }) };
    const original = new ModelProbeOwner(ownerOptions);
    try {
      const admittedAt = Date.now(), cutoff = admittedAt + 1000;
      const scope = initialProfile ? initialRuntimeModelProbeScope(initialProfile.runtime!.initialModelAdmissions![0]!, member, cutoff)
        : { schemaVersion: 1 as const, kind: mode === 'local' ? 'team' as const : 'native' as const,
        teamBindingDigest: runtimeDigest(own.team.definition.binding), actionDigest: runtimeDigest(request.commandId),
        selectionDigest: runtimeDigest({ providerId, modelId }), sourceRevision: 'TEST-source', rosterRevision: 'TEST-roster',
        mechanismDigest: modelReadinessMechanismDigest(management), workspace: management.cwd, cutoff,
        destinationKeys: [runtimeDigest({ launchId: 'TEST-file-run', memberId: member.memberId })] };
      const reference = (path: string): ReadinessSourceReference => {
        const directories: unknown[] = []; let directory = parsePath(path).root;
        for (const part of ['', ...dirname(path).slice(directory.length).split(sep).filter(Boolean)]) {
          if (part) directory = join(directory, part);
          try { const stat = lstatSync(directory); directories.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]); }
          catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
            return { path, root: own.root, present: false,
              digest: managementDigest({ path, root: own.root, directories, missing: directory }) }; }
        }
        try { const stat = lstatSync(path); return { path, root: own.root, present: true,
          digest: managementDigest({ path, root: own.root, directories,
            file: [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink],
            bytes: createHash('sha256').update(readFileSync(path)).digest('hex') }) }; }
        catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
          return { path, root: own.root, present: false, digest: managementDigest({ path, root: own.root, directories, missing: path }) }; }
      };
      const owner = { ownerId: 'TEST-file-owner' }, selection = { providerId, modelId };
      const origin: LocalModelReadinessOrigin = { schemaVersion: 1, kind: 'team', ownerDigest: managementDigest(owner),
        contextId: 'TEST-file-context', commandId: 'TEST-file-action', selectionDigest: managementDigest(selection),
        workspaces: [{ path: own.root, project: { selectedPath: config, invalid: false,
          sources: ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
            .map(name => reference(join(own.root, name))),
          providers: [{ providerId, baseUrl: 'http://127.0.0.1:9/v1', preset: 'custom', hasConfiguredApiKey: true }] },
          global: { notConsulted: 'project-precedence' } }], approval: { notConsulted: 'no-private-target' } };
      const preparation = mode === 'local' ? captureReadinessPreparation({ origin, remainingMs: 1000 }, {
        kind: 'team', owner, contextId: origin.contextId, commandId: origin.commandId, selection,
        workspaces: [own.root], targets: [{ workspace: own.root, providerId }], anchorCommandId: request.commandId,
        admittedAt, original: { present: false } }) : undefined;
      assert.equal(captureOpenCodeProbeAccount(management, request, () => true, undefined,
        preparation?.origin), undefined, 'initial scope cannot claim a future effective manual key');
      if (mode === 'settings') original.start(request);
      else if (mode === 'initial') original.startNativeReadiness(request, () => true, scope);
      else original.startPrepared(request, () => true, preparation, scope);
      const admitted = original.readRetainedProbe(request.commandId, request.context);
      assert.equal(admitted.nativeFileKeyWitness, undefined);
      assert.equal(admitted.readinessScope?.accountDigest, undefined);
      if (mode === 'late') await original.cancelContextual(request.commandId, request.context);
      complete(true);
      await original.awaitPrepared(request.commandId, request.context);
      const saved = original.readRetainedProbe(request.commandId, request.context);
      assert.equal(saved.fingerprint, admitted.fingerprint);
      assert.deepEqual(saved.readinessScope, admitted.readinessScope, 'scope/cutoff never acquire a late placeholder digest');
      assert.equal(nativeCalls, 1);
      assert.equal(JSON.stringify(saved).includes('TEST-original-private-key'), false, 'record has only opaque native evidence');
      assert.equal(Object.hasOwn(original.read({ commandId: request.commandId, profileId: request.profileId,
        configRevision: request.configRevision })!, 'nativeFileKeyWitness'), false, 'public snapshot always omits private proof');
      if (['unclean', 'late', 'settings'].includes(mode)) {
        assert.equal(saved.phase, mode === 'unclean' ? 'held' : mode === 'late' ? 'cancelled' : 'completed');
        assert.equal(saved.resourceHeld, mode === 'unclean');
        assert.equal(saved.ok, mode === 'settings');
        assert.equal(witnessReads, 0);
        assert.equal(saved.nativeFileKeyWitness, undefined);
        assert.equal(storedModelProbeSchema.safeParse({ ...saved, nativeFileKeyWitness: accepted?.encoded }).success, false);
      } else if (mode === 'copied' || mode === 'foreign') {
        assert.equal(witnessReads, 1); assert.equal(saved.phase, 'held'); assert.equal(saved.ok, false);
        assert.equal(saved.nativeFileKeyWitness, undefined);
      } else if (mode === 'missing') {
        const historical = original.captureReadinessReference(request.commandId, request.context,
          () => ({ target, originCurrent: true }));
        assert.equal(historical.preparationDigest, managementDigest({ scope: saved.readinessScope, anchor: null, origin: null }),
          'omitting the new witness preserves the historical reference bytes');
        assert.throws(() => captureOpenCodeProbeAccount(management, request, () => true, saved), { code: 'held' });
      } else {
        assert.ok(saved.nativeFileKeyWitness); assert.equal(witnessReads, 1);
        const account = captureOpenCodeProbeAccount(management, request, () => true, saved); assert.ok(account);
        assert.equal(account.nativeCredentialScopeDigest, accepted?.scopeDigest);
        const manager = { probes: original, readinessTarget: () => target };
        const capture = () => capturePreparedModelReference({ management: manager, profile: member,
          commandId: request.commandId, context: request.context, ...(mode === 'native' ? { kind: 'native' as const } : {}),
          isCurrent: () => true });
        const selected = capture();
        assert.equal(selected.preparationDigest, managementDigest({ scope: saved.readinessScope,
          anchor: saved.localModelReadinessPreparation ?? null, origin: saved.localModelReadinessOrigin ?? null,
          nativeFileKeyWitness: managementDigest(saved.nativeFileKeyWitness) }));
        const cold = new ModelProbeOwner({ ...ownerOptions, fence: new ManagementResourceFence(recordStore.list()),
          prepare: () => { throw Error('TEST cold account inspection cannot create another probe'); } });
        try { assert.deepEqual(capturePreparedModelReference({ management: { ...manager, probes: cold }, profile: member,
          commandId: request.commandId, context: request.context, ...(mode === 'native' ? { kind: 'native' as const } : {}),
          isCurrent: () => true }), selected); } finally { await cold.close(); }
        const binding = { backendId: own.team.definition.binding.backendId, teamId: member.teamId,
          runId: 'TEST-file-run', memberId: member.memberId, generation: '1' };
        const entry: MemberEntry = { profile: member, baseProfile: structuredClone(member),
          team: initialProfile ? { ...own.team, definition: initialProfile.teams[0]! } : own.team,
          binding, delivery: { ...binding, teamName: own.team.definition.binding.teamName },
          config: { tenantId: own.profile.owner.ownerId, projectId: own.team.definition.scope.projectId,
            sessionId: member.sessionId, generation: member.generation, configRevision: member.configRevision,
            requiredCapabilities: ['text'] } };
        const launch = new TeamLaunchOwner({ definition: { launchId: binding.runId, rosterRevision: runtimeDigest(scope),
          members: [{ memberId: member.memberId, binding, configurationDigest: runtimeDigest(member),
            baseConfigurationDigest: runtimeDigest(member), runtimeGeneration: member.generation,
            contextDigest: runtimeDigest('TEST-no-input'), configRevision: member.configRevision, skipped: false, timeoutMs: 1000 }] },
          hostIncarnation: 'TEST-file-host', store: new TeamOwnerStore(own.root, own.team.definition.binding.teamName),
          authorized: (action, callback) => own.owner.withLaunchAuthority('TEST-human', action, callback),
          runtime: { read: () => ({ attached: false, nativeReady: false }),
            open: async () => { throw Error('TEST no business allocation in account proof'); } } });
        try {
          if (initialProfile) {
            const captured = captureInitialRuntimeMemberAdmission(initialProfile, entry); assert.ok(captured);
            entry.initialModelAdmission = captured;
            const admit = (actorDigest = runtimeDigest('TEST-actor')) => attachInitialRuntimeModelAdmission({ launch, entries: [entry], management: manager,
              captureReference: capturePreparedModelReference,
              method: 'runtime.open', teamId: member.teamId, commandId: 'TEST-initial-file-open',
              payload: { memberId: member.memberId }, actorDigest,
              hostIncarnation: 'TEST-file-host', assertCurrent() {} });
            for (const invalid of ['unscoped', 'foreign', 'expired', 'held'] as const) {
              const changed: StoredModelProbe = structuredClone(saved);
              if (invalid === 'unscoped') delete changed.readinessScope;
              else if (invalid === 'foreign') changed.readinessScope = { ...changed.readinessScope!, actionDigest: 'f'.repeat(64) };
              else if (invalid === 'expired') changed.expiresAt = Date.now() - 1;
              else {
                changed.phase = 'held'; changed.ok = false; changed.resourceHeld = true;
                delete changed.nativeFileKeyWitness; delete changed.readiness;
              }
              recordStore.write(changed);
              try { assert.throws(admit, 'initial admission cannot adopt ' + invalid + ' proof'); }
              finally { recordStore.write(saved); }
              assert.equal(nativeCalls, 1, 'a refused retained receipt cannot create replacement preparation');
            }
            admit();
            const attached = launch.readModelReadiness({ binding, configRevision: member.configRevision,
              configurationDigest: runtimeDigest(member) });
            assert.deepEqual(attached.reference, selected);
            assert.equal(attached.consumer.cutoff, saved.expiresAt);
            assert.equal(attached.consumer.initialProfile, undefined, 'the original Linux proof remains a prepared arm');
            admit();
            assert.deepEqual(launch.readModelReadiness({ binding, configRevision: member.configRevision,
              configurationDigest: runtimeDigest(member) }), attached, 'same original pending attachment is a read-only replay');
            assert.throws(() => admit(runtimeDigest('TEST-another-actor')), { code: 'hold' },
              'another actor cannot replace the retained initial attempt with a new consumer');
            assert.equal(nativeCalls, 1, 'initial attachment replay and refusal never spend a second probe');
            assert.deepEqual(original.readRetainedProbe(request.commandId, request.context), saved,
              'the exact first context, scope, cutoff and clean receipt are never rewritten by allocation attachment');
          } else attachMemberModelReadiness({ launch, entry, reference: selected, commandId: 'TEST-consume',
            actorDigest: runtimeDigest('TEST-actor'), inputDigest: runtimeDigest(request), cutoff });
          const consumed = consumeMemberModelReadiness({ management: manager, launch, entry,
            hostIncarnation: 'TEST-file-host', assertCurrent() {} });
          assert.equal(consumed.kind, 'preparation'); assert.ok(consumed.assertReadinessCredential);
          let handoffs = 0;
          assert.throws(() => { consumed.assertReadinessCredential!('f'.repeat(64)); handoffs++; }, { code: 'held' });
          assert.equal(handoffs, 0, 'a later foreign native scope is refused before business handoff');
          consumed.assertReadinessCredential(account.nativeCredentialScopeDigest!);
          captureNativeRestartReadiness({ management: manager, launch, entry, isCurrent: () => true }).assertCurrent();
          if (initialProfile) {
            assert.equal(saved.modelId, providerId + '/' + member.model,
              'the original qualified probe remains unchanged while the member model stays bare');
            for (const modelId of ['test-foreign/' + member.model, providerId + '/' + request.modelId]) {
              recordStore.write({ ...saved, modelId });
              try {
                assert.throws(capture, { code: 'held' });
                assert.throws(() => captureNativeRestartReadiness({ management: manager, launch, entry,
                  isCurrent: () => true }), { code: 'held' });
              } finally { recordStore.write(saved); }
            }
            assert.deepEqual(original.readRetainedProbe(request.commandId, request.context), saved,
              'model comparison never rewrites the original scoped receipt or native account witness');
          }
          writeFileSync(file, 'TEST-drifted-original-key', { mode: 0o600 });
          assert.equal(account.isCurrent(), false);
          assert.throws(consumed.assertCurrent);
          assert.throws(() => captureNativeRestartReadiness({ management: manager, launch, entry, isCurrent: () => true }));
          assert.equal(nativeCalls, 1, 'post-close currentness never starts a replacement native owner');
        } finally { launch.seal(); }
      }
    } finally {
      if (mode === 'unclean') await assert.rejects(original.close(), { code: 'held' });
      else await original.close();
    }
  }
});

for (const provider of ['codex', 'opencode'] as const)
  for (const destination of ['lead', 'new-member'] as const)
    test(`saved Launch draft ${provider}/${destination} selects only its explicit private recipe and retains original cancellation after template change`, async (t) => {
      const f = fixture(t);
      const base = f.profile.runtime!.providerTemplates![0]!;
      const common = {
        teamId: base.teamId,
        memberId: base.memberId,
        principalId: base.principalId,
        sessionId: base.sessionId,
        generation: base.generation,
        configRevision: 'TEST-private-draft-recipe',
        model: 'TEST-private-default-model',
        accountBinding: `TEST-private-${provider}`,
        cwd: f.root,
        environment: base.environment,
        executable: base.executable,
        limits: base.limits,
      };
      const recipe = runtimeMemberProfileSchema.parse({
        ...common,
        provider,
        ...(provider === 'codex'
          ? {
              protocolRevision: '0.162.0',
              environment: { HOME: f.root, CODEX_HOME: f.root, PATH: '/TEST/no-bin' },
              nativeOptions: {
                approvalPolicy: 'never',
                sandbox: 'read-only',
                modelProvider: 'TEST-local',
              },
            }
          : {
              protocolRevision: '1.19.4',
              mcpPolicyPlugin: testPolicyPlugin(f.root),
              endpoint: 'http://127.0.0.1:19181',
              environment: {
                HOME: f.root,
                XDG_CONFIG_HOME: f.root,
                XDG_DATA_HOME: f.root,
                XDG_CACHE_HOME: f.root,
              },
              nativeOptions: { providerId: 'TEST-local', agent: 'build' },
            }),
      });
      f.profile.runtime!.providerTemplates!.push(recipe);
      const original = f.selection();
      const payload: TeamModelProbeSelection = {
        launchId: original.launchId,
        rosterRevision: original.rosterRevision,
        memberId: destination === 'lead' ? original.memberId : 'draft:new-worker',
        model: '__provider_default__',
        draft: {
          providerId: provider,
          target:
            destination === 'lead' ? { kind: 'lead' } : { kind: 'member', name: 'new-worker' },
          workspace: f.root,
        },
      };
      const before = files(f.root);
      const captured = f.runtime.captureLaunchModelProbe('TEST-imported-team', payload, 'start');
      assert.equal(captured.profile?.provider, provider);
      assert.equal(captured.profile?.accountBinding, `TEST-private-${provider}`);
      assert.equal(captured.model, 'TEST-private-default-model');
      assert.equal(captured.isCurrent(), true);
      assert.deepEqual(files(f.root), before);
      const profiles = new Map<string, ProviderManagementProfile>();
      const store = new FileManagementCommandStore(f.root);
      let runs = 0,
        finish!: (ok: boolean) => void;
      const probes = new ModelProbeOwner({
        store,
        fence: new ManagementResourceFence(store.list()),
        assertWriter: () => {},
        select: (profileId, configRevision) => ({
          profileId,
          configRevision,
          selectionDigest: runtimeDigest(profiles.get(profileId)),
          resourceId: runtimeDigest(provider),
        }),
        prepare: () => ({
          timeoutMs: 1000,
          run: () => {
            runs++;
            return new Promise<boolean>((done) => {
              finish = done;
            });
          },
          close: async () => true,
        }),
      });
      const request = {
        runtime: f.runtime,
        management: {
          probes,
          admitTeamProbeProfile: (profile: ProviderManagementProfile) => {
            profiles.set(profile.profileId, profile);
          },
        },
        teamId: 'TEST-imported-team',
        commandId: 'TEST-original-draft-check',
        payload,
      };
      await executeTeamModelProbe({ ...request, action: 'start' });
      recipe.accountBinding = 'TEST-replaced-private-account';
      assert.equal(captured.isCurrent(), false);
      finish(true);
      await new Promise<void>((done) => setImmediate(done));
      await assert.rejects(() => executeTeamModelProbe({ ...request, action: 'read' }), {
        code: 'conflict',
      });
      assert.equal((await executeTeamModelProbe({ ...request, action: 'cancel' }))?.ok, false);
      assert.equal(
        (await executeTeamModelProbe({ ...request, action: 'cancel' }))?.phase,
        'cancelled'
      );
      assert.equal(runs, 1);
      assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
      await probes.close();
    });

test('saved workspace projection distinguishes canonical inheritance from an explicit member cwd', (t) => {
  const f = fixture(t);
  assert.equal(
    f.view().members.find((member) => member.memberId === 'team-lead')!.selected.workspaceInherited,
    true
  );
  assert.equal(
    f.view().members.find((member) => member.memberId === 'alice')!.selected.workspaceInherited,
    true
  );
  const roster = f.team.connection.readRoster();
  f.team.connection.replaceRoster({
    commandId: 'TEST-explicit-workspace',
    expectedRevision: roster.revision,
    members: [{ name: 'alice', providerId: 'anthropic', cwd: f.root }],
  });
  assert.equal(
    f.view().members.find((member) => member.memberId === 'alice')!.selected.workspaceInherited,
    false
  );
});

for (const provider of ['codex', 'opencode'] as const)
  test(`${provider} model preflight preserves private default native options and binds explicit effort without rewriting the source`, (t) => {
    const f = fixture(t);
    selectProvider(f, provider);
    const template = f.profile.runtime!.providerTemplates![0]!;
    if (template.provider === 'codex') {
      template.nativeOptions.reasoningEffort = 'minimal';
      template.nativeOptions.fastMode = true;
    } else if (template.provider === 'opencode') {
      template.nativeOptions.variant = 'high';
      template.nativeOptions.toolApprovalMode = 'manual';
    }
    const before = structuredClone(template);
    const selected = f.selection();
    const original = f.runtime.captureLaunchModelProbe('TEST-imported-team', selected, 'start');
    assert.equal(original.profile?.provider, provider);
    if (original.profile?.provider === 'codex') {
      assert.equal(original.profile.reasoningEffort, 'minimal');
      assert.equal(original.profile.fastMode, true);
    }
    if (original.profile?.provider === 'opencode') assert.equal(original.profile.variant, 'high');
    const changed = f.runtime.captureLaunchModelProbe(
      'TEST-imported-team',
      { ...selected, effort: provider === 'codex' ? 'ultra' : 'low' },
      'start'
    );
    assert.notEqual(changed.profile?.configRevision, original.profile?.configRevision);
    if (changed.profile?.provider === 'codex') {
      assert.equal(changed.profile.reasoningEffort, 'ultra');
      assert.equal(changed.profile.fastMode, true);
    }
    if (changed.profile?.provider === 'opencode') assert.equal(changed.profile.variant, 'low');
    assert.deepEqual(template, before);
    assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
    if (template.provider === 'codex') template.nativeOptions.fastMode = false;
    else if (template.provider === 'opencode') template.nativeOptions.variant = 'medium';
    assert.equal(original.isCurrent(), false);
    assert.equal(changed.isCurrent(), false);
  });

for (const provider of ['claude', 'codex', 'opencode'] as const)
  for (const defaultEffort of ['low', undefined] as const)
    test(`${provider} explicit UI Default ${String(defaultEffort)} resets only model/effort from the same private recipe while absent choices retain captured values`, (t) => {
      const f = fixture(t);
      selectProvider(f, provider);
      const template = f.profile.runtime!.providerTemplates![0]!;
      if (template.provider === 'claude')
        template.nativeOptions = {
          ...(defaultEffort === undefined ? {} : { effort: defaultEffort }),
          fastMode: false,
        };
      else if (template.provider === 'codex') {
        if (defaultEffort !== undefined) template.nativeOptions.reasoningEffort = defaultEffort;
        else delete template.nativeOptions.reasoningEffort;
        template.nativeOptions.fastMode = false;
      } else if (defaultEffort !== undefined) template.nativeOptions.variant = defaultEffort;
      else delete template.nativeOptions.variant;
      const roster = f.team.connection.readRoster();
      f.team.connection.replaceRoster({
        commandId: 'TEST-saved-app-overrides',
        expectedRevision: roster.revision,
        savedSettings: {
          ...roster.savedSettings,
          cwd: f.root,
          providerId: provider === 'claude' ? 'anthropic' : provider,
          model: 'TEST-saved-app-model',
          effort: 'high',
          ...(provider === 'opencode' ? {} : { fastMode: 'on' }),
          syncModelsWithLead: false,
          limitContext: true,
        },
        members: roster.members
          .filter((member) => member.role === 'member')
          .map((member) => ({ name: member.name })),
      });
      const selected = f.selection();
      const retained = f.runtime.captureLaunchModelProbe('TEST-imported-team', selected, 'start');
      assert.equal(retained.model, 'TEST-saved-app-model');
      assert.equal(retained.effort, 'high');
      const { effort: _savedEffort, ...withoutEffort } = selected;
      const explicitDefault: TeamModelProbeSelection = {
        ...withoutEffort,
        model: '__provider_default__',
        draft: {
          providerId: provider === 'claude' ? 'anthropic' : provider,
          target: { kind: 'lead' },
          workspace: f.root,
        },
      };
      const fresh = f.runtime.captureLaunchModelProbe(
        'TEST-imported-team',
        explicitDefault,
        'start'
      );
      assert.equal(fresh.model, template.model);
      assert.equal(fresh.effort, defaultEffort);
      assert.equal(fresh.profile?.accountBinding, retained.profile?.accountBinding);
      if (fresh.profile?.provider === 'codex') assert.equal(fresh.profile.fastMode, true);
      assert.equal(fresh.isCurrent(), true);
      const saved = structuredClone(template);
      saved.accountBinding = 'TEST-foreign-account';
      assert.throws(
        () =>
          resolveTeamModelProbeRecipe({
            runtime: f.profile.runtime,
            team: f.team,
            input: explicitDefault,
            saved,
          }),
        { reason: 'probe-default-recipe' }
      );
      assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
    });

test('V1 saved Default rebases only its proven limit overlay and resets the native provider/model pair', (t) => {
  const f = fixture(t);
  selectProvider(f, 'opencode');
  const template = f.profile.runtime!.providerTemplates![0]!;
  assert(template.provider === 'opencode');
  template.model = 'default';
  template.managedPreferences = { defaultModelId: 'TEST-local/default', modelLimitOverrides: {
    'TEST-local/default': { contextTokens: 32000, outputTokens: 1000 },
    'TEST-other/chosen': { contextTokens: 64000, outputTokens: 2000 },
  } };
  template.environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: {
    'TEST-local': { models: { default: { limit: { context: 9000, output: 90 } } } },
    'TEST-other': { models: { chosen: { limit: { context: 8000, output: 80 } } } },
  }, testUnrelated: 'TEST-preserved' });
  const roster = f.team.connection.readRoster();
  f.team.connection.replaceRoster({
    commandId: 'TEST-qualified-nondefault', expectedRevision: roster.revision,
    savedSettings: { ...roster.savedSettings, cwd: f.root, providerId: 'opencode',
      model: 'TEST-other/chosen', syncModelsWithLead: false, limitContext: true },
    members: roster.members.filter(row => row.role === 'member').map(row => ({ name: row.name })),
  });
  const input = f.selection();
  const original = f.runtime.captureLaunchModelProbe('TEST-imported-team', input, 'start');
  assert.ok(original.profile);
  assert.equal(original.model, 'chosen');
  assert.equal(original.providerId, 'TEST-other');
  const originalConfig = JSON.parse(original.profile!.environment.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(originalConfig.provider['TEST-other'].models.chosen.limit, { context: 64000, output: 2000 });
  const { effort: _effort, ...withoutEffort } = input;
  const fresh = f.runtime.captureLaunchModelProbe('TEST-imported-team', {
    ...withoutEffort, model: '__provider_default__',
    draft: { providerId: 'opencode', target: { kind: 'lead' }, workspace: f.root },
  }, 'start');
  assert.ok(fresh.profile);
  assert.equal(fresh.model, 'default');
  assert.equal(fresh.providerId, 'TEST-local');
  const config = JSON.parse(fresh.profile!.environment.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(config.provider['TEST-local'].models.default.limit, { context: 32000, output: 1000 });
  assert.deepEqual(config.provider['TEST-other'].models.chosen.limit, { context: 8000, output: 80 });
  assert.equal(config.testUnrelated, 'TEST-preserved');
  assert.equal(fresh.profile?.accountBinding, original.profile?.accountBinding);
  assert.equal(fresh.isCurrent(), true);
  assert.equal(original.isCurrent(), true);
  assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), [], 'inspection does not allocate a Team');
  template.environment.TEST_UNRELATED_CHANGE = 'TEST-new-private-value';
  assert.equal(fresh.isCurrent(), false, 'only the derived selected limits are normalized');
});

test('V2 draft Default preserves the native session model and rejects drifted private defaults', (t) => {
  const f = fixture(t);
  const base = f.profile.runtime!.providerTemplates![0]!;
  const template = runtimeMemberProfileSchema.parse({
    provider: 'opencode',
    nativeGeneration: 'v2',
    protocolRevision: '2.0.21',
    teamId: 'TEST-template-team',
    memberId: 'TEST-template-member',
    principalId: 'TEST-template-agent',
    sessionId: 'TEST-template-session',
    generation: 1,
    configRevision: 'TEST-native-v2',
    cwd: f.root,
    model: 'TEST-bound-native-model',
    accountBinding: 'TEST-v2-account',
    executable: { path: join(f.root, 'TEST-native-engine'), sha256: 'a'.repeat(64) },
    environment: {
      HOME: f.root, XDG_CONFIG_HOME: f.root,
      XDG_DATA_HOME: f.root, XDG_CACHE_HOME: f.root,
    },
    endpoint: 'http://127.0.0.1:19181',
    limits: base.limits,
    nativeOptions: { providerId: 'TEST-native-provider', agent: 'build', variant: 'TEST-variant' },
  });
  f.profile.runtime!.providerTemplates!.push(template);
  const saved = runtimeMemberProfileSchema.parse({
    ...template, nativeSessionId: 'ses_TESTbound',
  });
  if (saved.provider !== 'opencode') throw Error('TEST_expected_saved_opencode_profile');
  const { effort: _effort, context: _context, ...selection } = f.selection();
  const input: TeamModelProbeSelection = {
    ...selection,
    model: '__provider_default__',
    draft: { providerId: 'opencode', target: { kind: 'lead' }, workspace: f.root },
  };
  const recipe = () => resolveTeamModelProbeRecipe({
    runtime: f.profile.runtime, team: f.team, input, saved,
  });
  assert.equal(recipe().model, saved.model);
  const selected = applyTeamModelProbeSelection(recipe(), input);
  assert.equal(selected.model, saved.model);
  if (selected.provider !== 'opencode') throw Error('TEST_expected_opencode_profile');
  assert.equal(selected.nativeSessionId, 'ses_TESTbound');
  assert.equal(selected.nativeOptions.variant, 'TEST-variant');
  assert.throws(() => teamModelProbeProfile(selected), { reason: 'probe-v2-unsupported' });
  assert.throws(() => applyTeamModelProbeSelection(recipe(), {
    ...input, model: saved.model,
  }), { reason: 'launch-option-unsupported' });

  // The model probe can show a saved effort without treating the same V2
  // native variant as a request to change it.
  const knownVariant = runtimeMemberProfileSchema.parse({
    ...saved, nativeOptions: { ...saved.nativeOptions, variant: 'high' },
  });
  const unchanged = applyTeamModelProbeSelection(knownVariant, {
    ...input, effort: 'high',
  });
  if (unchanged.provider !== 'opencode') throw Error('TEST_expected_opencode_profile');
  assert.equal(unchanged.nativeSessionId, saved.nativeSessionId);
  assert.equal(unchanged.nativeOptions.variant, 'high');
  assert.throws(() => applyTeamModelProbeSelection(knownVariant, {
    ...input, effort: 'low',
  }), { reason: 'launch-option-unsupported' });

  template.model = 'TEST-drifted-native-model';
  assert.throws(recipe, { reason: 'probe-default-recipe' });
  template.model = saved.model;
  if (template.provider !== 'opencode') throw Error('TEST_expected_opencode_template');
  template.nativeOptions.variant = 'TEST-drifted-variant';
  assert.throws(recipe, { reason: 'probe-default-recipe' });

  // The new embedded path binds the native delivery graph as part of the
  // same private Default recipe; a model match cannot hide an engine change.
  const embedded = {
    version: '2.1.4' as const, platform: process.platform, arch: process.arch,
    directory: join(f.root, 'TEST-engine'), manifestSha256: 'b'.repeat(64),
    externalDirectory: 'deny' as const,
  };
  const embeddedSaved = runtimeMemberProfileSchema.parse({ ...saved,
    protocolRevision: '2.1.4', embedded });
  const embeddedTemplate = runtimeMemberProfileSchema.parse({ ...embeddedSaved,
    nativeSessionId: undefined });
  f.profile.runtime!.providerTemplates = [embeddedTemplate];
  const embeddedRecipe = () => resolveTeamModelProbeRecipe({
    runtime: f.profile.runtime, team: f.team, input, saved: embeddedSaved,
  });
  assert.equal(embeddedRecipe().model, saved.model);
  assert.equal(teamModelProbeProfile(embeddedRecipe()).provider, 'opencode');
  if (embeddedTemplate.provider !== 'opencode' || !embeddedTemplate.embedded)
    throw Error('TEST_expected_embedded_template');
  embeddedTemplate.model = 'TEST-new-private-default';
  embeddedTemplate.nativeOptions.variant = 'low';
  embeddedTemplate.embedded.providerConfiguration = { models: { 'TEST-new-private-default': {} } };
  const freshDefault = applyTeamModelProbeSelection(embeddedRecipe(), input);
  assert.equal(freshDefault.model, 'TEST-new-private-default');
  if (freshDefault.provider !== 'opencode') throw Error('TEST_expected_opencode_default');
  assert.equal(freshDefault.nativeOptions.variant, 'low');
  assert.deepEqual(freshDefault.embedded?.providerConfiguration,
    embeddedTemplate.embedded.providerConfiguration);
  assert.equal(embeddedSaved.model, 'TEST-bound-native-model', 'saved native history is unchanged');
  embeddedTemplate.embedded.manifestSha256 = 'c'.repeat(64);
  assert.throws(embeddedRecipe, { reason: 'probe-default-recipe' });
  assert.deepEqual(f.owner.runtimeCaptures('TEST-human'), []);
});

function testPolicyPlugin(root: string) {
  const path = join(root, 'TEST-opencode-policy.js'),
    bytes = 'export default async () => ({})\n';
  writeFileSync(path, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function assertRetainedProductRosterTransfer(t: TestContext) {
  const providerId = 'test-local', modelId = 'TEST-model';
  let allocations = 0;
  const own = fixture(t, false, profile => {
    const definition = profile.teams[0]!, root = profile.owner.storageRoot;
    const alice = definition.members.find(row => row.memberId === 'alice')!;
    alice.settings = { providerId: 'opencode', model: modelId };
    alice.delivery = { ...definition.binding, runId: definition.scope.runId, memberId: 'alice', generation: '1' };
    definition.grants.push({ principalId: 'TEST-retained-agent', memberName: 'alice', permissions: ['read'] });
    profile.runtime!.members = [runtimeMemberProfileSchema.parse({
      provider: 'opencode', protocolRevision: '1.19.4', teamId: definition.binding.teamId, memberId: 'alice',
      principalId: 'TEST-retained-agent', sessionId: 'TEST-retained-session', generation: 1,
      configRevision: 'TEST-retained-config', accountBinding: 'TEST-retained-account', model: modelId, cwd: root,
      executable: { path: join(root, 'TEST-opencode'), sha256: 'c'.repeat(64) }, endpoint: 'http://127.0.0.1:9',
      mcpPolicyPlugin: testPolicyPlugin(root),
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
      nativeOptions: { providerId, agent: 'build' },
      limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 100,
        pendingInteractions: 1, timeoutMs: 1000 },
    })];
    writeFileSync(join(root, 'opencode.json'), JSON.stringify({ provider: { [providerId]: {
      npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'TEST-retained-key' },
      models: { [modelId]: { name: modelId } },
    } } }), { mode: 0o600 });
  }, () => { allocations++; });
  const initial = own.runtime.executeLaunch(own.team.definition.binding.teamId, 'configuration.read',
    'TEST-retained-configuration', {}) as unknown as { launch: { launchId: string; rosterRevision: string } };
  const originalRoster = own.team.connection.readRoster();
  const payload: TeamModelProbeSelection = {
    launchId: initial.launch.launchId, rosterRevision: initial.launch.rosterRevision,
    memberId: 'alice', model: providerId + '/' + modelId,
    draft: { providerId: 'opencode', target: { kind: 'member', name: 'alice', originalName: 'alice' } },
  };
  assert.notEqual(payload.rosterRevision, originalRoster.revision,
    'technical Launch and product-roster revisions are separate identities');
  assert.equal(payload.launchId.startsWith('saved-model-'), false);
  const captured = own.runtime.captureLaunchModelProbe(own.team.definition.binding.teamId, payload, 'read');
  assert.equal(captured.profile?.provider, 'opencode');
  if (captured.profile?.provider !== 'opencode') assert.fail('TEST-retained-OpenCode-profile');
  const profile = captured.profile, commandId = 'TEST-retained-product-probe';
  const records = new FileManagementCommandStore(own.root);
  const reference = (path: string): ReadinessSourceReference => {
    const directories: unknown[] = []; let directory = parsePath(path).root;
    for (const part of ['', ...dirname(path).slice(directory.length).split(sep).filter(Boolean)]) {
      if (part) directory = join(directory, part);
      try { const stat = lstatSync(directory); directories.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        return { path, root: own.root, present: false,
          digest: managementDigest({ path, root: own.root, directories, missing: directory }) }; }
    }
    try { const stat = lstatSync(path); return { path, root: own.root, present: true,
      digest: managementDigest({ path, root: own.root, directories,
        file: [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink],
        bytes: createHash('sha256').update(readFileSync(path)).digest('hex') }) }; }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      return { path, root: own.root, present: false,
        digest: managementDigest({ path, root: own.root, directories, missing: path }) }; }
  };
  const handleId = 'TEST-retained-handle', scope = own.team.definition.scope;
  const origin: LocalModelReadinessOrigin = {
    schemaVersion: 1, kind: 'team', ownerDigest: managementDigest(own.profile.owner),
    contextId: 'TEST-retained-context', commandId,
    selectionDigest: managementDigest({ handleId, scope, payload }),
    workspaces: [{ path: own.root, project: { selectedPath: join(own.root, 'opencode.json'), invalid: false,
      sources: ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
        .map(name => reference(join(own.root, name))),
      providers: [{ providerId, baseUrl: 'http://127.0.0.1:9/v1', preset: 'custom', hasConfiguredApiKey: true }],
    }, global: { notConsulted: 'project-precedence' } }], approval: { notConsulted: 'no-private-target' },
  };
  const profiles = new Map<string, ProviderManagementProfile>();
  const target = (selected: ProviderManagementProfile) => ({
    profileId: selected.profileId, configRevision: selected.configRevision,
    selectionDigest: runtimeDigest(selected), resourceId: runtimeDigest(selected.accountBinding),
  });
  let runs = 0, closes = 0, complete!: (ok: boolean) => void;
  const probes = new ModelProbeOwner({
    store: records, fence: new ManagementResourceFence(records.list()), assertWriter() {},
    select: (id, revision) => {
      const selected = profiles.get(id); assert.ok(selected); assert.equal(selected.configRevision, revision);
      return target(selected);
    },
    readinessOriginCurrent: selected =>
      captureOpenCodeReadinessOrigin(selected, profile, providerId, () => true).isCurrent(),
    prepare: (input, current, purpose, selectedOrigin) => {
      assert.equal(purpose, 'native-local-readiness-v1');
      assert.deepEqual(selectedOrigin, origin);
      const account = captureOpenCodeProbeAccount(profile, input, current, undefined, selectedOrigin);
      assert.ok(account);
      return { timeoutMs: 1000,
        run: () => { runs++; return new Promise<boolean>(resolve => { complete = resolve; }); },
        close: async () => { closes++; return true; },
        readiness: (): NativeLocalReadinessEvidence => ({
          schemaVersion: 1, ordinary: 'confirmed', coordination: 'not-applicable', decision: 'allow',
          reasons: ['not-applicable'], routeDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64),
          accountDigest: account.digest, metadata: { provider: 'custom', tools: null, modelListed: null,
            contextTokens: null, parameterCount: null, configuredContextTokens: null,
            trainedContextTokens: null, contextSource: 'unknown' },
        }),
      };
    },
  });
  const management = { probes, readinessTarget: target,
    admitTeamProbeProfile: (selected: ProviderManagementProfile) => { profiles.set(selected.profileId, selected); } };
  const request = { runtime: own.runtime, management, teamId: own.team.definition.binding.teamId,
    commandId, payload, readiness: { preparation: { origin, remainingMs: 1000 },
      owner: own.profile.owner, handleId, scope } };
  assert.equal((await executeTeamModelProbe({ ...request, action: 'start' }))?.phase, 'running');
  const admitted = probes.readRetainedProbe(commandId, captured.context);
  await executeTeamModelProbe({ ...request, action: 'start' });
  assert.equal(runs, 1, 'same-ID replay must not prepare another native probe');
  assert.equal(probes.readRetainedProbe(commandId, captured.context).expiresAt, admitted.expiresAt);
  complete(true);
  await probes.awaitPrepared(commandId, captured.context);
  const original = probes.readRetainedProbe(commandId, captured.context);
  assert.equal(original.phase, 'completed'); assert.equal(original.ok, true);
  assert.equal(original.resourceHeld, false); assert.equal(closes, 1);
  assert.equal(original.purpose, 'native-local-readiness-v1');
  assert.equal(original.readiness?.evidence.ordinary, 'confirmed');
  assert.equal(original.readinessScope?.sourceRevision, payload.launchId);
  assert.equal(original.readinessScope?.rosterRevision, payload.rosterRevision);
  const transfer: LocalModelReadinessTransfer = {
    preparationId: 'TEST-retained-preparation', remainingMs: 1000, probes: [{ commandId, selection: payload }],
    roster: { commandId: 'TEST-retained-full-CAS', expected: {
      expectedRevision: originalRoster.revision, savedSettings: originalRoster.savedSettings!,
      members: [{ name: 'alice', providerId: 'opencode', model: payload.model }],
    } },
  };
  own.team.connection.replaceRoster({ commandId: transfer.roster.commandId, ...transfer.roster.expected });
  const published = own.team.connection.readRoster();
  const source = captureRuntimeSource(own.profile, own.team, 'TEST-retained-capture', transfer.roster.commandId,
    published, { deferMcp: true });
  const compiled = compileRuntimeCapture(own.profile, own.team, source, 'model-preflight');
  const options = { management, team: own.team, source, profiles: compiled.profiles,
    principalId: own.profile.principalId, hostIncarnation: 'TEST-retained-host', transfer,
    admittedAt: Date.now(), isCurrent: () => true };
  const transferred = captureLaunchModelReadiness(options);
  assert.equal(transferred.groups.length, 1);
  assert.equal(transferred.groups[0]!.commandId, commandId);
  assert.equal(transferred.groups[0]!.context, captured.context);
  assert.equal(transferred.groups[0]!.expiresAt, original.expiresAt);
  assert.equal(transferred.capture.cutoff, original.expiresAt);
  assert.equal(transferred.capture.rosterRevision, published.revision);
  assert.equal(transferred.capture.targets[0]!.originalProbeCommandId, commandId);
  assert.equal(transferred.capture.targets[0]!.originalContext, captured.context);
  assert.equal(allocations, 0); assert.deepEqual(own.owner.runtimeCaptures(own.profile.principalId), []);
  await assert.rejects(() => executeTeamModelProbe({ ...request, action: 'start' }), { code: 'hold' });
  assert.equal(runs, 1, 'the changed product roster cannot renew the original admission');
  const originalBytes = files(join(own.root, 'management-commands'));
  for (const actionDigest of [
    runtimeDigest({ commandId, context: captured.context }),
    runtimeDigest({ commandId, context: captured.context, productRosterRevision: 'f'.repeat(64) }),
  ]) {
    try {
      records.write({ ...original, readinessScope: { ...original.readinessScope!, actionDigest } });
      assert.throws(() => captureLaunchModelReadiness(options), { code: 'held' });
    } finally {
      records.write(original); assert.deepEqual(files(join(own.root, 'management-commands')), originalBytes);
    }
  }
  assert.throws(() => captureLaunchModelReadiness({ ...options, transfer: { ...transfer,
    probes: [{ commandId: commandId + '-foreign', selection: payload }] } }), { code: 'conflict' });
  assert.throws(() => captureLaunchModelReadiness({ ...options, transfer: { ...transfer,
    probes: [{ commandId, selection: { ...payload, model: providerId + '/TEST-other-model' } }] } }), { code: 'conflict' });
  try {
    records.write({ ...original, expiresAt: Date.now() - 1 });
    assert.throws(() => captureLaunchModelReadiness(options), { code: 'held' });
  } finally {
    records.write(original); assert.deepEqual(files(join(own.root, 'management-commands')), originalBytes);
  }
  t.mock.timers.setTime(original.expiresAt - 1);
  assert.deepEqual(captureLaunchModelReadiness(options), transferred,
    'the original readiness remains usable strictly before its unchanged cutoff');
  t.mock.timers.setTime(original.expiresAt);
  assert.throws(() => captureLaunchModelReadiness(options), { code: 'held' },
    'the original readiness expires exactly at its cutoff without any lease extension');
  assert.deepEqual(files(join(own.root, 'management-commands')), originalBytes);
  assert.equal(runs, 1); assert.equal(closes, 1); assert.equal(allocations, 0);
}
