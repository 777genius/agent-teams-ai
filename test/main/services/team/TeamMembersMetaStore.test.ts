import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';

describe('TeamMembersMetaStore', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-members-meta-store-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    await fs.mkdir(hoisted.teamsBase, { recursive: true });
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
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

  it.each(['api', 'adapter', 'auto', 'codex-native'] as const)(
    'preserves current-schema Codex backend %s across write and store restart',
    async (providerBackendId) => {
      const teamName = `current-${providerBackendId}`;
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      const raw = new TeamMembersMetaStore().serializeMembers([
        { name: 'builder', providerId: 'codex', providerBackendId },
      ]);

      expect(JSON.parse(raw)).toMatchObject({
        version: 2,
        members: [{ name: 'builder', providerId: 'codex', providerBackendId }],
      });
      await fs.writeFile(path.join(teamDir, 'members.meta.json'), raw);

      await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toMatchObject([
        { name: 'builder', providerId: 'codex', providerBackendId },
      ]);
    }
  );

  it('preserves a current Codex provider-only member without synthesizing a backend', async () => {
    const teamName = 'current-provider-only';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({ version: 2, members: [{ name: 'builder', providerId: 'codex' }] })
    );

    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({
        name: 'builder',
        providerId: 'codex',
        providerBackendId: undefined,
      }),
    ]);
  });

  it('round-trips runtime selection provenance through strict current storage', async () => {
    const teamName = 'current-runtime-provenance';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    const provenance = {
      version: 1 as const,
      providerBackendId: 'inherited' as const,
      model: 'inherited' as const,
      effort: 'explicit' as const,
    };
    const raw = new TeamMembersMetaStore().serializeMembers([
      {
        name: 'builder',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'low',
        runtimeSelectionProvenance: provenance,
      },
    ]);
    await fs.writeFile(path.join(teamDir, 'members.meta.json'), raw);

    expect(JSON.parse(raw).members[0]).toMatchObject({ runtimeSelectionProvenance: provenance });
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ runtimeSelectionProvenance: provenance }),
    ]);
  });

  it.each(['api', 'adapter', 'auto', 'codex-native'] as const)(
    'migrates stored legacy Codex backend %s when hydrating members',
    async (providerBackendId) => {
      const teamName = `legacy-${providerBackendId}`;
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'members.meta.json'),
        JSON.stringify({
          version: 1,
          members: [{ name: 'builder', providerId: 'codex', providerBackendId }],
        })
      );

      await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toMatchObject([
        { name: 'builder', providerId: 'codex', providerBackendId: 'codex-native' },
      ]);
    }
  );

  it('treats a missing version as legacy and rejects an unknown version', async () => {
    const store = new TeamMembersMetaStore();
    for (const [teamName, record] of [
      [
        'missing-version',
        { members: [{ name: 'builder', providerId: 'codex', providerBackendId: 'api' }] },
      ],
      [
        'unknown-version',
        {
          version: 999,
          members: [{ name: 'builder', providerId: 'codex', providerBackendId: 'api' }],
        },
      ],
    ] as const) {
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(path.join(teamDir, 'members.meta.json'), JSON.stringify(record));
    }

    await expect(store.getMembers('missing-version')).resolves.toMatchObject([
      { providerBackendId: 'codex-native' },
    ]);
    await expect(store.getMeta('unknown-version')).rejects.toThrow(
      'Unsupported members.meta.json version: 999'
    );
  });

  it.each(['api', 'adapter', 'auto', 'codex-native'] as const)(
    'preserves current root backend %s when a write omits the optional root argument',
    async (providerBackendId) => {
      const teamName = `root-${providerBackendId}`;
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'members.meta.json'),
        JSON.stringify({ version: 2, providerBackendId, members: [{ name: 'alice' }] })
      );

      await new TeamMembersMetaStore().writeMembers(teamName, [{ name: 'alice', role: 'updated' }]);
      await expect(new TeamMembersMetaStore().getMeta(teamName)).resolves.toMatchObject({
        version: 2,
        providerBackendId,
      });
    }
  );

  it('normalizes a legacy root before promoting the file to v2', async () => {
    const teamName = 'legacy-root';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({ version: 1, providerBackendId: 'api', members: [{ name: 'alice' }] })
    );

    await new TeamMembersMetaStore().writeMembers(teamName, [{ name: 'alice', role: 'updated' }]);
    const raw = JSON.parse(await fs.readFile(path.join(teamDir, 'members.meta.json'), 'utf8'));
    expect(raw).toMatchObject({ version: 2, providerBackendId: 'codex-native' });
  });

  it('leaves future-version bytes exact and throws on mutation', async () => {
    const teamName = 'future-root';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    const exact = '{"version":999,"opaque":{"future":true},"members":[{"name":"alice"}]}\n';
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(metaPath, exact);

    await expect(
      new TeamMembersMetaStore().writeMembers(teamName, [{ name: 'bob' }])
    ).rejects.toThrow('Unsupported members.meta.json version: 999');
    expect(await fs.readFile(metaPath, 'utf8')).toBe(exact);
  });

  it('leaves malformed current bytes exact and rejects every ordinary write', async () => {
    const teamName = 'malformed-current';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'members.meta.json');
    const exact = '{"version":2,"members":[{"name":"alice","removedAt":"bad"}]}\n';
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(metaPath, exact);

    await expect(
      new TeamMembersMetaStore().writeMembers(teamName, [{ name: 'bob' }])
    ).rejects.toThrow('current roster is malformed');
    expect(await fs.readFile(metaPath, 'utf8')).toBe(exact);
  });
});
