import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, parse as parsePath, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { FileTeamRegistryStore } from '../dist/adapters/team-registry/FileTeamRegistryStore.js';
import { admitRegistryTeamNamespace } from '../dist/adapters/team-registry/admitRegistryTeamNamespace.js';
import { captureCreateTeamDraft } from '../dist/composition/captureCreateTeamDraft.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { CreateTeamLaunchCoordinator } from '../dist/composition/CreateTeamLaunchCoordinator.js';
import { ClaudeManagementCoordinator } from '../dist/composition/ClaudeManagementCoordinator.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { createOpenCodeLocalModelReadiness } from '../dist/adapters/providers/OpenCodeLocalModelReadiness.js';
import { captureOpenCodeReadinessOrigin } from '../dist/adapters/providers/OpenCodeReadinessOrigin.js';
import { executeTeamModelProbe } from '../dist/composition/teamLaunchModelProbe.js';
import { actualCaptureReadinessCommandId } from '../dist/team-launch/launchReadiness.js';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import { digest } from '../dist/team/identity.js';
import { runtimeSourceSelectionFixture } from './fixtures/runtime-source-selection.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type { CreateTeamLaunchPreparationInput } from '../dist/team-registry/createLaunchContracts.js';
import type { TeamLaunchRecord, TeamLaunchSummary } from '../dist/team-launch/contracts.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { Session } from '@agent-teams/provider-session-contracts';
import type { ProviderManagementProfile } from '../dist/management/profile.js';
import type { LocalModelReadinessPreparation, ReadinessSourceReference } from '../dist/management/commandRecords.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Complete TEST file references, computed independently of the bounded production reader.
function readinessReference(path: string, root: string): ReadinessSourceReference {
  const directories: unknown[] = [];
  let directory = parsePath(path).root;
  for (const part of ['', ...dirname(path).slice(directory.length).split(sep).filter(Boolean)]) {
    if (part) directory = join(directory, part);
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, root, present: false, digest: digest({ path, root, directories, missing: directory }) };
    }
    directories.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]);
  }
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, root, present: false, digest: digest({ path, root, directories, missing: path }) };
  }
  return { path, root, present: true, digest: digest({ path, root, directories,
    file: [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink],
    bytes: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }) };
}

function fixture(withSources = false, provider: 'claude' | 'opencode' = 'claude', worktree = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-create-launch-')));
  for (const name of ['project', 'home', 'config']) mkdirSync(join(root, name));
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: [],
    creation: { contextIds: ['TEST-context'] },
    owner: {
      ownerId: 'TEST-owner',
      profileId: 'TEST-profile',
      revision: 'TEST-revision',
      storageRoot: root,
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
          teamId: 'TEST-template',
          memberId: 'TEST-template',
          principalId: 'TEST-template',
          sessionId: 'TEST-template',
          generation: 0,
          configRevision: 'TEST-template',
          accountBinding: 'TEST-account',
          model: 'TEST-model',
          cwd: join(root, 'project'),
          executable: { path: process.execPath, sha256: 'a'.repeat(64) },
          environment: {
            HOME: join(root, 'home'),
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            PATH: '/TEST/bin',
          },
          nativeTools: [],
          autoAllowedTools: [],
          limits: {
            queuedInputs: 8,
            inputBytes: 4096,
            outputBytes: 8192,
            outputEvents: 128,
            pendingInteractions: 8,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
  if (provider === 'opencode') {
    const template = profile.runtime!.providerTemplates![0]!;
    if (template.provider !== 'claude') assert.fail('expected original TEST Claude template');
    const { nativeTools: _tools, autoAllowedTools: _allowed, ...base } = template;
    profile.runtime!.providerTemplates = [runtimeMemberProfileSchema.parse({ ...base,
      provider, protocolRevision: '1.19.4', endpoint: 'http://127.0.0.1:19189',
      mcpPolicyPlugin: testPolicyPlugin(root), accountBinding: 'TEST-opencode-account',
      nativeOptions: { providerId: 'test-local', agent: 'build', variant: 'medium' },
      environment: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'config') },
    })];
    writeFileSync(join(root, 'project', 'opencode.json'), JSON.stringify({ provider: {
      'test-local': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://example.test/v1', apiKey: 'TEST-only-key' } },
    } }));
  }
  if (worktree) {
    const git = (...args: string[]) => execFileSync('git', ['-C', join(root, 'project'), ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'TEST');
    git('config', 'user.email', 'test@example.invalid');
    git('add', '.');
    git('commit', '-m', 'TEST captured OpenCode configuration');
  }
  let current = true,
    opens = 0,
    spends = 0;
  const assertCurrent = () => {
    if (!current) throw new TeamLaunchError('hold', 'TEST-writer');
  };
  const sources = withSources ? runtimeSourceSelectionFixture(profile, assertCurrent) : undefined;
  const openedExecutables: string[] = [], probeProfiles: string[] = [];
  const allocatedMembers = new Map<string, number>();
  let resolveAllocated!: () => void;
  const allocated = new Promise<void>(resolve => { resolveAllocated = resolve; });
  const teams = new Map<string, HostedTeam>();
  const registry = new TeamRegistry({
    ownerId: profile.owner.ownerId,
    profileId: profile.owner.profileId,
    principalId: profile.principalId,
    contextIds: profile.creation!.contextIds,
    staticTeams: [],
    store: new FileTeamRegistryStore(root, assertCurrent),
    assertWriter: assertCurrent,
    admit: (definition, fresh, published) =>
      admitRegistryTeamNamespace(root, definition.binding, fresh, published),
    attach: (definition) => {
      if (teams.has(definition.binding.teamId)) return;
      const owner = createFilesystemTeamOwner({
        root,
        binding: definition.binding,
        members: definition.members.map(({ memberId, name, role, settings, delivery }) => ({
          memberId,
          name,
          role,
          ...(settings === undefined ? {} : { settings }),
          ...(delivery === undefined ? {} : { delivery }),
        })),
        grants: definition.grants.map(({ principalId, memberName, permissions, revoked }) => ({
          principalId,
          memberName,
          permissions,
          ...(revoked === undefined ? {} : { revoked }),
        })),
        ...(definition.savedSettings === undefined
          ? {}
          : { savedSettings: definition.savedSettings }),
        assertRosterEditable: (members) =>
          runtime.assertRosterEditable(definition.binding.teamId, members),
      });
      teams.set(definition.binding.teamId, {
        definition,
        owner,
        connection: owner.connect(profile.principalId),
        operatorPrincipalId: profile.principalId,
      });
    },
  });
  const createRuntime = () =>
    new RuntimeTeamCoordinator({
      profile,
      modelReadiness,
      ...(sources ? { sources: sources.index } : {}),
      teams,
      assertWriter: assertCurrent,
      createProvider: (context) => {
        opens++;
        openedExecutables.push(context.profile.executable.path);
        let ended!: () => void;
        const done = new Promise<void>((resolve) => {
          ended = resolve;
        });
        const driver: Session = {
          sessionRef: `TEST-${opens}`,
          submit: async () => ({ ok: false, code: 'unsupported' }),
          observe: async function* () {
            await done;
            yield* [];
          },
          respondToInteraction: async () => ({
            ok: false,
            code: 'unsupported',
          }),
          interrupt: async () => ({ ok: false, code: 'unsupported' }),
          checkReadiness: async () => {
            if (!allocatedMembers.has(context.profile.memberId))
              allocatedMembers.set(context.profile.memberId, Date.now());
            if (allocatedMembers.size === 2) resolveAllocated();
            return { ok: true, value: undefined };
          },
          checkpoint: () => ({ ok: false, code: 'unsupported' }),
          close: async () => {
            ended();
            return { logicallyClosed: true, cleanup: 'confirmed' };
          },
        };
        return {
          factory: {
            open: async () => ({
              driver,
              capabilities: [...context.request.requiredCapabilities],
            }),
          },
          isReady: () => false,
          seal() {},
          cleanup: async () => true,
        };
      },
    });
  let runtime: RuntimeTeamCoordinator;
  const claude = new ClaudeManagementCoordinator([], assertCurrent);
  const targets = new ProviderManagementCoordinator([], assertCurrent, root);
  const profiles = new Map<string, ProviderManagementProfile>();
  const store = new FileManagementCommandStore(root);
  const pending: Array<(ok: boolean) => void> = [];
  const probes = new ModelProbeOwner({
    store,
    fence: new ManagementResourceFence(store.list()),
    assertWriter: assertCurrent,
    select: (id, revision) => {
      const selected = profiles.get(id);
      return selected?.provider === 'opencode' ? targets.readinessTarget(selected) : claude.target(id, revision);
    },
    readinessOriginCurrent(origin, input, isCurrent = () => true) {
      const selected = profiles.get(input.profileId);
      return selected?.provider === 'opencode' &&
        captureOpenCodeReadinessOrigin(origin, selected, input.providerId, isCurrent).isCurrent();
    },
    prepare: (input, current, purpose, origin) => {
      const ordinary = {
      timeoutMs: 90000,
      run: () => {
        spends++;
        probeProfiles.push(input.profileId);
        return new Promise<boolean>((resolve) => pending.push(resolve));
      },
      close: async () => true,
      };
      const selected = profiles.get(input.profileId);
      if (selected?.provider !== 'opencode') return ordinary;
      assert.equal(purpose, 'native-local-readiness-v1');
      assert.ok(origin);
      return createOpenCodeLocalModelReadiness(selected, input, current, {
        ordinary(observe) { return { ...ordinary, async run() {
          observe({ id: input.providerId, npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'https://example.test/v1', apiKey: 'TEST-only-key' } });
          return ordinary.run();
        } }; },
        coordination() { assert.fail('keyed TEST source cannot start an authless coordination probe'); },
        fetchImpl: async () => { assert.fail('keyed TEST source cannot discover metadata'); },
      }, origin);
    },
  });
  const modelReadiness = { probes, readinessTarget: targets.readinessTarget.bind(targets),
    admitTeamProbeProfile(value: ProviderManagementProfile) {
      profiles.set(value.profileId, structuredClone(value));
      if (value.provider === 'claude') claude.admitProbeProfile(value);
      else if (value.provider === 'opencode') targets.admitTeamProbeProfile(value);
      else assert.fail('TEST-fixture-provider');
    },
  };
  runtime = createRuntime();
  const createCoordinator = () =>
    new CreateTeamLaunchCoordinator({
      profile,
      ...(sources ? { sources: sources.index } : {}),
      registry,
      runtime,
      assertCurrent,
      team: (id) => teams.get(id),
      management: modelReadiness,
    });
  let coordinator = createCoordinator();
  const input: CreateTeamLaunchPreparationInput = {
    preparationId: 'TEST-preparation',
    draft: {
      contextId: 'TEST-context',
      teamName: 'TEST-created',
      savedSettings: {
        cwd: join(root, 'project'),
        providerId: 'anthropic',
        model: 'TEST-model',
        effort: 'medium',
        limitContext: true,
        prompt: 'TEST initial prompt',
      },
      members: [{ name: 'worker', memberSettings: { role: 'TEST role' } }],
    },
  };
  if (provider === 'opencode') {
    input.draft.savedSettings.providerId = 'opencode';
    input.draft.savedSettings.model = 'test-local/TEST-model';
  }
  if (worktree) {
    input.draft.savedSettings.worktree = 'test-b2-worktree';
    input.draft.members[0]!.memberSettings.isolation = 'worktree';
  }
  return {
    root,
    profile,
    sources,
    openedExecutables,
    probeProfiles,
    input,
    get coordinator() {
      return coordinator;
    },
    get runtime() {
      return runtime;
    },
    registry,
    teams,
    store,
    probes,
    claude,
    modelReadiness,
    origin(actual?: { workspace: string; commandId: string; selection: unknown }): LocalModelReadinessPreparation | undefined {
      if (provider !== 'opencode') return undefined;
      const workspace = actual?.workspace ?? join(root, 'project'), selectedPath = join(workspace, 'opencode.json');
      return { remainingMs: 90000, origin: { schemaVersion: 1, kind: actual ? 'team' : 'create',
        ownerDigest: digest(profile.owner), contextId: input.draft.contextId,
        commandId: actual?.commandId ?? input.preparationId, selectionDigest: digest(actual?.selection ?? input),
        workspaces: [{ path: workspace, project: { selectedPath, invalid: false,
          sources: ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
            .map(name => readinessReference(join(workspace, name), workspace)),
          providers: [{ providerId: 'test-local', baseUrl: 'https://example.test/v1', preset: 'custom', hasConfiguredApiKey: true }],
        }, global: { notConsulted: 'project-precedence' } }], approval: { notConsulted: 'no-private-target' },
      } };
    },
    opens: () => opens,
    spends: () => spends,
    async waitForOriginalAllocation(members: TeamLaunchSummary['members']) {
      const expected = members.map(({ memberId, attempt }) => ({ memberId, deadline: attempt.deadlineMs }));
      assert.equal(expected.length, 2);
      assert.equal(new Set(expected.map(row => row.memberId)).size, 2);
      assert.ok(expected.every(row => Number.isSafeInteger(row.deadline) && row.deadline > 0));
      const cutoff = Math.min(...expected.map(row => row.deadline));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([allocated, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Original Create allocation deadline expired')),
            Math.max(0, cutoff - Date.now()));
        })]);
        assert.deepEqual([...allocatedMembers.keys()].sort(), expected.map(row => row.memberId).sort());
        for (const { memberId } of expected)
          assert.ok(allocatedMembers.get(memberId)! < cutoff, 'allocation must precede the original minimum deadline');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async green() {
      pending.shift()!(true);
      await tick();
    },
    invalidate() {
      current = false;
    },
    async restart() {
      await runtime.close();
      runtime = createRuntime();
      coordinator = createCoordinator();
    },
    async close() {
      current = true;
      await probes.close();
      await targets.close();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('published source is shared by Create preflight and launch, while retained model defaults survive another publication', async () => {
  const f = fixture(true);
  try {
    const selected = await f.sources!.publish('TEST-source-B');
    const preview = captureCreateTeamDraft(f.profile, f.input, true, f.sources!.index);
    assert.ok(preview.selections.every(row => row.selection.profile.executable.path === selected.executable.path));
    await f.coordinator.prepare('start', f.input);
    await f.green();
    assert.equal(f.probeProfiles[0], preview.selections[0]!.selection.profile.profileId);
    const created = await f.coordinator.submit('TEST-source-create', f.input);
    await tick();
    assert.deepEqual(f.openedExecutables, [selected.executable.path, selected.executable.path]);
    const team = f.teams.get(created.creation.record.teamId)!;
    const originalSources = f.runtime.readLaunchSourceSelections(created.creation.record.teamId, created.launch.launchId);
    assert.ok(originalSources.every(row => row.revision === selected.selection.revision));
    await f.sources!.publish('TEST-source-C');
    const retained = f.runtime.captureLaunchModelProbe(created.creation.record.teamId, {
      launchId: created.launch.launchId,
      rosterRevision: created.launch.rosterRevision,
      memberId: team.definition.members[0]!.memberId,
      model: '__provider_default__',
      draft: { providerId: 'anthropic', target: { kind: 'lead' }, workspace: join(f.root, 'project') },
    }, 'start');
    assert.equal(retained.profile?.executable.path, selected.executable.path);
    assert.equal(retained.model, 'TEST-model');
    assert.equal(retained.isCurrent(), true);
    await f.coordinator.submit('TEST-source-create', f.input);
    assert.equal(f.opens(), 2);
    assert.equal(f.spends(), 1);
  } finally { await f.close(); }
});

test('source publication invalidates old Create proof but exact cancellation still settles its original intent', async () => {
  const f = fixture(true);
  try {
    await f.sources!.publish('TEST-source-B');
    const running = await f.coordinator.prepare('start', f.input);
    await f.sources!.publish('TEST-source-C');
    await assert.rejects(f.coordinator.submit('TEST-source-create', f.input));
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.equal(f.opens(), 0);
    const changed = structuredClone(f.input);
    changed.draft.savedSettings.prompt = 'TEST-foreign-intent';
    await assert.rejects(f.coordinator.prepare('cancel', changed), { code: 'conflict' });
    const cancelled = await f.coordinator.prepare('cancel', f.input);
    assert.equal(cancelled.probes[0]!.commandId, running.probes[0]!.commandId);
    assert.equal(cancelled.probes[0]!.phase, 'cancelled');
    assert.equal(f.spends(), 1);
    assert.equal((await f.coordinator.prepare('cancel', f.input)).probes[0]!.phase, 'cancelled');
  } finally { await f.close(); }
});

test('legacy seed probe receipts remain cancellable after the first source publication', async () => {
  const f = fixture(true);
  try {
    const initial = await f.coordinator.prepare('read', f.input);
    const seed = captureCreateTeamDraft(f.profile, f.input);
    const selection = seed.selections[0]!.selection;
    const context = digest({ draftDigest: seed.draftDigest, preparationId: f.input.preparationId, selection });
    f.probes.start({
      commandId: initial.probes[0]!.commandId,
      profileId: selection.profile.profileId, configRevision: selection.profile.configRevision,
      providerId: selection.providerId, modelId: selection.model, context,
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      ...(selection.context === undefined ? {} : { modelContext: selection.context }),
    });
    assert.equal((await f.coordinator.prepare('read', f.input)).probes[0]!.phase, 'running');
    await f.sources!.publish('TEST-legacy-to-B');
    assert.equal((await f.coordinator.prepare('cancel', f.input)).probes[0]!.phase, 'cancelled');
    assert.equal(f.spends(), 1);
  } finally { await f.close(); }
});

test('an interrupted published Create preserves B and permits an explicit proved fresh Launch on C', async () => {
  const f = fixture(true);
  try {
    await f.sources!.publish('TEST-source-B');
    await f.coordinator.prepare('start', f.input);
    await f.green();
    const read = f.runtime.readLaunchSourceSelections.bind(f.runtime);
    let concurrent: Promise<unknown> | undefined;
    f.runtime.readLaunchSourceSelections = () => {
      assert.throws(() => f.coordinator.lookup('TEST-source-create', f.input), { reason: 'creation-pending' });
      concurrent = assert.rejects(f.coordinator.submit('TEST-source-create', f.input), { reason: 'creation-pending' });
      throw new TeamLaunchError('hold', 'TEST-interrupted-before-start');
    };
    await assert.rejects(f.coordinator.submit('TEST-source-create', f.input), { code: 'hold' });
    f.runtime.readLaunchSourceSelections = read;
    await concurrent;
    assert.equal(f.registry.list('TEST-context').teams.length, 1);
    assert.equal(f.opens(), 0);
    const selectedC = await f.sources!.publish('TEST-source-C');
    const renewed = { ...f.input, preparationId: 'TEST-source-C-preflight' };
    const partial = await f.coordinator.submit('TEST-source-create', renewed);
    assert.equal(partial.partialCreated, true);
    assert.equal(partial.launch.admission, undefined);
    assert.equal(partial.launch.startedAtMs, null);
    const teamId = partial.creation.record.teamId, team = f.teams.get(teamId)!;
    const records = new TeamOwnerStore(f.root, partial.creation.record.teamName);
    const oldPath = join(records.directory, 'launches', `${digest(partial.launch.launchId)}.json`);
    const oldBytes = readFileSync(oldPath);
    await f.restart();
    const cold = f.coordinator.lookup('TEST-source-create', renewed)!;
    assert.equal(cold.partialCreated, true);
    assert.equal(cold.launch.launchId, partial.launch.launchId);
    const view = f.runtime.executeLaunch(teamId, 'model.configuration.read', 'TEST-next-model-read', {}) as {
      source: { sourceId: string; rosterRevision: string };
      members: Array<{ memberId: string }>;
    };
    assert.ok(view.source.sourceId.startsWith('saved-model-'));
    const checked = f.runtime.captureLaunchModelProbe(teamId, {
      launchId: view.source.sourceId, rosterRevision: view.source.rosterRevision,
      memberId: view.members[0]!.memberId, model: 'TEST-model',
      draft: { providerId: 'anthropic', target: { kind: 'lead' }, workspace: join(f.root, 'project') },
    }, 'start');
    assert.equal(checked.profile?.provider, 'claude');
    assert.equal(checked.profile?.executable.path, selectedC.executable.path);
    assert.equal(checked.isCurrent(), true);
    const nativeProfile = checked.profile!;
    if (nativeProfile.provider !== 'claude') assert.fail('expected Claude probe');
    f.claude.admitProbeProfile(nativeProfile);
    const probeId = { commandId: 'TEST-fresh-launch-model', profileId: nativeProfile.profileId,
      configRevision: nativeProfile.configRevision };
    f.probes.start({ ...probeId, providerId: 'anthropic', modelId: checked.model, context: checked.context }, checked.isCurrent);
    await f.green();
    assert.equal(f.probes.read(probeId)?.ok, true);
    assert.equal(f.opens(), 0);
    assert.equal(f.spends(), 2);
    team.connection.replaceRoster({ commandId: 'TEST-fresh-roster', expectedRevision: team.connection.readRoster().revision,
      savedSettings: f.input.draft.savedSettings,
      members: f.input.draft.members.map(({ name, memberSettings }) => ({ name, ...memberSettings })) });
    const next = await f.runtime.executeLaunch(teamId, 'capture', 'TEST-fresh-capture', { rosterCommandId: 'TEST-fresh-roster' }) as {
      launch: { launchId: string; rosterRevision: string };
    };
    assert.ok(f.runtime.readLaunchSourceSelections(teamId, next.launch.launchId).every(row => row.revision === selectedC.selection.revision));
    const nextScope = { launchId: next.launch.launchId, rosterRevision: next.launch.rosterRevision };
    await f.runtime.executeLaunch(teamId, 'start', 'TEST-fresh-start', nextScope);
    await tick();
    assert.deepEqual(f.openedExecutables, [selectedC.executable.path, selectedC.executable.path]);
    await f.runtime.executeLaunch(teamId, 'start', 'TEST-fresh-start', nextScope);
    assert.equal((await f.coordinator.submit('TEST-source-create', renewed)).partialCreated, true);
    assert.equal(f.opens(), 2);
    assert.deepEqual(readFileSync(oldPath), oldBytes);
    assert.equal(f.registry.list('TEST-context').teams.length, 1);
  } finally { await f.close(); }
});

// Unauthorized or unsupported input becoming a Team, probe spend or captured session makes this red.
test('draft preflight rejects unsupported intent and foreign context before Team writes or probe spend', async () => {
  const f = fixture();
  try {
    for (const change of [
      (input: CreateTeamLaunchPreparationInput) => {
        input.draft.contextId = 'foreign';
      },
      (input: CreateTeamLaunchPreparationInput) => {
        input.draft.savedSettings.providerId = 'codex';
      },
      (input: CreateTeamLaunchPreparationInput) => {
        input.draft.members[0]!.memberSettings.providerId = 'opencode';
      },
      (input: CreateTeamLaunchPreparationInput) => {
        input.draft.savedSettings.extraCliArgs = '--mcp-config=/TEST/foreign';
      },
      (input: CreateTeamLaunchPreparationInput) => {
        input.draft.members[0]!.memberSettings.mcpPolicy = {
          mode: 'strictAllowlist',
        };
      },
      (input: CreateTeamLaunchPreparationInput) => {
        input.draft.members[0]!.name = 'worker-2';
      },
    ]) {
      const input = structuredClone(f.input);
      change(input);
      await assert.rejects(f.coordinator.prepare('start', input));
      await assert.rejects(f.coordinator.submit('TEST-create', input));
    }
    assert.equal(f.spends(), 0);
    assert.equal(f.opens(), 0);
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.deepEqual([...f.store.list()], []);
  } finally {
    await f.close();
  }
});

// Reads/duplicates spending twice, stale proof authorizing a Team, or changed drafts escaping the original record makes this red.
test('preparation reuses original scoped probe, binds the full draft and requires an unexpired green record', async () => {
  const f = fixture();
  try {
    const empty = await f.coordinator.prepare('read', f.input);
    assert.equal(empty.ready, false);
    assert.equal(f.spends(), 0);
    assert.equal((await f.coordinator.prepare('start', f.input)).probes[0]!.phase, 'running');
    await f.coordinator.prepare('start', f.input);
    assert.equal(f.spends(), 1, 'identical members share one native probe');
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.equal(f.opens(), 0);
    const altered = structuredClone(f.input);
    altered.draft.savedSettings.prompt = 'TEST changed prompt';
    await assert.rejects(
      f.coordinator.prepare('start', altered),
      (error: unknown) => error instanceof TeamLaunchError && error.code === 'conflict'
    );
    assert.equal(f.spends(), 1);
    await f.green();
    const green = await f.coordinator.prepare('read', f.input);
    assert.equal(green.ready, true);
    assert.equal(green.probes[0]!.commandId, green.probes[1]!.commandId);
    const saved = f.store.read(green.probes[0]!.commandId)!;
    if (saved.kind !== 'model.probe') throw new Error('Expected probe');
    f.store.write({ ...saved, expiresAt: Date.now() - 1 });
    assert.equal((await f.coordinator.prepare('read', f.input)).ready, false);
    await assert.rejects(f.coordinator.submit('TEST-create', f.input));
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.equal(f.opens(), 0);
  } finally {
    await f.close();
  }
});

// A replaced cwd retaining the old green admission would authorize a different project inode.
test('submit revalidates the original green target identity before any registry mutation', async () => {
  const f = fixture();
  try {
    await f.coordinator.prepare('start', f.input);
    await f.green();
    renameSync(join(f.root, 'project'), join(f.root, 'original-project'));
    mkdirSync(join(f.root, 'project'));
    await assert.rejects(f.coordinator.submit('TEST-create', f.input));
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.equal(f.opens(), 0);
    assert.equal(f.spends(), 1);
  } finally {
    await f.close();
  }
});

// A fresh preparation may renew proof, but a lost original running receipt must never spend again.
test('cancelled original proof is retained and a new preparation renews without allocating a Team', async () => {
  const f = fixture();
  try {
    await f.coordinator.prepare('start', f.input);
    const cancelled = await f.coordinator.prepare('cancel', f.input);
    assert.equal(cancelled.probes[0]!.phase, 'cancelled');
    await f.coordinator.prepare('start', f.input);
    assert.equal(f.spends(), 1);
    const next = { ...f.input, preparationId: 'TEST-fresh-proof' };
    await f.coordinator.prepare('start', next);
    assert.equal(f.spends(), 2);
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.equal(f.opens(), 0);
    const rows = [...f.store.list()];
    assert.equal(rows.length, 2);
    assert.equal(
      rows.some((row) => row.commandId === cancelled.probes[0]!.commandId),
      true
    );
  } finally {
    await f.close();
  }
});

// Renewal changing registry identity, duplicate starts/prompts, or old expired proof blocking original read makes this red.
test('submit uses original registry/roster/capture/start receipts and recovers same-ID admission after proof expiry', async (t) => {
  for (const { provider, worktree } of [
    { provider: 'claude', worktree: false },
    { provider: 'opencode', worktree: false },
    { provider: 'opencode', worktree: true },
  ] as const) {
    const f = fixture(false, provider, worktree);
    const preparationProbeCount = provider === 'opencode' ? 2 : 1;
    try {
      assert.equal(f.coordinator.lookup('TEST-create', f.input), null);
      const first = await f.coordinator.prepare('start', f.input, f.origin());
      await f.green();
      if (provider === 'opencode') {
        const next = await f.coordinator.prepare('start', f.input, f.origin());
        assert.equal(next.probes[0]!.commandId, first.probes[0]!.commandId);
        assert.equal(next.probes[0]!.phase, 'completed');
        assert.equal(next.probes[1]!.phase, 'running');
        assert.notEqual(next.probes[0]!.commandId, next.probes[1]!.commandId,
          'the original worker role retains its distinct full native recipe');
        assert.ok(next.probes[1]!.expiresAt <= first.probes[0]!.expiresAt,
          'the next original group cannot renew the first preparation cutoff');
        await f.green();
      }
      const prepared = await f.coordinator.prepare('read', f.input);
      assert.equal(prepared.ready, true);
      const captured = provider === 'opencode'
        ? await f.coordinator.capture('TEST-create', f.input, 90000) : undefined;
      if (captured) {
        assert.equal(captured.partialCreated, true);
        assert.equal(f.opens(), 0, 'materializing the original capture cannot allocate a Session');
        assert.equal(f.spends(), preparationProbeCount, 'capture retains both original recipes without another model input');
      }
      if (worktree) {
        assert.ok(captured);
        const teamId = captured.creation.record.teamId, team = f.teams.get(teamId)!;
        const expected = { launchId: captured.launch.launchId, rosterRevision: captured.launch.rosterRevision };
        const view = f.runtime.readModelReadinessCapture(teamId, expected)!;
        assert.equal(view.targets.length, 2);
        const records = new TeamOwnerStore(f.root, captured.creation.record.teamName);
        const path = `launches/${digest(captured.launch.launchId)}.json`;
        const before = records.read<TeamLaunchRecord>(path)!;
        assert.equal(before.readiness?.groups.length, preparationProbeCount, 'each original project recipe retains its own preparation');
        const cutoff = before.readiness!.capture!.cutoff;
        const configuration = f.runtime.executeLaunch(teamId, 'configuration.read', 'TEST-actual-read',
          { launchId: expected.launchId }) as {
          members: Array<{ memberId: string; selected: { workspace: string; model: string; effort?: string } | null }>;
        };
        for (const target of view.targets) {
          const selected = configuration.members.find(row => row.memberId === target.memberId)!.selected!;
          assert.notEqual(selected.workspace, target.originalWorkspace);
          assert.equal(target.originalWorkspace, join(f.root, 'project'));
          const commandId = actualCaptureReadinessCommandId(view.preparationId, view.captureCommandId, target.memberId);
          const payload = { ...expected, memberId: target.memberId, model: selected.model,
            ...(selected.effort === undefined ? {} : { effort: selected.effort }) };
          const handleId = 'TEST-create-worktree', scope = team.definition.scope;
          const spent = f.spends();
          await assert.rejects(executeTeamModelProbe({ runtime: f.runtime, management: f.modelReadiness, teamId,
            commandId, payload, action: 'start', readiness: { owner: f.profile.owner, handleId, scope,
              preparation: f.origin({ workspace: target.originalWorkspace, commandId,
                selection: { handleId, scope, payload } })! } }));
          assert.equal(f.spends(), spent, 'original project policy cannot authorize the actual worktree');
          await executeTeamModelProbe({ runtime: f.runtime, management: f.modelReadiness, teamId,
            commandId, payload, action: 'start', readiness: { owner: f.profile.owner, handleId, scope,
              preparation: f.origin({ workspace: selected.workspace, commandId, selection: { handleId, scope, payload } })! } });
          await f.green();
          const child = f.store.read(commandId);
          assert.ok(child?.kind === 'model.probe');
          assert.equal(child.readiness?.evidence.decision, 'allow');
          assert.equal(child.readinessScope?.workspace, selected.workspace);
          assert.ok(child.expiresAt <= cutoff);
          assert.equal(f.opens(), 0, 'actual-cwd proof precedes the original allocation');
        }
        assert.equal(records.read<TeamLaunchRecord>(path)!.readiness!.capture!.cutoff, cutoff);
      }
      const result = await f.coordinator.submit('TEST-create', f.input, captured && {
        launchId: captured.launch.launchId, rosterRevision: captured.launch.rosterRevision,
      });
      assert.equal(result.creation.phase, 'published');
      if (worktree) await f.waitForOriginalAllocation(result.launch.members);
      await tick();
      assert.equal(f.opens(), 2);
      const team = f.teams.get(result.creation.record.teamId)!;
      assert.equal(team.owner.runtimeCaptures(f.profile.principalId).length, 1);
      assert.equal((team.connection.readSnapshot() as { messages: unknown[] }).messages.length, 1);
      const originalProbes = [...f.store.list()].filter(row => row.kind === 'model.probe')
        .filter(row => provider !== 'opencode' || row.readinessScope?.kind === 'create');
      assert.equal(originalProbes.length, preparationProbeCount);
      const probe = originalProbes[0]!;
      if (probe.kind !== 'model.probe') throw new Error('Expected probe');
      if (provider === 'opencode') {
        for (const original of originalProbes) {
          assert.equal(original.readiness?.evidence.decision, 'allow');
          assert.equal(original.readiness?.evidence.ordinary, 'confirmed');
          assert.equal(original.resourceHeld, false);
        }
        const record = new TeamOwnerStore(f.root, result.creation.record.teamName)
          .read<TeamLaunchRecord>(`launches/${digest(result.launch.launchId)}.json`)!;
        assert.deepEqual(record.readiness?.consumers.map(row => row.disposition), ['consumed', 'consumed']);
        if (worktree) {
          assert.equal(record.readiness!.groups.length, 2, 'only the two used actual-cwd references occupy destination slots');
          assert.ok(record.readiness!.groups.every(row => !originalProbes.some(probe => row.commandId === probe.commandId)));
          assert.ok(record.readiness!.consumers.every(row => row.groupCommandId ===
            actualCaptureReadinessCommandId(record.readiness!.capture!.preparationId,
              record.readiness!.capture!.commandId, row.memberId)));
          for (const original of originalProbes) assert.equal(f.store.read(original.commandId)!.fingerprint, original.fingerprint,
            'replacing an unused parent reference preserves the original probe record');
        } else for (const consumer of record.readiness!.consumers) {
          const member = team.definition.members.find(row => row.memberId === consumer.memberId);
          assert.ok(member);
          const original = prepared.probes.find(row => row.memberName === member.name);
          assert.ok(original);
          assert.equal(consumer.groupCommandId, original.commandId);
        }
      }
      for (const original of f.store.list()) {
        if (original.kind === 'model.probe') f.store.write({ ...original, expiresAt: Date.now() - 1 });
      }
      f.profile.owner.revision = 'TEST-next-host-revision';
      await f.restart();
      const renewal = { ...f.input, preparationId: 'TEST-renewal-no-probe' };
      const original = f.coordinator.lookup('TEST-create', renewal)!;
      assert.equal(original.creation.record.teamId, result.creation.record.teamId);
      const duplicate = await f.coordinator.submit('TEST-create', renewal);
      assert.equal(duplicate.launch.launchId, result.launch.launchId);
      await tick();
      assert.equal(f.opens(), 2);
      assert.equal(f.spends(), preparationProbeCount + (worktree ? 2 : 0));
      assert.equal((team.connection.readSnapshot() as { messages: unknown[] }).messages.length, 1);
      const altered = structuredClone(renewal);
      altered.draft.savedSettings.prompt = 'TEST changed';
      assert.throws(() => f.coordinator.lookup('TEST-create', altered));
      await assert.rejects(f.coordinator.submit('TEST-create', altered));
      assert.equal(f.registry.list('TEST-context').teams.length, 1);
      f.invalidate();
      assert.throws(() => f.coordinator.lookup('TEST-create', f.input));
    } catch (error) {
      t.diagnostic(JSON.stringify({ provider, worktree, opens: f.opens(), spends: f.spends(),
        ownerRevision: f.profile.owner.revision,
        originalFailure: error instanceof Error ? error.stack : String(error) }));
      try {
        const runtimeRoot = join(f.root, 'runtime-sessions');
        const runtimeRecords = readdirSync(runtimeRoot).flatMap(member =>
          readdirSync(join(runtimeRoot, member)).filter(file => file.endsWith('.json'))
            .map(file => JSON.parse(readFileSync(join(runtimeRoot, member, file), 'utf8')) as RuntimeSessionRecord));
        const launches = [...f.teams.values()].flatMap(team => {
          const directory = join(f.root, 'teams', team.definition.binding.teamName, '.host-owner', 'launches');
          return existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json'))
            .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')) as TeamLaunchRecord) : [];
        });
        t.diagnostic(JSON.stringify({ probes: [...f.store.list()].filter(row => row.kind === 'model.probe')
          .map(({ commandId, fingerprint, phase, ok, resourceHeld, expiresAt, readinessScope, readinessRetired }) =>
            ({ commandId, fingerprint, phase, ok, resourceHeld, expiresAt, readinessScope, readinessRetired })),
          runtime: runtimeRecords.map(({ binding, profileId, hostIncarnation, phase, custody, sealed, nativeReady,
            closeClaimed, diagnostic, inputs }) => ({ binding, profileId, hostIncarnation, phase, custody,
            sealed, nativeReady, closeClaimed, diagnostic,
            inputs: inputs.map(({ operationRef, phase }) => ({ operationRef, phase })) })),
          launches: launches.map(({ definition, startCommandId, readiness, members }) =>
            ({ launchId: definition.launchId, startCommandId, readiness, members })) }));
      } catch (snapshotError) {
        t.diagnostic(`Original failure snapshot unavailable: ${String(snapshotError)}`);
      }
      throw error;
    } finally {
      await f.close();
    }
  }
});

// A forged captured owner reaching the new host-scoped entrypoints makes this red.
test('Host creation methods reject a foreign captured owner without any native allocation', async () => {
  const f = fixture();
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = createInterface({ input: output });
  const frames = lines[Symbol.asyncIterator]();
  const host = createTeamHost(f.profile, { input, output });
  let id = 0;
  try {
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'host.handshake',
        params: { protocolVersion: 1 },
      }) + '\n'
    );
    await frames.next();
    for (const method of ['prepare', 'probe.read', 'probe.cancel', 'submit', 'lookup']) {
      input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: `team.creation.${method}`,
          params: {
            owner: { ...f.profile.owner, revision: 'foreign' },
            commandId: 'TEST-command',
            payload: f.input,
          },
        }) + '\n'
      );
      const result = JSON.parse((await frames.next()).value!).result;
      assert.equal(result.ok, false);
      assert.equal(result.code, 'forbidden');
    }
    assert.equal(existsSync(join(f.root, 'teams')), false);
  } finally {
    await host.dispose();
    lines.close();
    await f.close();
  }
});

test('Create compiles the same mixed-provider form into private member model checks without Team or native allocation', async () => {
  const f = fixture();
  try {
    const claude = f.profile.runtime!.providerTemplates![0]!;
    const common = {
      teamId: claude.teamId,
      memberId: claude.memberId,
      principalId: claude.principalId,
      sessionId: claude.sessionId,
      generation: 0,
      configRevision: 'TEST-recipe',
      cwd: claude.cwd,
      executable: claude.executable,
      limits: claude.limits,
      model: 'TEST-model',
    };
    f.profile.runtime!.providerTemplates!.push(
      runtimeMemberProfileSchema.parse({
        ...common,
        provider: 'codex',
        protocolRevision: '0.162.0',
        accountBinding: 'TEST-codex-account',
        environment: {
          HOME: join(f.root, 'home'),
          CODEX_HOME: join(f.root, 'config'),
        },
        nativeOptions: {
          approvalPolicy: 'never',
          sandbox: 'read-only',
          modelProvider: 'TEST-local',
          reasoningEffort: 'minimal',
          fastMode: true,
        },
      }),
      runtimeMemberProfileSchema.parse({
        ...common,
        provider: 'opencode',
        mcpPolicyPlugin: testPolicyPlugin(f.root),
        protocolRevision: '1.19.4',
        accountBinding: 'TEST-opencode-account',
        endpoint: 'http://127.0.0.1:19189',
        environment: {
          HOME: join(f.root, 'home'),
          XDG_CONFIG_HOME: join(f.root, 'config'),
          XDG_DATA_HOME: join(f.root, 'config'),
          XDG_CACHE_HOME: join(f.root, 'config'),
        },
        nativeOptions: { providerId: 'TEST-local', agent: 'build', variant: 'high' },
      })
    );
    f.input.draft.savedSettings.fastMode = 'on';
    f.input.draft.savedSettings.skipPermissions = false;
    f.input.draft.members = [
      {
        name: 'codex-worker',
        memberSettings: { providerId: 'codex', model: 'TEST-codex', effort: 'ultra' },
      },
      {
        name: 'opencode-worker',
        memberSettings: {
          providerId: 'opencode',
          model: 'TEST-local/TEST-open',
          effort: 'low',
        },
      },
    ];
    const first = captureCreateTeamDraft(f.profile, f.input);
    assert.deepEqual(
      first.selections.map(({ selection }) => [
        selection.profile.provider,
        selection.profile.accountBinding,
        selection.providerId,
        selection.model,
      ]),
      [
        ['claude', 'TEST-account', 'anthropic', 'TEST-model'],
        ['codex', 'TEST-codex-account', 'codex', 'TEST-codex'],
        ['opencode', 'TEST-opencode-account', 'TEST-local', 'TEST-open'],
      ]
    );
    assert.equal(first.selections[1]!.selection.profile.provider, 'codex');
    const codex = first.selections[1]!.selection.profile;
    if (codex.provider !== 'codex') assert.fail('TEST-codex');
    assert.equal(codex.reasoningEffort, 'ultra');
    assert.equal(codex.fastMode, true);
    const opencode = first.selections[2]!.selection.profile;
    if (opencode.provider !== 'opencode') assert.fail('TEST-opencode');
    assert.equal(opencode.variant, 'low');
    assert.deepEqual(
      first.selections.map((row) => row.selection.effort),
      ['medium', 'ultra', 'low']
    );
    assert.deepEqual(captureCreateTeamDraft(f.profile, f.input), first);
    f.profile.runtime!.providerTemplates![1]!.accountBinding = 'TEST-new-account';
    assert.notEqual(captureCreateTeamDraft(f.profile, f.input).draftDigest, first.draftDigest);
    f.input.draft.members[1]!.memberSettings.model = 'foreign/TEST-open';
    const foreign = captureCreateTeamDraft(f.profile, f.input).selections[2]!.selection;
    assert.deepEqual(
      [foreign.providerId, foreign.model, foreign.profile.accountBinding],
      ['foreign', 'TEST-open', 'TEST-opencode-account']
    );
    assert.equal(f.teams.size, 0);
    assert.equal(f.opens(), 0);
    assert.equal(f.spends(), 0);
  } finally {
    await f.close();
  }
});

test('worktree draft model preflight accepts existing controls without creating Git worktrees or a Team', async () => {
  const f = fixture();
  try {
    const input = structuredClone(f.input);
    input.draft.savedSettings.worktree = 'TEST-named';
    input.draft.members[0]!.memberSettings.isolation = 'worktree';
    const captured = captureCreateTeamDraft(f.profile, input);
    assert.equal(captured.selections.length, 2);
    assert.equal(existsSync(join(f.root, 'teams')), false);
    assert.equal(existsSync(join(f.root, '.host-worktrees')), false);
    assert.equal(f.opens(), 0);
    assert.equal(f.spends(), 0);
  } finally {
    await f.close();
  }
});

function testPolicyPlugin(root: string) {
  const path = join(root, 'TEST-opencode-policy.js'),
    bytes = 'export default async () => ({})\n';
  writeFileSync(path, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
