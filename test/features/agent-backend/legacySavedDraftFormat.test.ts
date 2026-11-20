// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLegacyStoppedTeamSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { createDraftTeamConfig } from '../../../src/main/services/team/createDraftTeamConfig';
import {
  classifyLegacySavedTeamNativeRecords,
  isLegacySavedTeamProductRecords,
} from '../../../src/main/services/team/LegacySavedTeamNativeIdentity';
import { TeamLaunchStateStore } from '../../../src/main/services/team/TeamLaunchStateStore';
import { TeamMembersMetaStore } from '../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';

import type { LegacyStoppedSourceOwners } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import type { ProviderModelLaunchIdentity } from '../../../src/shared/types';

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

async function savedDraft(
  runtimeSelectionVersion?: 1,
  launchIdentity?: ProviderModelLaunchIdentity
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-saved-draft-format-')));
  roots.push(root);
  paths.root = root;
  const teamName = 'saved-format';
  const teamMetaStore = new TeamMetaStore();
  await createDraftTeamConfig(
    {
      teamName,
      ...(runtimeSelectionVersion === undefined ? {} : { runtimeSelectionVersion }),
      cwd: root,
      providerId: launchIdentity?.providerId ?? 'codex',
      model: 'TEST-model',
      members: [{ name: 'worker', role: 'developer' }],
    },
    { teamMetaStore, membersMetaStore: new TeamMembersMetaStore() }
  );
  if (launchIdentity) {
    const current = await teamMetaStore.getMeta(teamName);
    if (!current) throw new Error('TEST real writer did not create metadata');
    await teamMetaStore.writeMeta(teamName, { ...current, launchIdentity });
  }
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
      readStoppedTeamImportCommandFacts: async () => ({
        known: true,
        pending: 0,
        revision: 'TEST',
      }),
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

  it.each(
    (['anthropic', 'codex', 'gemini', 'opencode'] as const).flatMap((providerId) =>
      (['default', 'explicit'] as const).map((selectedModelKind) => ({
        providerId,
        selectedModelKind,
      }))
    )
  )(
    'reads the real metadata writer launch identity for $providerId/$selectedModelKind',
    async ({ providerId, selectedModelKind }) => {
      const identity = launchIdentity(providerId, selectedModelKind);
      const f = await savedDraft(1, identity);
      expect(f.meta.launchIdentity).toEqual(identity);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, {
          config: null,
          meta: f.meta,
          roster: f.roster,
        })
      ).toBe(true);
      const header = await f.source.fenced(() => f.source.describe());
      expect(header.sourceKind).toBe('saved-draft');
      expect(header.savedSettings.providerId).toBe(providerId);
      expect(header.savedSettings).not.toHaveProperty('launchIdentity');
      expect(JSON.parse(readFileSync(f.metaPath, 'utf8'))).toEqual(f.meta);
    }
  );

  it('reads older identities without the optional billing and fast-mode fields', async () => {
    const f = await savedDraft(1, launchIdentity('opencode', 'default'));
    const identity = { ...(f.meta.launchIdentity as Record<string, unknown>) };
    for (const key of [
      'billingMode',
      'selectedFastMode',
      'resolvedFastMode',
      'fastResolutionReason',
    ])
      delete identity[key];
    const meta = { ...f.meta, launchIdentity: identity },
      bytes = JSON.stringify(meta);
    writeFileSync(f.metaPath, bytes);
    expect(
      isLegacySavedTeamProductRecords(f.teamName, { config: null, meta, roster: f.roster })
    ).toBe(true);
    expect((await f.source.fenced(() => f.source.describe())).sourceKind).toBe('saved-draft');
    expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
  });

  it('refuses malformed identities and unknown nested fields without rewriting saved bytes', async () => {
    const f = await savedDraft(1, launchIdentity('codex', 'explicit'));
    const identity = f.meta.launchIdentity as Record<string, unknown>;
    const invalid = [
      null,
      [],
      'TEST',
      {},
      { ...identity, providerId: 'foreign' },
      { ...identity, providerId: ['codex'] },
      { ...identity, selectedModelKind: 'auto' },
      { ...identity, selectedModel: 1 },
      { ...identity, providerBackendId: {} },
      { ...identity, catalogSource: 'foreign' },
      { ...identity, catalogSource: ['runtime'] },
      { ...identity, catalogFetchedAt: 1 },
      { ...identity, selectedEffort: 'foreign' },
      { ...identity, selectedEffort: ['high'] },
      { ...identity, resolvedEffort: false },
      { ...identity, selectedFastMode: true },
      { ...identity, selectedFastMode: ['inherit'] },
      { ...identity, resolvedFastMode: 'true' },
      { ...identity, billingMode: 'foreign' },
      { ...identity, billingMode: ['api'] },
      { ...identity, fastResolutionReason: 'bad\0value' },
      { ...identity, unknownProductField: true },
      { ...identity, credentials: { apiKey: 'TEST-only' } },
      Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'selectedModel')),
    ];
    for (const launchIdentity of invalid) {
      const meta = { ...f.meta, launchIdentity },
        bytes = JSON.stringify(meta);
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

  it('keeps nested native identities subject to the original custody requirement', async () => {
    const f = await savedDraft(1, launchIdentity('codex', 'explicit'));
    for (const [key, value] of [
      ['sessionId', 'TEST-native-session'],
      ['runId', 'TEST-native-run'],
      ['pid', process.pid],
    ] as const) {
      const meta = {
        ...f.meta,
        launchIdentity: { ...(f.meta.launchIdentity as Record<string, unknown>), [key]: value },
      };
      const bytes = JSON.stringify(meta),
        records = { config: null, meta, roster: f.roster };
      writeFileSync(f.metaPath, bytes);
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('retained');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({
        reason: 'native-custody-unverified',
      });
      expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
    }
  });
});

function launchIdentity(
  providerId: ProviderModelLaunchIdentity['providerId'],
  selectedModelKind: ProviderModelLaunchIdentity['selectedModelKind']
): ProviderModelLaunchIdentity {
  return {
    providerId,
    providerBackendId: providerId === 'codex' ? 'codex-native' : null,
    billingMode: 'api',
    selectedModel: selectedModelKind === 'explicit' ? 'TEST-model' : null,
    selectedModelKind,
    resolvedLaunchModel: 'TEST-model',
    catalogId: 'TEST-catalog',
    catalogSource: 'runtime',
    catalogFetchedAt: '2026-11-20T00:00:00.000Z',
    selectedEffort: null,
    resolvedEffort: 'high',
    selectedFastMode: 'inherit',
    resolvedFastMode: false,
    fastResolutionReason: null,
  };
}
