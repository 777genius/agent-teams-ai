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
});
