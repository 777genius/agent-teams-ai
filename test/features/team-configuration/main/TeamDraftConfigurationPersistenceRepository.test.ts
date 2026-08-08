import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTeamDraftConfigurationPersistenceRepository } from '../../../../src/features/team-configuration/main';

import type { TeamMetaFile } from '../../../../src/main/services/team/TeamMetaStore';
import type { TeamCreateConfigRequest, TeamMember } from '../../../../src/shared/types';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function createHarness(options: { failMembersWrite?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'team-draft-config-repository-'));
  temporaryRoots.push(root);
  const roots = {
    teamsRoot: join(root, 'teams'),
    tasksRoot: join(root, 'tasks'),
  };
  const teamMetadata = new Map<string, Omit<TeamMetaFile, 'version'>>();
  const membersMetadata = new Map<string, { providerBackendId?: string; members: TeamMember[] }>();
  const teamMetaStore = {
    getMeta: vi.fn(async (teamName: string) => teamMetadata.get(teamName) ?? null),
    writeMeta: vi.fn(async (teamName: string, data: Omit<TeamMetaFile, 'version'>) => {
      teamMetadata.set(teamName, data);
    }),
  };
  const teamMembersMetaStore = {
    getMeta: vi.fn(async (teamName: string) => membersMetadata.get(teamName) ?? null),
    writeMembers: vi.fn(
      async (
        teamName: string,
        members: TeamMember[],
        writeOptions?: { providerBackendId?: string }
      ) => {
        if (options.failMembersWrite) {
          throw new Error('members write failed');
        }
        membersMetadata.set(teamName, {
          providerBackendId: writeOptions?.providerBackendId,
          members,
        });
      }
    ),
  };
  const invalidateListTeamsCache = vi.fn();
  const now = vi.fn(() => 1_700_000_000_000);
  const repository = createTeamDraftConfigurationPersistenceRepository({
    teamMetaStore,
    teamMembersMetaStore,
    fileSystem: {
      join,
      lstat,
      mkdir,
      rm,
    },
    invalidateListTeamsCache,
    now,
  });

  return {
    invalidateListTeamsCache,
    membersMetadata,
    now,
    repository,
    roots,
    teamMembersMetaStore,
    teamMetadata,
    teamMetaStore,
  };
}

describe('TeamDraftConfigurationPersistenceRepository', () => {
  it('allows exactly one concurrent create to claim a team name', async () => {
    const harness = await createHarness();
    const results = await Promise.allSettled([
      harness.repository.createTeamConfig(
        { teamName: 'draft-team', members: [{ name: 'alpha' }] },
        harness.roots
      ),
      harness.repository.createTeamConfig(
        { teamName: 'draft-team', members: [{ name: 'beta' }] },
        harness.roots
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(harness.teamMetaStore.writeMeta).toHaveBeenCalledTimes(1);
    expect(harness.teamMembersMetaStore.writeMembers).toHaveBeenCalledTimes(1);
    expect(harness.invalidateListTeamsCache).toHaveBeenCalledTimes(1);
    expect(harness.membersMetadata.get('draft-team')?.members.map((member) => member.name)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(?:alpha|beta)$/)])
    );
  });

  it('guards both roots without overwriting existing or orphan artifacts', async () => {
    const harness = await createHarness();
    const existingTeamDir = join(harness.roots.teamsRoot, 'team-artifact');
    const existingTasksDir = join(harness.roots.tasksRoot, 'tasks-artifact');
    await mkdir(existingTeamDir, { recursive: true });
    await mkdir(existingTasksDir, { recursive: true });
    await writeFile(join(existingTeamDir, 'team.meta.json'), 'existing-team');
    await writeFile(join(existingTasksDir, '1.json'), 'existing-task');

    await expect(
      harness.repository.createTeamConfig({ teamName: 'team-artifact', members: [] }, harness.roots)
    ).rejects.toThrow('Team already exists: team-artifact');
    await expect(
      harness.repository.createTeamConfig(
        { teamName: 'tasks-artifact', members: [] },
        harness.roots
      )
    ).rejects.toThrow('Team already exists: tasks-artifact');

    await expect(readFile(join(existingTeamDir, 'team.meta.json'), 'utf8')).resolves.toBe(
      'existing-team'
    );
    await expect(readFile(join(existingTasksDir, '1.json'), 'utf8')).resolves.toBe('existing-task');
    await expect(access(join(harness.roots.tasksRoot, 'team-artifact'))).rejects.toThrow();
    await expect(access(join(harness.roots.teamsRoot, 'tasks-artifact'))).rejects.toThrow();
    expect(harness.teamMetaStore.writeMeta).not.toHaveBeenCalled();
  });

  it('normalizes member metadata and invalidates the list cache after persistence', async () => {
    const harness = await createHarness();
    const request: TeamCreateConfigRequest = {
      teamName: 'draft-team',
      cwd: '  /workspace/project  ',
      providerBackendId: 'codex-native',
      members: [
        {
          name: '  builder  ',
          role: '  Engineer  ',
          workflow: '  Ship focused changes  ',
          isolation: 'worktree',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: '  gpt-5.2  ',
          effort: 'high',
          fastMode: 'on',
          mcpPolicy: {
            mode: 'strictAllowlist',
            serverNames: [' repo ', 'REPO', '', 'docs'],
          },
        },
        { name: 'reviewer' },
      ],
    };

    await harness.repository.createTeamConfig(request, harness.roots);

    expect(harness.teamMetaStore.writeMeta).toHaveBeenCalledWith(
      'draft-team',
      expect.objectContaining({
        cwd: '/workspace/project',
        createdAt: 1_700_000_000_000,
      })
    );
    const members = harness.membersMetadata.get('draft-team')?.members ?? [];
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({
      name: 'builder',
      role: 'Engineer',
      workflow: 'Ship focused changes',
      isolation: 'worktree',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      effort: 'high',
      fastMode: 'on',
      mcpPolicy: {
        mode: 'strictAllowlist',
        serverNames: ['repo', 'docs'],
      },
      agentType: 'general-purpose',
      joinedAt: 1_700_000_000_000,
      color: expect.any(String),
    });
    expect(members[1]).toMatchObject({ name: 'reviewer', color: expect.any(String) });
    expect(members[0]?.color).not.toBe(members[1]?.color);
    expect(harness.invalidateListTeamsCache).toHaveBeenCalledTimes(1);
    expect(harness.teamMembersMetaStore.writeMembers.mock.invocationCallOrder[0]).toBeLessThan(
      harness.invalidateListTeamsCache.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('rolls back only directories created by the failed attempt', async () => {
    const harness = await createHarness({ failMembersWrite: true });
    const teamsSentinel = join(harness.roots.teamsRoot, 'unrelated-team');
    const tasksSentinel = join(harness.roots.tasksRoot, 'unrelated-team');
    await mkdir(teamsSentinel, { recursive: true });
    await mkdir(tasksSentinel, { recursive: true });
    await writeFile(join(teamsSentinel, 'keep.txt'), 'team');
    await writeFile(join(tasksSentinel, 'keep.txt'), 'tasks');

    await expect(
      harness.repository.createTeamConfig(
        { teamName: 'failed-team', members: [{ name: 'builder' }] },
        harness.roots
      )
    ).rejects.toThrow('members write failed');

    await expect(access(join(harness.roots.teamsRoot, 'failed-team'))).rejects.toThrow();
    await expect(access(join(harness.roots.tasksRoot, 'failed-team'))).rejects.toThrow();
    await expect(readFile(join(teamsSentinel, 'keep.txt'), 'utf8')).resolves.toBe('team');
    await expect(readFile(join(tasksSentinel, 'keep.txt'), 'utf8')).resolves.toBe('tasks');
    expect(harness.invalidateListTeamsCache).not.toHaveBeenCalled();
  });

  it('migrates the team backend and excludes removed members from saved requests', async () => {
    const harness = await createHarness();
    harness.teamMetadata.set('draft-team', {
      cwd: '/workspace/project',
      providerId: 'codex',
      createdAt: 1,
    });
    harness.membersMetadata.set('draft-team', {
      providerBackendId: 'api',
      members: [
        {
          name: 'active',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          mcpPolicy: {
            mode: 'strictAllowlist',
            serverNames: [' repo ', 'REPO', 'docs'],
          },
        },
        {
          name: 'removed',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          removedAt: 10,
        },
      ],
    });

    await expect(harness.repository.getSavedRequest('missing-team')).resolves.toBeNull();
    await expect(harness.repository.getSavedRequest('draft-team')).resolves.toMatchObject({
      teamName: 'draft-team',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      members: [
        {
          name: 'active',
          providerBackendId: 'codex-native',
          mcpPolicy: {
            mode: 'strictAllowlist',
            serverNames: ['repo', 'docs'],
          },
        },
      ],
    });
    expect(harness.teamMembersMetaStore.getMeta).toHaveBeenCalledTimes(1);
  });

  it('rolls back claimed roots when member validation fails', async () => {
    const harness = await createHarness();

    await expect(
      harness.repository.createTeamConfig(
        { teamName: 'invalid-team', members: [{ name: 'builder-2' }] },
        harness.roots
      )
    ).rejects.toThrow('reserved for runtime-managed numeric suffixes');

    await expect(access(join(harness.roots.teamsRoot, 'invalid-team'))).rejects.toThrow();
    await expect(access(join(harness.roots.tasksRoot, 'invalid-team'))).rejects.toThrow();
    expect(harness.teamMembersMetaStore.writeMembers).not.toHaveBeenCalled();
    expect(harness.invalidateListTeamsCache).not.toHaveBeenCalled();
  });
});
