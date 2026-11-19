// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLegacyStoppedTeamSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { createDraftTeamConfig } from '../../../src/main/services/team/createDraftTeamConfig';
import { isLegacySavedTeamProductRecords } from '../../../src/main/services/team/LegacySavedTeamNativeIdentity';
import { TeamLaunchStateStore } from '../../../src/main/services/team/TeamLaunchStateStore';
import { TeamMembersMetaStore } from '../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';

import type { LegacyStoppedSourceOwners } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';

const paths = vi.hoisted(() => ({ root: '/TEST-unconfigured-saved-draft' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(paths.root, 'claude'),
  getTeamsBasePath: () => join(paths.root, 'claude/teams'),
  getTasksBasePath: () => join(paths.root, 'claude/tasks'),
  getAppDataPath: () => join(paths.root, 'app'),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function savedDraft(runtimeSelectionVersion?: 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-saved-draft-format-')));
  roots.push(root);
  paths.root = root;
  const teamName = 'saved-format';
  await createDraftTeamConfig(
    {
      teamName,
      ...(runtimeSelectionVersion === undefined ? {} : { runtimeSelectionVersion }),
      cwd: root,
      providerId: 'codex',
      model: 'TEST-model',
      members: [{ name: 'worker', role: 'developer' }],
    },
    { teamMetaStore: new TeamMetaStore(), membersMetaStore: new TeamMembersMetaStore() }
  );
  const team = join(root, 'claude/teams', teamName);
  const metaPath = join(team, 'team.meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  const roster: unknown = JSON.parse(readFileSync(join(team, 'members.meta.json'), 'utf8'));
  // Controlled owner facts isolate the actual writer/reader format boundary.
  // No provider, native custody or complete import qualification is claimed.
  const owners: LegacyStoppedSourceOwners = {
    backup: { withTeamIdentityFence: (_name, read) => read() },
    provisioning: {
      withStoppedTeamImportFence: (_name, read) => read(),
      readStoppedTeamImportRuntimeFacts: () => ({ active: 0 }),
      readStoppedTeamImportLifecycleFacts: () => ({ active: 0 }),
      readStoppedTeamImportStopFacts: () => ({ active: 0 }),
      readStoppedTeamImportDeliveryFacts: () => ({ active: 0 }),
    },
    data: {
      readStoppedTeamImportBackgroundFacts: () => ({ active: 0 }),
      readStoppedTeamImportCommandFacts: async () => ({ known: true, pending: 0, revision: 'TEST' }),
      readStoppedTeamImportNotificationFacts: async () => ({
        known: true,
        pending: 0,
        revision: 'TEST',
      }),
    },
    launch: new TeamLaunchStateStore(),
  };
  const source = createLegacyStoppedTeamSource(
    {
      sourceOwnerId: 'TEST-owner',
      sourceId: 'TEST-source',
      contextId: 'TEST-context',
      teamName,
      roots: [
        { category: 'team', path: team },
        { category: 'tasks', path: join(root, 'claude/tasks', teamName) },
      ],
      isCurrent: () => true,
    },
    owners
  );
  return { teamName, meta, metaPath, roster, source };
}

describe('actual saved-draft product format', () => {
  it.each([undefined, 1] as const)(
    'retains runtime selection version %s from the real Save-only writer',
    async (version) => {
      const f = await savedDraft(version);
      expect(f.meta.runtimeSelectionVersion).toBe(version);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, {
          config: null,
          meta: f.meta,
          roster: f.roster,
        })
      ).toBe(true);
      const header = await f.source.fenced(() => f.source.describe());
      expect(header.sourceKind).toBe('saved-draft');
      expect(header.savedSettings.runtimeSelectionVersion).toBe(version);
      expect(header.savedSettings).toMatchObject({ providerId: 'codex', model: 'TEST-model' });
      expect(header.members.map((member) => member.name)).toEqual(['team-lead', 'worker']);
      expect(JSON.parse(readFileSync(f.metaPath, 'utf8'))).toEqual(f.meta);
    }
  );

  it('refuses unsupported versions and unrelated fields without normalizing saved records', async () => {
    const f = await savedDraft(1);
    const invalidMetadata = [
      ...[0, 2, '1', true, null, {}, []].map((runtimeSelectionVersion) => ({
        ...f.meta,
        runtimeSelectionVersion,
      })),
      { ...f.meta, launchIdentity: { providerId: 'codex', selectedModelKind: 'explicit' } },
      { ...f.meta, unknownProductField: true },
    ];
    for (const meta of invalidMetadata) {
      const bytes = JSON.stringify(meta);
      writeFileSync(f.metaPath, bytes);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, { config: null, meta, roster: f.roster })
      ).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({
        reason: 'source-unreadable',
      });
      expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
    }
  });
});
