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

import { TeamMemberResolver } from '../../../../src/main/services/team/TeamMemberResolver';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';

describe('TeamMembersMetaStore', () => {
  it('reads a pinned team root and filters known CLI suffix artifacts only when explicitly allowed', async () => {
    const store = new TeamMembersMetaStore();
    const stableBase = path.join(tempDir, 'snapshot-teams');
    const name = 'snapshot-team';
    const directory = path.join(stableBase, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'alice', role: 'Reviewer' },
          { name: 'alice-2', role: 'Reviewer' },
        ],
      })
    );

    expect(await store.getMeta(name, { requireCompleteMembers: true })).toBeNull();
    expect(await store.getMeta(name, { requireCompleteMembers: true }, stableBase)).toBeNull();
    const result = await store.getMeta(
      name,
      { requireCompleteMembers: true, allowCliAutoSuffixArtifacts: true },
      stableBase
    );
    expect(result?.members.map((member) => member.name)).toEqual(['alice']);
  });

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

  it.each(['LIVE_ROLE_COBALT', '', undefined])(
    'keeps the projected role %s after metadata reload while leaving config untouched',
    async (role) => {
      const teamName = 'ptc-test-a';
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      const config = {
        name: teamName,
        members: [{ name: 'Alice', role: 'Test worker', agentId: 'alice@ptc-test-a' }],
      };
      const configBytes = JSON.stringify(config);
      await fs.writeFile(path.join(teamDir, 'config.json'), configBytes);
      await new TeamMembersMetaStore().writeMembers(teamName, [{ name: 'Alice', role }]);

      const metadata = await new TeamMembersMetaStore().getMembers(teamName);
      const member = new TeamMemberResolver().resolveMembers(config, metadata, [], [])[0];

      expect(member.role).toBe(role || undefined);
      expect(member.agentId).toBe('alice@ptc-test-a');
      expect(await fs.readFile(path.join(teamDir, 'config.json'), 'utf8')).toBe(configBytes);
    }
  );

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
});
