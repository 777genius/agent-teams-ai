import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { FileTeamRegistryStore } from '../dist/adapters/team-registry/FileTeamRegistryStore.js';
import { admitRegistryTeamNamespace } from '../dist/adapters/team-registry/admitRegistryTeamNamespace.js';
import { captureCreateTeamDraft } from '../dist/composition/captureCreateTeamDraft.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { CreateTeamLaunchCoordinator } from '../dist/composition/CreateTeamLaunchCoordinator.js';
import { ClaudeManagementCoordinator } from '../dist/composition/ClaudeManagementCoordinator.js';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type { CreateTeamLaunchPreparationInput } from '../dist/team-registry/createLaunchContracts.js';
import type { Session } from '@agent-teams/provider-session-contracts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
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
  let current = true,
    opens = 0,
    spends = 0;
  const assertCurrent = () => {
    if (!current) throw new TeamLaunchError('hold', 'TEST-writer');
  };
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
      teams,
      assertWriter: assertCurrent,
      createProvider: (context) => {
        opens++;
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
          checkReadiness: async () => ({ ok: true, value: undefined }),
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
  let runtime = createRuntime();
  const claude = new ClaudeManagementCoordinator([], assertCurrent);
  const store = new FileManagementCommandStore(root);
  const pending: Array<(ok: boolean) => void> = [];
  const probes = new ModelProbeOwner({
    store,
    fence: new ManagementResourceFence(store.list()),
    assertWriter: assertCurrent,
    select: (id, revision) => claude.target(id, revision),
    prepare: () => ({
      timeoutMs: 90000,
      run: () => {
        spends++;
        return new Promise((resolve) => pending.push(resolve));
      },
      close: async () => true,
    }),
  });
  const createCoordinator = () =>
    new CreateTeamLaunchCoordinator({
      profile,
      registry,
      runtime,
      assertCurrent,
      team: (id) => teams.get(id),
      management: {
        probes,
        admitTeamProbeProfile: (value) => {
          if (value.provider !== 'claude') assert.fail('TEST-Claude-only-fixture');
          claude.admitProbeProfile(value);
        },
      },
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
  return {
    root,
    profile,
    input,
    get coordinator() {
      return coordinator;
    },
    registry,
    teams,
    store,
    probes,
    opens: () => opens,
    spends: () => spends,
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
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

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
test('submit uses original registry/roster/capture/start receipts and recovers same-ID admission after proof expiry', async () => {
  const f = fixture();
  try {
    assert.equal(f.coordinator.lookup('TEST-create', f.input), null);
    await f.coordinator.prepare('start', f.input);
    await f.green();
    const result = await f.coordinator.submit('TEST-create', f.input);
    assert.equal(result.creation.phase, 'published');
    await tick();
    assert.equal(f.opens(), 2);
    const team = f.teams.get(result.creation.record.teamId)!;
    assert.equal(team.owner.runtimeCaptures(f.profile.principalId).length, 1);
    assert.equal((team.connection.readSnapshot() as { messages: unknown[] }).messages.length, 1);
    const probe = [...f.store.list()][0]!;
    if (probe.kind !== 'model.probe') throw new Error('Expected probe');
    f.store.write({ ...probe, expiresAt: Date.now() - 1 });
    f.profile.owner.revision = 'TEST-next-host-revision';
    await f.restart();
    const renewal = { ...f.input, preparationId: 'TEST-renewal-no-probe' };
    const original = f.coordinator.lookup('TEST-create', renewal)!;
    assert.equal(original.creation.record.teamId, result.creation.record.teamId);
    const duplicate = await f.coordinator.submit('TEST-create', renewal);
    assert.equal(duplicate.launch.launchId, result.launch.launchId);
    await tick();
    assert.equal(f.opens(), 2);
    assert.equal(f.spends(), 1);
    assert.equal((team.connection.readSnapshot() as { messages: unknown[] }).messages.length, 1);
    const altered = structuredClone(renewal);
    altered.draft.savedSettings.prompt = 'TEST changed';
    assert.throws(() => f.coordinator.lookup('TEST-create', altered));
    await assert.rejects(f.coordinator.submit('TEST-create', altered));
    assert.equal(f.registry.list('TEST-context').teams.length, 1);
    f.invalidate();
    assert.throws(() => f.coordinator.lookup('TEST-create', f.input));
  } finally {
    await f.close();
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
    assert.equal(
      captureCreateTeamDraft(f.profile, f.input).selections[2]!.selection.model,
      'foreign/TEST-open'
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
