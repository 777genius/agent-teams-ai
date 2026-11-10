import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';
import { FileTeamRegistryStore } from '../dist/adapters/team-registry/FileTeamRegistryStore.js';
import { admitRegistryTeamNamespace } from '../dist/adapters/team-registry/admitRegistryTeamNamespace.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';
import type { StoredTeamCreation } from '../dist/team-registry/state.js';
import type { TeamRegistryReceipt } from '../dist/team-registry/contracts.js';

function sandbox() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-registry-')));
}
function intent(cwd: string, teamName = 'new-team') {
  return {
    contextId: 'TEST-context',
    teamName,
    savedSettings: {
      cwd,
      displayName: 'Saved team',
      description: 'Configured only',
      color: 'blue',
      prompt: 'TEST-private-prompt',
    },
    members: [
      {
        name: 'alice',
        memberSettings: { role: 'Researcher', model: 'TEST-model', fastMode: 'off' as const },
      },
    ],
  };
}
function bootstrapOptions(
  root: string,
  definition: HostedTeamDefinition
): FilesystemTeamOwnerOptions {
  return {
    root,
    binding: definition.binding,
    ...(definition.savedSettings === undefined ? {} : { savedSettings: definition.savedSettings }),
    members: definition.members.map(({ memberId, name, role, delivery, settings }) => ({
      memberId,
      name,
      role,
      ...(delivery ? { delivery } : {}),
      ...(settings === undefined ? {} : { settings }),
    })),
    grants: definition.grants.map(({ principalId, memberName, permissions, revoked }) => ({
      principalId,
      memberName,
      permissions,
      ...(revoked === undefined ? {} : { revoked }),
    })),
  };
}
function fixture(
  root: string,
  options: {
    store?: FileTeamRegistryStore;
    staticTeams?: HostedTeamDefinition[];
    attach?: (definition: HostedTeamDefinition) => void;
  } = {}
) {
  const lease = acquireProfileWriterLease(root);
  const attached = new Map<string, ReturnType<typeof createFilesystemTeamOwner>>();
  const store = options.store ?? new FileTeamRegistryStore(root, () => lease.assertCurrent());
  const registry = new TeamRegistry({
    ownerId: 'TEST-owner',
    profileId: 'TEST-profile',
    principalId: 'TEST-principal',
    contextIds: ['TEST-context'],
    staticTeams: options.staticTeams ?? [],
    store,
    assertWriter: () => lease.assertCurrent(),
    admit: (definition, fresh, bootstrapPublished) =>
      admitRegistryTeamNamespace(root, definition.binding, fresh, bootstrapPublished),
    attach:
      options.attach ??
      ((definition) => {
        const owner = createFilesystemTeamOwner(bootstrapOptions(root, definition));
        owner.connect('TEST-principal').readRoster();
        attached.set(definition.binding.teamId, owner);
      }),
  });
  return { registry, store, attached, close: () => lease.release() };
}

// A second Team, lost saved configuration, or different cold IDs would fail these product assertions.
test('registry saves canonical product configuration and replays the same command after cold startup', () => {
  const root = sandbox();
  let current = fixture(root);
  try {
    const original = current.registry.create('TEST-create', intent(root));
    assert.equal(original.phase, 'published');
    const config = JSON.parse(readFileSync(join(root, 'teams', 'new-team', 'config.json'), 'utf8'));
    assert.deepEqual(config.savedSettings, intent(root).savedSettings);
    assert.deepEqual(
      config.members.map((member: { name: string; role: string }) => ({
        name: member.name,
        role: member.role,
      })),
      [
        { name: 'team-lead', role: undefined },
        { name: 'alice', role: 'member' },
      ]
    );
    const roster = current.attached
      .get(original.record.teamId)!
      .connect('TEST-principal')
      .readRoster();
    assert.equal(roster.members[1]!.settings.role, 'Researcher');
    assert.equal(roster.members[1]!.settings.fastMode, 'off');
    assert.deepEqual(current.registry.list('TEST-context'), { teams: [original.record], held: [] });
    assert.equal(JSON.stringify(original).includes(root), false);
    assert.equal(JSON.stringify(original).includes('TEST-private-prompt'), false);
    assert.deepEqual(current.registry.create('TEST-create', intent(root)), original);
    assert.throws(
      () => current.registry.create('TEST-create', { ...intent(root), teamName: 'changed' }),
      code('conflict')
    );
    assert.throws(
      () => current.registry.create('TEST-new-command', intent(root)),
      code('conflict')
    );
    current.close();
    current = fixture(root);
    current.registry.restore();
    assert.deepEqual(
      current.registry.lookup('TEST-create', 'TEST-context', intent(root)),
      original
    );
    assert.deepEqual(current.registry.create('TEST-create', intent(root)), original);
    assert.equal(current.attached.size, 1);
    assert.deepEqual(readdirSync(join(root, 'teams')), ['new-team']);
    assert.equal(current.store.readAll().length, 1);
    assert.throws(
      () =>
        current.registry.lookup('TEST-create', 'TEST-context', { ...intent(root), members: [] }),
      code('conflict')
    );
  } finally {
    current.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function code(expected: string) {
  return (error: unknown) => error instanceof TeamOwnerError && error.code === expected;
}

// A deleted published namespace must stay held; bootstrap defaults cannot replace user product data.
test('published namespace loss stays held through hot and cold replay without replacement', () => {
  const root = sandbox();
  let current = fixture(root);
  try {
    const original = current.registry.create('TEST-original', intent(root));
    const saved = current.store.readAll()[0]!;
    assert.equal(saved.bootstrapPublished, true);
    rmSync(join(root, 'teams', 'new-team'), { recursive: true });
    const held = current.registry.create('TEST-original', intent(root));
    assert.equal(held.phase, 'held');
    assert.deepEqual(held.record, original.record);
    assert.deepEqual(readdirSync(join(root, 'teams')), []);
    current.close();
    current = fixture(root);
    current.registry.restore();
    assert.deepEqual(current.registry.lookup('TEST-original', 'TEST-context'), held);
    assert.deepEqual(current.registry.create('TEST-original', intent(root)), held);
    assert.deepEqual(readdirSync(join(root, 'teams')), []);
    assert.deepEqual(current.store.readAll()[0]!.definition, saved.definition);
    assert.equal(current.store.readAll()[0]!.bootstrapPublished, true);
    assert.throws(
      () => current.registry.create('TEST-replacement', intent(root)),
      code('conflict')
    );
    assert.equal(
      current.registry.create('TEST-other', intent(root, 'healthy-team')).phase,
      'published'
    );
    assert.equal(current.registry.list('TEST-context').held.length, 1);
    assert.equal(current.registry.list('TEST-context').teams.length, 1);
  } finally {
    current.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Faults occur after durable publications, so a retry must retain the original IDs and bootstrap debt.
test('interrupted intent and ready:false bootstrap recover only the original generated definition', () => {
  const root = sandbox();
  class InterruptedIntentStore extends FileTeamRegistryStore {
    override write(record: StoredTeamCreation) {
      super.write(record);
      if (record.phase === 'pending') throw new TeamOwnerError('hold');
    }
  }
  let current = fixture(root, { store: new InterruptedIntentStore(root, () => {}) });
  try {
    assert.throws(
      () => current.registry.create('TEST-interrupted-intent', intent(root)),
      code('hold')
    );
    const pending = current.store.readAll()[0]!;
    assert.equal(pending.phase, 'pending');
    assert.throws(() => readdirSync(join(root, 'teams')), { code: 'ENOENT' });
    current.close();
    current = fixture(root, {
      attach: (definition) => {
        class InterruptedBootstrapStore extends TeamOwnerStore {
          override write(name: string, value: unknown) {
            super.write(name, value);
            if (name === 'state.json' && (value as { ready: boolean }).ready === false)
              throw new TeamOwnerError('hold');
          }
        }
        createFilesystemTeamOwner({
          ...bootstrapOptions(root, definition),
          store: new InterruptedBootstrapStore(root, definition.binding.teamName),
        });
      },
    });
    current.registry.restore();
    const held = current.registry.lookup('TEST-interrupted-intent', 'TEST-context')!;
    assert.equal(held.phase, 'held');
    assert.deepEqual(held.record, pending.record);
    assert.equal(current.registry.list('TEST-context').teams.length, 0);
    assert.equal(current.registry.list('TEST-context').held[0]!.phase, 'held');
    const state = JSON.parse(
      readFileSync(join(root, 'teams', 'new-team', '.host-owner', 'state.json'), 'utf8')
    );
    assert.equal(state.ready, false);
    current.close();
    current = fixture(root);
    current.registry.restore();
    const published = current.registry.lookup('TEST-interrupted-intent', 'TEST-context')!;
    assert.equal(published.phase, 'published');
    assert.deepEqual(published.record, pending.record);
    assert.deepEqual(current.store.readAll()[0]!.definition, pending.definition);
    assert.deepEqual(current.registry.create('TEST-interrupted-intent', intent(root)), published);
  } finally {
    current.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Refusal must preserve all foreign bytes and must not publish an intent that could later adopt them.
test('static names, duplicate/reserved members and foreign or symlink namespaces refuse before Team writes', () => {
  const root = sandbox();
  const external = sandbox();
  const staticDefinition: HostedTeamDefinition = {
    binding: { backendId: 'TEST-owner', teamId: 'static-id', teamName: 'static-team' },
    scope: {
      projectId: 'p',
      workspaceId: 'w',
      teamId: 'static-id',
      runId: 'r',
      memberId: 'user',
      generation: '1',
    },
    members: [],
    grants: [],
  };
  const current = fixture(root, { staticTeams: [staticDefinition] });
  try {
    assert.throws(
      () => current.registry.create('TEST-static', intent(root, 'STATIC-TEAM')),
      code('conflict')
    );
    assert.throws(() =>
      current.registry.create('TEST-reserved', {
        ...intent(root),
        members: [{ name: 'TEAM-LEAD', memberSettings: {} }],
      })
    );
    assert.throws(() =>
      current.registry.create('TEST-duplicate', {
        ...intent(root),
        members: [
          { name: 'alice', memberSettings: {} },
          { name: 'ALICE', memberSettings: {} },
        ],
      })
    );
    assert.throws(() =>
      current.registry.create('TEST-relative', {
        ...intent(root),
        savedSettings: { cwd: 'relative' },
      })
    );
    mkdirSync(join(root, 'teams', 'foreign'), { recursive: true });
    writeFileSync(join(root, 'teams', 'foreign', 'config.json'), 'TEST-foreign-bytes');
    assert.throws(
      () => current.registry.create('TEST-foreign', intent(root, 'foreign')),
      code('conflict')
    );
    assert.equal(
      readFileSync(join(root, 'teams', 'foreign', 'config.json'), 'utf8'),
      'TEST-foreign-bytes'
    );
    symlinkSync(
      external,
      join(root, 'teams', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.throws(() => current.registry.create('TEST-link', intent(root, 'linked')), code('hold'));
    assert.deepEqual(readdirSync(external), []);
    assert.deepEqual(current.store.readAll(), []);
  } finally {
    current.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

function profile(root: string, enabled = true): TeamHostProfile {
  return {
    schemaVersion: 1,
    principalId: 'TEST-principal',
    teams: [],
    owner: {
      ownerId: 'TEST-owner',
      profileId: 'TEST-profile',
      revision: 'r',
      storageRoot: root,
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: '0'.repeat(64),
      hostEntrySha256: '1'.repeat(64),
    },
    ...(enabled ? { creation: { contextIds: ['TEST-context'] } } : {}),
  };
}
function host(rawProfile: TeamHostProfile) {
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = createInterface({ input: output });
  const frames = lines[Symbol.asyncIterator]();
  const server = createTeamHost(rawProfile, { input, output });
  let sequence = 0;
  return {
    async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = ++sequence;
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const next = await frames.next();
      assert.equal(next.done, false);
      const frame = JSON.parse(next.value!) as { id: number; result: Record<string, unknown> };
      assert.equal(frame.id, id);
      return frame.result;
    },
    async close() {
      await server.dispose();
      lines.close();
    },
  };
}

// The real private NDJSON surface must check captured owner/context before journal or namespace effects.
test(
  'Host registry authorizes exact owner/context and shares newly created Team without restart',
  { timeout: 10000 },
  async () => {
    const root = sandbox();
    let current = host(profile(root));
    try {
      await current.rpc('host.handshake', { protocolVersion: 1 });
      const owner = profile(root).owner;
      const before = readdirSync(root);
      assert.deepEqual(
        await current.rpc('team.registry.create', {
          owner: { ...owner, revision: 'foreign' },
          commandId: 'TEST-forged',
          payload: intent(root),
        }),
        { ok: false, code: 'forbidden', outcome: 'rejected' }
      );
      assert.deepEqual(
        await current.rpc('team.registry.create', {
          owner,
          commandId: 'TEST-context',
          payload: { ...intent(root), contextId: 'foreign-context' },
        }),
        { ok: false, code: 'forbidden', outcome: 'rejected' }
      );
      assert.deepEqual(readdirSync(root), before);
      const created = await current.rpc('team.registry.create', {
        owner,
        commandId: 'TEST-create',
        payload: intent(root),
      });
      assert.equal(created.ok, true);
      const receipt = created.value as TeamRegistryReceipt;
      assert.equal(receipt.phase, 'published');
      const snapshot = await current.rpc('team.snapshot', {
        commandId: 'TEST-product-read',
        binding: { ...receipt.record.binding, owner },
        payload: {},
      });
      assert.equal(snapshot.ok, true);
      assert.deepEqual((snapshot.value as { members: unknown[] }).members, [
        { name: 'team-lead', role: 'lead' },
        { name: 'alice', role: 'member' },
      ]);
      const teamBinding = { ...receipt.record.binding, owner };
      const roster = await current.rpc('team.roster.read', {
        commandId: 'TEST-roster',
        binding: teamBinding,
        payload: {},
      });
      const edited = await current.rpc('team.roster.replace', {
        commandId: 'TEST-edit',
        binding: teamBinding,
        payload: {
          expectedRevision: (roster.value as { revision: string }).revision,
          members: [{ name: 'bob', role: 'New researcher' }],
          savedSettings: { cwd: root, displayName: 'Edited team' },
        },
      });
      assert.equal(edited.ok, true);
      const afterEdit = await current.rpc('team.roster.read', {
        commandId: 'TEST-after-edit',
        binding: teamBinding,
        payload: {},
      });
      assert.deepEqual(
        await current.rpc('team.registry.create', {
          owner,
          commandId: 'TEST-create',
          payload: intent(root),
        }),
        created
      );
      assert.deepEqual(
        await current.rpc('team.roster.read', {
          commandId: 'TEST-after-replay',
          binding: teamBinding,
          payload: {},
        }),
        afterEdit,
        'hot creation replay retains the existing owner and every subsequent product edit'
      );
      await current.close();
      current = host(profile(root));
      await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.deepEqual(
        await current.rpc('team.registry.lookup', {
          owner,
          commandId: 'TEST-create',
          payload: { contextId: 'TEST-context', expected: intent(root) },
        }),
        created
      );
      assert.deepEqual(
        await current.rpc('team.registry.list', {
          owner,
          commandId: 'TEST-list',
          payload: { contextId: 'TEST-context' },
        }),
        { ok: true, value: { teams: [receipt.record], held: [] } }
      );
      assert.deepEqual(
        await current.rpc('team.roster.read', {
          commandId: 'TEST-cold-roster',
          binding: teamBinding,
          payload: {},
        }),
        afterEdit
      );
    } finally {
      await current.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'default profile leaves registry disabled and creates no registry state',
  { timeout: 10000 },
  async () => {
    const root = sandbox();
    const rawProfile = profile(root, false);
    const current = host(rawProfile);
    try {
      const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.equal((handshake.capabilities as string[]).includes('team.registry'), false);
      const before = readdirSync(root);
      assert.deepEqual(
        await current.rpc('team.registry.create', {
          owner: rawProfile.owner,
          commandId: 'TEST-disabled',
          payload: intent(root),
        }),
        { ok: false, code: 'forbidden', outcome: 'rejected' }
      );
      assert.deepEqual(readdirSync(root), before);
    } finally {
      await current.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
