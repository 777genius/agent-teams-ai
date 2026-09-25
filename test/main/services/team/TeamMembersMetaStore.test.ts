import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
  beforeAtomicWrite: null as null | ((filePath: string, contents: string) => Promise<void>),
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

vi.mock('../../../../src/main/services/team/atomicWrite', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/main/services/team/atomicWrite')>();
  return {
    atomicWriteAsync: async (filePath: string, contents: string) => {
      await hoisted.beforeAtomicWrite?.(filePath, contents);
      await actual.atomicWriteAsync(filePath, contents);
    },
  };
});

import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';

describe('TeamMembersMetaStore', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-members-meta-store-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    await fs.mkdir(hoisted.teamsBase, { recursive: true });
    hoisted.beforeAtomicWrite = null;
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
    hoisted.beforeAtomicWrite = null;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps an active suffixed member when the base member is removed during writeMembers', async () => {
    const store = new TeamMembersMetaStore();
    const teamName = 'mixed-team';
    await fs.mkdir(path.join(hoisted.teamsBase, teamName), { recursive: true });

    await store.writeMembers(teamName, [
      {
        name: 'alice',
        providerId: 'codex',
        removedAt: Date.now(),
      },
      {
        name: 'alice-2',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
      },
    ]);

    const members = await store.getMembers(teamName);
    expect(members.map((member) => member.name)).toEqual(['alice', 'alice-2']);
  });

  it('keeps an active suffixed member when reading persisted metadata with a removed base member', async () => {
    const store = new TeamMembersMetaStore();
    const teamName = 'mixed-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });

    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify(
        {
          version: 1,
          members: [
            {
              name: 'alice',
              providerId: 'codex',
              removedAt: Date.now(),
            },
            {
              name: 'alice-2',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            },
          ],
        },
        null,
        2
      )
    );

    const members = await store.getMembers(teamName);
    expect(members.map((member) => member.name)).toEqual(['alice', 'alice-2']);
  });

  it('serializes two store instances so a launch rewrite retains a racing real tombstone', async () => {
    const tombstoneStore = new TeamMembersMetaStore();
    const launchStore = new TeamMembersMetaStore();
    const teamName = 'racing-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await tombstoneStore.writeMembers(teamName, [
      { name: 'builder', role: 'Existing builder' },
      { name: 'reviewer', role: 'Existing reviewer' },
    ]);

    const removedAt = Date.parse('2026-07-19T12:00:00.000Z');
    let releaseTombstoneWrite!: () => void;
    const tombstoneWriteReleased = new Promise<void>((resolve) => {
      releaseTombstoneWrite = resolve;
    });
    let tombstoneWriteBlocked!: () => void;
    const tombstoneWriteReached = new Promise<void>((resolve) => {
      tombstoneWriteBlocked = resolve;
    });
    hoisted.beforeAtomicWrite = async (_filePath, contents) => {
      if (!contents.includes(`"removedAt": ${removedAt}`)) return;
      tombstoneWriteBlocked();
      await tombstoneWriteReleased;
    };

    const tombstoneWrite = tombstoneStore.updateMembers(teamName, (members) =>
      members.map((member) =>
        member.name === 'builder' ? { ...member, role: 'Removed builder', removedAt } : member
      )
    );
    await tombstoneWriteReached;

    let launchTransformCalled = false;
    const launchRewrite = launchStore.updateMembers(teamName, (members) => {
      launchTransformCalled = true;
      return [
        { name: 'reviewer', role: 'Relaunched reviewer' },
        ...members.filter((member) => member.removedAt != null),
      ];
    });
    await Promise.resolve();
    expect(launchTransformCalled).toBe(false);

    releaseTombstoneWrite();
    await Promise.all([tombstoneWrite, launchRewrite]);

    expect(await launchStore.getMembers(teamName)).toEqual([
      expect.objectContaining({ name: 'builder', role: 'Removed builder', removedAt }),
      expect.objectContaining({ name: 'reviewer', role: 'Relaunched reviewer' }),
    ]);
  });

  it('uses raw normalized rows for updates so an unrelated update does not delete a duplicate', async () => {
    const store = new TeamMembersMetaStore();
    const teamName = 'raw-projection-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        members: [
          { name: 'alice', role: 'Builder' },
          { name: 'alice-2', role: 'Runtime duplicate' },
        ],
      })
    );

    expect((await store.getMembers(teamName)).map((member) => member.name)).toEqual(['alice']);

    await store.updateMembers(teamName, (members) => [
      ...members,
      { name: 'bob', role: 'Reviewer' },
    ]);

    const persisted = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      members: Array<{ name: string }>;
    };
    expect(persisted.members.map((member) => member.name)).toEqual(['alice', 'alice-2', 'bob']);
    expect((await store.getMembers(teamName)).map((member) => member.name)).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('preserves the existing provider backend during an atomic roster mutation', async () => {
    const store = new TeamMembersMetaStore();
    const teamName = 'provider-backend-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await store.writeMembers(teamName, [{ name: 'alice', role: 'Builder' }], {
      providerBackendId: 'codex-native',
    });

    await store.updateMembers(teamName, async (members) => [
      ...members,
      { name: 'bob', role: 'Reviewer' },
    ]);

    const persisted = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      providerBackendId?: string;
      members: Array<{ name: string }>;
    };
    expect(persisted.providerBackendId).toBe('codex-native');
    expect(persisted.members.map((member) => member.name)).toEqual(['alice', 'bob']);

    await store.updateMembers(teamName, (members) => [...members], {
      providerBackendId: 'opencode-cli',
    });
    const overridden = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      providerBackendId?: string;
    };
    expect(overridden.providerBackendId).toBe('opencode-cli');
  });

  it('holds the canonical lock for writeMembers as well as updateMembers', async () => {
    const updateStore = new TeamMembersMetaStore();
    const writeStore = new TeamMembersMetaStore();
    const teamName = 'write-lock-team';
    await fs.mkdir(path.join(hoisted.teamsBase, teamName), { recursive: true });
    await updateStore.writeMembers(teamName, [{ name: 'alice' }]);

    let releaseUpdateWrite!: () => void;
    const updateWriteReleased = new Promise<void>((resolve) => {
      releaseUpdateWrite = resolve;
    });
    let updateWriteBlocked!: () => void;
    const updateWriteReached = new Promise<void>((resolve) => {
      updateWriteBlocked = resolve;
    });
    hoisted.beforeAtomicWrite = async (_filePath, contents) => {
      if (!contents.includes('Updated Alice')) return;
      updateWriteBlocked();
      await updateWriteReleased;
    };

    const update = updateStore.updateMembers(teamName, (members) =>
      members.map((member) => ({ ...member, role: 'Updated Alice' }))
    );
    await updateWriteReached;
    let replacementSettled = false;
    const replacement = writeStore
      .writeMembers(teamName, [{ name: 'bob' }])
      .finally(() => (replacementSettled = true));
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    releaseUpdateWrite();
    await Promise.all([update, replacement]);
    expect(await updateStore.getMembers(teamName)).toEqual([
      expect.objectContaining({ name: 'bob' }),
    ]);
  });

  it('releases the cross-instance lock when an atomic update write fails', async () => {
    const failingStore = new TeamMembersMetaStore();
    const recoveryStore = new TeamMembersMetaStore();
    const teamName = 'failure-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await failingStore.writeMembers(teamName, [{ name: 'alice', role: 'Original' }]);

    hoisted.beforeAtomicWrite = async (_filePath, contents) => {
      if (contents.includes('Failed update')) {
        throw new Error('disk full');
      }
    };
    await expect(
      failingStore.updateMembers(teamName, (members) =>
        members.map((member) => ({ ...member, role: 'Failed update' }))
      )
    ).rejects.toThrow('disk full');
    expect(await fs.stat(`${metaPath}.lock`).catch(() => null)).toBeNull();

    hoisted.beforeAtomicWrite = null;
    await recoveryStore.updateMembers(teamName, (members) => [
      ...members,
      { name: 'bob', role: 'Recovered' },
    ]);
    expect(await recoveryStore.getMembers(teamName)).toEqual([
      expect.objectContaining({ name: 'alice', role: 'Original' }),
      expect.objectContaining({ name: 'bob', role: 'Recovered' }),
    ]);
  });

  it('preserves unknown fields only for retained members while replacing known fields', async () => {
    const store = new TeamMembersMetaStore();
    const teamName = 'round-trip-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        providerBackendId: 'codex-native',
        futureRoot: { retained: true },
        members: [
          {
            name: 'alice',
            role: 'Old role',
            model: 'remove-me',
            futureMember: { retained: true },
            mcpPolicy: {
              mode: 'strictAllowlist',
              scopes: { user: true, futureScope: 'retained' },
              serverNames: ['old-server'],
              futurePolicy: { retained: true },
            },
          },
          { name: 'removed', role: 'Do not resurrect', futureMember: true },
        ],
      }),
      'utf8'
    );

    await store.updateMembers(teamName, (members) =>
      members
        .filter((member) => member.name !== 'removed')
        .map((member) => ({
          ...member,
          role: 'New role',
          model: undefined,
          mcpPolicy: {
            mode: 'strictAllowlist' as const,
            scopes: { project: true },
            serverNames: ['new-server'],
          },
        }))
    );

    const persisted = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      futureRoot?: unknown;
      members: Array<Record<string, unknown>>;
    };
    expect(persisted.futureRoot).toEqual({ retained: true });
    expect(persisted.members).toHaveLength(1);
    expect(persisted.members[0]).toMatchObject({
      name: 'alice',
      role: 'New role',
      futureMember: { retained: true },
      mcpPolicy: {
        mode: 'strictAllowlist',
        scopes: { project: true, futureScope: 'retained' },
        serverNames: ['new-server'],
        futurePolicy: { retained: true },
      },
    });
    expect(persisted.members[0].model).toBeUndefined();
  });

  it('rejects an unsupported persisted member provider backend without rewriting bytes', async () => {
    const store = new TeamMembersMetaStore();
    const teamName = 'unsupported-provider-backend-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    const raw = JSON.stringify({
      version: 1,
      members: [
        {
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'future-backend',
        },
      ],
    });
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(metaPath, raw, 'utf8');
    let updateCalled = false;
    let writeCalled = false;
    hoisted.beforeAtomicWrite = async () => {
      writeCalled = true;
    };

    await expect(
      store.updateMembers(teamName, (members) => {
        updateCalled = true;
        return [...members, { name: 'bob' }];
      })
    ).rejects.toThrow('Refusing to replace malformed members metadata');
    expect(updateCalled).toBe(false);
    expect(writeCalled).toBe(false);
    await expect(fs.readFile(metaPath, 'utf8')).resolves.toBe(raw);
  });

  it.each([
    ['future version', JSON.stringify({ version: 2, members: [] })],
    ['malformed JSON', '{not-json'],
    [
      'malformed known member field',
      JSON.stringify({ version: 1, members: [{ name: 'alice', role: 42 }] }),
    ],
    [
      'malformed nested MCP scope',
      JSON.stringify({
        version: 1,
        members: [
          {
            name: 'alice',
            mcpPolicy: { mode: 'strictAllowlist', scopes: { user: 'enabled' } },
          },
        ],
      }),
    ],
    ['oversized JSON', JSON.stringify({ version: 1, members: [], pad: 'x'.repeat(256 * 1024) })],
  ])('fails closed on %s without replacing the existing bytes', async (_label, raw) => {
    const store = new TeamMembersMetaStore();
    const teamName = 'closed-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(metaPath, raw, 'utf8');

    await expect(store.writeMembers(teamName, [{ name: 'replacement' }])).rejects.toBeTruthy();
    await expect(fs.readFile(metaPath, 'utf8')).resolves.toBe(raw);
  });
});
