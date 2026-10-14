import { projectTemplateContent } from '@features/custom-team-templates/core/domain/templateContentPolicy';
import { SavedTeamConfigurationSnapshotAdapter } from '@features/custom-team-templates/main/adapters/output/SavedTeamConfigurationSnapshotAdapter';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ teamsBase: '' }));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

import type { TeamMember } from '@shared/types';

const adapter = new SavedTeamConfigurationSnapshotAdapter();
const metaStore = new TeamMetaStore();
const membersStore = new TeamMembersMetaStore();

async function writeTeamMeta(teamName: string, prompt?: string): Promise<void> {
  await metaStore.writeMeta(teamName, {
    cwd: '/projects/example',
    ...(prompt === undefined ? {} : { prompt }),
    createdAt: Date.now(),
  });
}

async function writeRoster(
  teamName: string,
  members: readonly Partial<TeamMember>[],
  raw?: string
): Promise<void> {
  if (raw !== undefined) {
    await fs.writeFile(path.join(hoisted.teamsBase, teamName, 'members.meta.json'), raw);
    return;
  }
  await membersStore.writeMembers(
    teamName,
    members.map((member) => ({ name: member.name ?? 'unnamed', ...member }) as TeamMember)
  );
}

async function writeConfig(teamName: string, config: unknown): Promise<void> {
  await fs.writeFile(
    path.join(hoisted.teamsBase, teamName, 'config.json'),
    typeof config === 'string' ? config : JSON.stringify(config)
  );
}

async function createTeamDir(teamName: string): Promise<string> {
  const directory = path.join(hoisted.teamsBase, teamName);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

describe('SavedTeamConfigurationSnapshotAdapter', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-template-snapshot-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    await fs.mkdir(hoisted.teamsBase, { recursive: true });
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a missing team directory as an unavailable source', async () => {
    await expect(adapter.readSnapshot('absent-team')).resolves.toEqual({
      status: 'sourceUnavailable',
      sourceTeamName: 'absent-team',
    });
  });

  it('reports an invalid or unsafe team identity as an unavailable source', async () => {
    for (const teamName of ['', '  ', '../escape', 'Team With Spaces', 'UPPER', 'a'.repeat(200)]) {
      await expect(adapter.readSnapshot(teamName)).resolves.toEqual({
        status: 'sourceUnavailable',
        sourceTeamName: teamName,
      });
    }
  });

  it('reports a directory with no authoritative saved configuration as unavailable', async () => {
    const directory = await createTeamDir('empty-team');
    await fs.writeFile(path.join(directory, 'launch-state.json'), '{"state":"ready"}');

    await expect(adapter.readSnapshot('empty-team')).resolves.toEqual({
      status: 'sourceUnavailable',
      sourceTeamName: 'empty-team',
    });
  });

  it('reads the saved launch prompt and keeps an absent roster absent', async () => {
    await createTeamDir('prompt-only');
    await writeTeamMeta('prompt-only', 'Ship the migration safely.');

    const outcome = await adapter.readSnapshot('prompt-only');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;

    expect(outcome.snapshot).toEqual({
      sourceTeamName: 'prompt-only',
      teamPrompt: 'Ship the migration safely.',
      roster: { status: 'absent' },
    });

    const projection = projectTemplateContent(outcome.snapshot);
    expect(projection.status).toBe('ready');
    if (projection.status !== 'ready') return;
    expect(projection.content.members).toEqual([]);
    expect(projection.content.teamPrompt).toBe('Ship the migration safely.');
    // An absent roster and a readable empty roster must stay distinguishable.
    expect(projection.warnings).toContainEqual({ code: 'noRecordedRoster' });
  });

  it('accepts a config.json-only team without inventing a prompt', async () => {
    await createTeamDir('imported-team');
    await writeConfig('imported-team', { name: 'imported-team', members: [] });

    const outcome = await adapter.readSnapshot('imported-team');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(outcome.snapshot.teamPrompt).toBeUndefined();

    const projection = projectTemplateContent(outcome.snapshot);
    expect(projection.status).toBe('ready');
    if (projection.status !== 'ready') return;
    expect(projection.content.teamPrompt).toBe('');
    expect(projection.warnings).toContainEqual({ code: 'missingTeamPrompt' });
    expect(projection.warnings).toContainEqual({ code: 'noRecordedRoster' });
  });

  it('reads a strictly readable roster with zero members as a valid empty roster', async () => {
    await createTeamDir('empty-roster');
    await writeTeamMeta('empty-roster', 'Prompt.');
    await writeRoster('empty-roster', []);

    const outcome = await adapter.readSnapshot('empty-roster');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(outcome.snapshot.roster).toEqual({ status: 'readable', members: [] });

    const projection = projectTemplateContent(outcome.snapshot);
    expect(projection.status).toBe('ready');
    if (projection.status !== 'ready') return;
    expect(projection.warnings).toContainEqual({ code: 'emptyRoster' });
    expect(projection.warnings).not.toContainEqual({ code: 'noRecordedRoster' });
  });

  it('blocks a malformed roster instead of silently dropping members', async () => {
    await createTeamDir('damaged-roster');
    await writeTeamMeta('damaged-roster', 'Prompt.');
    await writeRoster(
      'damaged-roster',
      [],
      JSON.stringify({ version: 1, members: [{ name: 'alice' }, { role: 'reviewer' }] })
    );

    const outcome = await adapter.readSnapshot('damaged-roster');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(outcome.snapshot.roster).toEqual({ status: 'unreadable' });

    const projection = projectTemplateContent(outcome.snapshot);
    expect(projection).toEqual({ status: 'rosterUnreadable', sourceTeamName: 'damaged-roster' });
  });

  it('blocks a roster whose recognized values would not survive a canonical read', async () => {
    await createTeamDir('lossy-roster');
    await writeTeamMeta('lossy-roster', 'Prompt.');
    await writeRoster(
      'lossy-roster',
      [],
      JSON.stringify({ version: 1, members: [{ name: 'alice', role: 42 }] })
    );

    const outcome = await adapter.readSnapshot('lossy-roster');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(outcome.snapshot.roster).toEqual({ status: 'unreadable' });
  });

  it('keeps a recoverable roster readable when it contains a known auto-suffix artifact', async () => {
    await createTeamDir('artifact-roster');
    await writeTeamMeta('artifact-roster', 'Deliver the feature.');
    await writeRoster(
      'artifact-roster',
      [],
      JSON.stringify({
        version: 1,
        members: [
          { name: 'dev', role: 'developer', workflow: 'Build the feature.' },
          { name: 'dev-2', role: 'developer', workflow: 'Build the feature.' },
        ],
      })
    );

    // The template path may drop the generated duplicate itself, so a known
    // artifact is not proof that the whole roster is unreadable.
    const outcome = await adapter.readSnapshot('artifact-roster');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(outcome.snapshot.roster).toEqual({
      status: 'readable',
      members: [{ name: 'dev', role: 'developer', workflow: 'Build the feature.' }],
    });

    const projection = projectTemplateContent(outcome.snapshot);
    expect(projection.status).toBe('ready');
    if (projection.status !== 'ready') return;
    // The legitimate base member is retained, the artifact is excluded, and a
    // generated duplicate is not counted as a removed teammate.
    expect(projection.content.members).toEqual([
      { name: 'dev', role: 'developer', workflow: 'Build the feature.' },
    ]);
    expect(projection.warnings).toEqual([]);

    // Other consumers of the strict read are not weakened: management
    // replacement still fails closed on the same file.
    await expect(
      membersStore.getMeta('artifact-roster', { requireCompleteMembers: true })
    ).resolves.toBeNull();
  });

  it('refuses a trashed team instead of projecting its saved configuration', async () => {
    await createTeamDir('trashed-team');
    await writeTeamMeta('trashed-team', 'Prompt.');
    await writeRoster('trashed-team', [{ name: 'alice', role: 'reviewer' }]);
    // A trashed team keeps a fully valid configuration on disk, so the refusal
    // has to come from the deletion marker rather than from a read failure.
    await metaStore.writeMeta('trashed-team', {
      cwd: '/projects/example',
      prompt: 'Prompt.',
      deletedAt: new Date().toISOString(),
      createdAt: Date.now(),
    });

    await expect(adapter.readSnapshot('trashed-team')).resolves.toEqual({
      status: 'sourceUnavailable',
      sourceTeamName: 'trashed-team',
    });
  });

  it('blocks an unreadable team.meta.json instead of reporting a missing prompt', async () => {
    const directory = await createTeamDir('broken-meta');
    await fs.writeFile(path.join(directory, 'team.meta.json'), '{ not json');

    await expect(adapter.readSnapshot('broken-meta')).resolves.toEqual({
      status: 'sourceUnavailable',
      sourceTeamName: 'broken-meta',
    });
  });

  it('blocks an unreadable config.json instead of ignoring it', async () => {
    await createTeamDir('broken-config');
    await writeConfig('broken-config', '{ not json');

    await expect(adapter.readSnapshot('broken-config')).resolves.toEqual({
      status: 'sourceUnavailable',
      sourceTeamName: 'broken-config',
    });
  });

  it('projects active members, excludes the canonical lead and counts removed teammates', async () => {
    await createTeamDir('staffed-team');
    await writeTeamMeta('staffed-team', 'Deliver the feature.');
    await writeRoster('staffed-team', [
      { name: 'team-lead', agentType: 'team-lead', role: 'Lead' },
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      { name: 'bob' },
      { name: 'carol', role: 'writer', removedAt: Date.now() },
    ]);

    const outcome = await adapter.readSnapshot('staffed-team');
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;

    const projection = projectTemplateContent(outcome.snapshot);
    expect(projection.status).toBe('ready');
    if (projection.status !== 'ready') return;

    // The canonical lead is excluded from the projection and from the count of
    // excluded removed teammates.
    expect(projection.content.members).toEqual([
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      { name: 'bob' },
    ]);
    // Only the projected members contribute warnings, and their missing text
    // is never invented: the removed teammate and the lead produce none.
    expect(projection.warnings).toEqual([
      { code: 'missingMemberRole', memberName: 'bob' },
      { code: 'missingMemberWorkflow', memberName: 'bob' },
      { code: 'removedMembersExcluded', count: 1 },
    ]);
  });

  it('rejects a snapshot whose files change while it is being read', async () => {
    await createTeamDir('racing-team');
    await writeTeamMeta('racing-team', 'Original prompt.');
    await writeRoster('racing-team', [{ name: 'alice' }]);

    const original = TeamMetaStore.prototype.getMeta;
    vi.spyOn(TeamMetaStore.prototype, 'getMeta').mockImplementation(async function (
      this: TeamMetaStore,
      ...args: Parameters<typeof original>
    ) {
      const result = await original.apply(this, args);
      await fs.writeFile(
        path.join(hoisted.teamsBase, 'racing-team', 'team.meta.json'),
        metaStore.serializeMeta({
          cwd: '/projects/example',
          prompt: 'Changed prompt.',
          createdAt: Date.now(),
        })
      );
      return result;
    });

    await expect(adapter.readSnapshot('racing-team')).resolves.toEqual({
      status: 'configurationChanged',
      sourceTeamName: 'racing-team',
    });
  });

  it('reports a stable revision for an unchanged team and ignores unrelated artifacts', async () => {
    const directory = await createTeamDir('stable-team');
    await writeTeamMeta('stable-team', 'Prompt.');
    await writeRoster('stable-team', [{ name: 'alice' }]);
    // A task/message/history artifact that would fail if anything parsed it: the
    // adapter must read saved configuration and roster metadata only.
    await fs.writeFile(path.join(directory, 'tasks.json'), '{ not json');
    await fs.writeFile(path.join(directory, 'sentMessages.json'), '{ not json');
    await fs.mkdir(path.join(directory, 'members'), { recursive: true });

    const first = await adapter.readSnapshot('stable-team');
    const second = await adapter.readSnapshot('stable-team');
    expect(first.status).toBe('available');
    expect(second.status).toBe('available');
    if (first.status !== 'available' || second.status !== 'available') return;

    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(second.revision).toBe(first.revision);
    expect(first.snapshot).toEqual(second.snapshot);
    expect(Object.keys(first.snapshot).sort((left, right) => left.localeCompare(right))).toEqual([
      'roster',
      'sourceTeamName',
      'teamPrompt',
    ]);
  });

  it('changes the revision when the roster metadata changes', async () => {
    await createTeamDir('evolving-team');
    await writeTeamMeta('evolving-team', 'Prompt.');
    await writeRoster('evolving-team', [{ name: 'alice' }]);

    const before = await adapter.readSnapshot('evolving-team');
    await writeRoster('evolving-team', [{ name: 'alice' }, { name: 'bob' }]);
    const after = await adapter.readSnapshot('evolving-team');

    expect(before.status).toBe('available');
    expect(after.status).toBe('available');
    if (before.status !== 'available' || after.status !== 'available') return;
    expect(after.revision).not.toBe(before.revision);
    expect(after.snapshot.roster).toEqual({
      status: 'readable',
      members: [{ name: 'alice' }, { name: 'bob' }],
    });
  });
});
